/**
 * The single place a hidden-card move becomes bytes.
 *
 * Its input type is the enforcement mechanism: `CardMoveRequest` has no field
 * that can carry deck order, a salt, a hand array, a Merkle sibling or a hand
 * slot, so a witness value cannot reach calldata by being passed to the wrong
 * argument - only by being typed into one of the public fields on purpose. The
 * vault worker still audits the finished bytes against the real secrets before
 * releasing them (`privacy.ts`), because that is the check the type system
 * cannot make.
 *
 * Signatures and selectors come from `@zkdeal/protocol`
 * (`CARD_DUEL_ENTRY_POINT_SIGNATURES` / `CARD_DUEL_SELECTORS`), which is
 * asserted equal to the compiled `HiddenCardDuelV5` artifact. Nothing is
 * re-spelled here.
 */
import {
  CARD_DUEL_ENTRY_POINT_SIGNATURES,
  CARD_DUEL_SELECTORS,
  type CardDuelEntryPoint,
  type Hex,
  type ParticipantLeaf,
} from '@zkdeal/protocol'
import { encodeAbiParameters, type AbiParameter } from 'viem'

export type { CardDuelEntryPoint }

/** `MerkleParticipants.Participant`, spelled once for viem. */
const PARTICIPANT_TUPLE: AbiParameter = {
  name: 'previous',
  type: 'tuple',
  components: [
    { name: 'index', type: 'uint64' },
    { name: 'owner', type: 'address' },
    { name: 'sessionKey', type: 'address' },
    { name: 'sessionExpiry', type: 'uint64' },
    { name: 'spendLimit', type: 'uint256' },
    { name: 'paymentSpent', type: 'uint256' },
    { name: 'itemBalance', type: 'uint256' },
    { name: 'nonce', type: 'uint64' },
    { name: 'applicationData', type: 'bytes32' },
    { name: 'active', type: 'bool' },
  ],
}
const PROOF: AbiParameter = { name: 'proof', type: 'bytes32[]' }
const DUEL_ID: AbiParameter = { name: 'duelId', type: 'uint64' }

/**
 * Everything a move may carry into calldata. Every field below is either
 * on-chain state already, a commitment, an ordered circuit public input, or the
 * 256-byte Groth16 blob.
 */
export interface CardMoveRequest {
  readonly move: CardDuelEntryPoint
  /**
   * The leaf as the chain currently holds it. Absent only for
   * `registerDuelist`, which proves an EMPTY leaf instead.
   */
  readonly previous?: ParticipantLeaf
  /** Sibling path for `previous.index` against the current participant root. */
  readonly participantProof?: readonly Hex[]
  readonly duelId?: bigint
  /** Poseidon deck commitment, as the bytes32 the contract stores. */
  readonly deckRoot?: Hex
  /** Root of the all-empty hand, from the same deck-init proof. */
  readonly emptyHandRoot?: Hex
  readonly newHandRoot?: Hex
  readonly commitment?: Hex
  readonly seed?: Hex
  readonly cardId?: number
  readonly boardSlot?: number
  readonly attackerSlot?: number
  readonly targetSlot?: number
  /** `abi.encode(uint256[2],uint256[2][2],uint256[2])` - exactly 256 bytes. */
  readonly innerProof?: Hex
  /** `registerDuelist` only; it proves an empty leaf rather than `previous`. */
  readonly registration?: {
    readonly index: number
    readonly sessionKey: Hex
    readonly sessionExpiry: bigint
    readonly fundedAmount: bigint
    readonly emptyLeafProof: readonly Hex[]
  }
}

export interface CardCalldata {
  readonly move: CardDuelEntryPoint
  /** Canonical signature the selector is taken from. */
  readonly signature: string
  readonly selector: Hex
  /** ABI-encoded argument tuple, without the selector. */
  readonly args: Hex
  /** Selector plus arguments - the exact bytes that reach L1 calldata. */
  readonly calldata: Hex
  readonly bytes: number
  /** Ordered, human-readable summary of what is being published. */
  readonly published: readonly { readonly name: string; readonly value: string }[]
}

