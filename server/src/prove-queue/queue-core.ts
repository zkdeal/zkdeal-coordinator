/**
 * The prove-queue state machine, and nothing else.
 *
 * Pure by design: every transition takes the current time as an argument and
 * touches only in-memory maps, so the whole lease/retry/expiry story is
 * testable with a fake clock and the persistence layer (`queue-store.ts`)
 * stays a dumb mirror. This is the same separation `ProvingSlot` draws - the
 * queue is not what makes proving exclusive (each prover host holds its own
 * GPU gate); it is what makes waiting observable and failure recoverable.
 *
 * Position semantics extend `ProvingSlot`'s: 0 while running (leased), 1 for
 * the next in line. A requeued job goes to the BACK of the line, never its
 * old slot - a submitter that was told "position 2" must never look again and
 * see "position 3" because someone else's lease died in front of it.
 */

import {
  PROVE_ENDPOINTS,
  ProveQueueRejection,
  isProveEndpoint,
  type ProveJob,
  type ProveNodeCapabilities,
  type ProveQueueNodeStats,
  type ProveQueueStatus,
  type ProveQueueStatusEntry,
} from './queue-types.js'

/** A proof is minutes, not hours: a silent node forfeits its job in 25 min. */
export const DEFAULT_LEASE_TTL_MS = 25 * 60_000
/** A job is leased at most twice; the second death condemns it. */
export const DEFAULT_MAX_ATTEMPTS = 2
/** Hard queue ceilings. The HTTP body limit protects one request; these bound
 * the aggregate bytes held by a noisy tenant and by the whole service. */
export const DEFAULT_MAX_GLOBAL_JOBS = 10_000
export const DEFAULT_MAX_GLOBAL_BYTES = 4 * 1024 * 1024 * 1024
export const DEFAULT_MAX_TENANT_JOBS = 256
export const DEFAULT_MAX_TENANT_BYTES = 512 * 1024 * 1024
/** Conservative proof estimate used when a service class has no measurement. */
export const DEFAULT_ESTIMATED_PROOF_TIME_MS = 5 * 60_000
/** Every interval of waiting improves a tenant's effective virtual finish. */
export const DEFAULT_AGING_INTERVAL_MS = 10 * 60_000

export interface ProveJobSubmission {
  tenantId?: string
  roomId?: string | null
  allocationId?: string | null
  sponsorshipId?: string | null
  serviceClass?: 'standard' | 'latency' | 'batch'
  partition?: 'shared' | 'reserved' | 'dedicated'
  correlationId?: string | null
  idempotencyRequestHash?: string | null
  deadlineAtMs?: number | null
  deadlineTrusted?: boolean
  priority?: number
  requestBytes?: number
  tenantWeight?: number
  estimatedWork?: number
  estimatedProofTimeMs?: number
  settlementMarginMs?: number
  maxTenantJobs?: number
  maxTenantBytes?: number
}

export interface ProveQueueCoreOptions {
  leaseTtlMs?: number
  maxAttempts?: number
  maxGlobalJobs?: number
  maxGlobalBytes?: number
  maxTenantJobs?: number
  maxTenantBytes?: number
  /** Backward-compatible name used as the default proof-time estimate. */
  urgentDeadlineWindowMs?: number
  agingIntervalMs?: number
}

const stamp = (nowMs: number): string => new Date(nowMs).toISOString()

export class ProveQueueCore {
  private readonly leaseTtlMs: number
  private readonly maxAttempts: number
  private readonly maxGlobalJobs: number
  private readonly maxGlobalBytes: number
  private readonly maxTenantJobs: number
  private readonly maxTenantBytes: number
  private readonly defaultEstimatedProofTimeMs: number
  private readonly agingIntervalMs: number
  /** Every job the queue still remembers, keyed by id. */
  private readonly jobs = new Map<string, ProveJob>()
  /** FIFO of QUEUED job ids. Leasing removes; requeueing appends. */
  private order: string[] = []
  private readonly nodes = new Map<string, ProveQueueNodeStats>()
  /** Weighted-fair virtual service consumed by each tenant in this process. */
  private readonly tenantVirtualFinish = new Map<string, number>()

