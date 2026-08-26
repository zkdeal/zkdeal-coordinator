/**
 * The prove queue's HTTP surface: `/queue/v1/*`.
 *
 * Two credentials, two roles. A submitter (bearer ZKDEAL_QUEUE_SUBMIT_TOKEN)
 * may enqueue and read its jobs; a prover node (bearer ZKDEAL_QUEUE_NODE_TOKEN)
 * may lease, heartbeat and report. Neither token unlocks the other side, so a
 * leaked submitter credential cannot forge results and a leaked node
 * credential cannot flood the line. `GET /queue/v1/status` stays open the way
 * the prover's `/healthz` and `/v5/capabilities` do - it is how an
 * orchestrator observes readiness, and it exposes labels and counters only,
 * never request or result bytes.
 *
 * The token comparison is constant-time, matching `authorized_v5` in
 * `prover-node/zkvm/crates/risc0/host/src/http.rs`.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { shortId } from '../demo-validation.js'
import {
  METRICS_CONTENT_TYPE,
  counter,
  gauge,
  renderMetrics,
  type MetricSample,
} from '../metrics.js'
import type { ProveQueueStore } from './queue-store.js'
import { PROVE_ENDPOINTS, ProveQueueRejection, isProveEndpoint } from './queue-types.js'
import { hasHostedRole, type HostedPrincipal, type HostedRole } from '../hosted-types.js'

/** A shorter secret is a guessable secret; refuse to serve behind one. */
const MIN_QUEUE_TOKEN_LENGTH = 16

/**
 * Witness bodies are MB-scale. Mirror the prover's own generosity
 * (`MAX_HTTP_BODY_BYTES`) with a flat ceiling rather than importing Rust
 * constants: what matters is that a legitimate room witness fits and a
 * gigabyte does not.
 */
const QUEUE_BODY_LIMIT_BYTES = 64 * 1024 * 1024

/** How often dead leases are reclaimed even when nobody is calling. */
const SWEEP_INTERVAL_MS = 30_000

export interface ProveQueueRouteOptions {
  store: ProveQueueStore
  submitToken: string
  nodeToken: string
  /** PostgreSQL-backed hosted authentication; fixed tokens remain standalone-only. */
  authenticate?: (
    token: string,
    kind: 'api-key' | 'node',
  ) => Promise<HostedPrincipal | null>
}

