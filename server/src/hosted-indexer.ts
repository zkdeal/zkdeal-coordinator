import { readFileSync } from 'node:fs'
import type { Abi } from 'viem'
import {
  decodeEventLog,
  decodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  stringToHex,
} from 'viem'
import type { HostedRuntime } from './hosted-runtime.js'
import type { HostedRoomSemanticProjection,HostedSystemSemanticProjection } from './postgres-hosted-store.js'
import type { BlobArchiveCoordinator, IndexedBlobRequirement } from './blob-archive.js'
import { emitHostedTrace } from './structured-log.js'

/** Durable projection and room observation documents intentionally share one schema. */
export const HOSTED_INDEXER_PROJECTION_SCHEMA = 2
export const HOSTED_OBSERVATION_SCHEMA = 2

const ADMISSION_RECEIPT_TYPEHASH=keccak256(stringToHex(
  'AdmissionReceipt(uint64 roomId,uint64 admissionId,bytes32 transactionHash,uint64 depositInboxId,bytes32 depositContentHash,uint64 deadlineBlock,uint64 maximumBatchIndex,uint64 bondEpoch,uint256 admissionFee)',
))

export const ROOM_MANAGER_EVENT_KINDS = Object.freeze({
  AdmissionOmissionChallenged: 'admission',
  AdmissionReceiptDischarged: 'admission',
  AdmissionRecorded: 'admission',
  AggregateProofConfigured: 'configuration',
  AggregateMemberOutcome: 'aggregate',
  ApproverChangeQueued: 'approver',
  BatchAccepted: 'batch',
  BugOracleConfigured: 'configuration',
  ChallengePayoutClaimed: 'challenge',
  ColdTemplateDataPublished: 'capacity',
  DataAvailabilityAccepted: 'data-availability',
  DataAvailabilityConfigured: 'data-availability',
  DeadlineGracePurchased: 'renewal',
  DepositQueued: 'deposit',
  DepositRefunded: 'deposit',
  EscapeClaimRegistered: 'escape',
  EscapeClaimed: 'escape',
  EscapeOpened: 'escape',
  EscapePolicyBound: 'escape',
  ForcedOutcomeRecorded: 'forced-transaction',
  ForcedTransactionQueued: 'forced-transaction',
  FacetConfigured: 'configuration',
  Initialized: 'configuration',
  L1StateInputPublished: 'import',
  LivenessAttested: 'liveness',
  OmissionChallengeOpened: 'challenge',
  OmissionChallengeRepaired: 'challenge',
  OmissionChallengeSettled: 'challenge',
  ProtocolFeeAccrued: 'fee',
  ProtocolFeeConfigured: 'configuration',
  ProtocolFeeMadeClaimable: 'fee',
  ProtocolFeeReversed: 'fee',
  ProtocolFeesClaimed: 'fee',
  ProgramIndicted: 'indictment',
  RecoveryBatchAccepted: 'recovery',
  RoomClosedByRecovery: 'recovery',
  RoomCreated: 'room',
  RoomOwnershipAssigned: 'handoff',
  RoleAdminChanged: 'governance',
  RoleGranted: 'governance',
  RoleRevoked: 'governance',
  ServiceBondFunded: 'escrow',
  ServiceBondWithdrawn: 'escrow',
  TerminalBatchAccepted: 'batch',
  VerifierIndicted: 'indictment',
  WithdrawalClaimed: 'withdrawal',
  WithdrawalRootPublished: 'withdrawal',
  Upgraded: 'governance',
} as const)

export const ROOM_POOL_EVENT_KINDS = Object.freeze({
  AllocationDisposed: 'allocation',
  AllocationRenewed: 'renewal',
  AllocationReserved: 'allocation',
  AllocationUsed: 'allocation',
  CapacityProfileConfirmed: 'capacity',
  CapacityProfileRequested: 'capacity',
  ColdPreparationCancelled: 'capacity',
  ColdPreparationCompleted: 'capacity',
  ColdPreparationRequested: 'capacity',
  FinalizedCheckpointRecorded: 'finality',
  HostingFacetConfigured: 'configuration',
  Initialized: 'configuration',
  NodeAuthoritiesConfigured: 'node',
  NodeDrainStarted: 'node-lifecycle',
  NodeRegistered: 'node',
  NodeRetired: 'node-lifecycle',
  NodeStatusChanged: 'node',
  Paused: 'governance',
  PriceEpochPublished: 'pricing',
  RoleAdminChanged: 'governance',
  RoleGranted: 'governance',
  RoleRevoked: 'governance',
  RunningCreditAdded: 'escrow',
  RunningFeesSettled: 'metering',
  ServiceFeesClaimed: 'escrow',
  SlotConfigured: 'capacity',
  SponsoredEscrowFunded: 'sponsorship',
  TreasuryFeesClaimed: 'escrow',
  Unpaused: 'governance',
  Upgraded: 'governance',
} as const)

/** State-changing selectors whose calldata is retained beside emitted facts. */
export const ROOM_MANAGER_CALL_KINDS = Object.freeze({
  applyAggregateMember: 'aggregate',
  applyVerifiedBatch: 'batch',
  attestLiveness: 'liveness',
  challengeOmittedAdmission: 'challenge',
  claimChallengePayout: 'challenge',
  claimProtocolFees: 'fee',
  claimWithdrawal: 'withdrawal',
  closeInertRoom: 'recovery',
  configureFacets: 'configuration',
  createManagedRoom: 'room',
  createManagedRoomWithDataAvailability: 'room',
  createRoom: 'room',
  createRoomWithDataAvailability: 'room',
  dischargeAdmissionReceipt: 'admission',
  forceTransaction: 'forced-transaction',
  fundServiceBond: 'escrow',
  grantRole: 'governance',
  initialize: 'configuration',
  publishL1StateInput: 'import',
  purchaseDeadlineGrace: 'renewal',
  queueApproverChange: 'approver',
  queueDeposit: 'deposit',
  refundExpiredDeposit: 'deposit',
  renounceRole: 'governance',
  revokeRole: 'governance',
  setAggregateProofConfig: 'aggregate',
  setBugOracle: 'configuration',
  setProtocolFee: 'configuration',
  settleOmissionChallenge: 'challenge',
  submitAggregate: 'aggregate',
  submitBatch: 'batch',
  submitBatchWithDataAvailability: 'data-availability',
  submitRecoveryBatch: 'recovery',
  upgradeToAndCall: 'governance',
  validateBatch: 'batch',
  withdrawServiceBond: 'escrow',
} as const)

