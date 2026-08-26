/**
 * Durable prove queue: `ProveQueueCore` mirrored onto DATA_DIR/prove-queue.
 *
 * Same discipline as `JsonFileStore`: temp-write + fsync + atomic rename, so
 * a crash or a concurrent reader never observes a half-written document. The
 * split between `index.json` and per-job files is deliberate - request and
 * result bodies are MB-scale witness JSON, and rewriting them on every
 * heartbeat would turn a 25-minute lease into constant disk churn. The index
 * holds only metadata; the bodies are written once each.
 *
 * Restart recovery is the core's own expiry rule: leases are reloaded as
 * they were, and the first sweep (run in the constructor) requeues any that
 * died while the process was down - an agent that survived the restart keeps
 * heartbeating its still-valid lease and never notices.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  ProveQueueCore,
  type ProveJobSubmission,
  type ProveQueueCoreOptions,
} from './queue-core.js'
import {
  ProveQueueRejection,
  isProveEndpoint,
  type ProveJob,
  type ProveNodeCapabilities,
  type ProveQueueNodeStats,
  type ProveQueueStatus,
} from './queue-types.js'

/** How long a finished job (and its MB-scale files) stays fetchable. */
export const DEFAULT_RESULT_TTL_MS = 2 * 60 * 60_000

/** Job ids come from `shortId('pj')`; anything else must not touch a path. */
const JOB_ID_RE = /^pj-[0-9a-f]{10}$/

export interface ProveQueueStoreOptions extends ProveQueueCoreOptions {
  resultTtlMs?: number
  /** Injectable clock, so tests can replay expiry and GC deterministically. */
  now?: () => number
}

interface IndexDocument {
  version: 1
  jobs: ProveJob[]
  nodes: ProveQueueNodeStats[]
}

export class ProveQueueStore {
  private readonly core: ProveQueueCore
  private readonly resultTtlMs: number
  private readonly now: () => number
  /** Sweep totals since this process started; `/queue/v1/metrics` reads them. */
  private leasesExpired = 0
  private jobsPruned = 0

  constructor(
    private readonly dir: string,
    options: ProveQueueStoreOptions = {},
  ) {
    this.core = new ProveQueueCore(options)
    this.resultTtlMs = options.resultTtlMs ?? DEFAULT_RESULT_TTL_MS
    this.now = options.now ?? Date.now
    mkdirSync(this.jobsDir, { recursive: true })
    const index = this.readIndex()
    if (index) this.core.restore(index.jobs, index.nodes)
    // Restart recovery: leases that died with the previous process are
    // requeued before the first request is answered.
    this.sweep()
  }

  private get indexPath(): string {
    return join(this.dir, 'index.json')
  }

  private get jobsDir(): string {
    return join(this.dir, 'jobs')
  }

  private jobFile(jobId: string, kind: 'request' | 'result'): string {
    if (!JOB_ID_RE.test(jobId)) {
      throw new Error(`invalid prove-queue job id ${JSON.stringify(jobId)}`)
    }
    return join(this.jobsDir, `${jobId}.${kind}.json`)
  }