/** Constant-time bearer check, same shape as the admission service's. */
function bearerMatches(expected: Buffer, authorization: string | undefined): boolean {
  if (!authorization?.startsWith('Bearer ')) return false
  const supplied = Buffer.from(authorization.slice('Bearer '.length))
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function rejectionStatus(code: ProveQueueRejection['code']): number {
  switch (code) {
    case 'UNKNOWN_JOB':
      return 404
    case 'BAD_ENDPOINT':
      return 400
    case 'CAPACITY':
      return 429
    case 'FORBIDDEN':
      return 403
    default:
      // NOT_LEASE_HOLDER / BAD_STATE: the request was well-formed but the
      // job's state contradicts it.
      return 409
  }
}

export function registerProveQueueRoutes(
  app: FastifyInstance,
  options: ProveQueueRouteOptions,
): void {
  const { store } = options
  for (const [label, token] of [
    ['submit', options.submitToken],
    ['node', options.nodeToken],
  ] as const) {
    if (!options.authenticate && (typeof token !== 'string' || token.length < MIN_QUEUE_TOKEN_LENGTH)) {
      // Fail closed at registration: a queue with a missing or trivial
      // credential must never start listening.
      throw new Error(
        `the prove-queue ${label} token must contain at least ${MIN_QUEUE_TOKEN_LENGTH} characters`,
      )
    }
  }
  const submitToken = Buffer.from(options.submitToken)
  const nodeToken = Buffer.from(options.nodeToken)

  const guarded =
    (expected: Buffer) =>
    (request: FastifyRequest, reply: FastifyReply): boolean => {
      if (bearerMatches(expected, request.headers.authorization)) return true
      void reply.code(401).send({ error: 'missing or invalid queue bearer token' })
      return false
    }
  const submitter = guarded(submitToken)
  const node = guarded(nodeToken)

  const hostedPrincipal = async (
    request: FastifyRequest,
    reply: FastifyReply,
    kind: 'api-key' | 'node',
    role: HostedRole,
  ): Promise<HostedPrincipal | null> => {
    if (!options.authenticate) return null
    const authorization = request.headers.authorization
    if (!authorization?.startsWith('Bearer ')) {
      void reply.code(401).send({ error: 'missing queue bearer credential' })
      return null
    }
    const principal = await options.authenticate(authorization.slice('Bearer '.length).trim(), kind)
    if (!principal) {
      void reply.code(401).send({ error: 'queue credential is invalid or revoked' })
      return null
    }
    if (!hasHostedRole(principal, role)) {
      void reply.code(403).send({ error: `role ${role} required` })
      return null
    }
    return principal
  }

  const rejected = (reply: FastifyReply, error: unknown): unknown => {
    if (error instanceof ProveQueueRejection) {
      return reply.code(rejectionStatus(error.code)).send({ error: error.message })
    }
    throw error
  }

  // Leases must expire even while every agent is dead and no request arrives
  // to trigger an on-access sweep - that is exactly the moment a waiting
  // submitter is watching its position.
  const sweeper = setInterval(() => store.sweep(), SWEEP_INTERVAL_MS)
  sweeper.unref?.()
  app.addHook('onClose', async () => clearInterval(sweeper))

  /* ---------- submitter surface ---------- */

  app.post<{ Body: {
    endpoint?: unknown
    request?: unknown
    roomId?: unknown
    allocationId?: unknown
    sponsorshipId?: unknown
    serviceClass?: unknown
    partition?: unknown
    correlationId?: unknown
    deadlineAt?: unknown
    priority?: unknown
  } }>(
    '/queue/v1/jobs',
    { bodyLimit: QUEUE_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const principal = options.authenticate
        ? await hostedPrincipal(request, reply, 'api-key', 'job-submit')
        : null
      if (options.authenticate ? !principal : !submitter(request, reply)) return
      const endpoint = request.body?.endpoint
      if (!isProveEndpoint(endpoint)) {
        return reply.code(400).send({ error: 'endpoint is not a proveable prover route' })
      }
      if (request.body?.request === undefined) {
        return reply.code(400).send({ error: 'request body is required' })
      }
      const serialized = JSON.stringify(request.body.request)
      const requestBytes = Buffer.byteLength(serialized, 'utf8')
      const idempotencyKeyHeader = request.headers['idempotency-key']
      const idempotencyKey = Array.isArray(idempotencyKeyHeader)
        ? idempotencyKeyHeader[0]
        : idempotencyKeyHeader
      if (options.authenticate && (!idempotencyKey || idempotencyKey.length > 200)) {
        return reply.code(400).send({ error: 'Idempotency-Key is required and must not exceed 200 characters' })
      }
      const tenantId = principal?.tenantId ?? request.ip
      const requestHash = createHash('sha256').update(JSON.stringify({
        endpoint,
        request: request.body.request,
        roomId: request.body.roomId ?? null,
        allocationId: request.body.allocationId ?? null,
        sponsorshipId: request.body.sponsorshipId ?? null,
        serviceClass: request.body.serviceClass ?? 'standard',
        partition: request.body.partition ?? 'shared',
        correlationId: request.body.correlationId ?? null,
        deadlineAt: request.body.deadlineAt ?? null,
        priority: request.body.priority ?? 0,
      })).digest('hex')
      const jobId = idempotencyKey
        ? `pj-${createHash('sha256').update(`${tenantId}\0${idempotencyKey}`).digest('hex').slice(0, 10)}`
        : shortId('pj')
      const existing = store.job(jobId)
      if (existing) {
        if (existing.job.tenantId !== tenantId) return reply.code(403).send({ error: 'job belongs to another tenant' })
        if (existing.job.idempotencyRequestHash !== requestHash) {
          return reply.code(409).send({ error: 'Idempotency-Key was already used for a different request' })
        }
        return { jobId, position: existing.position, already: true }
      }
      const partition = request.body.partition ?? 'shared'
      if (!['shared', 'reserved', 'dedicated'].includes(String(partition))) {
        return reply.code(400).send({ error: 'partition is invalid' })
      }
      if (partition !== 'shared' && (!principal || !hasHostedRole(principal, 'capacity-manage'))) {
        return reply.code(403).send({ error: 'capacity-manage role required for reserved/dedicated work' })
      }
      const serviceClass = request.body.serviceClass ?? 'standard'
      if (!['standard', 'latency', 'batch'].includes(String(serviceClass))) {
        return reply.code(400).send({ error: 'serviceClass is invalid' })
      }
      const deadlineAtMs = request.body.deadlineAt === undefined || request.body.deadlineAt === null
        ? null
        : Date.parse(String(request.body.deadlineAt))
      if (deadlineAtMs !== null && !Number.isFinite(deadlineAtMs)) {
        return reply.code(400).send({ error: 'deadlineAt must be an ISO timestamp' })
      }
      const priority = request.body.priority === undefined ? 0 : Number(request.body.priority)
      try {
        const { job, position } = store.submit(
          jobId,
          endpoint,
          request.body.request,
          principal?.principalId ?? request.ip,
          {
            tenantId,
            roomId: request.body.roomId === undefined ? null : String(request.body.roomId),
            allocationId: request.body.allocationId === undefined ? null : String(request.body.allocationId),
            sponsorshipId: request.body.sponsorshipId === undefined ? null : String(request.body.sponsorshipId),
            serviceClass: serviceClass as 'standard' | 'latency' | 'batch',
            partition: partition as 'shared' | 'reserved' | 'dedicated',
            correlationId: request.body.correlationId === undefined ? null : String(request.body.correlationId),
            deadlineAtMs,
            deadlineTrusted: Boolean(principal && hasHostedRole(principal, 'deadline-set')),
            priority,
            requestBytes,
            tenantWeight: principal?.limits.queueWeight ?? 1,
            maxTenantJobs: principal?.limits.maxQueuedJobs,
            maxTenantBytes: principal?.limits.maxQueuedBytes,
            estimatedWork: PROVE_ENDPOINTS[endpoint] ? 10 : 1,
            estimatedProofTimeMs: PROVE_ENDPOINTS[endpoint] ? 5 * 60_000 : 30_000,
            settlementMarginMs: 2 * 60_000,
            idempotencyRequestHash: requestHash,
          },
        )
        return { jobId: job.id, position, already: false }
      } catch (error) {
        return rejected(reply, error)
      }
    },
  )

  app.get<{ Params: { id: string } }>('/queue/v1/jobs/:id', async (request, reply) => {
    const principal = options.authenticate
      ? await hostedPrincipal(request, reply, 'api-key', 'job-read')
      : null
    if (options.authenticate ? !principal : !submitter(request, reply)) return
    const found = store.job(request.params.id)
    if (!found) return reply.code(404).send({ error: 'unknown job' })
    const { job, position } = found
    if (principal && job.tenantId !== principal.tenantId) {
      return reply.code(404).send({ error: 'unknown job' })
    }
    return {
      jobId: job.id,
      endpoint: job.endpoint,
      needsGpu: job.needsGpu,
      status: job.status,
      nodeId: job.nodeId,
      attempts: job.attempts,
      enqueuedAt: job.enqueuedAt,
      leasedAt: job.leasedAt,
      finishedAt: job.finishedAt,
      failure: job.failure,
      position,
    }
  })

  app.get<{ Params: { id: string } }>('/queue/v1/jobs/:id/result', async (request, reply) => {
    const principal = options.authenticate
      ? await hostedPrincipal(request, reply, 'api-key', 'job-read')
      : null
    if (options.authenticate ? !principal : !submitter(request, reply)) return
    const found = store.job(request.params.id)
    if (principal && (!found || found.job.tenantId !== principal.tenantId)) {
      return reply.code(404).send({ error: 'no result is available' })
    }
    const result = store.result(request.params.id)
    // 404 until DONE: "not yet" and "never existed" are deliberately the same
    // answer, so pollers need exactly one loop.
    if (result === null) return reply.code(404).send({ error: 'no result is available' })
    return result
  })

  /* ---------- prover-node surface ---------- */

  app.post<{ Body: { nodeId?: unknown; capabilities?: {
    gpu?: unknown
    partitions?: unknown
    allocationIds?: unknown
    tenantIds?: unknown
  } } }>(
    '/queue/v1/lease',
    async (request, reply) => {
      const principal = options.authenticate
        ? await hostedPrincipal(request, reply, 'node', 'prove-node')
        : null
      if (options.authenticate ? !principal : !node(request, reply)) return
      const nodeId = request.body?.nodeId
      if (typeof nodeId !== 'string' || nodeId.length === 0 || nodeId.length > 128) {
        return reply.code(400).send({ error: 'nodeId is required' })
      }
      if (principal && nodeId !== principal.principalId) {
        return reply.code(403).send({ error: 'nodeId must equal the authenticated node principal' })
      }
      const leased = store.lease(nodeId, {
        gpu: request.body?.capabilities?.gpu !== false,
        partitions: Array.isArray((request.body?.capabilities as Record<string, unknown> | undefined)?.partitions)
          ? (request.body!.capabilities as { partitions: Array<'shared' | 'reserved' | 'dedicated'> }).partitions
          : undefined,
        allocationIds: Array.isArray((request.body?.capabilities as Record<string, unknown> | undefined)?.allocationIds)
          ? (request.body!.capabilities as { allocationIds: string[] }).allocationIds
          : undefined,
        tenantIds: principal
          ? [principal.tenantId]
          : Array.isArray((request.body?.capabilities as Record<string, unknown> | undefined)?.tenantIds)
            ? (request.body!.capabilities as { tenantIds: string[] }).tenantIds
            : undefined,
      })
      if (!leased) return reply.code(204).send()
      return {
        jobId: leased.job.id,
        endpoint: leased.job.endpoint,
        needsGpu: leased.job.needsGpu,
        attempts: leased.job.attempts,
        leaseExpiresAt: leased.job.leaseExpiresAt,
        // The agent's `parseLeasedJob` (prover-node/agent) refuses any lease
        // whose owner correlation tuple is missing or empty - the job is then
        // dropped client-side and its lease silently burns an attempt until
        // the queue condemns it. Standalone jobs may carry no hosted
        // correlation id, so the job id (always a safe identifier) stands in.
        tenantId: leased.job.tenantId,
        roomId: leased.job.roomId,
        correlationId: leased.job.correlationId ?? leased.job.id,
        request: leased.request,
      }
    },
  )

  app.post<{ Params: { id: string }; Body: { nodeId?: unknown } }>(
    '/queue/v1/jobs/:id/heartbeat',
    async (request, reply) => {
      if (options.authenticate
        ? !await hostedPrincipal(request, reply, 'node', 'prove-node')
        : !node(request, reply)) return
      const nodeId = request.body?.nodeId
      if (typeof nodeId !== 'string') return reply.code(400).send({ error: 'nodeId is required' })
      if (options.authenticate) {
        const authorization = request.headers.authorization!
        const principal = await options.authenticate(authorization.slice('Bearer '.length).trim(), 'node')
        if (!principal || nodeId !== principal.principalId) return reply.code(403).send({ error: 'nodeId mismatch' })
      }
      try {
        const job = store.heartbeat(request.params.id, nodeId)
        return { jobId: job.id, leaseExpiresAt: job.leaseExpiresAt }
      } catch (error) {
        return rejected(reply, error)
      }
    },
  )

  app.post<{ Params: { id: string }; Body: { nodeId?: unknown; result?: unknown } }>(
    '/queue/v1/jobs/:id/complete',
    { bodyLimit: QUEUE_BODY_LIMIT_BYTES },
    async (request, reply) => {
      if (options.authenticate
        ? !await hostedPrincipal(request, reply, 'node', 'prove-node')
        : !node(request, reply)) return
      const nodeId = request.body?.nodeId
      if (typeof nodeId !== 'string') return reply.code(400).send({ error: 'nodeId is required' })
      if (options.authenticate) {
        const authorization = request.headers.authorization!
        const principal = await options.authenticate(authorization.slice('Bearer '.length).trim(), 'node')
        if (!principal || nodeId !== principal.principalId) return reply.code(403).send({ error: 'nodeId mismatch' })
      }
      if (request.body?.result === undefined) {
        return reply.code(400).send({ error: 'result is required' })
      }
      try {
        const { already, job } = store.complete(request.params.id, nodeId, request.body.result)
        return { jobId: job.id, status: job.status, already }
      } catch (error) {
        return rejected(reply, error)
      }
    },
  )

  app.post<{
    Params: { id: string }
    Body: { nodeId?: unknown; reason?: unknown; retryable?: unknown }
  }>('/queue/v1/jobs/:id/fail', async (request, reply) => {
    if (options.authenticate
      ? !await hostedPrincipal(request, reply, 'node', 'prove-node')
      : !node(request, reply)) return
    const nodeId = request.body?.nodeId
    if (typeof nodeId !== 'string') return reply.code(400).send({ error: 'nodeId is required' })
    if (options.authenticate) {
      const authorization = request.headers.authorization!
      const principal = await options.authenticate(authorization.slice('Bearer '.length).trim(), 'node')
      if (!principal || nodeId !== principal.principalId) return reply.code(403).send({ error: 'nodeId mismatch' })
    }
    const reason =
      typeof request.body?.reason === 'string' && request.body.reason.length > 0
        ? request.body.reason.slice(0, 2_000)
        : 'the prover node reported a failure without a readable reason'
    try {
      const job = store.fail(request.params.id, nodeId, reason, request.body?.retryable === true)
      return { jobId: job.id, status: job.status, attempts: job.attempts }
    } catch (error) {
      return rejected(reply, error)
    }
  })

  /* ---------- observability ---------- */

  app.get('/queue/v1/status', async (request, reply) => {
    if (options.authenticate) {
      const principal = await hostedPrincipal(request, reply, 'api-key', 'job-read')
      if (!principal) return
      const status = store.status()
      return {
        ...status,
        active: status.active.filter((entry) => entry.tenantId === principal.tenantId),
        waiting: status.waiting.filter((entry) => entry.tenantId === principal.tenantId),
      }
    }
    return store.status()
  })

  // Open exactly like /queue/v1/status: node labels, queue depths, ages and
  // sweep counters only - never request or result bytes. The standalone
  // process aliases the same output at /metrics for the Kurtosis scraper.
  app.get('/queue/v1/metrics', async (_request, reply) => {
    reply.header('content-type', METRICS_CONTENT_TYPE)
    return renderProveQueueMetrics(store)
  })
}

/**
 * The queue's Prometheus exposition, shared by `GET /queue/v1/metrics` and
 * the standalone process's root `GET /metrics` alias. `store.status()` sweeps
 * first, so expired leases are already requeued (and counted) by the time the
 * gauges are read.
 */
export function renderProveQueueMetrics(store: ProveQueueStore, nowMs = Date.now()): string {
  const status = store.status()
  const totals = store.metrics()
  const ageSeconds = (iso: string | null): number | null => {
    if (!iso) return null
    const parsed = Date.parse(iso)
    return Number.isFinite(parsed) ? Math.max(0, (nowMs - parsed) / 1_000) : null
  }
  const perNode = (pick: (node: (typeof status.nodes)[number]) => string | null): MetricSample[] =>
    status.nodes.flatMap((node) => {
      const value = ageSeconds(pick(node))
      return value === null ? [] : [{ labels: { node: node.nodeId }, value }]
    })
  const oldest = (stamps: Array<string | null>): number =>
    stamps.reduce((max, stamp) => Math.max(max, ageSeconds(stamp) ?? 0), 0)
  return renderMetrics([
    gauge('zkdeal_queue_jobs_active', status.active.length),
    gauge('zkdeal_queue_jobs_waiting', status.waiting.length),
    counter(
      'zkdeal_queue_node_jobs_done',
      status.nodes.map((node) => ({ labels: { node: node.nodeId }, value: node.jobsDone })),
    ),
    gauge('zkdeal_queue_node_last_lease_age_seconds', perNode((node) => node.lastLeaseAt)),
    gauge('zkdeal_queue_node_last_result_age_seconds', perNode((node) => node.lastResultAt)),
    gauge(
      'zkdeal_queue_oldest_waiting_age_seconds',
      oldest(status.waiting.map((entry) => entry.enqueuedAt)),
    ),
    gauge(
      'zkdeal_queue_active_lease_age_seconds',
      oldest(status.active.map((entry) => entry.startedAt)),
    ),
    counter('zkdeal_queue_leases_expired_total', totals.leasesExpired),
    counter('zkdeal_queue_jobs_pruned_total', totals.jobsPruned),
  ])
}