  constructor(options: ProveQueueCoreOptions = {}) {
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.maxGlobalJobs = options.maxGlobalJobs ?? DEFAULT_MAX_GLOBAL_JOBS
    this.maxGlobalBytes = options.maxGlobalBytes ?? DEFAULT_MAX_GLOBAL_BYTES
    this.maxTenantJobs = options.maxTenantJobs ?? DEFAULT_MAX_TENANT_JOBS
    this.maxTenantBytes = options.maxTenantBytes ?? DEFAULT_MAX_TENANT_BYTES
    this.defaultEstimatedProofTimeMs =
      options.urgentDeadlineWindowMs ?? DEFAULT_ESTIMATED_PROOF_TIME_MS
    this.agingIntervalMs = options.agingIntervalMs ?? DEFAULT_AGING_INTERVAL_MS
  }

  private demand(jobId: string): ProveJob {
    const job = this.jobs.get(jobId)
    if (!job) throw new ProveQueueRejection('UNKNOWN_JOB', `job ${jobId} is not known`)
    return job
  }

  /**
   * The holder check every node-side report goes through. A node whose lease
   * expired (and whose job may already be running elsewhere) must not be able
   * to complete or fail it - the recorded holder is the only voice.
   */
  private demandHolder(jobId: string, nodeId: string): ProveJob {
    const job = this.demand(jobId)
    if (job.nodeId !== nodeId) {
      throw new ProveQueueRejection(
        'NOT_LEASE_HOLDER',
        `job ${jobId} is not leased to ${nodeId}`,
      )
    }
    return job
  }

  private nodeStats(nodeId: string): ProveQueueNodeStats {
    let stats = this.nodes.get(nodeId)
    if (!stats) {
      stats = { nodeId, lastLeaseAt: null, lastResultAt: null, jobsDone: 0 }
      this.nodes.set(nodeId, stats)
    }
    return stats
  }

