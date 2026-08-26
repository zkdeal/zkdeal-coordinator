import type {
  CheckpointPlan,
  CheckpointPolicyDocument,
  CheckpointTrigger,
} from './demo-checkpoint-policy.js'
import type { ProvingSlotStatus } from './demo-proving-queue.js'
import type { DemoRoomSettingsDocument } from './demo-room-settings.js'

export type {
  CheckpointPlan,
  CheckpointPolicyDocument,
  CheckpointTrigger,
} from './demo-checkpoint-policy.js'
export type { ProvingSlotEntry, ProvingSlotStatus } from './demo-proving-queue.js'

export type DemoPhase =
  | 'DRAFT'
  | 'VALIDATED'
  | 'COLD_EXECUTING'
  | 'COLD_PROVING'
  | 'TEMPLATE_REGISTERED'
  | 'ROOM_READY'
  | 'DEPLOYED'
  | 'ACTIVE'
  | 'PROVING'
  | 'LOCALLY_VERIFIED'
  | 'L1_PENDING'
  | 'L1_ACCEPTED'
  | 'L1_FINALIZED'
  | 'CLOSED'
  | 'FAILED'

export type StateMode = 'INITIAL_WITNESS' | 'ROOM_LOCAL' | 'L1_MIRROR' | 'EXCLUDED'
export type AuthorizationMode = 'UNANIMOUS_APPROVERS' | 'VALIDITY_ONLY'

export interface DemoStateSelection {
  label: string
  slot: string
  value: string
  mode: StateMode
}

export interface DemoContractArtifact {
  contractName: string
  abi: readonly unknown[]
  bytecode?: string | { object?: string }
  deployedBytecode?: string | { object?: string }
  storageLayout?: {
    storage?: Array<{ label?: string; slot?: string; type?: string }>
  }
}

export interface DemoTemplateRequest {
  name: string
  presetId?: string
  contractMode?: 'artifact' | 'attached'
  artifact?: DemoContractArtifact
  attachedAddress?: string
  constructorArgs?: readonly unknown[]
  runtimeCode?: string
  selectedState?: DemoStateSelection[]
  authorizationMode?: AuthorizationMode
  participantCapacity?: number
  activeApprovers?: number
}

export interface DemoTemplate {
  id: string
  name: string
  presetId: string | null
  source: 'preset' | 'artifact' | 'attached'
  phase: DemoPhase
  createdAt: string
  updatedAt: string
  authorizationMode: AuthorizationMode
  participantCapacity: number
  activeApprovers: number
  selectedState: DemoStateSelection[]
  allowedSelectors: string[]
  runtimeCode: string | null
  artifact?: DemoContractArtifact
  constructorArgs?: readonly unknown[]
  attachedAddress?: string
  preparation?: DemoPreparedTemplate
  failure?: DemoFailure
}

/**
 * The duel a card template was actually prepared against, published so a
 * browser addresses the deployed contract instead of guessing one.
 *
 * WHY THIS IS ON THE WIRE. The duel's address is not cosmetic: a player's
 * envelope is signed with `to = duel`, and `proofDomain` - public input 0 of
 * every card circuit - is `keccak256(abi.encode(roomApplicationDomain,
 * duel)) % p`, written by `HiddenCardDuelV5`'s constructor. A console pointed
 * at the wrong address therefore signs for the wrong contract AND proves
 * against the wrong domain, and neither failure is visible until the guest
 * rejects the batch. These addresses are deliberately exempt from the response
 * redaction (`PUBLISHED_IN_FULL`); a truncated address is unusable.
 *
 * Every field is public deployment data. Nothing here is secret: the runtime
 * code, the stake terms and the seat owners are all already readable on the
 * chain the room settles to.
 */
export interface DemoCardRoom {
  duelAddress: string
  stakeTokenAddress: string
  proofAdapterAddress: string
  deckVerifierAddress: string
  handVerifierAddress: string
  /** The domain `HiddenCardDuelV5`'s constructor hashed into `proofDomain`. */
  roomApplicationDomain: string
  /** Decimal strings: JSON has no bigint and these are uint256 on the chain. */
  entryStake: string
  fundedAmount: string
  sessionExpiry: number
  participantCapacity: number
  /** Seat owners in participant-index order; the cold state funds exactly these. */
  duelistOwners: string[]
}

