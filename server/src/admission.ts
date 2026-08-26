import { timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  createPublicClient,
  encodeAbiParameters,
  http,
  keccak256,
  recoverTransactionAddress,
  type Hex,
  type TransactionSerialized,
  zeroHash,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { RateLimiter } from './quota.js'
import { isDevChain } from './config.js'
import { assertProductionConfirmationDepth } from './l1-confirmation-policy.js'
import {
  canonicalRoomId,
  ObserverRevisionConflictError,
  type ObservedRoom,
} from './observer.js'
import type { AdmissionWalRecord } from './hosted-types.js'
import { recordAdmissionRecovered } from './metrics.js'

const MAX_RAW_TRANSACTION_BYTES = 128 * 1024

/**
 * Minimum length of the operator credential that gates admission. Matches the
 * demo control surface so a short, guessable token cannot be configured.
 */
export const MIN_ADMISSION_TOKEN_LENGTH = 16

/**
 * Signing a receipt commits `omissionPenalty` of the room service bond until
 * the batch coordinator drains the queue, so the queue is bounded: a saturated
 * queue is refused rather than silently accumulating unfulfillable promises.
 */
export const DEFAULT_MAX_PENDING_PER_ROOM = 256

/**
 * A receipt whose deadline is one block away cannot be met by any prover, yet
 * it is immediately challengeable. Require a configured lead over the L1 head.
 */
export const DEFAULT_MINIMUM_DEADLINE_LEAD_BLOCKS = 8n

/**
 * The observer archive is written by an external indexer. Refuse to sign
 * against a view of L1 the archive has not caught up with.
 */
export const DEFAULT_MAX_ARCHIVE_LAG_BLOCKS = 8n

/** Per-IP and per-sender admission burst controls. */
const ADMISSION_IP_BURST = 120
const ADMISSION_IP_PER_SEC = 20
const ADMISSION_SENDER_BURST = 128
const ADMISSION_SENDER_PER_SEC = 4

export interface AdmissionReceipt {
  roomId: string
  admissionId: string
  transactionHash: Hex
  depositInboxId: string
  depositContentHash: Hex
  deadlineBlock: string
  maximumBatchIndex: string
  bondEpoch: string
  admissionFee: string
  signature: Hex
}

export interface AdmissionRequest {
  rawSignedTransaction: Hex
  depositInboxId: string
  deadlineBlock: string
  maximumBatchIndex: string
  admissionFee?: string
}

export interface AdmissionTypedData {
  domain: {
    name: 'ZkdealRoom'
    version: '6'
    chainId: number
    verifyingContract: Hex
  }
  types: {
    AdmissionReceipt: Array<{ name: string; type: string }>
  }
  primaryType: 'AdmissionReceipt'
  message: {
    roomId: bigint
    admissionId: bigint
    transactionHash: Hex
    depositInboxId: bigint
    depositContentHash: Hex
    deadlineBlock: bigint
    maximumBatchIndex: bigint
    bondEpoch: bigint
    admissionFee: bigint
  }
}

export interface AdmissionSigner {
  readonly address: Hex
  signTypedData(data: AdmissionTypedData): Promise<Hex>
}

/** Explicit local/dev signer. Hosted production constructs a remote signer. */
export function localAdmissionSigner(privateKey: Hex): AdmissionSigner {
  const account = privateKeyToAccount(privateKey)
  return {
    address: account.address,
    signTypedData: (data) => account.signTypedData(data),
  }
}

export interface QueuedTransaction {
  receipt: AdmissionReceipt
  rawSignedTransaction: Hex
  sender: Hex
}

/** Deposit inbox row as the RoomManager itself stores it. */
export interface ChainDepositEntry {
  depositor: Hex
  beneficiary: Hex
  asset: Hex
  amount: bigint
  queuedAtBlock: bigint
  consumed: boolean
  refunded: boolean
}

/**
 * The small, safety-relevant projection admission needs. Standalone mode
 * supplies a complete `ObservedRoom`; hosted mode supplies this projection
 * from PostgreSQL. Keeping the reader async prevents a replica-local file
 * archive from becoming a hidden hosted authority.
 */
export interface AdmissionRoomObservation {
  roomId: string
  revision?: string
  status: ObservedRoom['status']
  authorizationMode: ObservedRoom['authorizationMode']
  admissionSigner: ObservedRoom['admissionSigner']
  serviceBond: string
  minimumServiceBond: string
  omissionPenalty: string
  bondEpoch: string
  maximumAdmissionWindow: string
  minimumDepositConfirmations: string
  latestObservedL1Block: string
  deposits: ObservedRoom['deposits']
  admissions: ObservedRoom['admissions']
  batches: Array<Pick<ObservedRoom['batches'][number], 'batchIndex' | 'admissionCursor'>>
  /** Direct reconciled roomState fields used when old batch rows are pruned. */
  latestBatchIndex?: string
  admissionCursor?: string
}

export interface AdmissionObservationReader {
  get(roomId: string): AdmissionRoomObservation | null | Promise<AdmissionRoomObservation | null>
  /** Present only for the explicitly standalone file archive. */
  put?(room: ObservedRoom, expectedRevision?: string | null): unknown
}

export interface AdmissionServiceConfig {
  chainId: number
  roomManager: Hex
  signer: AdmissionSigner
  observer: AdmissionObservationReader
  /**
   * Operator-issued bearer credential. Every admission request must present
   * it: without one, an anonymous caller can make this key sign slashable
   * receipts until the whole service bond is committed.
   */
  operatorToken: string
  /**
   * Live L1 head. Deadlines are validated against the chain, not against the
   * archive's `latestObservedL1Block`, which nothing in this process refreshes.
   */
  latestL1Block: () => Promise<bigint>
  /** Re-reads the event block before a deposit-backed receipt is signed. */
  canonicalL1BlockHash?: (blockNumber: bigint) => Promise<Hex | null>
  /**
   * Chain-first deposit read. The signed `depositContentHash` is built from
   * these values, never from the archive row: an indexer-edited amount would
   * otherwise make this key sign an unsatisfiable receipt - a guaranteed
   * omission and bond slash.
   */
  chainDepositEntry?: (roomId: bigint, inboxId: bigint) => Promise<ChainDepositEntry | null>
  /**
   * Chain-first `roomState().admissionCursor` read capping the derived
   * admission id. An inflated archive cursor would both slash (ids the
   * contract can never accept) and permanently wedge admission through the
   * never-lower issued-id high-water.
   */
  chainAdmissionCursor?: (roomId: bigint) => Promise<bigint>
  /** Operator policy floor for `admissionFee`; the client value is not trusted. */
  minimumAdmissionFee?: bigint
  minimumDeadlineLeadBlocks?: bigint
  maximumArchiveLagBlocks?: bigint
  maximumPendingPerRoom?: number
  /**
   * Durable last-issued-id record. Defaults to an in-memory store, which is
   * sufficient for a single-process run but does not survive a restart.
   */
  issuedIds?: AdmissionIdStore
  /**
   * Hosted authority. `reserve` must durably commit the exact raw transaction
   * and immutable request under a live fencing token before this service is
   * allowed to create a slashable signature.
   */
  hostedWal?: {
    tenantId(roomId: string): Promise<string>
    findByTransactionHash(transactionHash: Hex): Promise<AdmissionWalRecord | null>
    highWater(roomId: string): Promise<bigint>
    pendingCount(roomId: string): Promise<number>
    pendingDeposit(roomId: string, depositInboxId: string): Promise<boolean>
    reserve(input: {
      roomId: string
      admissionId: string
      tenantId: string
      transactionHash: Hex
      rawSignedTransaction: Hex
      sender: Hex
      request: AdmissionWalRecord['request']
    }): Promise<AdmissionWalRecord>
    commit(
      roomId: string,
      admissionId: string,
      receipt: AdmissionReceipt,
    ): Promise<AdmissionWalRecord>
    reserved(limit?: number): Promise<AdmissionWalRecord[]>
  }
}

/**
 * Raised when the coordinator cannot currently establish the preconditions for
 * a receipt (no live L1 view, a stale archive, a saturated operator queue).
 * Reported as 503 so a caller can retry instead of rewriting a valid request.
 */
export class AdmissionUnavailableError extends Error {}

/**
 * Caller-safe rejection reason.
 *
 * Every validation failure raised by `submitSerial` is written for the caller,
 * but errors escaping `observer.put` are Node filesystem errors whose messages
 * embed the absolute archive path, the process pid and the store's file
 * layout. Only reasons this module authored are echoed; anything else is
 * reported generically and logged server-side. Mirrors the redaction the RPC
 * proxy, the faucet and `index.ts` already apply on outward-facing paths.
 */
export class AdmissionRejectedError extends Error {}

function callerSafeReason(error: unknown): string {
  return error instanceof AdmissionRejectedError ? error.message : 'Admission validation failed.'
}

function canonicalUint(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new AdmissionRejectedError(`${label} must be a decimal unsigned integer`)
  }
  return BigInt(value)
}

