/**
 * The shared prove queue's vocabulary.
 *
 * One coordinator-side queue in front of N prover nodes. A submitter never
 * talks to a prover directly: it enqueues {endpoint, request}, and a prover
 * agent pulls the job, forwards it to ITS local prover, and reports the
 * verbatim prover JSON back. The queue therefore has to know exactly one
 * thing about the prover: which routes exist and which of them occupy the
 * single GPU slot - anything else stays opaque bytes.
 */

/**
 * The prover's POST surface, mirrored from
 * `prover-node/zkvm/crates/risc0/host/src/http.rs` (`serve_v5`). The value is
 * whether the route takes the host's `gpu_gate` permit. A job for any other
 * endpoint is refused at submission: the queue must never become an open
 * proxy that lets a submitter aim a prover node at an arbitrary path.
 */
// The '/v5/...' strings mirror the prover binary's HTTP surface, which
// changes only in the gated image ceremony - do not de-version them here.
export const PROVE_ENDPOINTS: Readonly<Record<string, boolean>> = {
  // Current VALIDITY_ONLY live-room bridge served by zkdeal-r0. It performs
  // CPU/native STF construction and validation before the existing v5 proof.
  '/hosting/v1/rooms/prepare-batch': false,
  '/v5/rooms/prepare': true,
  '/v5/rooms/execute': false,
  '/v5/rooms/prove': true,
  '/v5/rooms/verify': false,
  '/v5/cold-templates/execute': false,
  '/v5/cold-templates/prove': true,
  '/v5/cold-templates/verify': false,
  '/v5/data-availability/prepare': false,
  '/v5/data-availability/execute': false,
  '/v5/data-availability/prove': true,
  '/v5/data-availability/verify': false,
  '/v5/aggregates/execute': false,
  '/v5/aggregates/prove': true,
  '/v5/aggregates/verify': false,
  '/v5/receipts/wrap': true,
  '/v5/receipts/identity-p254': true,
  '/v5/receipts/groth16': true,
}

export function isProveEndpoint(endpoint: unknown): endpoint is string {
  return typeof endpoint === 'string' && endpoint in PROVE_ENDPOINTS
}

export type ProveJobStatus = 'QUEUED' | 'LEASED' | 'DONE' | 'FAILED'

export interface ProveJobFailure {
  reason: string
  /** Whether the failure condemned the job or only the attempt. */
  retryable: boolean
}

export interface ProveJob {
  /** `shortId('pj')` - the request/result files on disk are named after it. */
  id: string
  /** One of `PROVE_ENDPOINTS`; validated at submission, trusted afterwards. */
  endpoint: string
  /** Derived from the endpoint, never from the submitter. */
  needsGpu: boolean
  status: ProveJobStatus
  /** Who enqueued it - an observability label, not an authority. */
  submitterId: string
  /**
   * Hosting tenant that owns the request/result bytes. This is derived from
   * the authenticated principal by the HTTP layer; it is never trusted from
   * an arbitrary request body. Old queue snapshots are restored with
   * `submitterId` as the tenant so upgrades preserve ownership.
   */
  tenantId: string
  /** Room/allocation attribution used by admission, capacity and billing. */
  roomId: string | null
  allocationId: string | null
  sponsorshipId: string | null
  serviceClass: 'standard' | 'latency' | 'batch'
  partition: 'shared' | 'reserved' | 'dedicated'
  correlationId: string | null
  /** Hash binding an external Idempotency-Key to the complete submission. */
  idempotencyRequestHash: string | null
  /**
   * Trusted service deadline. Untrusted callers may submit a hint, but the
   * route only sets `deadlineTrusted` for a principal carrying the deadline
   * scope. The scheduler ignores untrusted deadlines for global urgency.
   */
  deadlineAt: string | null
  deadlineTrusted: boolean
  /** Larger values win ties inside one tenant; bounded by the route. */
  priority: number
  /** Serialized request bytes reserved against tenant/global queue caps. */
  requestBytes: number
  /** Positive scheduling share configured for the tenant tier. */
  tenantWeight: number
  /** Estimated normalized work charged to weighted fair service. */
  estimatedWork: number
  /** Proof duration used to derive latest-start urgency. */
  estimatedProofTimeMs: number
  /** L1 settlement/inclusion allowance subtracted from the deadline. */
  settlementMarginMs: number
  /** `deadline - estimatedProofTime - settlementMargin`, if deadline exists. */
  latestStartAt: string | null
  /** Stable origin for aging/starvation calculations, including retries. */
  agingStartedAt: string
  /** The node currently (or last) holding the lease; null while queued. */
  nodeId: string | null
  /** Leases taken so far. A job is condemned once this reaches the cap. */
  attempts: number
  enqueuedAt: string
  leasedAt: string | null
  finishedAt: string | null
  /** Wall-clock lease deadline; heartbeats push it forward. */
  leaseExpiresAt: string | null
  /** The last recorded failure, kept across a retry so the story survives. */
  failure: ProveJobFailure | null
}

export interface ProveQueueNodeStats {
  nodeId: string
  lastLeaseAt: string | null
  lastResultAt: string | null
  jobsDone: number
}

/**
 * One row of `GET /queue/v1/status` - the same observable-position shape
 * `ProvingSlot` publishes (`ProvingSlotEntry`), so a UI already reading the
 * demo's proving-slot status can read this without relearning the fields.
 * `kind` carries the endpoint and `subjectId` the submitter.
 */
export interface ProveQueueStatusEntry {
  id: string
  kind: string
  subjectId: string
  tenantId: string
  roomId: string | null
  allocationId: string | null
  sponsorshipId: string | null
  serviceClass: ProveJob['serviceClass']
  partition: ProveJob['partition']
  correlationId: string | null
  deadlineAt: string | null
  latestStartAt: string | null
  waitAgeMs: number
  starvationBoost: number
  enqueuedAt: string
  startedAt: string | null
  /** 0 while running (leased), 1 for the next in line, and so on. */
  position: number
}

/**
 * `ProvingSlotStatus` extended for many workers: `active` is a list because
 * CPU-only jobs are co-leasable, and `nodes` says who is actually pulling.
 */
export interface ProveQueueStatus {
  active: ProveQueueStatusEntry[]
  waiting: ProveQueueStatusEntry[]
  nodes: ProveQueueNodeStats[]
}

/** What a prover agent declares when it asks for work. */
export interface ProveNodeCapabilities {
  /** False lets a CPU-only worker pull execute/verify jobs. Default true. */
  gpu?: boolean
  /** Defaults to shared only for old agents. */
  partitions?: Array<ProveJob['partition']>
  /** Reservation allocation ids this worker is entitled to serve. */
  allocationIds?: string[]
  /** Dedicated tenant ids this worker is entitled to serve. */
  tenantIds?: string[]
}

export type ProveQueueRejectionCode =
  | 'UNKNOWN_JOB'
  | 'BAD_ENDPOINT'
  | 'NOT_LEASE_HOLDER'
  | 'BAD_STATE'
  | 'CAPACITY'
  | 'FORBIDDEN'

/**
 * A refusal with enough structure for the HTTP layer to pick a status code
 * without string-matching the message.
 */
export class ProveQueueRejection extends Error {
  constructor(
    readonly code: ProveQueueRejectionCode,
    message: string,
  ) {
    super(message)
    this.name = 'ProveQueueRejection'
  }
}
