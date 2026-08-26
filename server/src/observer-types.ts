type Hex = `0x${string}`

export interface ObservedTransaction {
  index: number
  hash: Hex
  from: Hex
  to: Hex | null
  nonce: string
  type: string
  status: 'SUCCEEDED' | 'REVERTED'
  gasUsed: string
  selector: Hex | null
}

export interface ObservedBlock {
  blockNumber: string
  stateRoot: Hex
  transactionCommitment: Hex
  transactions: ObservedTransaction[]
}

export interface ObservedBatch {
  batchIndex: string
  startL2Block: string
  endL2Block: string
  preStateRoot: Hex
  postStateRoot: Hex
  batchDataHash: Hex
  canonicalDataHash: Hex
  approverRoot: Hex
  approverEpoch: string
  activeCount: string
  inboxCursor: string
  admissionCursor: string
  forcedCursor: string
  importCursor: string
  outboxEpoch: string
  withdrawalRoot: Hex | null
  close: boolean
  acceptedL1Block: string
  /** Hash of `acceptedL1Block` when this batch was indexed (v2 provenance). */
  acceptedL1BlockHash?: Hex
  acceptedL1Transaction: Hex
  acceptedAt: string
  blocks: ObservedBlock[]
}

export interface ObservedRoom {
  roomId: string
  /**
   * Monotonic write counter maintained by `ObserverStore.put` when a caller
   * opts into compare-and-set. Absent on archives written before the check
   * existed; treated as "no revision observed" by the CAS comparison.
   */
  revision?: string
  /**
   * Retention/bootstrap floor. Contiguity is validated from here rather than
   * from batch 1 / L2 block 1, so an indexer can trim old batches or bootstrap
   * against an already-running room. Absent means "the archive starts at the
   * beginning of the room", the only shape that used to be storable.
   */
  archiveFloor?: {
    /** First batch index retained; the batch before it is not required. */
    batchIndex: string
    /** Last L2 block of the batch preceding `batchIndex`. */
    priorL2Block: string
  }
  /**
   * Write-schema marker. 2 adds the provenance hashes (`headBlockHash`,
   * per-batch `acceptedL1BlockHash`, per-import `sourceBlockHash`) and the
   * `reorg` declaration. Optional so documents written before the field
   * existed stay readable; the observer write route requires 2 on every PUT.
   */
  schemaVersion?: number
  /** Hash of `latestObservedL1Block` when this observation was indexed. */
  headBlockHash?: Hex
  /**
   * Declared only on a rewrite after an L1 reorg. `latestObservedL1Block` may
   * decrease only when this is present AND the coordinator corroborates the
   * fork point against its own quorum L1 read - the declaration alone proves
   * nothing.
   */
  reorg?: {
    /** Last block shared by the old and new histories. */
    forkPointBlock: string
    forkPointHash: Hex
    detectedAtBlock: string
  }
  status: 'OPEN' | 'CLOSED'
  authorizationMode: 'UNANIMOUS_APPROVERS' | 'VALIDITY_ONLY'
  admissionSigner: Hex | null
  serviceBond: string
  minimumServiceBond: string
  omissionPenalty: string
  bondEpoch: string
  maximumAdmissionWindow: string
  /** Canonical-depth policy copied from the room's L1 configuration. */
  minimumDepositConfirmations: string
  latestObservedL1Block: string
  coldTemplateId: Hex
  coldTemplateDataHash: Hex
  policyHash: Hex
  participantRoot: Hex
  participantEpoch: string
  participantCount: string
  participantCapacity: string
  managedService?: {
    allocationId: Hex
    nodeId: Hex
    slotId: Hex
    status: 'RESERVED' | 'USED' | 'DISPOSED' | 'INTERRUPTED'
    startBlock: string
    proofDeadlineBlock: string
    priceEpoch: string
    lastHealthyBlock: string
    refundableBalance: string
  }
  supportedAssets: Hex[]
  approvers: Array<{
    index: string
    member: Hex
    joinedEpoch: string
    status: 'ACTIVE' | 'RETIRED'
  }>
  liabilities: Array<{
    asset: Hex
    pending: string
    controlled: string
    claimable: string
    paid: string
  }>
  imports: Array<{
    importId: string
    sourceBlock: string
    /** Hash of `sourceBlock` when this import was indexed (v2 provenance). */
    sourceBlockHash?: Hex
    source: Hex
    adapterId: Hex
    stateRoot: Hex
    consumedBatch: string | null
  }>
  deposits: Array<{
    inboxId: string
    depositor: Hex
    asset: Hex
    /** Net amount credited by the intake facet (after any token transfer fee). */
    amount: string
    beneficiary: Hex
    queuedAtBlock: string
    /** Hash of `queuedAtBlock` when this observation was indexed. */
    queuedAtBlockHash: Hex
    status: 'PENDING' | 'CONSUMED' | 'REFUNDED'
    consumedBatch: string | null
  }>
  withdrawals: Array<{
    outboxEpoch: string
    index: string
    asset: Hex
    amount: string
    recipient: Hex
    status: 'CLAIMABLE' | 'PAID'
    claimedL1Transaction: Hex | null
  }>
  admissions: Array<{
    admissionId: string
    transactionHash: Hex
    depositInboxId: string
    depositContentHash: Hex
    deadlineBlock: string
    maximumBatchIndex: string
    status: 'PENDING' | 'SUCCEEDED' | 'REVERTED' | 'REJECTED' | 'OMITTED'
    l2BlockNumber: string | null
    transactionIndex: number | null
  }>
  forcedTransactions: Array<{
    forcedId: string
    transactionHash: Hex
    deadlineBlock: string
    status: 'PENDING' | 'SUCCEEDED' | 'REVERTED' | 'REJECTED'
    l2BlockNumber: string | null
    transactionIndex: number | null
  }>
  applications: Array<{
    applicationId: string
    kind: 'AUCTION' | 'SHOP'
    contract: Hex
    status: string
    participantRoot: Hex
    participantCount: string
    participantCapacity: string
    metrics: Record<string, string>
  }>
  batches: ObservedBatch[]
}
