/**
 * Browser-side mirror of the room's `MerkleParticipants` ledger.
 *
 * Every mutating `HiddenCardDuelV5` entry point takes `(Participant previous,
 * bytes32[] proof)` and returns the next leaf, and `_writeParticipant` reverts
 * unless `next.nonce == previous.nonce + 1`. A client therefore has to keep its
 * own copy of the tree and rehash the returned leaf into it BEFORE building the
 * next proof, or its second move is rejected.
 *
 * The leaf hash, the root and the sibling path all come from `@zkdeal/protocol`
 * (`participantLeafHash` / `participantMerkleRoot` /
 * `participantMerkleProof`), which mirrors `MerkleParticipants.sol`
 * one-for-one. This module only owns the bookkeeping around them.
 *
 * Nothing here is secret: a participant leaf is `index`, `owner`, `sessionKey`,
 * `sessionExpiry`, escrow counters, a nonce and one `applicationData` word, all
 * of which are on-chain state.
 */
import {
  CARD_PARTICIPANT_CAPACITY,
  assertCardParticipantCapacity,
  emptyParticipantRoot,
  participantLeafHash,
  participantMerkleProof,
  participantMerkleRoot,
  type Hex,
  type ParticipantLeaf,
} from '@zkdeal/protocol'

export type { ParticipantLeaf }

const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as Hex

export interface CardParticipantLedger {
  readonly capacity: number
  /** Occupied leaves by index; an absent index is `bytes32(0)`. */
  readonly leaves: ReadonlyMap<number, Hex>
  /** The full record behind each occupied leaf, so a caller can build `previous`. */
  readonly records: ReadonlyMap<number, ParticipantLeaf>
}

export function createCardLedger(
  capacity: number = CARD_PARTICIPANT_CAPACITY,
): CardParticipantLedger {
  assertCardParticipantCapacity(capacity)
  return { capacity, leaves: new Map(), records: new Map() }
}

export function cardLedgerRoot(ledger: CardParticipantLedger): Hex {
  return ledger.leaves.size === 0
    ? emptyParticipantRoot(ledger.capacity)
    : participantMerkleRoot(ledger.leaves, ledger.capacity)
}

/** Sibling path for `index`, LSB-first, exactly as `_deriveRoot` consumes it. */
export function cardLedgerProof(ledger: CardParticipantLedger, index: number): Hex[] {
  return participantMerkleProof(ledger.leaves, ledger.capacity, index)
}

/**
 * `registerDuelist` proves an EMPTY leaf, so its path is taken against the tree
 * as it stands before the registration is folded in.
 */
export function cardEmptyLeafProof(ledger: CardParticipantLedger, index: number): Hex[] {
  if (ledger.leaves.has(index)) {
    throw new Error(`participant index ${index} is already registered in this mirror`)
  }
  return cardLedgerProof(ledger, index)
}

/** Fold an accepted leaf into the mirror. Returns a new ledger; never mutates. */
export function cardLedgerWith(
  ledger: CardParticipantLedger,
  participant: ParticipantLeaf,
): CardParticipantLedger {
  const index = Number(participant.index)
  if (!Number.isSafeInteger(index) || index < 0 || index >= ledger.capacity) {
    throw new Error(`participant index ${participant.index} is outside capacity ${ledger.capacity}`)
  }
  const leaf = participantLeafHash(participant)
  const leaves = new Map(ledger.leaves)
  const records = new Map(ledger.records)
  if (leaf === ZERO_BYTES32) {
    leaves.delete(index)
    records.delete(index)
  } else {
    leaves.set(index, leaf)
    records.set(index, participant)
  }
  return { capacity: ledger.capacity, leaves, records }
}

export function cardParticipant(
  ledger: CardParticipantLedger,
  index: number,
): ParticipantLeaf {
  const record = ledger.records.get(index)
  if (!record) throw new Error(`participant index ${index} is not in this mirror`)
  return record
}

/**
 * The leaf `_writeParticipant` will accept as `next`: identical identity, nonce
 * advanced by exactly one, and only the four mutable fields patched. Building
 * it here rather than at each call site is what keeps the mirror and the chain
 * in step across a whole duel.
 */
export function cardAdvancedParticipant(
  previous: ParticipantLeaf,
  patch: {
    readonly spendLimit?: bigint
    readonly paymentSpent?: bigint
    readonly itemBalance?: bigint
    readonly applicationData?: Hex
  } = {},
): ParticipantLeaf {
  return {
    index: previous.index,
    owner: previous.owner,
    sessionKey: previous.sessionKey,
    sessionExpiry: previous.sessionExpiry,
    spendLimit: patch.spendLimit ?? previous.spendLimit,
    paymentSpent: patch.paymentSpent ?? previous.paymentSpent,
    itemBalance: patch.itemBalance ?? previous.itemBalance,
    nonce: previous.nonce + 1n,
    applicationData: patch.applicationData ?? previous.applicationData,
    active: previous.active,
  }
}

/** The leaf `registerDuelist` writes: nonce 0, escrow funded, no duel state yet. */
export function cardRegisteredParticipant(input: {
  readonly index: number
  readonly owner: Hex
  readonly sessionKey: Hex
  readonly sessionExpiry: bigint
  readonly fundedAmount: bigint
}): ParticipantLeaf {
  return {
    index: BigInt(input.index),
    owner: input.owner,
    sessionKey: input.sessionKey,
    sessionExpiry: input.sessionExpiry,
    spendLimit: input.fundedAmount,
    paymentSpent: 0n,
    itemBalance: 0n,
    nonce: 0n,
    applicationData: ZERO_BYTES32,
    active: true,
  }
}
