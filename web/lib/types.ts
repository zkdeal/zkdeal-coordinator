export type Address = string

/**
 * The L2 sequencer interval is a hard-coded constant in
 * packages/room-client (startSequencer), not a per-room setting: nothing in
 * the room record, genesis, or L1 carries a chosen block time. Surfaced here
 * so the UI can display it as a protocol constant instead of pretending it is
 * configurable.
 */
export const SEQUENCER_BLOCK_TIME_MS = 500

export interface AbiInput {
  name: string
  type: string
  options?: string[]
}

export interface AbiFunction {
  name: string
  stateMutability: 'view' | 'nonpayable' | 'payable'
  inputs: AbiInput[]
  outputs: { name: string; type: string }[]
  description?: string
}

export interface ContractDef {
  address: Address
  name: string
  kind: 'ERC-4626' | 'DvP' | 'ERC-20' | 'Custom'
  standard: string
  abi: AbiFunction[]
  metrics?: Record<string, string>
}

export interface LiquidityPosition {
  token: string
  symbol: string
  amount: number
  provider: string
  /**
   * Fiat valuation. Deliberately optional and never synthesised: there is no
   * price source in this app, and a hard-coded 0 previously rendered as a
   * "$0.00 Escrowed ETH" headline for rooms holding real deposits.
   */
  usd?: number
}

export interface Peer {
  id: string
  address: Address
  role: 'sequencer' | 'member' | 'observer'
  latencyMs: number
  joinedAt: number
  self?: boolean
}

export interface DealBlock {
  height: number
  hash: string
  txCount: number
  gasUsed: number
  proposer: string
  timestamp: number
  /** pending = awaiting N-of-N ack; acked = fully signed; settled = on L1 */
  proof: 'pending' | 'acked' | 'settled'
  acks?: number
  ackTarget?: number
}

/** @deprecated use DealBlock */
export type RollupBlock = DealBlock

/**
 * Room parameters as far as they are actually KNOWN.
 *
 * Fields the coordinator registry does not publish are `undefined` and must
 * render as "unknown" - inventing a plausible default (challenge window 2,
 * chain 1, "public") is material misinformation during abort/finalize/claim.
 */
export interface RoomSettings {
  /**
   * L2 block interval. NOT configurable: the sequencer runs a fixed 500ms
   * interval (packages/room-client startSequencer), so this is a protocol
   * constant surfaced for display, not a room setting.
   */
  blockTimeMs: number
  /** Max members (≤ circuit MAX_MEMBERS=7). */
  memberTarget: number
  /** Per-member L1 deposit, wei as decimal string for UI. */
  depositEth: string
  /** Deal deadline unix seconds; undefined when unknown. */
  deadlineSec?: number
  /** L1 blocks after submitCheckpoint before finalize; undefined when unknown. */
  challengeWindowBlocks?: number
  /** Always Groth16 for production settlement certificate. */
  proofSystem: 'Groth16'
  /** On-chain calldata DA at settlement (PROTOCOL v2). */
  daLayer: 'Calldata'
  /** L1 chain id; only known for the attached room. */
  settlementChainId?: number
  /** FIFO at sequencer (join-order leader) - no MEV claim. */
  sequencerPolicy: 'fifo-join-order'
}

export type RoomStatus =
  | 'created'
  | 'open'
  | 'live'
  | 'challenge'
  | 'finalized'
  | 'aborted'
  | 'settled'
  | 'sealed'

export interface Room {
  id: string
  name: string
  description: string
  scenario: 'erc4626' | 'dvp' | 'generic'
  status: RoomStatus
  createdAt: number
  sealedAt?: number
  /** First member by L1 join order (FIFO sequencer). Null when unknown. */
  operator: Address | null
  settings: RoomSettings
  peers: Peer[]
  blocks: DealBlock[]
  liquidity: LiquidityPosition[]
  contracts: ContractDef[]
  /** Checkpoints submitted to L1 (usually 0 or 1 in a demo). */
  batchesSubmitted: number
  l1TxHash?: string
  depositWei?: string
  totalEscrowWei?: string
  peersOnline?: number
  /**
   * True when `name`/`description` come from this browser tab's memory (set at
   * creation) rather than any shared record. They are not persisted to the
   * coordinator or L1 and no other member sees them.
   */
  nameIsLocalAlias?: boolean
}

export const SCENARIO_LABEL: Record<Room['scenario'], string> = {
  erc4626: 'ERC-4626 Vault',
  dvp: 'DvP desk',
  generic: 'Generic channel',
}