  submit(
    id: string,
    endpoint: string,
    submitterId: string,
    nowMs: number,
    submission: ProveJobSubmission = {},
  ): ProveJob {
    if (!isProveEndpoint(endpoint)) {
      throw new ProveQueueRejection(
        'BAD_ENDPOINT',
        `${endpoint} is not a proveable endpoint`,
      )
    }
    if (this.jobs.has(id)) {
      throw new ProveQueueRejection('BAD_STATE', `job ${id} already exists`)
    }
    const tenantId = submission.tenantId ?? submitterId
    if (tenantId.length === 0 || tenantId.length > 128) {
      throw new ProveQueueRejection('BAD_STATE', 'tenant id is malformed')
    }
    const requestBytes = submission.requestBytes ?? 0
    if (!Number.isSafeInteger(requestBytes) || requestBytes < 0) {
      throw new ProveQueueRejection('BAD_STATE', 'request byte count is malformed')
    }
    const priority = submission.priority ?? 0
    if (!Number.isSafeInteger(priority) || priority < 0 || priority > 100) {
      throw new ProveQueueRejection('BAD_STATE', 'priority must be an integer from 0 through 100')
    }
    const tenantWeight = submission.tenantWeight ?? 1
    if (!Number.isFinite(tenantWeight) || tenantWeight <= 0 || tenantWeight > 100) {
      throw new ProveQueueRejection('BAD_STATE', 'tenant weight must be greater than zero')
    }
    const estimatedWork = submission.estimatedWork ?? 1
    if (!Number.isFinite(estimatedWork) || estimatedWork <= 0 || estimatedWork > 1_000_000_000) {
      throw new ProveQueueRejection('BAD_STATE', 'estimated work must be a positive finite number')
    }
    const estimatedProofTimeMs = submission.estimatedProofTimeMs ?? this.defaultEstimatedProofTimeMs
    if (!Number.isSafeInteger(estimatedProofTimeMs) || estimatedProofTimeMs < 1_000) {
      throw new ProveQueueRejection('BAD_STATE', 'estimated proof time must be at least one second')
    }
    const settlementMarginMs = submission.settlementMarginMs ?? 0
    if (!Number.isSafeInteger(settlementMarginMs) || settlementMarginMs < 0) {
      throw new ProveQueueRejection('BAD_STATE', 'settlement margin must be a non-negative integer')
    }
    const serviceClass = submission.serviceClass ?? 'standard'
    if (!['standard', 'latency', 'batch'].includes(serviceClass)) {
      throw new ProveQueueRejection('BAD_STATE', 'service class is invalid')
    }
    const partition = submission.partition ?? 'shared'
    if (!['shared', 'reserved', 'dedicated'].includes(partition)) {
      throw new ProveQueueRejection('BAD_STATE', 'queue partition is invalid')
    }
    if (partition === 'reserved' && !submission.allocationId) {
      throw new ProveQueueRejection('BAD_STATE', 'reserved jobs require an allocation id')
    }
    const unfinished = [...this.jobs.values()].filter(
      (job) => job.status === 'QUEUED' || job.status === 'LEASED',
    )
    const tenantUnfinished = unfinished.filter((job) => job.tenantId === tenantId)
    const globalBytes = unfinished.reduce((total, job) => total + job.requestBytes, 0)
    const tenantBytes = tenantUnfinished.reduce((total, job) => total + job.requestBytes, 0)
    if (unfinished.length >= this.maxGlobalJobs || globalBytes + requestBytes > this.maxGlobalBytes) {
      throw new ProveQueueRejection('CAPACITY', 'the global prove queue is at capacity')
    }
    const requestedTenantJobCap = submission.maxTenantJobs ?? this.maxTenantJobs
    const requestedTenantByteCap = submission.maxTenantBytes ?? this.maxTenantBytes
    if (!Number.isSafeInteger(requestedTenantJobCap) || requestedTenantJobCap < 1) {
      throw new ProveQueueRejection('BAD_STATE', 'tenant job cap is malformed')
    }
    if (!Number.isSafeInteger(requestedTenantByteCap) || requestedTenantByteCap < 1) {
      throw new ProveQueueRejection('BAD_STATE', 'tenant byte cap is malformed')
    }
    const tenantJobCap = Math.min(requestedTenantJobCap, this.maxTenantJobs)
    const tenantByteCap = Math.min(requestedTenantByteCap, this.maxTenantBytes)
    if (
      tenantUnfinished.length >= tenantJobCap ||
      tenantBytes + requestBytes > tenantByteCap
    ) {
      throw new ProveQueueRejection('CAPACITY', `tenant ${tenantId} is at prove-queue capacity`)
    }
    const deadlineAtMs = submission.deadlineAtMs ?? null
    if (deadlineAtMs !== null && (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= nowMs)) {
      throw new ProveQueueRejection('BAD_STATE', 'deadline must be a future timestamp')
    }
    const job: ProveJob = {
      id,
      endpoint,
      needsGpu: PROVE_ENDPOINTS[endpoint]!,
      status: 'QUEUED',
      submitterId,
      tenantId,
      roomId: submission.roomId ?? null,
      allocationId: submission.allocationId ?? null,
      sponsorshipId: submission.sponsorshipId ?? null,
      serviceClass,
      partition,
      correlationId: submission.correlationId ?? null,
      idempotencyRequestHash: submission.idempotencyRequestHash ?? null,
      deadlineAt: deadlineAtMs === null ? null : stamp(deadlineAtMs),
      deadlineTrusted: submission.deadlineTrusted === true,
      priority,
      requestBytes,
      tenantWeight,
      estimatedWork,
      estimatedProofTimeMs,
      settlementMarginMs,
      latestStartAt: deadlineAtMs === null
        ? null
        : stamp(deadlineAtMs - estimatedProofTimeMs - settlementMarginMs),
      agingStartedAt: stamp(nowMs),
      nodeId: null,
      attempts: 0,
      enqueuedAt: stamp(nowMs),
      leasedAt: null,
      finishedAt: null,
      leaseExpiresAt: null,
      failure: null,
    }
    this.jobs.set(id, job)
    this.order.push(id)
    return job
  }