function rawTransaction(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) {
    throw new AdmissionRejectedError('raw signed transaction must be even-length hexadecimal bytes')
  }
  const bytes = (value.length - 2) / 2
  if (bytes === 0 || bytes > MAX_RAW_TRANSACTION_BYTES) {
    throw new AdmissionRejectedError(`raw signed transaction must fit within ${MAX_RAW_TRANSACTION_BYTES} bytes`)
  }
  return value.toLowerCase() as Hex
}

/**
 * Operator-owned record of the highest admission id issued per room.
 *
 * `RoomManagerValidationFacet` requires `admissionId == admissionCursor + i + 1`
 * exactly, so ids must be strictly sequential and may never be re-issued. The
 * public archive is written by an external indexer and can be pruned, rebuilt
 * or restored from an older copy - deriving the next id from it alone then
 * re-issues a consumed id, and one cursor advance makes two different
 * transaction hashes look satisfied. This lives outside the archive so a
 * rewrite of the archive cannot move it backwards.
 */
export class AdmissionIdStore {
  private readonly issued = new Map<string, bigint>()

  /** `path` null keeps the record in memory only (tests, ephemeral runs). */
  constructor(private readonly path: string | null = null) {
    if (!path) return
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      for (const [roomId, value] of Object.entries(parsed)) {
        if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
          this.issued.set(roomId, BigInt(value))
        }
      }
    } catch (error) {
      // A missing record is the normal first-run state. Anything else must not
      // be silently treated as "nothing issued yet".
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  highWater(roomId: string): bigint {
    return this.issued.get(roomId) ?? 0n
  }

  record(roomId: string, admissionId: bigint): void {
    if (admissionId <= this.highWater(roomId)) return
    this.issued.set(roomId, admissionId)
    if (!this.path) return
    const snapshot = Object.fromEntries(
      [...this.issued].map(([id, value]) => [id, value.toString()]),
    )
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, 'utf8')
    renameSync(temporary, this.path)
  }
}

/**
 * Live `eth_blockNumber` reader for the configured L1 endpoint. Kept here so
 * the service can be constructed with a deterministic reader under test.
 */