export interface DemoPreparedTemplate {
  templateId: string
  initialStateRoot: string
  policyHash: string
  proofProgramId: string
  proofSystemVersion: string
  initialApproverRoot: string
  initialActiveCount: number
  initialParticipantRoot: string
  initialParticipantCount: number
  canonicalColdTemplateData: string
  coldProofMs: number
  registrationTransaction: string
  contractAddress: string | null
  /**
   * Present only for a `card-duel` template, and then always: the cold template
   * id commits to these addresses, so they are as much a part of what was
   * prepared as the state root is.
   */
  cardRoom?: DemoCardRoom
  /**
   * Present only for the certified ERC-7540 preset. Addresses are persisted so
   * the coordinator can read both deployed runtimes back after a restart.
   */
  erc7540Room?: DemoErc7540Room
  /** Present only for the progressive, real ERC-4626 vault preset. */
  erc4626Room?: DemoErc4626Room
}

export interface DemoErc7540Room {
  vaultAddress: string
  assetTokenAddress: string
  aliceAddress: string
  bobAddress: string
  managerAddress: string
  participantCapacity: number
  runtimeBindings: Array<{ role: 'vault' | 'assetToken'; address: string }>
}

export interface DemoErc4626Room {
  vaultAddress: string
  assetTokenAddress: string
  investorAddress: string
  liquidityProviderAddress: string
  participantCapacity: number
  runtimeBindings: Array<{ role: 'vault' | 'assetToken'; address: string }>
}

export interface DemoRoomRequest {
  name: string
  templateId: string
  managed?: boolean
  /**
   * Whether a short readable suffix is appended to `name` so no two rooms are
   * confusable. Defaults to TRUE: two rooms called "Card duel live" is exactly
   * the ambiguity that made a duel look like it restarted for no reason. Set it
   * to false to keep the supplied name verbatim, in which case a name another
   * room already carries is refused rather than duplicated.
   */
  uniqueName?: boolean
  /**
   * L1 INCLUSION allowance for one batch, in blocks, recomputed from the chain
   * head at the start of every checkpoint. Bounded and defaulted per preset by
   * `demo-room-settings.ts`; a card room's default is 120 s of headroom.
   */
  deadlineBlocksFromStart?: number
  /**
   * Absolute L1 block by which this room's next batch must be included, when
   * the caller knows one - a pool allocation's `proofDeadlineBlock`, say. The
   * free demo path has none, and the policy's deadline arm simply does not fire
   * for a room that does not carry one.
   */
  proofDeadlineBlock?: number
}

export interface DemoAction {
  id: string
  actionId: string
  label: string
  actorId: string
  calldata: string
  /** Deterministic host fixture key used for this canned call. */
  fixtureSignerIndex?: number
  /** Per-transaction gas bound certified into the signed envelope. */
  gasLimit?: number
  block: 1 | 2
  acceptedAt: string
  /**
   * The browser-signed EIP-2718 envelope carrying `calldata`, when the client
   * signs its own moves. Present for a duel move; absent for a preset action
   * the prover host signs with its own fixture key.
   *
   * PRIVACY: an EIP-1559 envelope carries the already-public calldata and a
   * signature. Deck order, salts, hands and Merkle paths are not in it and
   * never reach this service.
   */
  signedTransaction?: string
  /**
   * Sequence number of the checkpoint that PROVED this move, or null while it
   * is still pending. The cursor is what stops a second checkpoint from
   * resubmitting the first one's moves.
   */
  checkpointSequence: number | null
}