  /**
   * Hand the first eligible QUEUED job to `nodeId`, FIFO. Two skips only:
   * a declared CPU-only worker never receives a GPU job, and a node already
   * holding a GPU lease is not handed a second one - its prover host runs one
   * proof at a time (the `gpu_gate` semaphore in http.rs), so a second GPU
   * job would just sit dying on its 25-minute lease. CPU jobs stay
   * co-leasable so cheap execute/verify work never queues behind a proof.
   */
  lease(nodeId: string, capabilities: ProveNodeCapabilities, nowMs: number): ProveJob | null {
    const gpuCapable = capabilities.gpu !== false
    const holdsGpuLease = [...this.jobs.values()].some(
      (job) => job.status === 'LEASED' && job.nodeId === nodeId && job.needsGpu,
    )
    const partitions = new Set(capabilities.partitions ?? ['shared'])
    const allocationIds = new Set(capabilities.allocationIds ?? [])
    const tenantIds = new Set(capabilities.tenantIds ?? [])
    const eligible = this.order.flatMap((id, index) => {
      const job = this.jobs.get(id)
      if (!job || job.status !== 'QUEUED') return []
      if (job.needsGpu && (!gpuCapable || holdsGpuLease)) return []
      if (!partitions.has(job.partition)) return []
      if (
        job.partition === 'reserved'
        && (!job.allocationId || !allocationIds.has(job.allocationId) || !tenantIds.has(job.tenantId))
      ) return []
      if (job.partition === 'dedicated' && !tenantIds.has(job.tenantId)) return []
      return [{ job, index }]
    })
    if (eligible.length === 0) return null

    // Trusted deadlines that are genuinely near expiry use global EDF. A
    // tenant cannot manufacture this pre-emption: the route only marks a
    // deadline trusted for an authenticated scope or a server-side policy.
    const urgent = eligible
      .filter(({ job }) => {
        if (!job.deadlineTrusted || !job.latestStartAt) return false
        return Date.parse(job.latestStartAt) <= nowMs
      })
      .sort((a, b) => {
        const deadline = Date.parse(a.job.deadlineAt!) - Date.parse(b.job.deadlineAt!)
        if (deadline !== 0) return deadline
        if (a.job.priority !== b.job.priority) return b.job.priority - a.job.priority
        return a.index - b.index
      })

    let selected = urgent[0]
    if (!selected) {
      // Weighted fairness chooses the tenant with the least virtual service;
      // EDF + priority is then applied only INSIDE that tenant. This prevents
      // one tenant from monopolising the fleet while still meeting its own
      // earliest service deadline first.
      const tenants = new Map<string, Array<(typeof eligible)[number]>>()
      for (const candidate of eligible) {
        const rows = tenants.get(candidate.job.tenantId) ?? []
        rows.push(candidate)
        tenants.set(candidate.job.tenantId, rows)
      }
      const tenant = [...tenants.entries()].sort((a, b) => {
        const aBoost = Math.max(...a[1].map((entry) =>
          Math.floor(Math.max(0, nowMs - Date.parse(entry.job.agingStartedAt)) / this.agingIntervalMs)))
        const bBoost = Math.max(...b[1].map((entry) =>
          Math.floor(Math.max(0, nowMs - Date.parse(entry.job.agingStartedAt)) / this.agingIntervalMs)))
        const virtual =
          ((this.tenantVirtualFinish.get(a[0]) ?? 0) - aBoost) -
          ((this.tenantVirtualFinish.get(b[0]) ?? 0) - bBoost)
        if (virtual !== 0) return virtual
        return Math.min(...a[1].map((entry) => entry.index)) - Math.min(...b[1].map((entry) => entry.index))
      })[0]!
      selected = tenant[1].sort((a, b) => {
        const aDeadline = a.job.deadlineAt ? Date.parse(a.job.deadlineAt) : Number.POSITIVE_INFINITY
        const bDeadline = b.job.deadlineAt ? Date.parse(b.job.deadlineAt) : Number.POSITIVE_INFINITY
        if (aDeadline !== bDeadline) return aDeadline - bDeadline
        if (a.job.priority !== b.job.priority) return b.job.priority - a.job.priority
        return a.index - b.index
      })[0]!
    }
    const index = selected.index
    const [id] = this.order.splice(index, 1)
    const job = this.jobs.get(id!)!
    job.status = 'LEASED'
    job.nodeId = nodeId
    job.attempts += 1
    job.leasedAt = stamp(nowMs)
    job.leaseExpiresAt = stamp(nowMs + this.leaseTtlMs)
    this.tenantVirtualFinish.set(
      job.tenantId,
      (this.tenantVirtualFinish.get(job.tenantId) ?? 0) + job.estimatedWork / job.tenantWeight,
    )
    this.nodeStats(nodeId).lastLeaseAt = stamp(nowMs)
    return job
  }