  /** temp-write + fsync + atomic rename (same directory → rename is atomic). */
  private writeFileAtomic(path: string, value: unknown): void {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(value), 'utf8')
      const fd = openSync(tmp, 'r+')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, path)
    } catch (err) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        /* best effort cleanup */
      }
      throw err
    }
  }

  private readIndex(): IndexDocument | null {
    if (!existsSync(this.indexPath)) return null
    // Corruption must surface, not be swallowed into an empty queue.
    return JSON.parse(readFileSync(this.indexPath, 'utf8')) as IndexDocument
  }

  private persist(): void {
    const { jobs, nodes } = this.core.snapshot()
    this.writeFileAtomic(this.indexPath, { version: 1, jobs, nodes } satisfies IndexDocument)
  }

  private readBody(jobId: string, kind: 'request' | 'result'): unknown | null {
    const path = this.jobFile(jobId, kind)
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  }

  /** Expire dead leases and forget stale results; persists only on change. */
  sweep(): void {
    const nowMs = this.now()
    const expired = this.core.expireLeases(nowMs)
    const pruned = this.core.prune(nowMs, this.resultTtlMs)
    this.leasesExpired += expired.length
    this.jobsPruned += pruned.length
    for (const job of pruned) {
      for (const kind of ['request', 'result'] as const) {
        try {
          const path = this.jobFile(job.id, kind)
          if (existsSync(path)) unlinkSync(path)
        } catch {
          // A leaked file is recoverable garbage; a crashed sweep is not.
        }
      }
    }
    if (expired.length > 0 || pruned.length > 0) this.persist()
  }

  submit(
    id: string,
    endpoint: string,
    request: unknown,
    submitterId: string,
    submission: ProveJobSubmission = {},
  ): {
    job: ProveJob
    position: number
  } {
    this.sweep()
    if (!isProveEndpoint(endpoint)) {
      // Refused before any bytes land: a rejected submission must not leave
      // an orphaned request file behind.
      throw new ProveQueueRejection('BAD_ENDPOINT', `${endpoint} is not a proveable endpoint`)
    }
    // Body first, then the index: the index must never point at a request
    // file that is not yet on disk, or a crash strands an unrunnable job.
    const requestPath = this.jobFile(id, 'request')
    this.writeFileAtomic(requestPath, request)
    try {
      const job = this.core.submit(id, endpoint, submitterId, this.now(), submission)
      this.persist()
      return { job, position: this.core.position(id) ?? 0 }
    } catch (error) {
      // Capacity/deadline policy is evaluated by the core. A refusal after the
      // durable body write must not strand unindexed tenant bytes on disk.
      try {
        if (existsSync(requestPath)) unlinkSync(requestPath)
      } catch {
        /* best effort; the rejected job is never referenced by the index */
      }
      throw error
    }
  }

  job(jobId: string): { job: ProveJob; position: number | null } | null {
    this.sweep()
    const job = this.core.job(jobId)
    if (!job) return null
    return { job, position: this.core.position(jobId) }
  }

  /** The verbatim prover JSON, only once the job is DONE. */
  result(jobId: string): unknown | null {
    const job = this.core.job(jobId)
    if (!job || job.status !== 'DONE') return null
    return this.readBody(jobId, 'result')
  }

  lease(
    nodeId: string,
    capabilities: ProveNodeCapabilities,
  ): { job: ProveJob; request: unknown } | null {
    this.sweep()
    const job = this.core.lease(nodeId, capabilities, this.now())
    if (!job) return null
    const request = this.readBody(job.id, 'request')
    this.persist()
    return { job, request }
  }

  heartbeat(jobId: string, nodeId: string): ProveJob {
    this.sweep()
    const job = this.core.heartbeat(jobId, nodeId, this.now())
    this.persist()
    return job
  }

  complete(jobId: string, nodeId: string, result: unknown): { already: boolean; job: ProveJob } {
    this.sweep()
    // The result file is written only when the core is about to accept this
    // exact report: a non-holder's refusal must not leave bytes behind, and a
    // duplicate report (idempotent path) must not clobber the stored result.
    const current = this.core.job(jobId)
    if (current && current.status === 'LEASED' && current.nodeId === nodeId) {
      this.writeFileAtomic(this.jobFile(jobId, 'result'), result)
    }
    const outcome = this.core.complete(jobId, nodeId, this.now())
    this.persist()
    return outcome
  }

  fail(jobId: string, nodeId: string, reason: string, retryable: boolean): ProveJob {
    this.sweep()
    const job = this.core.fail(jobId, nodeId, reason, retryable, this.now())
    this.persist()
    return job
  }

  status(): ProveQueueStatus {
    this.sweep()
    return this.core.status()
  }

  /**
   * Process-lifetime sweep totals (deliberately NOT persisted: a Prometheus
   * counter is expected to reset on restart, and `rate()` absorbs that).
   */
  metrics(): { leasesExpired: number; jobsPruned: number } {
    return { leasesExpired: this.leasesExpired, jobsPruned: this.jobsPruned }
  }
}