function rpcClients(rpcUrls: string | readonly string[]) {
  const urls = typeof rpcUrls === 'string' ? [rpcUrls] : [...rpcUrls]
  if (new Set(urls).size < 2) {
    throw new Error('critical L1 reads require two independent RPC endpoints')
  }
  return urls.map((url) => createPublicClient({ transport: http(url) }))
}

/**
 * Critical L1 reads are compared as `(number, hash)` across every configured
 * provider. A lagging or forked provider is an availability failure, never a
 * value the coordinator guesses past.
 */
export function createL1BlockNumberReader(
  rpcUrls: string | readonly string[],
): () => Promise<bigint> {
  const clients = rpcClients(rpcUrls)
  return async () => {
    const blocks = await Promise.all(
      clients.map((client) => client.getBlock({ blockTag: 'latest', includeTransactions: false })),
    )
    const first = blocks[0]
    if (first?.number === null || !first?.hash) throw new Error('L1 RPC returned no latest block')
    if (
      blocks.some(
        (block) =>
          block.number !== first.number || block.hash?.toLowerCase() !== first.hash!.toLowerCase(),
      )
    ) {
      throw new Error('L1 RPC providers disagree on the latest canonical block')
    }
    return first.number
  }
}

export function createL1BlockHashReader(
  rpcUrls: string | readonly string[],
): (blockNumber: bigint) => Promise<Hex | null> {
  const clients = rpcClients(rpcUrls)
  return async (blockNumber) => {
    const blocks = await Promise.all(
      clients.map(async (client) => {
        try {
          return await client.getBlock({ blockNumber, includeTransactions: false })
        } catch {
          return null
        }
      }),
    )
    const first = blocks[0]
    if (!first?.hash || first.number !== blockNumber) return null
    if (
      blocks.some(
        (block) =>
          !block ||
          block.number !== blockNumber ||
          block.hash?.toLowerCase() !== first.hash!.toLowerCase(),
      )
    ) {
      throw new Error(`L1 RPC providers disagree on canonical block ${blockNumber}`)
    }
    return first.hash
  }
}

/**
 * Two-provider finalized-tag read. Feeds the observer write surface's
 * finalized anchor; an unreadable tag or a provider disagreement is an
 * availability failure, never a lower guess.
 */
export function createL1FinalizedBlockReader(
  rpcUrls: string | readonly string[],
): () => Promise<{ number: bigint; hash: Hex }> {
  const clients = rpcClients(rpcUrls)
  return async () => {
    const blocks = await Promise.all(
      clients.map((client) =>
        client.getBlock({ blockTag: 'finalized', includeTransactions: false }),
      ),
    )
    const first = blocks[0]
    if (first?.number === null || !first?.hash) throw new Error('L1 RPC returned no finalized block')
    if (
      blocks.some(
        (block) =>
          block.number !== first.number || block.hash?.toLowerCase() !== first.hash!.toLowerCase(),
      )
    ) {
      throw new Error('L1 RPC providers disagree on the finalized block')
    }
    return { number: first.number, hash: first.hash }
  }
}

/**
 * Return shapes of the RoomManager observation-facet views this coordinator
 * reads at signing time, transcribed from RoomManagerObservationFacet.sol /
 * IRoomManager.sol (enums decode as uint8). Inlined: the coordinator must not
 * depend on a contracts build tree being present at runtime.
 */
const DEPOSIT_ENTRY_ABI = [
  {
    type: 'function',
    name: 'depositEntry',
    stateMutability: 'view',
    inputs: [
      { name: 'roomId', type: 'uint64' },
      { name: 'inboxId', type: 'uint64' },
    ],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'depositor', type: 'address' },
          { name: 'beneficiary', type: 'address' },
          { name: 'asset', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'queuedAtBlock', type: 'uint64' },
          { name: 'consumed', type: 'bool' },
          { name: 'refunded', type: 'bool' },
        ],
      },
    ],
  },
] as const

const ROOM_STATE_ABI = [
  {
    type: 'function',
    name: 'roomState',
    stateMutability: 'view',
    inputs: [{ name: 'roomId', type: 'uint64' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'state', type: 'uint8' },
          { name: 'authorizationMode', type: 'uint8' },
          { name: 'coldTemplateId', type: 'bytes32' },
          { name: 'proofProgramId', type: 'bytes32' },
          { name: 'proofSystemVersion', type: 'bytes32' },
          { name: 'policyHash', type: 'bytes32' },
          { name: 'adapterPolicyRoot', type: 'bytes32' },
          { name: 'importPublisher', type: 'address' },
          { name: 'verifier', type: 'address' },
          { name: 'verifierCodeHash', type: 'bytes32' },
          { name: 'stateRoot', type: 'bytes32' },
          { name: 'participantRoot', type: 'bytes32' },
          { name: 'participantEpoch', type: 'uint64' },
          { name: 'participantCount', type: 'uint64' },
          { name: 'participantCapacity', type: 'uint64' },
          { name: 'approverRoot', type: 'bytes32' },
          { name: 'approverEpoch', type: 'uint64' },
          { name: 'activeCount', type: 'uint64' },
          { name: 'batchIndex', type: 'uint64' },
          { name: 'l2BlockHeight', type: 'uint64' },
          { name: 'approverChangeCursor', type: 'uint64' },
          { name: 'nextApproverChangeId', type: 'uint64' },
          { name: 'inboxCursor', type: 'uint64' },
          { name: 'nextInboxId', type: 'uint64' },
          { name: 'admissionCursor', type: 'uint64' },
          { name: 'forcedCursor', type: 'uint64' },
          { name: 'nextForcedId', type: 'uint64' },
          { name: 'importCursor', type: 'uint64' },
          { name: 'nextImportId', type: 'uint64' },
          { name: 'outboxEpoch', type: 'uint64' },
          { name: 'minimumImportConfirmations', type: 'uint64' },
          { name: 'minimumDepositConfirmations', type: 'uint64' },
          { name: 'inactivityTimeout', type: 'uint64' },
          { name: 'lastVerifiedAt', type: 'uint64' },
          { name: 'closedAtBlock', type: 'uint64' },
          { name: 'maximumAdmissionWindow', type: 'uint64' },
          { name: 'bondEpoch', type: 'uint64' },
          { name: 'admissionSigner', type: 'address' },
          { name: 'minimumServiceBond', type: 'uint96' },
          { name: 'omissionPenalty', type: 'uint96' },
          { name: 'serviceBond', type: 'uint256' },
          { name: 'coldTemplateDataHash', type: 'bytes32' },
          // Appended by the v7 recovery instruments; the tuple must carry
          // them or the eth_call return data no longer decodes.
          { name: 'lastAttestedAt', type: 'uint64' },
          { name: 'closedByRecovery', type: 'bool' },
        ],
      },
    ],
  },
] as const

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * Two-provider `depositEntry(uint64,uint64)` read on the RoomManager. A
 * zeroed row (no depositor) reports null; a provider disagreement throws.
 */
