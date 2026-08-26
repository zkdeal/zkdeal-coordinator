export type HostedRole =
  | 'hosting-admin'
  | 'tenant-admin'
  | 'room-operator'
  | 'job-submit'
  | 'job-read'
  | 'deadline-set'
  | 'usage-read'
  | 'withdrawal-read'
  | 'withdrawal-claim'
  | 'capacity-manage'
  | 'indexer-write'
  | 'l1-publish'
  | 'l1-liveness'
  | 'l1-room-submit'
  | 'l1-aggregate-submit'
  | 'l1-pool-sponsor'
  | 'l1-pool-finality-oracle'
  | 'l1-pool-beneficiary'
  | 'prove-node'

export type HostedPrincipalKind = 'api-key' | 'node' | 'service'
export type HostedOutboxAudience = 'tenant' | 'public-chain' | 'admin-internal'

export interface TenantLimits {
  queueWeight: number
  maxQueuedJobs: number
  maxQueuedBytes: number
  maxConcurrentJobs: number
  requestsPerMinute: number
  sseConnections: number
}

export interface HostedPrincipal {
  principalId: string
  tenantId: string
  kind: HostedPrincipalKind
  roles: HostedRole[]
  limits: TenantLimits
  /** Present only for short-lived wallet-authenticated allocation sessions. */
  walletSession?: {
    chainId: number
    allocationId: `0x${string}`
    roomId: string
    walletAddress: `0x${string}`
    authorityFactId: string
    authorityBlockHash: `0x${string}`
    expiresAt: string
  }
}

export interface CoordinatorFence {
  leaseName: string
  holderId: string
  token: bigint
  expiresAt: string
  delegation?: {
    component: string
    workerId: string
    token: bigint
  }
}

export interface AdmissionWalRecord {
  roomId: string
  admissionId: string
  tenantId: string
  transactionHash: `0x${string}`
  rawSignedTransaction: `0x${string}`
  sender: `0x${string}`
  request: {
    depositInboxId: string
    depositContentHash: `0x${string}`
    deadlineBlock: string
    maximumBatchIndex: string
    bondEpoch: string
    admissionFee: string
    signerAddress: `0x${string}`
  }
  receipt: Record<string, unknown> | null
  status: 'RESERVED' | 'COMMITTED' | 'LEASED' | 'ACKED' | 'CANCELLED'
  leaseOwner: string | null
  leaseExpiresAt: string | null
  createdAt: string
  updatedAt: string
}

export interface HostedOutboxEvent {
  eventId: string
  tenantId: string | null
  audience: HostedOutboxAudience
  topic: string
  aggregateId: string
  payload: unknown
  createdAt: string
}

export interface UsageEntry {
  usageId: string
  tenantId: string
  allocationId: string | null
  jobId: string | null
  roomId: string | null
  unit: string
  quantity: string
  observedAt: string
  idempotencyKey: string
  metadata: Record<string, unknown>
}

export interface AggregateBillingMember {
  memberIndex: number
  jobId: string
  roomId: string
  batchIndex: string
}

export interface BillingLedgerEntry {
  entryId: string
  /** Tenant that accepted the quote and owns the invoice. */
  tenantId: string
  /** Tenant whose proof work consumed the service; differs for sponsorships. */
  beneficiaryTenantId: string | null
  sponsorshipId: string | null
  allocationId: string | null
  jobId: string | null
  roomId: string | null
  aggregateHash: `0x${string}` | null
  memberIndex: number | null
  entryKind: 'CHARGE' | 'L1_ALLOCATION_CHARGE' | 'REORG_CREDIT' | 'REFUND' | 'SLA_CREDIT'
  unit: string
  quantity: string
  currency: string | null
  amount: string | null
  priceId: string | null
  priceEffectiveFrom: string | null
  slaPolicyId: string | null
  slaEffectiveFrom: string | null
  sourceFactId: string | null
  reversesEntryId: string | null
  idempotencyKey: string
  metadata: Record<string, unknown>
  createdAt: string
}