export interface DemoRoom {
  id: string
  name: string
  templateId: string
  managed: boolean
  deadlineBlocksFromStart: number
  phase: DemoPhase
  createdAt: string
  updatedAt: string
  chainRoomId: string | null
  deploymentTransaction: string | null
  actions: DemoAction[]
  /** The latest ACCEPTED checkpoint, kept for callers that read only one. */
  checkpoint?: DemoCheckpoint
  /** Every checkpoint attempt on this room, oldest first, failures included. */
  checkpoints: DemoCheckpointRecord[]
  /**
   * Absolute L1 block by which the room's next batch must be included, when the
   * room was given one. The free demo path creates rooms with `createRoom`
   * and therefore has no pool allocation and no absolute deadline, so this is
   * normally null and the deadline arm of the policy simply never fires.
   */
  proofDeadlineBlock: string | null
  /** When the most recent checkpoint STARTED; the elapsed trigger reads it. */
  lastCheckpointAt: string | null
  /** Set when the demo operator explicitly closes the room to further actions. */
  closedAt: string | null
  failure?: DemoFailure
}

export interface DemoCheckpoint {
  proofMs: number
  localVerificationMs: number
  /**
   * The merged room transaction on L1, redacted by `publicDemoView` like every
   * other long identifier. `l1TransactionHash` carries the same value in full.
   */
  transaction: string
  /**
   * The same hash, deliberately exempt from redaction so a browser can show and
   * link the transaction a checkpoint actually landed in.
   */
  l1TransactionHash: string
  l1Block: string
  /** Inclusion block identity; required to retract a provisional acceptance. */
  l1BlockHash: string
  finalizedL1Block: string
  finalizedL1BlockHash: string
  /** The `batchIndex` this checkpoint advanced the room to on L1. */
  batchIndex: number
  postStateRoot: string
  explorerUrl: string | null
}

export type CheckpointOutcome = 'RUNNING' | 'ACCEPTED' | 'FAILED'

/** One checkpoint attempt: what it carried, when, and how it ended. */
export interface DemoCheckpointRecord {
  /** 1-based, in start order. */
  sequence: number
  trigger: CheckpointTrigger
  /** Exactly the actions this attempt proved, in acceptance order. */
  actionIds: string[]
  startedAt: string
  finishedAt: string | null
  outcome: CheckpointOutcome
  /** Milliseconds this attempt spent waiting for the single proving slot. */
  queueWaitMs: number
  result?: DemoCheckpoint
  failure?: DemoFailure
}

/** What `checkpointRoom` is being asked to prove. */
export interface DemoCheckpointRequest {
  sequence: number
  trigger: CheckpointTrigger
  actions: readonly DemoAction[]
}

export interface DemoFailure {
  explanation: string
  effect: string
  recovery: string
}

export interface DemoJob {
  id: string
  kind: 'PREPARE_TEMPLATE' | 'DEPLOY_ROOM' | 'CHECKPOINT_ROOM'
  subjectId: string
  phase: DemoPhase
  startedAt: string
  updatedAt: string
  finishedAt: string | null
  /**
   * Proofs ahead of this job in the single GPU's queue at the moment it was
   * enqueued: 0 when it started at once, 1 when one proof was already running.
   * Null for a job that needs no proof.
   */
  queuePosition: number | null
  failure?: DemoFailure
}

/** What `/demo/v1/rooms/:id/checkpoints` publishes about a live room. */
export interface DemoCheckpointStatus {
  roomId: string
  chainRoomId: string | null
  checkpoints: DemoCheckpointRecord[]
  plan: CheckpointPlan
  queue: ProvingSlotStatus
  policy: CheckpointPolicyDocument
}