export function createDepositEntryReader(
  rpcUrls: string | readonly string[],
  roomManager: Hex,
): (roomId: bigint, inboxId: bigint) => Promise<ChainDepositEntry | null> {
  const clients = rpcClients(rpcUrls)
  return async (roomId, inboxId) => {
    const entries = await Promise.all(
      clients.map((client) =>
        client.readContract({
          address: roomManager,
          abi: DEPOSIT_ENTRY_ABI,
          functionName: 'depositEntry',
          args: [roomId, inboxId],
        }),
      ),
    )
    const first = entries[0]!
    if (
      entries.some(
        (entry) =>
          entry.depositor.toLowerCase() !== first.depositor.toLowerCase() ||
          entry.beneficiary.toLowerCase() !== first.beneficiary.toLowerCase() ||
          entry.asset.toLowerCase() !== first.asset.toLowerCase() ||
          entry.amount !== first.amount ||
          entry.queuedAtBlock !== first.queuedAtBlock ||
          entry.consumed !== first.consumed ||
          entry.refunded !== first.refunded,
      )
    ) {
      throw new Error(`L1 RPC providers disagree on deposit entry ${inboxId} of room ${roomId}`)
    }
    if (first.depositor.toLowerCase() === ZERO_ADDRESS) return null
    return {
      depositor: first.depositor,
      beneficiary: first.beneficiary,
      asset: first.asset,
      amount: first.amount,
      queuedAtBlock: first.queuedAtBlock,
      consumed: first.consumed,
      refunded: first.refunded,
    }
  }
}

/** Two-provider `roomState(uint64).admissionCursor` read on the RoomManager. */
export function createAdmissionCursorReader(
  rpcUrls: string | readonly string[],
  roomManager: Hex,
): (roomId: bigint) => Promise<bigint> {
  const clients = rpcClients(rpcUrls)
  return async (roomId) => {
    const rooms = await Promise.all(
      clients.map((client) =>
        client.readContract({
          address: roomManager,
          abi: ROOM_STATE_ABI,
          functionName: 'roomState',
          args: [roomId],
        }),
      ),
    )
    const first = rooms[0]!
    if (rooms.some((entry) => entry.admissionCursor !== first.admissionCursor)) {
      throw new Error(`L1 RPC providers disagree on the admission cursor of room ${roomId}`)
    }
    return first.admissionCursor
  }
}

export class AdmissionService {
  private readonly signer: AdmissionSigner
  private readonly pending = new Map<string, QueuedTransaction[]>()
  private readonly serial = new Map<string, Promise<unknown>>()
  private readonly senderLimiter = new RateLimiter(ADMISSION_SENDER_BURST, ADMISSION_SENDER_PER_SEC)
  private readonly minimumAdmissionFee: bigint
  private readonly minimumDeadlineLeadBlocks: bigint
  private readonly maximumArchiveLagBlocks: bigint
  private readonly maximumPendingPerRoom: number
  private readonly operatorToken: Buffer
  private readonly issuedIds: AdmissionIdStore

  constructor(private readonly config: AdmissionServiceConfig) {
    if (
      typeof config.operatorToken !== 'string' ||
      config.operatorToken.length < MIN_ADMISSION_TOKEN_LENGTH
    ) {
      throw new Error(
        `the admission operator token must contain at least ${MIN_ADMISSION_TOKEN_LENGTH} characters`,
      )
    }
    if (typeof config.latestL1Block !== 'function') {
      throw new Error('the admission service requires a live L1 block reader')
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(config.signer.address)) {
      throw new Error('the admission signer address is malformed')
    }
    this.signer = config.signer
    this.operatorToken = Buffer.from(config.operatorToken)
    this.minimumAdmissionFee = config.minimumAdmissionFee ?? 0n
    this.minimumDeadlineLeadBlocks =
      config.minimumDeadlineLeadBlocks ?? DEFAULT_MINIMUM_DEADLINE_LEAD_BLOCKS
    this.maximumArchiveLagBlocks = config.maximumArchiveLagBlocks ?? DEFAULT_MAX_ARCHIVE_LAG_BLOCKS
    this.maximumPendingPerRoom = config.maximumPendingPerRoom ?? DEFAULT_MAX_PENDING_PER_ROOM
    this.issuedIds = config.issuedIds ?? new AdmissionIdStore()
  }