export interface BillingInvoice {
  invoiceId: string
  supersedesInvoiceId: string | null
  tenantId: string
  periodStart: string
  periodEnd: string
  currency: string
  ledgerHighWater: string
  netAmount: string
  lineItems: Array<{
    unit: string
    quantity: string
    amount: string
  }>
  createdAt: string
}

export interface CanonicalBlockInput {
  chainId: number
  number: string
  hash: `0x${string}`
  parentHash: `0x${string}`
  observedAt: string
}

export interface CapacityIntent {
  allocationId: string
  tenantId: string
  roomId: string
  desiredState: 'RESERVED' | 'ACTIVE' | 'RENEW' | 'HANDOFF' | 'RELEASED'
  providerNodeId: string | null
  deadlineAt: string | null
  idempotencyKey: string
  previousIdempotencyKey?: string | null
  metadata: Record<string, unknown>
}

export type CapacityExecutionStatus =
  | 'PENDING'
  | 'LEASED'
  | 'RETRY'
  | 'APPLIED'
  | 'FAILED'

/** Immutable provider request leased under the current coordinator epoch. */
export interface CapacityExecutionLease extends CapacityIntent {
  executionStatus: 'LEASED'
  appliedState: CapacityIntent['desiredState'] | null
  providerOperationId: string | null
  attempts: number
  maxAttempts: number
  leaseOwner: string
  leaseToken: string
  leaseExpiresAt: string
}

export type NodeLifecycleDesiredState = 'DRAINING' | 'RETIRED'
export type NodeLifecycleStatus =
  | 'PENDING'
  | 'LEASED'
  | 'RETRY'
  | 'VERIFYING'
  | 'APPLIED'
  | 'FAILED'
  | 'RECOVERY_REQUIRED'