export const ROOM_POOL_CALL_KINDS = Object.freeze({
  beginNodeDrain: 'node-lifecycle',
  cancelColdPreparation: 'capacity',
  claimServiceFees: 'escrow',
  claimTreasuryFees: 'escrow',
  completeColdPreparation: 'capacity',
  configureHostingFacet: 'configuration',
  configureNodeAuthorities: 'node',
  configureSlot: 'capacity',
  confirmCapacityProfile: 'capacity',
  disposeRoom: 'allocation',
  grantRole: 'governance',
  initialize: 'configuration',
  markNodeStale: 'node',
  pause: 'governance',
  publishPriceEpoch: 'pricing',
  quarantineNode: 'node',
  recordFinalizedCheckpoint: 'finality',
  registerNode: 'node',
  registerPreset: 'capacity',
  renounceRole: 'governance',
  reportNodeHeartbeat: 'node',
  retireNode: 'node-lifecycle',
  requestCapacityProfile: 'capacity',
  requestColdPreparationForWithPermit: 'capacity',
  requestColdPreparationWithPermit: 'capacity',
  renewRoomForWithPermit: 'renewal',
  renewRoomWithPermit: 'renewal',
  reserveAndStartWithPermit: 'allocation',
  reserveAndStartForWithDataAvailabilityWithPermit: 'data-availability',
  reserveAndStartForWithPermit: 'sponsorship',
  reserveAndStartWithDataAvailabilityWithPermit: 'data-availability',
  reserveRoomForWithPermit: 'sponsorship',
  reserveRoomWithPermit: 'allocation',
  revokeRole: 'governance',
  setNodeDelegate: 'node',
  settleRunningFees: 'metering',
  startReservedRoom: 'allocation',
  startReservedRoomWithDataAvailability: 'data-availability',
  topUpRunningCredit: 'escrow',
  unpause: 'governance',
  upgradeToAndCall: 'governance',
} as const)

function jsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(jsonValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonValue(item)]),
    )
  }
  return value
}

export function loadContractAbi(path: string): Abi {
  const artifact = JSON.parse(readFileSync(path, 'utf8')) as { abi?: unknown }
  if (!Array.isArray(artifact.abi)) throw new Error(`contract artifact ${path} has no ABI`)
  return artifact.abi as Abi
}

export function mergeContractAbis(...abis: readonly Abi[]): Abi {
  const seen = new Set<string>()
  const merged = []
  for (const abi of abis) {
    for (const item of abi) {
      const key = JSON.stringify(item)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(item)
    }
  }
  return merged as Abi
}

export interface HostedIndexerSource {
  name: string
  address: `0x${string}`
  abi: Abi
  chainDerivedKinds: Readonly<Record<string, string>>
  calldataKinds: Readonly<Record<string, string>>
  /** Only the RoomManager source exposes the canonical observation views. */
  observation?: boolean
}

export interface HostedIndexerOptions {
  runtime: HostedRuntime
  sources: readonly HostedIndexerSource[]
  /** Independently queried initial floor, normally the deployment block. */
  bootstrapBlock: 'finalized' | `0x${string}`
  maxBlocksPerRun?: number
  maxRoomsPerReconciliation?: number
  blobArchive?: BlobArchiveCoordinator
}

interface IndexedBlock {
  chainId: number
  number: string
  hash: `0x${string}`
  parentHash: `0x${string}`
  timestamp: string
}

interface CachedTransaction {
  transaction: Record<string, unknown>
  verifiedSources: string[]
}

function tupleField(value: unknown, name: string, index: number): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && name in value) {
    return (value as Record<string, unknown>)[name]
  }
  return Array.isArray(value) ? value[index] : undefined
}

function hexArray(value: unknown, bytes: number, field: string): `0x${string}`[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty array`)
  const expression = new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`)
  return value.map((item) => {
    const text = String(item)
    if (!expression.test(text)) throw new Error(`${field} contains malformed bytes`)
    return text.toLowerCase() as `0x${string}`
  })
}

const decimalValue = (value: unknown): bigint | null => {
  const text=String(value ?? '')
  return /^(?:0|[1-9][0-9]*)$/.test(text) ? BigInt(text) : null
}