  heartbeat(jobId: string, nodeId: string, nowMs: number): ProveJob {
    const job = this.demandHolder(jobId, nodeId)
    if (job.status !== 'LEASED') {
      throw new ProveQueueRejection('BAD_STATE', `job ${jobId} is ${job.status}, not LEASED`)
    }
    job.leaseExpiresAt = stamp(nowMs + this.leaseTtlMs)
    return job
  }

  /**
   * Idempotent for the holder: an agent that completed but lost the HTTP
   * response retries the same call and must not be told it failed. Anyone
   * else - including the node the job was previously leased to - is refused.
   */
  complete(jobId: string, nodeId: string, nowMs: number): { already: boolean; job: ProveJob } {
    const job = this.demandHolder(jobId, nodeId)
    if (job.status === 'DONE') return { already: true, job }
    if (job.status !== 'LEASED') {
      throw new ProveQueueRejection('BAD_STATE', `job ${jobId} is ${job.status}, not LEASED`)
    }
    job.status = 'DONE'
    job.finishedAt = stamp(nowMs)
    job.leaseExpiresAt = null
    job.failure = null
    const stats = this.nodeStats(nodeId)
    stats.lastResultAt = stamp(nowMs)
    stats.jobsDone += 1
    return { already: false, job }
  }

  fail(jobId: string, nodeId: string, reason: string, retryable: boolean, nowMs: number): ProveJob {
    const job = this.demandHolder(jobId, nodeId)
    if (job.status !== 'LEASED') {
      throw new ProveQueueRejection('BAD_STATE', `job ${jobId} is ${job.status}, not LEASED`)
    }
    this.settleFailedAttempt(job, reason, retryable, nowMs)
    return job
  }

  /**
   * A retryable death (reported or by lease expiry) requeues the job at the
   * back of the line until its attempts are spent; then it is condemned so a
   * submitter polling it gets an answer instead of an infinite loop between
   * two broken nodes.
   */
  private settleFailedAttempt(
    job: ProveJob,
    reason: string,
    retryable: boolean,
    nowMs: number,
  ): void {
    job.failure = { reason, retryable }
    job.leaseExpiresAt = null
    job.leasedAt = null
    if (retryable && job.attempts < this.maxAttempts) {
      job.status = 'QUEUED'
      job.nodeId = null
      this.order.push(job.id)
      return
    }
    job.status = 'FAILED'
    job.finishedAt = stamp(nowMs)
  }

  /** Reclaim every lease whose deadline passed. Returns the touched jobs. */
  expireLeases(nowMs: number): ProveJob[] {
    const touched: ProveJob[] = []
    for (const job of this.jobs.values()) {
      if (job.status !== 'LEASED' || !job.leaseExpiresAt) continue
      if (Date.parse(job.leaseExpiresAt) > nowMs) continue
      this.settleFailedAttempt(
        job,
        `the lease held by ${job.nodeId} expired without a result`,
        true,
        nowMs,
      )
      touched.push(job)
    }
    return touched
  }

  /**
   * Forget finished jobs older than `ttlMs`. Results are MB-scale files a
   * submitter fetches once - two hours of grace is plenty, and forgetting is
   * what keeps the index from growing without bound. Returns the removed
   * jobs so the store can delete their files.
   */
  prune(nowMs: number, ttlMs: number): ProveJob[] {
    const removed: ProveJob[] = []
    for (const job of this.jobs.values()) {
      if (job.status !== 'DONE' && job.status !== 'FAILED') continue
      if (!job.finishedAt || Date.parse(job.finishedAt) + ttlMs > nowMs) continue
      this.jobs.delete(job.id)
      removed.push(job)
    }
    return removed
  }

  job(jobId: string): ProveJob | null {
    return this.jobs.get(jobId) ?? null
  }

  /** 0 while leased, 1-based FIFO rank while queued, null otherwise. */
  position(jobId: string): number | null {
    const job = this.jobs.get(jobId)
    if (!job) return null
    if (job.status === 'LEASED') return 0
    if (job.status !== 'QUEUED') return null
    const index = this.order.indexOf(jobId)
    return index < 0 ? null : index + 1
  }