export interface DemoSystemStatus {
  decision: 'READY' | 'STARTING' | 'DEGRADED'
  services: Array<{ id: string; label: string; status: 'READY' | 'STARTING' | 'FAILED' }>
  gpu: {
    name: string
    samplesSeconds: number[]
    medianSeconds: number
    maximumSeconds: number
    recommendedProofSeconds: number
    recommendedDeadlineBlocks: number
  } | null
  /**
   * `reference` is the short form for display; `address` is the whole thing,
   * exempt from redaction, because a viewer verifying the stand has to open it
   * in the explorer rather than read it.
   */
  contracts: Array<{ label: string; reference: string; address: string }>
  canary: {
    roomReference: string
    l1Block: string
    transactionReference: string
    /** The same transaction, whole, so the canary is verifiable and not merely shown. */
    l1TransactionHash: string
    explorerUrl: string | null
  } | null
  explorerUrl: string | null
  apiUrl: string | null
  /**
   * The RoomManager's deployment domain, exempt from redaction. A browser that
   * signs its own room transactions needs it to compute
   * `room_chain_id_v5(deploymentDomain, roomId)`; a truncated value would make
   * every envelope it signs be refused for the wrong chain id.
   */
  deploymentDomain: string | null
  /** The checkpoint policy's constants, so a client explains rather than guesses. */
  checkpointPolicy: CheckpointPolicyDocument
  /**
   * Per-room settings a client may choose, with their bounds and per-preset
   * defaults. Carried here as well as on `/demo/v1/room-settings` so a console
   * that already reads the system document needs no second fetch.
   */
  roomSettings: DemoRoomSettingsDocument
  /** The single GPU's queue at the moment of the read. */
  provingQueue: ProvingSlotStatus
}

export interface DemoPresetAction {
  id: string
  label: string
  actor: string
  calldata: string
  recommendedBlock: 1 | 2
  fixtureSignerIndex?: number
  gasLimit?: number
}

export interface DemoPresetPeer {
  id: string
  label: string
  description: string
  fixtureSignerIndex?: number
}

export interface DemoPreset {
  id: string
  name: string
  summary: string
  workload: string
  authorizationMode: AuthorizationMode
  participantCapacity: number
  activeApprovers: number
  allowedSelectors: string[]
  /**
   * Canned demo moves. Empty when the workload's calldata cannot honestly be
   * canned (a participant tuple, a Merkle proof and an inner proof are all
   * per-move), in which case the client supplies calldata and `addAction`
   * checks it against `allowedSelectors`.
   */
  actions: DemoPresetAction[]
  /** Human descriptions used by guided presenters; optional for old presets. */
  peers?: DemoPresetPeer[]
  initialStorage: DemoStateSelection[]
  /**
   * Prover-request shape overrides. Absent means the historical single-contract,
   * single-participant default in `baseSpec`.
   */
  registeredParticipants?: number
  touchedParticipants?: number
  touchedContracts?: number
  residentAccounts?: number
  /**
   * Prover-host capability tokens this preset requires. Preparation refuses,
   * naming them, when the host's `/v5/capabilities` does not report them all.
   */
  proverCapabilities?: readonly string[]
}

export interface DemoRuntime {
  systemStatus(): Promise<DemoSystemStatus>
  /**
   * Explorer link for an L1 transaction, or null when no explorer is
   * configured. Synchronous and optional: the control plane needs it to make a
   * room's own deployment transaction clickable, and only the runtime knows the
   * explorer's base URL.
   */
  transactionUrl?(hash: string): string | null
  /**
   * `reference` is the short form for display; `blockHash` and `explorerUrl`
   * are what make the feed verifiable rather than decorative.
   */
  recentBlocks(): Promise<
    Array<{
      number: string
      timestamp: string
      transactions: number
      reference: string
      blockHash: string
      explorerUrl: string | null
    }>
  >
  prepareTemplate(
    template: DemoTemplate,
    onPhase: (phase: DemoPhase) => Promise<void>,
  ): Promise<DemoPreparedTemplate>
  deployRoom(
    room: DemoRoom,
    template: DemoTemplate,
    onPhase: (phase: DemoPhase) => Promise<void>,
  ): Promise<{ chainRoomId: string; transaction: string }>
  /**
   * Prove and submit ONE batch. `request` names exactly the accepted moves this
   * attempt must carry and the 1-based checkpoint sequence; a runtime that
   * cannot produce that batch must throw rather than prove a different one.
   */
  checkpointRoom(
    room: DemoRoom,
    template: DemoTemplate,
    onPhase: (phase: DemoPhase) => Promise<void>,
    request?: DemoCheckpointRequest,
  ): Promise<DemoCheckpoint>
}

/** On-disk shape of the persisted demo control-plane state. */
export interface DemoSnapshot {
  version: 1
  templates: DemoTemplate[]
  rooms: DemoRoom[]
  jobs: DemoJob[]
  idempotency: Record<string, string>
}