export interface NodeLifecycleOperation {
  operationId: string
  principalId: string
  onchainNodeId: `0x${string}`
  desiredState: NodeLifecycleDesiredState
  idempotencyKey: string
  priorOperationId: string | null
  status: NodeLifecycleStatus
  providerOperationId: string | null
  providerEvidence: Record<string, unknown>
  canonicalFactId: string | null
  canonicalFactBlockHash: `0x${string}` | null
  attempts: number
  maxAttempts: number
  nextAttemptAt: string
  leaseOwner: string | null
  leaseToken: string | null
  leaseExpiresAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export interface NodeLifecycleExecutionLease extends NodeLifecycleOperation {
  status: 'LEASED'
  leaseOwner: string
  leaseToken: string
  leaseExpiresAt: string
}

/** Fixed, durable queue-pressure sample sent to the capacity provider once. */
export interface CapacityDemandSignal {
  signalId: string
  windowStartedAt: string
  queuedJobs: number
  queuedBytes: string
  estimatedProofTimeMs: string
  urgentJobs: number
  reservedJobs: number
  activeGpuResources: number
  desiredGpuResources: number
  staleProofProfiles: number
  earliestLatestStartAt: string | null
  scaleDownSafe: boolean
  leaseOwner: string
  leaseToken: string
  leaseExpiresAt: string
}

export interface HostedProofProfile {
  proofClass: string
  endpoint: string
  needsGpu: boolean
  /** Decimal work units used by the weighted-fair scheduler. */
  estimatedWork: string
  estimatedProofTimeMs: number
  settlementMarginMs: number
  evidence: Record<string, unknown>
  verifiedAt: string
}

export interface HostedProviderNodeAssignment {
  principalId: string
  providerId: string
  active: boolean
  gpu: boolean
  /** Stable physical GPU/accelerator identity shared by every principal using it. */
  gpuResourceId: string | null
  partitions: Array<'shared' | 'reserved' | 'dedicated'>
  tenantIds: string[]
  allocationIds: string[]
  proofClasses: string[]
  maxConcurrentJobs: number
  leaseTtlMs: number
}

export interface HostedProveJob {
  jobId: string
  /** Exact prior failed member job whose released sponsorship effect this retry supersedes. */
  retryOfJobId: string | null
  tenantId: string
  roomId: string | null
  allocationId: string | null
  sponsorshipId: string | null
  serviceClass: 'standard' | 'latency' | 'batch'
  correlationId: string | null
  partition: 'shared' | 'reserved' | 'dedicated'
  proofClass: string
  endpoint: string
  needsGpu: boolean
  requestObjectKey: string
  requestBytes: string
  estimatedWork: string
  estimatedProofTimeMs: string
  /** Explicit persisted interpretation of the nullable commercial columns. */
  billingMode: 'quoted' | 'telemetry-only'
  /** Immutable commercial quote accepted at queue admission, or null for telemetry-only work. */
  payerTenantId: string | null
  quotePriceId: string | null
  quoteUnitPrice: string | null
  quoteCurrency: string | null
  quoteEffectiveFrom: string | null
  quoteAcceptedAt: string | null
  maximumChargeAmount: string | null
  maximumChargeCurrency: string | null
  quoteSlaPolicyId: string | null
  quoteSlaEffectiveFrom: string | null
  deadlineAt: string | null
  latestStartAt: string | null
  deadlineTrusted: boolean
  /** Canonical AllocationUsed/AllocationRenewed provenance for global urgency. */
  deadlineChainId: string | null
  deadlineBlock: string | null
  latestStartBlock: string | null
  deadlineFactKey: string | null
  deadlineFactBlockHash: string | null
  settlementMarginMs: string
  priority: number
  tenantWeight: string
  attempts: number
  maxAttempts: number
  enqueuedAt: string
  agingStartedAt: string
  status: 'QUEUED' | 'LEASED' | 'DONE' | 'FAILED'
  leaseOwner: string | null
  leaseExpiresAt: string | null
  resultObjectKey: string | null
  resultDigest: string | null
  errorCode: string | null
}

export const DEFAULT_TENANT_LIMITS: TenantLimits = Object.freeze({
  queueWeight: 1,
  maxQueuedJobs: 64,
  maxQueuedBytes: 256 * 1024 * 1024,
  maxConcurrentJobs: 2,
  requestsPerMinute: 600,
  sseConnections: 8,
})

export function hasHostedRole(principal: HostedPrincipal, role: HostedRole): boolean {
  // Tenant administration is a bounded tenant-plane delegation, never a
  // wildcard for room operators, provider nodes, indexers, or global urgency.
  const tenantAdminImplied = new Set<HostedRole>([
    'job-submit', 'job-read', 'usage-read', 'withdrawal-read',
    'withdrawal-claim', 'capacity-manage',
  ])
  return principal.roles.includes(role)
    || (principal.roles.includes('tenant-admin') && tenantAdminImplied.has(role))
}

const PRINCIPAL_ROLE_MATRIX: Readonly<Record<HostedPrincipalKind, ReadonlySet<HostedRole>>> = {
  'api-key': new Set<HostedRole>([
    'tenant-admin', 'job-submit', 'job-read', 'usage-read',
    'withdrawal-read', 'withdrawal-claim', 'capacity-manage',
  ]),
  node: new Set<HostedRole>(['prove-node', 'room-operator']),
  service: new Set<HostedRole>([
    'hosting-admin', 'deadline-set', 'indexer-write', 'room-operator',
    'l1-publish', 'l1-liveness', 'l1-room-submit',
    'l1-aggregate-submit', 'l1-pool-sponsor', 'l1-pool-finality-oracle',
    'l1-pool-beneficiary',
    'job-read', 'usage-read', 'withdrawal-read', 'withdrawal-claim',
    'capacity-manage',
  ]),
}

export function validatePrincipalRoles(kind: HostedPrincipalKind, roles: HostedRole[]): void {
  const unique = new Set(roles)
  if (roles.length === 0 || unique.size !== roles.length) {
    throw new Error('principal roles must be a non-empty unique list')
  }
  const allowed = PRINCIPAL_ROLE_MATRIX[kind]
  if (!allowed || roles.some((role) => !allowed.has(role))) {
    throw new Error(`principal kind ${kind} cannot be granted one or more requested roles`)
  }
}