  signerAddress(): Hex {
    return this.signer.address
  }

  private async signReceipt(unsigned: Omit<AdmissionReceipt, 'signature'>): Promise<AdmissionReceipt> {
    const signature = await this.signer.signTypedData({
      domain: {
        name: 'ZkdealRoom',
        version: '6',
        chainId: this.config.chainId,
        verifyingContract: this.config.roomManager,
      },
      types: {
        AdmissionReceipt: [
          { name: 'roomId', type: 'uint64' },
          { name: 'admissionId', type: 'uint64' },
          { name: 'transactionHash', type: 'bytes32' },
          { name: 'depositInboxId', type: 'uint64' },
          { name: 'depositContentHash', type: 'bytes32' },
          { name: 'deadlineBlock', type: 'uint64' },
          { name: 'maximumBatchIndex', type: 'uint64' },
          { name: 'bondEpoch', type: 'uint64' },
          { name: 'admissionFee', type: 'uint256' },
        ],
      },
      primaryType: 'AdmissionReceipt',
      message: {
        roomId: BigInt(unsigned.roomId),
        admissionId: BigInt(unsigned.admissionId),
        transactionHash: unsigned.transactionHash,
        depositInboxId: BigInt(unsigned.depositInboxId),
        depositContentHash: unsigned.depositContentHash,
        deadlineBlock: BigInt(unsigned.deadlineBlock),
        maximumBatchIndex: BigInt(unsigned.maximumBatchIndex),
        bondEpoch: BigInt(unsigned.bondEpoch),
        admissionFee: BigInt(unsigned.admissionFee),
      },
    })
    return { ...unsigned, signature }
  }

  async recoverHostedReservations(limit = 1_000): Promise<number> {
    if (!this.config.hostedWal) return 0
    const records = await this.config.hostedWal.reserved(limit)
    let recovered = 0
    for (const record of records) {
      if (record.request.signerAddress.toLowerCase() !== this.signer.address.toLowerCase()) {
        throw new AdmissionUnavailableError(
          `reserved admission ${record.roomId}:${record.admissionId} is bound to a different signer`,
        )
      }
      const receipt = await this.signReceipt({
        roomId: record.roomId,
        admissionId: record.admissionId,
        transactionHash: record.transactionHash,
        depositInboxId: record.request.depositInboxId,
        depositContentHash: record.request.depositContentHash,
        deadlineBlock: record.request.deadlineBlock,
        maximumBatchIndex: record.request.maximumBatchIndex,
        bondEpoch: record.request.bondEpoch,
        admissionFee: record.request.admissionFee,
      })
      await this.config.hostedWal.commit(record.roomId, record.admissionId, receipt)
      recovered += 1
    }
    recordAdmissionRecovered(recovered)
    return recovered
  }

  /** Constant-time operator credential check for every admission route. */
  authorizedOperator(authorization: string | undefined): boolean {
    if (!authorization?.startsWith('Bearer ')) return false
    const supplied = Buffer.from(authorization.slice('Bearer '.length))
    return (
      supplied.length === this.operatorToken.length &&
      timingSafeEqual(supplied, this.operatorToken)
    )
  }

  takePending(roomId: string): QueuedTransaction[] {
    const rows = this.pending.get(roomId) ?? []
    this.pending.delete(roomId)
    return rows
  }

  async submit(roomId: string, request: AdmissionRequest): Promise<AdmissionReceipt> {
    const prior = this.serial.get(roomId) ?? Promise.resolve()
    let release: (() => void) | undefined
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = prior.then(() => current)
    this.serial.set(roomId, tail)
    await prior
    try {
      return await this.submitSerial(roomId, request)
    } finally {
      release?.()
      if (this.serial.get(roomId) === tail) this.serial.delete(roomId)
    }
  }