/** Pure portion of field-level room reconciliation, exported for drift tests. */
export function roomSemanticReconciliationErrors(
  roomState: unknown,
  assets: unknown,
  liabilities: unknown,
  projection: HostedRoomSemanticProjection,
  auxiliary?: {
    challengeEscrow:unknown
    dataAvailability:unknown
    managedAllocationId:unknown
  },
): string[] {
  const errors=[...projection.errors]
  if (!roomState || typeof roomState !== 'object' || Array.isArray(roomState)) {
    return ['roomState view did not return a named tuple',...errors]
  }
  const state=roomState as Record<string,unknown>
  const requireDecimal=(field:string):bigint|null => {
    const value=decimalValue(state[field])
    if (value===null) errors.push(`${field} is not a canonical unsigned decimal`)
    return value
  }
  const compare=(left:string,right:string) => {
    const lhs=requireDecimal(left),rhs=requireDecimal(right)
    if (lhs!==null && rhs!==null && lhs>rhs) errors.push(`${left} exceeds ${right}`)
  }
  compare('participantCount','participantCapacity')
  compare('approverChangeCursor','nextApproverChangeId')
  compare('inboxCursor','nextInboxId')
  compare('forcedCursor','nextForcedId')
  compare('importCursor','nextImportId')
  const importDepth=requireDecimal('minimumImportConfirmations')
  const depositDepth=requireDecimal('minimumDepositConfirmations')
  if (importDepth!==null && (importDepth<12n || importDepth>192n)) {
    errors.push('minimumImportConfirmations violates protocol bounds')
  }
  if (depositDepth!==null && depositDepth<1n) errors.push('minimumDepositConfirmations violates protocol floor')
  const roomStatus=requireDecimal('state')
  const authorizationMode=requireDecimal('authorizationMode')
  const closedAtBlock=requireDecimal('closedAtBlock')
  requireDecimal('bondEpoch')
  requireDecimal('minimumServiceBond')
  requireDecimal('omissionPenalty')
  requireDecimal('serviceBond')
  if (roomStatus!==null && roomStatus!==1n && roomStatus!==2n) errors.push('room state is not Open or Closed')
  if (authorizationMode!==null && authorizationMode>1n) errors.push('authorizationMode is outside the protocol enum')
  if (roomStatus===1n && closedAtBlock!==null && closedAtBlock!==0n) errors.push('open room has a nonzero closedAtBlock')
  if (roomStatus===2n && closedAtBlock!==null && closedAtBlock===0n) errors.push('closed room has no closedAtBlock')

  const before=(maximum:string|null,stateField:string,label:string,allowEqual=false) => {
    if (maximum===null) return
    const max=decimalValue(maximum),bound=requireDecimal(stateField)
    if (max!==null && bound!==null && (allowEqual ? max>bound : max>=bound)) {
      errors.push(`${label} exceeds canonical ${stateField}`)
    }
  }
  before(projection.cursors.admissionMax,'admissionCursor','AdmissionRecorded admissionId')
  before(projection.cursors.depositQueuedMax,'nextInboxId','DepositQueued inboxId')
  before(projection.cursors.depositRefundedMax,'nextInboxId','DepositRefunded inboxId')
  before(projection.cursors.forcedQueuedMax,'nextForcedId','ForcedTransactionQueued forcedId')
  before(projection.cursors.forcedOutcomeMax,'forcedCursor','ForcedOutcomeRecorded forcedId')
  before(projection.cursors.importMax,'nextImportId','L1StateInputPublished importId')
  before(projection.cursors.batchMax,'batchIndex','BatchAccepted batchIndex',true)
  before(projection.cursors.withdrawalRootMax,'outboxEpoch','WithdrawalRootPublished epoch',true)
  before(projection.cursors.withdrawalClaimMax,'outboxEpoch','WithdrawalClaimed epoch',true)

  if (!Array.isArray(assets)) errors.push('assets view did not return an array')
  else {
    const normalized=assets.map(String).map((asset) => asset.toLowerCase())
    if (normalized.some((asset) => !/^0x[0-9a-f]{40}$/.test(asset))) errors.push('assets view contains a malformed address')
    if (new Set(normalized).size!==normalized.length) errors.push('assets view contains duplicates')
    if (!Array.isArray(liabilities)) errors.push('liability projection did not return an array')
    else {
      const liabilityAssets:string[]=[]
      for (const entry of liabilities) {
        if (!entry || typeof entry!=='object' || Array.isArray(entry)) {
          errors.push('liability projection contains a malformed entry')
          continue
        }
        const record=entry as Record<string,unknown>
        const asset=String(record.asset ?? '').toLowerCase()
        liabilityAssets.push(asset)
        const value=record.liability
        if (!value || typeof value!=='object' || Array.isArray(value)) {
          errors.push(`liability ${asset || '<missing>'} has no named tuple`)
          continue
        }
        for (const field of ['pending','controlled','claimable','paid']) {
          if (decimalValue((value as Record<string,unknown>)[field])===null) {
            errors.push(`liability ${asset || '<missing>'} ${field} is not a canonical unsigned decimal`)
          }
        }
      }
      if (new Set(liabilityAssets).size!==liabilityAssets.length) errors.push('liability projection contains duplicate assets')
      if (normalized.length!==liabilityAssets.length
        || normalized.some((asset) => !liabilityAssets.includes(asset))) {
        errors.push('liability asset set does not exactly match the canonical assets view')
      }
    }
  }
  if (auxiliary) {
    if (decimalValue(auxiliary.challengeEscrow)===null) errors.push('challenge escrow is not a canonical unsigned decimal')
    const allocation=String(auxiliary.managedAllocationId ?? '').toLowerCase()
    if (!/^0x[0-9a-f]{64}$/.test(allocation)) errors.push('managed allocation id is malformed')
    const da=auxiliary.dataAvailability
    if (!da || typeof da!=='object' || Array.isArray(da)) errors.push('data-availability config has no named tuple')
    else {
      const config=da as Record<string,unknown>
      const policy=decimalValue(config.policy)
      const fallback=String(config.fallbackAuthority ?? '').toLowerCase()
      const program=String(config.equivalenceProgramId ?? '').toLowerCase()
      const zeroAddress=`0x${'00'.repeat(20)}`,zeroHash=`0x${'00'.repeat(32)}`
      if (policy===null || policy>2n) errors.push('data-availability policy is outside the protocol enum')
      if (!/^0x[0-9a-f]{40}$/.test(fallback) || !/^0x[0-9a-f]{64}$/.test(program)) {
        errors.push('data-availability authority or equivalence program is malformed')
      } else if (policy===0n && (fallback!==zeroAddress || program!==zeroHash)) {
        errors.push('calldata-required policy unexpectedly carries blob/fallback authority')
      } else if (policy===1n && (fallback!==zeroAddress || program===zeroHash)) {
        errors.push('blob-required policy has an invalid fallback/program binding')
      } else if (policy===2n && (fallback===zeroAddress || program===zeroHash)) {
        errors.push('blob-preferred policy lacks its fallback/program binding')
      }
    }
  }
  return [...new Set(errors)]
}

export function dataAvailabilityRequirement(input: {
  functionName: string
  functionArgs: readonly unknown[] | undefined
  eventArgs: Record<string, unknown>
  chainId: number
  transactionHash: `0x${string}`
  blockNumber: string
  blockHash: `0x${string}`
}): IndexedBlobRequirement | null {
  if (input.eventArgs.usedBlob !== true) return null
  const roomId = String(input.eventArgs.roomId ?? '')
  const batchIndex = String(input.eventArgs.batchIndex ?? '')
  if (!/^\d+$/.test(roomId) || !/^\d+$/.test(batchIndex)) {
    throw new Error('blob data-availability event has malformed room or batch identity')
  }
  const args = input.functionArgs ?? []
  let manifest: unknown
  if (input.functionName === 'submitBatchWithDataAvailability') {
    manifest = args[2]
  } else if (input.functionName === 'submitAggregate') {
    const aggregate = args[0]
    const members = tupleField(aggregate, 'members', 0)
    if (!Array.isArray(members)) throw new Error('aggregate calldata has no member list')
    const member = members.find((candidate) => {
      const candidateRoom = tupleField(candidate, 'roomId', 0)
      const submission = tupleField(candidate, 'submission', 1)
      const journal = tupleField(submission, 'journal', 0)
      return String(candidateRoom) === roomId && String(tupleField(journal, 'batchIndex', 1)) === batchIndex
    })
    manifest = tupleField(member, 'dataAvailability', 2)
  } else {
    throw new Error(`blob data-availability event came from unsupported calldata ${input.functionName}`)
  }
  const startValue = tupleField(manifest, 'blobStartIndex', 2)
  const blobStartIndex = Number(startValue)
  if (!Number.isSafeInteger(blobStartIndex) || blobStartIndex < 0 || blobStartIndex > 5) {
    throw new Error('indexed manifest has an invalid blobStartIndex')
  }
  return {
    chainId: input.chainId,
    transactionHash: input.transactionHash,
    blockNumber: input.blockNumber,
    blockHash: input.blockHash,
    roomId,
    batchIndex,
    blobStartIndex,
    versionedHashes: hexArray(tupleField(manifest, 'blobVersionedHashes', 3), 32, 'manifest versioned hashes'),
    commitments: hexArray(tupleField(manifest, 'commitments', 4), 48, 'manifest commitments'),
  }
}

/**
 * Canonical multi-contract L1 follower. Blocks, logs, transactions and view
 * results are accepted only after independent RPC agreement. Each source owns
 * a durable cursor, so a crash after journalling a block cannot skip its logs.
 */
export class HostedIndexer {
  private readonly maxBlocksPerRun: number
  private readonly maxRoomsPerReconciliation: number
  private readonly sources: readonly HostedIndexerSource[]