function required<T>(value: T | undefined, move: string, field: string): T {
  if (value === undefined) throw new Error(`${move} requires ${field}`)
  return value
}

function assertInnerProof(value: Hex, move: string): Hex {
  if (!/^0x[0-9a-fA-F]{512}$/.test(value)) {
    throw new Error(`${move} requires a 256-byte Groth16 proof, got ${(value.length - 2) / 2} bytes`)
  }
  return value
}

function participantValue(participant: ParticipantLeaf): readonly unknown[] {
  return [
    participant.index,
    participant.owner,
    participant.sessionKey,
    participant.sessionExpiry,
    participant.spendLimit,
    participant.paymentSpent,
    participant.itemBalance,
    participant.nonce,
    participant.applicationData,
    participant.active,
  ]
}

interface Encoded {
  readonly params: readonly AbiParameter[]
  readonly values: readonly unknown[]
  readonly published: readonly { readonly name: string; readonly value: string }[]
}

/** Argument list per entry point, in declaration order. */
function encodeMove(request: CardMoveRequest): Encoded {
  const move = request.move
  const base = [PARTICIPANT_TUPLE, PROOF]
  const baseValues =
    move === 'registerDuelist'
      ? []
      : [
          participantValue(required(request.previous, move, 'the previous participant leaf')),
          [...required(request.participantProof, move, 'a participant Merkle proof')],
        ]
  const duelId = () => required(request.duelId, move, 'duelId')

  switch (move) {
    case 'registerDuelist': {
      const registration = required(request.registration, move, 'registration')
      return {
        params: [
          { name: 'index', type: 'uint64' },
          { name: 'sessionKey', type: 'address' },
          { name: 'sessionExpiry', type: 'uint64' },
          { name: 'fundedAmount', type: 'uint256' },
          { name: 'emptyLeafProof', type: 'bytes32[]' },
        ],
        values: [
          BigInt(registration.index),
          registration.sessionKey,
          registration.sessionExpiry,
          registration.fundedAmount,
          [...registration.emptyLeafProof],
        ],
        published: [
          { name: 'index', value: String(registration.index) },
          { name: 'sessionKey', value: registration.sessionKey },
          { name: 'fundedAmount', value: registration.fundedAmount.toString(10) },
        ],
      }
    }
    case 'openDuel':
    case 'withdrawUnspent':
      return { params: base, values: baseValues, published: [] }
    case 'joinDuel':
    case 'abandonDuel':
    case 'endTurn':
    case 'concede':
    case 'claimPrize':
      return {
        params: [...base, DUEL_ID],
        values: [...baseValues, duelId()],
        published: [{ name: 'duelId', value: duelId().toString(10) }],
      }
    case 'initializeDeck': {
      const deckRoot = required(request.deckRoot, move, 'deckRoot')
      const emptyHandRoot = required(request.emptyHandRoot, move, 'emptyHandRoot')
      const proof = assertInnerProof(required(request.innerProof, move, 'innerProof'), move)
      return {
        params: [
          ...base,
          DUEL_ID,
          { name: 'deckRoot', type: 'bytes32' },
          { name: 'emptyHandRoot', type: 'bytes32' },
          { name: 'innerProof', type: 'bytes' },
        ],
        values: [...baseValues, duelId(), deckRoot, emptyHandRoot, proof],
        published: [
          { name: 'duelId', value: duelId().toString(10) },
          { name: 'deckRoot', value: deckRoot },
          { name: 'emptyHandRoot', value: emptyHandRoot },
          { name: 'innerProof', value: `${(proof.length - 2) / 2} bytes of Groth16` },
        ],
      }
    }
    case 'commitSeed': {
      const commitment = required(request.commitment, move, 'commitment')
      return {
        params: [...base, DUEL_ID, { name: 'commitment', type: 'bytes32' }],
        values: [...baseValues, duelId(), commitment],
        published: [
          { name: 'duelId', value: duelId().toString(10) },
          { name: 'commitment', value: commitment },
        ],
      }
    }
    case 'revealSeed': {
      const seed = required(request.seed, move, 'seed')
      return {
        params: [...base, DUEL_ID, { name: 'seed', type: 'bytes32' }],
        values: [...baseValues, duelId(), seed],
        published: [
          { name: 'duelId', value: duelId().toString(10) },
          { name: 'seed', value: seed },
        ],
      }
    }
    case 'draw':
    case 'burn': {
      const newHandRoot = required(request.newHandRoot, move, 'newHandRoot')
      const proof = assertInnerProof(required(request.innerProof, move, 'innerProof'), move)
      return {
        params: [
          ...base,
          DUEL_ID,
          { name: 'newHandRoot', type: 'bytes32' },
          { name: 'innerProof', type: 'bytes' },
        ],
        values: [...baseValues, duelId(), newHandRoot, proof],
        published: [
          { name: 'duelId', value: duelId().toString(10) },
          { name: 'newHandRoot', value: newHandRoot },
          { name: 'innerProof', value: `${(proof.length - 2) / 2} bytes of Groth16` },
        ],
      }
    }
    case 'play': {
      const newHandRoot = required(request.newHandRoot, move, 'newHandRoot')
      const cardId = required(request.cardId, move, 'cardId')
      const boardSlot = required(request.boardSlot, move, 'boardSlot')
      const proof = assertInnerProof(required(request.innerProof, move, 'innerProof'), move)
      return {
        params: [
          ...base,
          DUEL_ID,
          { name: 'newHandRoot', type: 'bytes32' },
          { name: 'cardId', type: 'uint8' },
          { name: 'boardSlot', type: 'uint8' },
          { name: 'innerProof', type: 'bytes' },
        ],
        values: [...baseValues, duelId(), newHandRoot, cardId, boardSlot, proof],
        published: [
          { name: 'duelId', value: duelId().toString(10) },
          { name: 'newHandRoot', value: newHandRoot },
          { name: 'cardId', value: String(cardId) },
          { name: 'boardSlot', value: String(boardSlot) },
          { name: 'innerProof', value: `${(proof.length - 2) / 2} bytes of Groth16` },
        ],
      }
    }
    case 'attack': {
      const attackerSlot = required(request.attackerSlot, move, 'attackerSlot')
      const targetSlot = required(request.targetSlot, move, 'targetSlot')
      return {
        params: [
          ...base,
          DUEL_ID,
          { name: 'attackerSlot', type: 'uint8' },
          { name: 'targetSlot', type: 'uint8' },
        ],
        values: [...baseValues, duelId(), attackerSlot, targetSlot],
        published: [
          { name: 'duelId', value: duelId().toString(10) },
          { name: 'attackerSlot', value: String(attackerSlot) },
          { name: 'targetSlot', value: targetSlot === 255 ? '255 (face)' : String(targetSlot) },
        ],
      }
    }
    default: {
      const unreachable: never = move
      throw new Error(`unsupported card entry point ${String(unreachable)}`)
    }
  }
}

/**
 * Build the exact bytes a move publishes. `calldata` is what `callL2` signs and
 * what a VALIDITY_ONLY batch republishes on L1, so it is also what the payload
 * inspector renders and what the vault audits.
 */
export function buildCardMoveCalldata(request: CardMoveRequest): CardCalldata {
  const signature = CARD_DUEL_ENTRY_POINT_SIGNATURES[request.move]
  const selector = CARD_DUEL_SELECTORS[request.move]
  const { params, values, published } = encodeMove(request)
  const args = encodeAbiParameters(params as AbiParameter[], values as unknown[]) as Hex
  const calldata = `${selector}${args.slice(2)}` as Hex
  return {
    move: request.move,
    signature,
    selector,
    args,
    calldata,
    bytes: (calldata.length - 2) / 2,
    published,
  }
}

/** Canonical decimal field element (a circuit public input) as a `bytes32`. */
export function cardFieldToBytes32(decimal: string): Hex {
  const value = BigInt(decimal)
  if (value < 0n || value >= 1n << 256n) throw new Error('field element does not fit bytes32')
  return `0x${value.toString(16).padStart(64, '0')}` as Hex
}