  private async submitSerial(
    roomId: string,
    request: AdmissionRequest,
  ): Promise<AdmissionReceipt> {
    if (!canonicalRoomId(roomId)) throw new AdmissionRejectedError('room id must be a canonical uint64')
    const room = await this.config.observer.get(roomId)
    if (!room || room.status !== 'OPEN') throw new AdmissionRejectedError('room is not open in the observer')
    if (room.authorizationMode !== 'VALIDITY_ONLY') {
      throw new AdmissionRejectedError('room requires unanimous checkpoint approvals')
    }
    if (
      room.admissionSigner === null ||
      room.admissionSigner.toLowerCase() !== this.signer.address.toLowerCase()
    ) {
      throw new AdmissionRejectedError('configured admission signer does not control this room')
    }
    const serviceBond = BigInt(room.serviceBond)
    const minimumServiceBond = BigInt(room.minimumServiceBond)
    const omissionPenalty = BigInt(room.omissionPenalty)
    const archivedPendingAdmissions = room.admissions.filter((entry) => entry.status === 'PENDING').length
    const hostedPendingAdmissions = this.config.hostedWal
      ? await this.config.hostedWal.pendingCount(roomId)
      : 0
    const pendingAdmissions = Math.max(archivedPendingAdmissions, hostedPendingAdmissions)

    // The archive is only an index. Every window decision is taken against the
    // chain itself, and the service refuses to sign without that view.
    let chainHead: bigint
    try {
      chainHead = await this.config.latestL1Block()
    } catch {
      throw new AdmissionUnavailableError('the L1 head is unavailable to this coordinator')
    }
    const latestL1Block = BigInt(room.latestObservedL1Block)
    if (latestL1Block > chainHead || chainHead - latestL1Block > this.maximumArchiveLagBlocks) {
      throw new AdmissionUnavailableError(
        'the room observation archive is not current with the L1 head',
      )
    }

    const raw = rawTransaction(request.rawSignedTransaction)
    const sender = await recoverTransactionAddress({
      serializedTransaction: raw as TransactionSerialized,
    })
    if (!this.senderLimiter.take(sender.toLowerCase())) {
      throw new AdmissionUnavailableError('this sender has exceeded its admission rate')
    }
    const transactionHash = keccak256(raw)
    const hostedExisting = this.config.hostedWal
      ? await this.config.hostedWal.findByTransactionHash(transactionHash)
      : null
    if (hostedExisting && hostedExisting.roomId !== roomId) {
      throw new AdmissionRejectedError('transaction hash is already reserved by another room')
    }
    const requiredOmissionCoverage = BigInt(
      pendingAdmissions + (hostedExisting ? 0 : 1),
    ) * omissionPenalty
    if (
      serviceBond < minimumServiceBond ||
      omissionPenalty === 0n ||
      serviceBond < requiredOmissionCoverage
    ) {
      throw new AdmissionRejectedError('room service bond cannot cover another admission receipt')
    }
    if (room.admissions.some((entry) => entry.transactionHash === transactionHash)) {
      throw new AdmissionRejectedError('transaction already has an admission outcome')
    }

    const depositInboxId = canonicalUint(request.depositInboxId, 'deposit inbox id')
    const deadlineBlock = canonicalUint(request.deadlineBlock, 'deadline block')
    const maximumBatchIndex = canonicalUint(request.maximumBatchIndex, 'maximum batch index')
    const admissionFee = canonicalUint(request.admissionFee ?? '0', 'admission fee')
    if (admissionFee < this.minimumAdmissionFee) {
      throw new AdmissionRejectedError('admission fee is below the operator minimum for this coordinator')
    }
    // A receipt naming somebody else's escrowed deposit lets the holder of the
    // receipt force-refund it, cancelling a deposit the operator may already
    // have sequenced into a proven batch.
    let depositContentHash: Hex = zeroHash
    if (depositInboxId !== 0n) {
      const deposit = room.deposits.find((entry) => BigInt(entry.inboxId) === depositInboxId)
      if (!this.config.hostedWal && (!deposit || deposit.status !== 'PENDING' || deposit.consumedBatch !== null)) {
        throw new AdmissionRejectedError('deposit inbox id does not name a pending deposit in this room')
      }
      const minimumConfirmations = BigInt(room.minimumDepositConfirmations)
      if (!isDevChain(this.config.chainId)) {
        try {
          assertProductionConfirmationDepth(
            minimumConfirmations,
            'minimum deposit confirmations',
          )
        } catch {
          throw new AdmissionUnavailableError(
            'the room minimum deposit confirmation policy is below the production floor',
          )
        }
      }
      // Signed bytes never come from the archive. The archive names the
      // deposit; the values the receipt commits to are re-read from the
      // RoomManager on the two-provider quorum, so an indexer-edited row
      // cannot make this key promise an unsatisfiable admission.
      if (!this.config.chainDepositEntry) {
        throw new AdmissionUnavailableError(
          'the coordinator cannot re-read the deposit entry from the RoomManager',
        )
      }
      let chainDeposit: ChainDepositEntry | null
      try {
        chainDeposit = await this.config.chainDepositEntry(BigInt(roomId), depositInboxId)
      } catch {
        throw new AdmissionUnavailableError(
          'the coordinator cannot establish the canonical deposit entry',
        )
      }
      if (!chainDeposit || chainDeposit.consumed || chainDeposit.refunded) {
        throw new AdmissionUnavailableError(
          'the archived deposit is not a live deposit entry on canonical L1',
        )
      }
      if (chainDeposit.beneficiary.toLowerCase() !== sender.toLowerCase()) {
        throw new AdmissionRejectedError('deposit inbox id belongs to another beneficiary')
      }
      const queuedAtBlock = chainDeposit.queuedAtBlock
      if (queuedAtBlock > chainHead || chainHead - queuedAtBlock < minimumConfirmations) {
        throw new AdmissionRejectedError(
          'deposit inbox id has not reached the room minimum confirmation depth',
        )
      }
      if (!this.config.canonicalL1BlockHash) {
        throw new AdmissionUnavailableError(
          'the coordinator cannot reverify the deposit event block on canonical L1',
        )
      }
      let canonicalBlockHash: Hex | null
      try {
        canonicalBlockHash = await this.config.canonicalL1BlockHash(queuedAtBlock)
      } catch {
        throw new AdmissionUnavailableError(
          'the coordinator cannot establish the canonical deposit event block',
        )
      }
      if (!canonicalBlockHash) {
        throw new AdmissionUnavailableError(
          'the deposit event is no longer in a canonical L1 block',
        )
      }
      if (deposit && canonicalBlockHash.toLowerCase() !== deposit.queuedAtBlockHash.toLowerCase()) {
        throw new AdmissionUnavailableError(
          'the indexed deposit event is no longer in its canonical L1 block',
        )
      }
      if (deposit && (
        chainDeposit.depositor.toLowerCase() !== deposit.depositor.toLowerCase()
        || chainDeposit.beneficiary.toLowerCase() !== deposit.beneficiary.toLowerCase()
        || chainDeposit.asset.toLowerCase() !== deposit.asset.toLowerCase()
        || chainDeposit.amount !== BigInt(deposit.amount)
        || chainDeposit.queuedAtBlock !== BigInt(deposit.queuedAtBlock)
      )) {
        throw new AdmissionUnavailableError(
          'the archived deposit does not match the canonical L1 deposit entry',
        )
      }
      depositContentHash = keccak256(
        encodeAbiParameters(
          [
            { type: 'address' },
            { type: 'address' },
            { type: 'address' },
            { type: 'uint256' },
          ],
          [
            chainDeposit.depositor,
            chainDeposit.beneficiary,
            chainDeposit.asset,
            chainDeposit.amount,
          ],
        ),
      )
      const pendingHostedDeposit = this.config.hostedWal
        ? await this.config.hostedWal.pendingDeposit(roomId, depositInboxId.toString())
        : false
      if (pendingHostedDeposit || room.admissions.some(
        (entry) => entry.depositInboxId === depositInboxId.toString() && entry.status === 'PENDING',
      )) {
        throw new AdmissionRejectedError('deposit inbox id is already reserved by a pending admission')
      }
    }
    const latestBatch = BigInt(room.latestBatchIndex ?? room.batches.at(-1)?.batchIndex ?? '0')
    const maximumAdmissionWindow = BigInt(room.maximumAdmissionWindow)
    if (deadlineBlock < chainHead + this.minimumDeadlineLeadBlocks) {
      throw new AdmissionRejectedError('admission deadline does not leave the minimum lead time for this room')
    }
    if (deadlineBlock > chainHead + maximumAdmissionWindow || maximumBatchIndex <= latestBatch) {
      throw new AdmissionRejectedError('admission deadline or maximum batch is already exhausted')
    }

    // Expire what the deadline already released, then refuse rather than grow
    // an operator queue no batch builder can catch up with.
    const queue = this.config.hostedWal
      ? []
      : (this.pending.get(roomId) ?? []).filter(
          (entry) => BigInt(entry.receipt.deadlineBlock) > chainHead,
        )
    if (!hostedExisting && Math.max(queue.length, hostedPendingAdmissions) >= this.maximumPendingPerRoom) {
      throw new AdmissionUnavailableError(
        'the operator admission queue for this room is saturated',
      )
    }

    // The on-chain rule is `admissionId == admissionCursor + i + 1`: ids are
    // strictly sequential and an id may never be re-issued. The chain-observed
    // `admissionCursor` of the latest accepted batch is therefore a hard lower
    // bound even when the archive's `admissions` list has been pruned.
    const archiveMaximum = room.admissions.reduce((maximum, entry) => {
      const id = BigInt(entry.admissionId)
      return id > maximum ? id : maximum
    }, 0n)
    const observedCursor = BigInt(room.admissionCursor ?? room.batches.at(-1)?.admissionCursor ?? '0')
    const hostedMaximum = this.config.hostedWal
      ? await this.config.hostedWal.highWater(roomId)
      : 0n
    const archiveOrCursor = archiveMaximum > observedCursor ? archiveMaximum : observedCursor
    const admissionId = hostedExisting
      ? BigInt(hostedExisting.admissionId)
      : (archiveOrCursor > hostedMaximum ? archiveOrCursor : hostedMaximum) + 1n
    // A rebuilt, pruned or restored archive proposes an id this coordinator has
    // already signed. Re-issuing it makes one cursor advance satisfy two
    // different transaction hashes, so fail closed instead of guessing.
    if (!this.config.hostedWal && admissionId <= this.issuedIds.highWater(roomId)) {
      throw new AdmissionUnavailableError(
        'the room observation archive has rolled back behind an already-issued admission id',
      )
    }
    // The archive-derived id is additionally capped by the CHAIN's accepted
    // cursor plus the pending bound: the contract can only ever accept ids the
    // queue can still deliver, so an archive proposing one past that cap is
    // poisoned, not merely stale.
    if (!this.config.chainAdmissionCursor) {
      throw new AdmissionUnavailableError(
        'the coordinator cannot re-read the admission cursor from the RoomManager',
      )
    }
    let chainCursor: bigint
    try {
      chainCursor = await this.config.chainAdmissionCursor(BigInt(roomId))
    } catch {
      throw new AdmissionUnavailableError(
        'the coordinator cannot establish the canonical admission cursor',
      )
    }
    if (admissionId > chainCursor + BigInt(DEFAULT_MAX_PENDING_PER_ROOM)) {
      throw new AdmissionUnavailableError(
        'the derived admission id is beyond the chain admission cursor pending bound',
      )
    }
    const bondEpoch = BigInt(room.bondEpoch)
    if (this.config.hostedWal) {
      let tenantId: string
      try {
        tenantId = await this.config.hostedWal.tenantId(roomId)
      } catch {
        throw new AdmissionUnavailableError('the hosted room has no tenant ownership record')
      }
      const reserved = await this.config.hostedWal.reserve({
        roomId,
        admissionId: admissionId.toString(),
        tenantId,
        transactionHash,
        rawSignedTransaction: raw,
        sender,
        request: {
          depositInboxId: depositInboxId.toString(),
          depositContentHash,
          deadlineBlock: deadlineBlock.toString(),
          maximumBatchIndex: maximumBatchIndex.toString(),
          bondEpoch: bondEpoch.toString(),
          admissionFee: admissionFee.toString(),
          signerAddress: this.signer.address,
        },
      })
      if (reserved.receipt) {
        const prior = reserved.receipt as Partial<AdmissionReceipt>
        if (
          prior.roomId !== roomId
          || prior.admissionId !== admissionId.toString()
          || prior.transactionHash?.toLowerCase() !== transactionHash.toLowerCase()
          || typeof prior.signature !== 'string'
        ) throw new AdmissionUnavailableError('the hosted admission WAL contains an invalid receipt')
        return prior as AdmissionReceipt
      }
    }
    const receipt = await this.signReceipt({
      roomId,
      admissionId: admissionId.toString(),
      transactionHash,
      depositInboxId: depositInboxId.toString(),
      depositContentHash,
      deadlineBlock: deadlineBlock.toString(),
      maximumBatchIndex: maximumBatchIndex.toString(),
      bondEpoch: bondEpoch.toString(),
      admissionFee: admissionFee.toString(),
    })
    if (this.config.hostedWal) {
      // The exact raw transaction was committed by reserve() before signing.
      // Commit the now-created receipt before any projection write or network
      // response; a crash after this point is recovered by transaction hash.
      await this.config.hostedWal.commit(roomId, admissionId.toString(), receipt)
      return receipt
    }
    // Compare-and-set: the document was read before two awaits, so an indexer
    // write landing in between must not be clobbered with the stale snapshot.
    try {
      if (!this.config.observer.put) {
        throw new AdmissionUnavailableError('the standalone observation archive is not writable')
      }
      const localRoom = room as ObservedRoom
      this.config.observer.put(
        {
          ...localRoom,
          admissions: [
            ...localRoom.admissions,
            {
              admissionId: receipt.admissionId,
              transactionHash,
              depositInboxId: receipt.depositInboxId,
              depositContentHash: receipt.depositContentHash,
              deadlineBlock: receipt.deadlineBlock,
              maximumBatchIndex: receipt.maximumBatchIndex,
              status: 'PENDING',
              l2BlockNumber: null,
              transactionIndex: null,
            },
          ],
        },
        localRoom.revision ?? null,
      )
    } catch (error) {
      if (error instanceof ObserverRevisionConflictError) {
        throw new AdmissionUnavailableError(
          'the room observation archive changed while this admission was signed',
        )
      }
      throw error
    }
    // Recorded only after the archive is durable: reserving the id up front
    // would burn it on a failed write, and a gap is as unrecoverable on chain
    // as a reuse.
    this.issuedIds.record(roomId, admissionId)
    // Queued only after the archive is durable, so a rejected write cannot
    // leave a receipt the caller never received sitting in the queue.
    this.pending.set(roomId, [...queue, { receipt, rawSignedTransaction: raw, sender }])
    return receipt
  }
}