  constructor(private readonly options: HostedIndexerOptions) {
    this.maxBlocksPerRun = Math.max(1, Math.min(options.maxBlocksPerRun ?? 64, 1_000))
    this.maxRoomsPerReconciliation = Math.max(
      1,
      Math.min(options.maxRoomsPerReconciliation ?? 1_000, 10_000),
    )
    if (options.sources.length === 0) throw new Error('hosted indexer requires at least one contract source')
    const names = new Set<string>()
    const addresses = new Set<string>()
    for (const source of options.sources) {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(source.name)) throw new Error('indexer source name is invalid')
      if (!/^0x[0-9a-fA-F]{40}$/.test(source.address)) throw new Error(`indexer source ${source.name} address is invalid`)
      if (names.has(source.name)) throw new Error(`duplicate indexer source name ${source.name}`)
      if (addresses.has(source.address.toLowerCase())) throw new Error(`duplicate indexer source address ${source.address}`)
      names.add(source.name)
      addresses.add(source.address.toLowerCase())
    }
    if (options.sources.filter((source) => source.observation).length > 1) {
      throw new Error('only one indexer source may own room observations')
    }
    this.sources = options.sources
  }

  private async ensureAnchor(): Promise<void> {
    const agreed = await this.options.runtime.l1.agreedBlock(this.options.bootstrapBlock)
    const existing = await this.options.runtime.store.canonicalAnchor(agreed.chainId)
    if (existing) {
      if (existing.number !== agreed.number || existing.hash.toLowerCase() !== agreed.hash.toLowerCase()) {
        throw new Error('configured bootstrap anchor conflicts with durable anchor')
      }
      return
    }
    await this.options.runtime.store.setCanonicalAnchor(this.options.runtime.writableFence(), {
      chainId: agreed.chainId,
      number: agreed.number,
      hash: agreed.hash,
      verifiedSources: agreed.verifiedSources,
    })
  }

  private async commonAncestor(chainId: number, indexedNumber: string): Promise<string> {
    const floor = await this.options.runtime.store.canonicalFloor(chainId)
    if (!floor) throw new Error('canonical floor is unavailable')
    let cursor = BigInt(indexedNumber)
    while (cursor >= BigInt(floor.number)) {
      const local = cursor === BigInt(floor.number)
        ? { hash: floor.hash }
        : await this.options.runtime.store.canonicalBlockAt(chainId, cursor.toString())
      const remote = await this.options.runtime.l1.agreedBlock(`0x${cursor.toString(16)}`)
      if (local && local.hash.toLowerCase() === remote.hash.toLowerCase()) return cursor.toString()
      if (cursor === BigInt(floor.number)) break
      cursor -= 1n
    }
    throw new Error('L1 quorum disagrees below the finalized/archive floor')
  }

  private async decodeSourceBlock(
    source: HostedIndexerSource,
    block: IndexedBlock,
    transactionCache: Map<string, CachedTransaction>,
  ): Promise<Set<string>> {
    const agreement = await this.options.runtime.l1.agreedLogs({
      address: source.address,
      blockHash: block.hash,
    })
    const records: Parameters<HostedRuntime['store']['ingestIndexerRecords']>[1]['logs'] = []
    const facts: Parameters<HostedRuntime['store']['ingestIndexerRecords']>[1]['facts'] = []
    const blobRequirements: IndexedBlobRequirement[] = []
    const affectedRooms = new Set<string>()
    const traceContexts=new Map<string,Awaited<ReturnType<HostedRuntime['store']['l1TraceContextByTransactionHash']>>>()
    for (const raw of agreement.logs) {
      const data = String(raw.data ?? '') as `0x${string}`
      const topicValues = Array.isArray(raw.topics) ? raw.topics.map(String) : []
      if (topicValues.length === 0) throw new Error(`canonical ${source.name} log has no event topic`)
      const topics = topicValues as [`0x${string}`, ...`0x${string}`[]]
      const address = String(raw.address ?? '').toLowerCase() as `0x${string}`
      if (address !== source.address.toLowerCase()) throw new Error(`RPC returned a log outside ${source.name}`)
      const decoded = decodeEventLog({ abi: source.abi, data, topics, strict: true })
      const eventName = decoded.eventName
      if (typeof eventName !== 'string') throw new Error(`canonical ${source.name} log did not decode`)
      const factKind = source.chainDerivedKinds[eventName]
      if (!factKind) throw new Error(`${source.name} event ${eventName} has no chain-derived fact mapping`)
      const transactionHash = String(raw.transactionHash ?? '').toLowerCase() as `0x${string}`
      const logIndex = Number(BigInt(String(raw.logIndex ?? '0x0')))
      if (!/^0x[0-9a-f]{64}$/.test(transactionHash) || !Number.isSafeInteger(logIndex) || logIndex < 0) {
        throw new Error(`canonical ${source.name} log has malformed provenance`)
      }
      const args = jsonValue(decoded.args) as Record<string, unknown>
      const roomId = args.roomId === undefined ? null : String(args.roomId)
      if (roomId !== null) affectedRooms.add(roomId)

      let cached = transactionCache.get(transactionHash)
      if (!cached) {
        cached = await this.options.runtime.l1.agreedTransaction(transactionHash)
        transactionCache.set(transactionHash, cached)
      }
      const input = String(cached.transaction.input ?? '') as `0x${string}`
      if (!/^0x[0-9a-fA-F]{8,}$/.test(input)) throw new Error(`${source.name} event transaction has no decodable calldata`)
      const transactionTarget = String(cached.transaction.to ?? '').toLowerCase()
      const callSource = this.sources.find((candidate) => candidate.address.toLowerCase() === transactionTarget)
      // Anchoring the indexer at genesis on a chain where the protocol was
      // deployed replays the deployment transactions themselves, whose targets
      // are contract creations and unrelated addresses rather than configured
      // event sources. Failing closed is correct - an unknown target must never
      // be projected - but the operator needs to know the remedy is the
      // deployment anchor, not a code change.
      if (!callSource) {
        throw new Error(
          `${source.name} event transaction target ${transactionTarget} is not a configured source; `
          + 'set INDEXER_BOOTSTRAP_BLOCK to the deployment block rather than genesis '
          + 'so the replay starts after the deployment transactions',
        )
      }
      const call = decodeFunctionData({ abi: callSource.abi, data: input })
      if (!callSource.calldataKinds[call.functionName]) {
        throw new Error(`${callSource.name} calldata ${call.functionName} has no projection mapping`)
      }
      const calldata = jsonValue({
        source: callSource.name,
        functionName: call.functionName,
        callKind: callSource.calldataKinds[call.functionName],
        args: call.args,
      }) as Record<string, unknown>
      const verifiedSources = [...new Set([...agreement.verifiedSources, ...cached.verifiedSources])]
      if (eventName === 'DataAvailabilityAccepted') {
        const requirement = dataAvailabilityRequirement({
          functionName: call.functionName,
          functionArgs: call.args,
          eventArgs: args,
          chainId: block.chainId,
          transactionHash,
          blockNumber: block.number,
          blockHash: block.hash,
        })
        if (requirement) blobRequirements.push(requirement)
      }
      const event = {
        args,
        calldata,
        provenance: {
          source: source.name,
          chainId: block.chainId,
          blockNumber: block.number,
          blockHash: block.hash,
          transactionHash,
          logIndex,
          address,
          eventName,
          verifiedSources,
        },
      }
      records.push({ logIndex, transactionHash, address, eventName, decoded: event })
      const tenantId = roomId ? await this.options.runtime.store.roomTenant(block.chainId, roomId) : null
      let traceContext=traceContexts.get(transactionHash)
      if (!traceContexts.has(transactionHash)) {
        traceContext=await this.options.runtime.store.l1TraceContextByTransactionHash(transactionHash)
        traceContexts.set(transactionHash,traceContext)
      }
      emitHostedTrace({
        correlationId:traceContext?.correlationId ?? `indexer:${block.chainId}:${block.number}`,
        tenantId:traceContext?.tenantId ?? tenantId,roomId:traceContext?.roomId ?? roomId,
        operationId:traceContext?.operationId ?? null,component:'indexer',event:'fact.ingest',outcome:'succeeded',
      })
      facts.push({
        factKey: `${source.name}:${transactionHash}:${logIndex}:${eventName}`,
        factKind,
        roomId,
        tenantId,
        payload: event,
      })
    }
    await this.options.runtime.store.ingestIndexerRecords(this.options.runtime.writableFence(), {
      chainId: block.chainId,
      blockNumber: block.number,
      blockHash: block.hash,
      source: source.name,
      schemaVersion: HOSTED_INDEXER_PROJECTION_SCHEMA,
      logs: records,
      facts,
      blobRequirements,
    })
    if (this.options.blobArchive) {
      for (const requirement of blobRequirements) {
        try {
          await this.options.blobArchive.ensureArchived(requirement)
        } catch (error) {
          await this.options.runtime.store.completeBlobRequirement(
            this.options.runtime.writableFence(), requirement,
            error instanceof Error ? error.message.slice(0, 500) : 'blob archive verification failed',
          )
        }
      }
    }
    return affectedRooms
  }

  private async agreedView(
    source: HostedIndexerSource,
    block: IndexedBlock,
    functionName: string,
    args: readonly unknown[],
  ): Promise<{ value: unknown; verifiedSources: string[] }> {
    const data = encodeFunctionData({ abi: source.abi, functionName, args })
    const result = await this.options.runtime.l1.agreedCall({
      to: source.address,
      data,
      blockTag: { blockHash: block.hash, requireCanonical: true },
    })
    return {
      value: jsonValue(decodeFunctionResult({ abi: source.abi, functionName, data: result.data })),
      verifiedSources: result.verifiedSources,
    }
  }

  private async semanticFieldErrors(
    source:HostedIndexerSource,block:IndexedBlock,roomId:string,
    projection:HostedRoomSemanticProjection,
    current:{
      roomState:unknown;dataAvailability:unknown;managedAllocationId:unknown;challengeEscrow:unknown
    },
  ):Promise<{ errors:string[];verifiedSources:string[] }> {
    const errors:string[]=[]
    const evidence=new Set<string>()
    const view=async (functionName:string,args:readonly unknown[]) => {
      const result=await this.agreedView(source,block,functionName,args)
      result.verifiedSources.forEach((provider) => evidence.add(provider))
      return result.value
    }
    const equalHex=(left:unknown,right:unknown) => String(left ?? '').toLowerCase()===String(right ?? '').toLowerCase()
    const nonZeroHash=(value:unknown) => /^0x[0-9a-f]{64}$/.test(String(value ?? '').toLowerCase())
      && !/^0x0{64}$/.test(String(value ?? '').toLowerCase())
    const allocationEvents=new Set(['RoomOwnershipAssigned','AllocationUsed','AllocationRenewed','AllocationDisposed'])
    const latestAllocationFact=projection.latestFacts.filter((fact) => allocationEvents.has(fact.eventName))
      .sort((left,right) => BigInt(left.blockNumber)===BigInt(right.blockNumber)
        ? left.eventName.localeCompare(right.eventName) : BigInt(left.blockNumber)>BigInt(right.blockNumber) ? -1 : 1)[0]
    for (const fact of projection.latestFacts) {
      const args=fact.args
      if (fact.eventName==='AdmissionRecorded') {
        const id=decimalValue(args.admissionId)
        if (id===null || !nonZeroHash(await view('admissionOutcomeHash',[BigInt(roomId),id]))) {
          errors.push('latest AdmissionRecorded has no matching on-chain admission outcome hash')
        }
      } else if (fact.eventName==='DepositQueued' || fact.eventName==='DepositRefunded') {
        const id=decimalValue(args.inboxId)
        if (id===null) {
          errors.push(`${fact.eventName} inboxId is malformed`)
          continue
        }
        const entry=await view('depositEntry',[BigInt(roomId),id])
        if (fact.eventName==='DepositQueued') {
          if (!equalHex(tupleField(entry,'beneficiary',1),args.beneficiary)
            || !equalHex(tupleField(entry,'asset',2),args.asset)
            || String(tupleField(entry,'amount',3))!==String(args.amount)
            || String(tupleField(entry,'queuedAtBlock',4))!==fact.blockNumber) {
            errors.push('latest DepositQueued fields drift from canonical depositEntry')
          }
        } else if (tupleField(entry,'refunded',6)!==true) {
          errors.push('latest DepositRefunded is not marked refunded in canonical depositEntry')
        }
      } else if (fact.eventName==='ForcedTransactionQueued') {
        const id=decimalValue(args.forcedId)
        if (id===null) {
          errors.push('latest ForcedTransactionQueued forcedId is malformed')
          continue
        }
        const entry=await view('forcedEntry',[BigInt(roomId),id])
        if (!equalHex(tupleField(entry,'transactionHash',0),args.transactionHash)
          || String(tupleField(entry,'deadlineBlock',1))!==String(args.deadlineBlock)) {
          errors.push('latest ForcedTransactionQueued fields drift from canonical forcedEntry')
        }
      } else if (fact.eventName==='ForcedOutcomeRecorded') {
        const id=decimalValue(args.forcedId)
        if (id===null || !nonZeroHash(await view('forcedOutcomeHash',[BigInt(roomId),id]))) {
          errors.push('latest ForcedOutcomeRecorded has no matching on-chain outcome hash')
        }
      } else if (fact.eventName==='WithdrawalRootPublished') {
        const epoch=decimalValue(args.outboxEpoch)
        if (epoch===null || !equalHex(await view('withdrawalRoot',[BigInt(roomId),epoch]),args.withdrawalRoot)) {
          errors.push('latest WithdrawalRootPublished drifts from canonical withdrawalRoot')
        }
      } else if (fact.eventName==='WithdrawalClaimed') {
        const epoch=decimalValue(args.outboxEpoch),index=decimalValue(args.index)
        if (epoch===null || index===null || await view('isWithdrawalClaimed',[BigInt(roomId),epoch,index])!==true) {
          errors.push('latest WithdrawalClaimed is not marked claimed in canonical state')
        }
      } else if (fact.eventName==='OmissionChallengeOpened') {
        const callArgs=fact.calldata?.functionName==='challengeOmittedAdmission'
          && Array.isArray(fact.calldata.args) ? fact.calldata.args : null
        const receipt=callArgs?.[1]
        const receiptFields={
          admissionId:decimalValue(tupleField(receipt,'admissionId',0)),
          transactionHash:String(tupleField(receipt,'transactionHash',1) ?? '').toLowerCase(),
          depositInboxId:decimalValue(tupleField(receipt,'depositInboxId',2)),
          depositContentHash:String(tupleField(receipt,'depositContentHash',3) ?? '').toLowerCase(),
          deadlineBlock:decimalValue(tupleField(receipt,'deadlineBlock',4)),
          maximumBatchIndex:decimalValue(tupleField(receipt,'maximumBatchIndex',5)),
          bondEpoch:decimalValue(tupleField(receipt,'bondEpoch',6)),
          admissionFee:decimalValue(tupleField(receipt,'admissionFee',7)),
        }
        const decimalFields=[
          receiptFields.admissionId,receiptFields.depositInboxId,receiptFields.deadlineBlock,
          receiptFields.maximumBatchIndex,receiptFields.bondEpoch,receiptFields.admissionFee,
        ]
        const penalty=decimalValue(args.penalty),escrow=decimalValue(current.challengeEscrow)
        if (!receipt || decimalFields.some((value) => value===null)
          || !/^0x[0-9a-f]{64}$/.test(receiptFields.transactionHash)
          || !/^0x[0-9a-f]{64}$/.test(receiptFields.depositContentHash)) {
          errors.push('OmissionChallengeOpened calldata does not carry a canonical admission receipt')
          continue
        }
        const receiptHash=keccak256(encodeAbiParameters([
          { type:'bytes32' },{ type:'uint64' },{ type:'uint64' },{ type:'bytes32' },
          { type:'uint64' },{ type:'bytes32' },{ type:'uint64' },{ type:'uint64' },
          { type:'uint64' },{ type:'uint256' },
        ],[
          ADMISSION_RECEIPT_TYPEHASH,BigInt(roomId),receiptFields.admissionId!,receiptFields.transactionHash as `0x${string}`,
          receiptFields.depositInboxId!,receiptFields.depositContentHash as `0x${string}`,
          receiptFields.deadlineBlock!,receiptFields.maximumBatchIndex!,receiptFields.bondEpoch!,receiptFields.admissionFee!,
        ]))
        const challenge=await view('omissionChallenge',[BigInt(roomId),receiptHash])
        if (!equalHex(tupleField(challenge,'challenger',0),args.challenger)
          || String(tupleField(challenge,'openedAtBlock',1))!==fact.blockNumber
          || String(tupleField(challenge,'depositInboxId',2))!==String(receiptFields.depositInboxId)
          || String(tupleField(challenge,'maximumBatchIndex',3))!==String(receiptFields.maximumBatchIndex)
          || !equalHex(tupleField(challenge,'transactionHash',4),args.transactionHash)
          || String(tupleField(challenge,'penalty',5))!==String(args.penalty)
          || String(tupleField(challenge,'admissionId',6))!==String(args.admissionId)
          || penalty===null || penalty<1n || escrow===null || escrow<penalty) {
          errors.push('OmissionChallengeOpened fields or custody escrow drift from canonical challenge state')
        }
      } else if (fact.eventName==='OmissionChallengeRepaired' || fact.eventName==='OmissionChallengeSettled') {
        const receiptHash=String(args.receiptHash ?? '').toLowerCase()
        if (!/^0x[0-9a-f]{64}$/.test(receiptHash)) {
          errors.push(`${fact.eventName} receiptHash is malformed`)
          continue
        }
        const challenge=await view('omissionChallenge',[BigInt(roomId),receiptHash])
        if (String(tupleField(challenge,'challenger',0)).toLowerCase()!==`0x${'00'.repeat(20)}`
          || String(tupleField(challenge,'penalty',5))!=='0') {
          errors.push(`${fact.eventName} did not clear canonical challenge escrow state`)
        }
      } else if (fact.eventName==='ChallengePayoutClaimed') {
        const payee=String(args.payee ?? '').toLowerCase()
        if (!/^0x[0-9a-f]{40}$/.test(payee)
          || String(await view('challengePayoutOf',[BigInt(roomId),payee]))!=='0') {
          errors.push('ChallengePayoutClaimed did not clear canonical payout custody')
        }
      } else if (fact.eventName==='ServiceBondFunded') {
        const amount=decimalValue(args.amount),eventEpoch=decimalValue(args.bondEpoch)
        const currentEpoch=decimalValue(tupleField(current.roomState,'bondEpoch',36))
        if (amount===null || amount<1n || eventEpoch===null || currentEpoch===null || eventEpoch!==currentEpoch) {
          errors.push('ServiceBondFunded fields drift from canonical bond epoch/custody state')
        }
      } else if (fact.eventName==='ServiceBondWithdrawn') {
        const amount=decimalValue(args.amount)
        if (amount===null || amount<1n || String(tupleField(current.roomState,'state',0))!=='2'
          || String(tupleField(current.roomState,'serviceBond',40))!=='0'
          || String(current.challengeEscrow)!=='0') {
          errors.push('ServiceBondWithdrawn conflicts with closed-room zero bond/escrow custody state')
        }
      } else if (fact.eventName==='RoomClosedByRecovery') {
        if (String(tupleField(current.roomState,'state',0))!=='2'
          || tupleField(current.roomState,'closedByRecovery',43)!==true) {
          errors.push('RoomClosedByRecovery fact conflicts with canonical room state')
        }
      } else if (fact.eventName==='DataAvailabilityConfigured') {
        if (String(tupleField(current.dataAvailability,'policy',0))!==String(args.policy)
          || !equalHex(tupleField(current.dataAvailability,'fallbackAuthority',1),args.fallbackAuthority)
          || !equalHex(tupleField(current.dataAvailability,'equivalenceProgramId',2),args.equivalenceProgramId)) {
          errors.push('DataAvailabilityConfigured fields drift from canonical room config')
        }
      } else if (fact.eventName==='DataAvailabilityAccepted') {
        const policy=String(tupleField(current.dataAvailability,'policy',0))
        const usedBlob=args.usedBlob===true,usedFallback=args.usedAuthorizedFallback===true
        if (String(args.configuredPolicy)!==policy || !nonZeroHash(args.statementHash)
          || (usedBlob && policy==='0') || (usedBlob && usedFallback)
          || (usedFallback && policy!=='2')) {
          errors.push('DataAvailabilityAccepted fields violate the canonical room policy')
        }
      } else if (fact.eventName==='RoomOwnershipAssigned' || fact.eventName==='AllocationUsed'
        || fact.eventName==='AllocationRenewed' || fact.eventName==='AllocationDisposed') {
        if (fact!==latestAllocationFact) continue
        const expected=fact.eventName==='AllocationRenewed' ? args.newAllocationId
          : fact.eventName==='RoomOwnershipAssigned' ? args.managedAllocationId : args.allocationId
        if (!equalHex(current.managedAllocationId,expected)) {
          errors.push(`${fact.eventName} allocation id drifts from canonical managedAllocationId`)
        }
        if (fact.eventName==='AllocationDisposed' && String(tupleField(current.roomState,'state',0))!=='2') {
          errors.push('AllocationDisposed fact exists while the canonical room remains open')
        }
      }
    }
    return { errors,verifiedSources:[...evidence] }
  }

  private async systemFieldErrors(
    block:IndexedBlock,projection:HostedSystemSemanticProjection,
  ):Promise<{ errors:string[];verifiedSources:string[] }> {
    const source=this.sources.find((candidate) => candidate.name==='room-pool')
    if (!source) return {
      errors:projection.latestNodeFacts.length>0
        ? ['node lifecycle facts exist without a configured RoomPool state source'] : [],
      verifiedSources:[],
    }
    const errors:string[]=[]
    const evidence=new Set<string>()
    const nodes=new Map<string,unknown>()
    for (const fact of projection.latestNodeFacts) {
      const nodeId=String(fact.args.nodeId ?? '').toLowerCase()
      if (!/^0x[0-9a-f]{64}$/.test(nodeId)) {
        errors.push(`${fact.eventName} has a malformed nodeId`)
        continue
      }
      let state=nodes.get(nodeId)
      if (!state) {
        const result=await this.agreedView(source,block,'nodeState',[nodeId])
        result.verifiedSources.forEach((provider) => evidence.add(provider))
        state=result.value
        nodes.set(nodeId,state)
      }
      const status=String(tupleField(state,'status',4))
      const pending=String(tupleField(state,'pendingProfileHash',3)).toLowerCase()
      const profileNonce=String(tupleField(state,'profileNonce',7))
      const active=decimalValue(tupleField(state,'activeAllocations',8))
      if (fact.eventName==='NodeRegistered') {
        if (String(tupleField(state,'serviceAccount',0)).toLowerCase()!==String(fact.args.serviceAccount).toLowerCase()
          || String(tupleField(state,'boundAccount',1)).toLowerCase()!==String(fact.args.boundAccount).toLowerCase()
          || String(tupleField(state,'heartbeatTimeoutBlocks',5))!==String(fact.args.heartbeatTimeoutBlocks)) {
          errors.push('NodeRegistered fields drift from canonical nodeState')
        }
      } else if (fact.eventName==='NodeStatusChanged') {
        if (status!==String(fact.args.status)) errors.push('NodeStatusChanged status drifts from canonical nodeState')
      } else if (fact.eventName==='NodeDrainStarted') {
        const started=decimalValue(fact.args.activeAllocations)
        const eventNonce=decimalValue(fact.args.profileNonce),currentNonce=decimalValue(profileNonce)
        if (!['6','7'].includes(status) || pending!==`0x${'00'.repeat(32)}`
          || eventNonce===null || currentNonce===null || currentNonce<eventNonce
          || active===null || started===null || active>started) {
          errors.push('NodeDrainStarted fields drift from canonical draining nodeState')
        }
      } else if (fact.eventName==='NodeRetired') {
        if (status!=='6' || pending!==`0x${'00'.repeat(32)}` || active!==0n) {
          errors.push('NodeRetired conflicts with canonical terminal nodeState')
        }
      } else if (fact.eventName==='CapacityProfileRequested') {
        const eventNonce=decimalValue(fact.args.profileNonce),currentNonce=decimalValue(profileNonce)
        if (eventNonce===null || currentNonce===null || currentNonce<eventNonce
          || (currentNonce===eventNonce && status==='3'
            && pending!==String(fact.args.profileHash).toLowerCase())) {
          errors.push('CapacityProfileRequested fields drift from canonical nodeState')
        }
      } else if (fact.eventName==='CapacityProfileConfirmed') {
        const eventNonce=decimalValue(fact.args.profileNonce),currentNonce=decimalValue(profileNonce)
        if (eventNonce===null || currentNonce===null || currentNonce<eventNonce
          || (currentNonce===eventNonce && status==='3' && pending!==`0x${'00'.repeat(32)}`)) {
          errors.push('CapacityProfileConfirmed fields drift from canonical nodeState')
        }
      }
    }
    return { errors,verifiedSources:[...evidence] }
  }

  private async reconcileRooms(block: IndexedBlock, seed: Set<string>): Promise<number> {
    const source = this.sources.find((candidate) => candidate.observation)
    if (!source) return 0
    const [roomIds,systemProjection] = await Promise.all([
      this.options.runtime.store.leaseRoomReconciliations(
        this.options.runtime.writableFence(),block.chainId,[...seed],this.maxRoomsPerReconciliation,
      ),
      this.options.runtime.store.systemSemanticProjection(block.chainId,block.number),
    ])
    const systemFields=await this.systemFieldErrors(block,systemProjection)
    const systemErrors=[...new Set([...systemProjection.errors,...systemFields.errors])]
    let completed = 0
    for (const roomId of roomIds) {
      try {
        const [
          roomState,assets,allocationId,dataAvailability,challengeEscrow,
          domainSeparator,deploymentDomain,semanticProjection,
        ] = await Promise.all([
          this.agreedView(source, block, 'roomState', [BigInt(roomId)]),
          this.agreedView(source, block, 'assets', [BigInt(roomId)]),
          this.agreedView(source, block, 'managedAllocationId', [BigInt(roomId)]),
          this.agreedView(source, block, 'dataAvailabilityConfig', [BigInt(roomId)]),
          this.agreedView(source, block, 'challengeEscrow', [BigInt(roomId)]),
          this.agreedView(source,block,'DOMAIN_SEPARATOR',[]),
          this.agreedView(source,block,'deploymentDomain',[]),
          this.options.runtime.store.roomSemanticProjection(block.chainId,roomId,block.number),
        ])
        const assetValues = Array.isArray(assets.value) ? assets.value : []
        const liabilities = []
        const evidence = new Set([
          ...roomState.verifiedSources,
          ...assets.verifiedSources,
          ...allocationId.verifiedSources,
          ...dataAvailability.verifiedSources,
          ...challengeEscrow.verifiedSources,
          ...domainSeparator.verifiedSources,
          ...deploymentDomain.verifiedSources,
          ...systemFields.verifiedSources,
        ])
        for (const asset of assetValues) {
          const liability = await this.agreedView(source, block, 'liability', [BigInt(roomId), asset])
          liabilities.push({ asset, liability: liability.value })
          liability.verifiedSources.forEach((item) => evidence.add(item))
        }
        const semanticFields=await this.semanticFieldErrors(source,block,roomId,semanticProjection,{
          roomState:roomState.value,dataAvailability:dataAvailability.value,
          managedAllocationId:allocationId.value,challengeEscrow:challengeEscrow.value,
        })
        semanticFields.verifiedSources.forEach((item) => evidence.add(item))
        const errors = roomSemanticReconciliationErrors(
          roomState.value,assets.value,liabilities,semanticProjection,{
            challengeEscrow:challengeEscrow.value,dataAvailability:dataAvailability.value,
            managedAllocationId:allocationId.value,
          },
        )
        errors.push(...semanticFields.errors)
        errors.push(...systemErrors)
        const tenantId=await this.options.runtime.store.roomTenant(block.chainId, roomId)
        await this.options.runtime.store.putRoomObservation(this.options.runtime.writableFence(), {
          chainId: block.chainId,
          roomId,
          tenantId,
          schemaVersion: HOSTED_OBSERVATION_SCHEMA,
          headBlock: block.number,
          headHash: block.hash,
          document: {
            roomId,
            headBlock: block.number,
            headHash: block.hash,
            roomState: roomState.value,
            assets: assets.value,
            liabilities,
            managedAllocationId: allocationId.value,
            dataAvailability: dataAvailability.value,
            challengeEscrow: challengeEscrow.value,
            domainSeparator:domainSeparator.value,
            deploymentDomain:deploymentDomain.value,
            semanticProjection:{
              schemaVersion:1,cursors:semanticProjection.cursors,
              fieldCheckedEvents:semanticProjection.latestFacts.map((fact) => fact.eventName),
              checkedAtBlock:block.number,checkedAtHash:block.hash,
            },
            provenance: { verifiedSources: [...evidence] },
          },
          reconciliationErrors: [...new Set(errors)],
        })
        await this.options.runtime.store.completeRoomReconciliation(this.options.runtime.writableFence(), {
          chainId: block.chainId,
          roomId,
          headBlock: block.number,
          headHash: block.hash,
          error: errors.length > 0 ? errors.join('; ') : null,
        })
        emitHostedTrace({
          correlationId:`reconcile:${block.chainId}:${block.number}:${roomId}`,tenantId,roomId,
          component:'reconciler',event:'room.reconcile',outcome:errors.length===0 ? 'succeeded' : 'failed',
        })
        if (errors.length === 0) completed += 1
      } catch (error) {
        await this.options.runtime.store.completeRoomReconciliation(this.options.runtime.writableFence(), {
          chainId: block.chainId,
          roomId,
          headBlock: block.number,
          headHash: block.hash,
          error: error instanceof Error ? error.message.slice(0, 500) : 'unknown reconciliation error',
        })
        emitHostedTrace({
          correlationId:`reconcile:${block.chainId}:${block.number}:${roomId}`,roomId,
          component:'reconciler',event:'room.reconcile',outcome:'failed',
        })
      }
    }
    if (systemErrors.length>0) {
      throw new Error(`system semantic reconciliation failed: ${systemErrors.slice(0,5).join('; ')}`)
    }
    return completed
  }

  async reconcileOnce(): Promise<{ head: string; reconciledRooms: number }> {
    const latest = await this.options.runtime.l1.agreedBlock('latest')
    const head = await this.options.runtime.store.canonicalHead(latest.chainId)
    if (!head) throw new Error('canonical journal has no head to reconcile')
    const block = await this.options.runtime.l1.agreedBlock(`0x${BigInt(head.number).toString(16)}`)
    if (block.hash.toLowerCase() !== head.hash.toLowerCase()) {
      throw new Error('reconciliation head does not match the independent L1 quorum')
    }
    return { head: block.number, reconciledRooms: await this.reconcileRooms(block, new Set()) }
  }

  async runOnce(): Promise<{ from: string; to: string; blocks: number; reconciledRooms: number }> {
    await this.ensureAnchor()
    await this.options.blobArchive?.recoverPending(100)
    const latest = await this.options.runtime.l1.agreedBlock('latest')
    const current = await this.options.runtime.store.canonicalHead(latest.chainId)
    const anchor = await this.options.runtime.store.canonicalAnchor(latest.chainId)
    if (!anchor) throw new Error('canonical anchor disappeared')
    const ancestor = current ? await this.commonAncestor(latest.chainId, current.number) : anchor.number
    const durableCursors = await this.options.runtime.store.indexerCursors(latest.chainId)
    const cursorBySource = new Map(durableCursors.map((cursor) => [cursor.source, BigInt(cursor.blockNumber)]))
    const minimumCursor = this.sources.reduce((minimum, source) => {
      const currentCursor = cursorBySource.get(source.name) ?? BigInt(anchor.number)
      return currentCursor < minimum ? currentCursor : minimum
    }, BigInt(ancestor))
    const start = minimumCursor + 1n
    const end = [BigInt(latest.number), start + BigInt(this.maxBlocksPerRun) - 1n]
      .reduce((left, right) => left < right ? left : right)
    const transactionCache = new Map<string, CachedTransaction>()
    const affectedRooms = new Set<string>()
    let processed = 0
    let lastBlock: IndexedBlock | null = null
    for (let number = start; number <= end; number += 1n) {
      const block = await this.options.runtime.l1.agreedBlock(`0x${number.toString(16)}`)
      const local = await this.options.runtime.store.canonicalBlockAt(block.chainId, block.number)
      if (!local || local.hash.toLowerCase() !== block.hash.toLowerCase()) {
        await this.options.runtime.store.recordCanonicalBlocks(this.options.runtime.writableFence(), [{
          chainId: block.chainId,
          number: block.number,
          hash: block.hash,
          parentHash: block.parentHash,
          observedAt: new Date(Number(BigInt(block.timestamp)) * 1_000).toISOString(),
        }])
      }
      for (const source of this.sources) {
        if ((cursorBySource.get(source.name) ?? BigInt(anchor.number)) >= number) continue
        const rooms = await this.decodeSourceBlock(source, block, transactionCache)
        rooms.forEach((roomId) => affectedRooms.add(roomId))
        cursorBySource.set(source.name, number)
      }
      lastBlock = block
      processed += 1
    }
    const observationHead = lastBlock
      ?? (current ? await this.options.runtime.l1.agreedBlock(`0x${BigInt(current.number).toString(16)}`) : null)
    const reconciledRooms = observationHead ? await this.reconcileRooms(observationHead, affectedRooms) : 0

    const finalized = await this.options.runtime.l1.agreedBlock('finalized')
    const finalizedLocal = await this.options.runtime.store.canonicalBlockAt(finalized.chainId, finalized.number)
    const everySourceIndexed = this.sources.every(
      (source) => (cursorBySource.get(source.name) ?? BigInt(anchor.number)) >= BigInt(finalized.number),
    )
    if (everySourceIndexed && finalizedLocal?.hash.toLowerCase() === finalized.hash.toLowerCase()) {
      if (!await this.options.runtime.store.blobArchiveReadyThrough(finalized.chainId, finalized.number)) {
        throw new Error('canonical blob archive is incomplete through the agreed finalized block')
      }
      await this.options.runtime.store.advanceCanonicalFloor(this.options.runtime.writableFence(), {
        chainId: finalized.chainId,
        number: finalized.number,
        hash: finalized.hash,
        verifiedSources: finalized.verifiedSources,
      })
    }
    return {
      from: processed > 0 ? start.toString() : ancestor,
      to: lastBlock?.number ?? ancestor,
      blocks: processed,
      reconciledRooms,
    }
  }
}