  status(nowMs = Date.now()): ProveQueueStatus {
    const view = (job: ProveJob, position: number): ProveQueueStatusEntry => ({
      id: job.id,
      kind: job.endpoint,
      subjectId: job.submitterId,
      tenantId: job.tenantId,
      roomId: job.roomId,
      allocationId: job.allocationId,
      sponsorshipId: job.sponsorshipId,
      serviceClass: job.serviceClass,
      partition: job.partition,
      correlationId: job.correlationId,
      deadlineAt: job.deadlineAt,
      latestStartAt: job.latestStartAt,
      waitAgeMs: Math.max(0, nowMs - Date.parse(job.agingStartedAt)),
      starvationBoost: Math.floor(
        Math.max(0, nowMs - Date.parse(job.agingStartedAt)) / this.agingIntervalMs,
      ),
      enqueuedAt: job.enqueuedAt,
      startedAt: job.leasedAt,
      position,
    })
    const active = [...this.jobs.values()]
      .filter((job) => job.status === 'LEASED')
      .map((job) => view(job, 0))
    const waiting = this.order
      .map((id) => this.jobs.get(id))
      .filter((job): job is ProveJob => job !== undefined && job.status === 'QUEUED')
      .map((job, index) => view(job, index + 1))
    return { active, waiting, nodes: [...this.nodes.values()].map((stats) => ({ ...stats })) }
  }

  /** Everything the store persists; deep-copied so the disk sees no aliases. */
  snapshot(): { jobs: ProveJob[]; nodes: ProveQueueNodeStats[] } {
    return {
      // `order` is recoverable from enqueue order: `jobs` is a Map in
      // insertion order and requeued jobs were re-inserted... it is NOT - a
      // requeue keeps its original Map slot. Persist queue rank explicitly by
      // serialising QUEUED jobs in `order` first, then the rest.
      jobs: [
        ...this.order.map((id) => this.jobs.get(id)!).filter(Boolean),
        ...[...this.jobs.values()].filter((job) => job.status !== 'QUEUED'),
      ].map((job) => ({ ...job, failure: job.failure ? { ...job.failure } : null })),
      nodes: [...this.nodes.values()].map((stats) => ({ ...stats })),
    }
  }

  /** Rebuild from a snapshot. QUEUED jobs re-enter the line in file order. */
  restore(jobs: ProveJob[], nodes: ProveQueueNodeStats[]): void {
    this.jobs.clear()
    this.nodes.clear()
    this.order = []
    this.tenantVirtualFinish.clear()
    for (const job of jobs) {
      const restored: ProveJob = {
        ...job,
        tenantId: job.tenantId ?? job.submitterId,
        roomId: job.roomId ?? null,
        allocationId: job.allocationId ?? null,
        sponsorshipId: job.sponsorshipId ?? null,
        serviceClass: job.serviceClass ?? 'standard',
        partition: job.partition ?? 'shared',
        correlationId: job.correlationId ?? null,
        idempotencyRequestHash: job.idempotencyRequestHash ?? null,
        deadlineAt: job.deadlineAt ?? null,
        deadlineTrusted: job.deadlineTrusted === true,
        priority: Number.isSafeInteger(job.priority) ? job.priority : 0,
        requestBytes: Number.isSafeInteger(job.requestBytes) ? job.requestBytes : 0,
        tenantWeight:
          Number.isFinite(job.tenantWeight) && job.tenantWeight > 0 ? job.tenantWeight : 1,
        estimatedWork:
          Number.isFinite(job.estimatedWork) && job.estimatedWork > 0 ? job.estimatedWork : 1,
        estimatedProofTimeMs:
          Number.isSafeInteger(job.estimatedProofTimeMs) && job.estimatedProofTimeMs >= 1_000
            ? job.estimatedProofTimeMs
            : this.defaultEstimatedProofTimeMs,
        settlementMarginMs:
          Number.isSafeInteger(job.settlementMarginMs) && job.settlementMarginMs >= 0
            ? job.settlementMarginMs
            : 0,
        latestStartAt: job.latestStartAt ?? null,
        agingStartedAt: job.agingStartedAt ?? job.enqueuedAt,
        failure: job.failure ? { ...job.failure } : null,
      }
      this.jobs.set(job.id, restored)
      if (job.status === 'QUEUED') this.order.push(job.id)
    }
    for (const stats of nodes) this.nodes.set(stats.nodeId, { ...stats })
  }
}