export function registerAdmissionRoutes(
  app: FastifyInstance,
  service: AdmissionService | null,
): void {
  const ipLimiter = new RateLimiter(ADMISSION_IP_BURST, ADMISSION_IP_PER_SEC)

  /**
   * Shared gate for both admission routes: availability, per-IP burst, then
   * the operator credential. Returns null after having sent the response.
   */
  const admitted = (request: FastifyRequest, reply: FastifyReply): AdmissionService | null => {
    if (!service) {
      void reply.code(503).send({
        decision: 'ADMISSION_UNAVAILABLE',
        reason: 'This coordinator has no environment-backed admission signer.',
        nextAction: 'Use the L1 forced-transaction path or another configured coordinator.',
      })
      return null
    }
    if (!ipLimiter.take(request.ip)) {
      void reply.code(429).send({
        decision: 'RATE_LIMITED',
        reason: 'This client exceeded the coordinator admission rate.',
        nextAction: 'Retry after the configured admission window.',
      })
      return null
    }
    if (!service.authorizedOperator(request.headers.authorization)) {
      void reply.header('www-authenticate', 'Bearer realm="zkdeal-admission"')
      void reply.code(401).send({
        decision: 'NOT_ADMITTED',
        reason: 'This coordinator requires an operator-issued admission credential.',
        nextAction: 'Present the operator credential or use the L1 forced-transaction path.',
      })
      return null
    }
    return service
  }

  app.post<{ Params: { id: string }; Body: AdmissionRequest }>(
    '/rooms/:id/transactions',
    { bodyLimit: MAX_RAW_TRANSACTION_BYTES * 2 + 16 * 1024 },
    async (request, reply) => {
      const admission = admitted(request, reply)
      if (!admission) return reply
      try {
        const receipt = await admission.submit(request.params.id, request.body)
        return {
          decision: 'LOCALLY_ADMITTED',
          guarantee: 'The transaction will be succeeded, reverted, or rejected by the deadline.',
          receipt,
        }
      } catch (error) {
        if (error instanceof AdmissionUnavailableError) {
          return reply.code(503).send({
            decision: 'ADMISSION_UNAVAILABLE',
            reason: error.message,
            nextAction: 'Retry later or use the L1 forced-transaction path.',
          })
        }
        if (!(error instanceof AdmissionRejectedError)) {
          // Node filesystem messages carry the archive path and pid; keep the
          // raw error server-side and answer with a fixed reason.
          request.log.error({ error, roomId: request.params.id }, 'admission failed internally')
        }
        return reply.code(400).send({
          decision: 'NOT_ADMITTED',
          reason: callerSafeReason(error),
          nextAction: 'Correct the transaction or use the L1 forced-transaction path.',
        })
      }
    },
  )

  /**
   * Operator drain for the batch builder. Without a consumer every issued
   * receipt is unconditionally challengeable, so the queue is exposed on the
   * same credential rather than left unreachable inside the process.
   */
  app.post<{ Params: { id: string } }>(
    '/rooms/:id/pending-transactions',
    { bodyLimit: 4096 },
    async (request, reply) => {
      const admission = admitted(request, reply)
      if (!admission) return reply
      return {
        decision: 'PENDING_DRAINED',
        roomId: request.params.id,
        transactions: admission.takePending(request.params.id),
      }
    },
  )
}
