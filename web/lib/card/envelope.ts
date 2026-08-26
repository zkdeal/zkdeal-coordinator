/**
 * The signed envelope a duel move travels in.
 *
 * A room proves the transactions its customers signed. The coordinator
 * refuses a checkpoint that carries duel calldata with no envelope
 * (`server/src/demo-runtime-spec.ts`) precisely because accepting calldata
 * alone would let the host script a batch the players never made. So this
 * module is the browser's half of that contract: one EIP-1559 transaction per
 * move, signed by the seat's own key.
 *
 * PRIVACY. An EIP-2718 envelope is nine public fields and a signature. Every
 * one of them is fixed here from public data - chain id, nonce, gas, the duel
 * address, a zero value, empty access list, and the SAME calldata bytes the
 * payload inspector already renders. There is no field on
 * `CardMoveEnvelopeRequest` that could carry a deck order, a salt, a hand or
 * a Merkle path, and `signCardMoveEnvelope` re-decodes what it signed and
 * refuses to return it unless every field is byte-for-byte what was asked for.
 * The vault audits the finished envelope as well, because a structural argument
 * is not a measurement.
 *
 * IDENTITY. The signer is `cardDemoSeatAccount(seat)`, which is the same
 * account `identity.ts` reads `owner` - the circuit's `player` public input -
 * off. `signCardMoveEnvelope` recovers the sender from its own signature and
 * throws if it is not that address, so a future edit that separates the two
 * fails here rather than inside the guest.
 *
 * FEES. `stf-core`'s `tx_env_from_raw` and the host's `raw::inspect_one` both
 * reject a fee-bearing room transaction: a room runs on free gas. Both fee caps
 * are therefore zero, and a non-zero one is a refusal, not a policy choice.
 */
import { roomChainIdV5, type Hex } from '@zkdeal/protocol'
import { parseTransaction, recoverTransactionAddress, type Hex as ViemHex } from 'viem'
import type { CardDuelEntryPoint } from './calldata'
import { cardDemoSeatAccount } from './identity'
import type { CardSessionEntry } from './session'

/**
 * Gas each move is signed for, matching the budget the coordinator's own room
 * request declares (`CARD_ROOM_REGISTER_GAS` / `CARD_ROOM_MOVE_GAS` in
 * `server/src/card-request.ts`). A registration walks a seven-deep keccak
 * Merkle path AND performs an ERC-20 `transferFrom`, which is why it is the
 * more expensive of the two.
 */
export const CARD_MOVE_GAS_LIMIT = 600_000n
export const CARD_REGISTER_GAS_LIMIT = 700_000n

/** A room block may spend this much; the same ceiling `policy.rs` certifies. */
export const CARD_ROOM_BLOCK_GAS_LIMIT = 5_000_000n

export function cardMoveGasLimit(move: CardDuelEntryPoint): bigint {
  return move === 'registerDuelist' ? CARD_REGISTER_GAS_LIMIT : CARD_MOVE_GAS_LIMIT
}

/**
 * The EIP-155 chain id a room's transactions sign under.
 *
 * `room_chain_id_v5(deploymentDomain, roomId)` - the host refuses an envelope
 * signed for any other chain and names the one it got, which is the single most
 * likely integration mistake here. The first 50 digest bits are used and bit 50
 * forced on, so the value is always a safe JS integer.
 *
 * IT IS `roomChainIdV5`, NOT `roomChainId`. The two hash different typehash
 * preimages (`RoomChainIdV5(...)` vs `RoomChainIdV4(...)`) and therefore return
 * different numbers, and `chainId` is signed over. Signing with the v4
 * derivation produced envelopes every room rejects at admission -
 * `test/card-envelope.test.ts` pins the value and pins that the two differ.
 */
export function cardRoomChainIdV5(deploymentDomain: string, chainRoomId: string): number {
  if (!/^0x[0-9a-fA-F]{64}$/.test(deploymentDomain)) {
    throw new Error(
      'the room chain id needs the RoomManager deployment domain as a bytes32; the coordinator ' +
        'publishes it as `deploymentDomain` on /demo/v1/system',
    )
  }
  if (!/^(0|[1-9][0-9]*)$/.test(chainRoomId)) {
    throw new Error('the room chain id needs the room\'s on-chain uint64 id')
  }
  const value = roomChainIdV5(deploymentDomain as Hex, BigInt(chainRoomId))
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('this room chain id is not a safe JavaScript integer')
  }
  return Number(value)
}

/** Either a chain id every envelope for a room signs under, or why there is none. */
export interface CardRoomSigning {
  readonly chainId: number | null
  /** Null when there is nothing to report yet, i.e. no room is attached. */
  readonly reason: string | null
}

/**
 * Decide whether this room's moves can be signed at all.
 *
 * Both halves are needed and neither can be guessed: a room that has not been
 * deployed has no on-chain id, and a coordinator that does not publish its
 * `deploymentDomain` leaves no way to derive the chain id from anything. An
 * envelope signed under a guessed chain id is not caught at the edge - the host
 * refuses it by name partway through preparing a batch - so this reports the
 * missing input instead of inventing one.
 */
export function cardRoomSigning(
  deploymentDomain: string | null,
  chainRoomId: string | null,
): CardRoomSigning {
  if (chainRoomId === null) {
    return {
      chainId: null,
      reason:
        'This room has no on-chain id yet, so its transactions have no chain id to sign under. ' +
        'Deploy the room first.',
    }
  }
  if (deploymentDomain === null) {
    return {
      chainId: null,
      reason:
        'This coordinator does not publish its RoomManager deployment domain, so a browser ' +
        'cannot compute room_chain_id_v5(deploymentDomain, roomId). Every envelope signed ' +
        'without it is refused by the prover for the wrong chain id, so no move is submitted.',
    }
  }
  try {
    return { chainId: cardRoomChainIdV5(deploymentDomain, chainRoomId), reason: null }
  } catch (caught) {
    return {
      chainId: null,
      reason: caught instanceof Error ? caught.message : 'This room has no signable chain id.',
    }
  }
}

/**
 * The transaction nonce seat `seat` must sign `sequence` with.
 *
 * Counted over the WHOLE move log, not over what is currently pending: a room's
 * account nonces are state, and a checkpoint advances that state rather than
 * resetting it. Counting only unproven moves would make the first move after
 * every checkpoint re-use a consumed nonce, which the executor rejects.
 *
 * Derived from the entry's own position rather than from a counter, so it is
 * the same value whenever it is asked for and a retry cannot invent a gap.
 */
export function cardSeatNonce(
  entries: readonly CardSessionEntry[],
  seat: number,
  sequence: number,
): number {
  return entries.filter((entry) => entry.seat === seat && entry.sequence < sequence).length
}

/** Everything the envelope publishes, decoded back out of the signed bytes. */
export interface CardEnvelopeFields {
  readonly chainId: number
  readonly nonce: number
  readonly to: Hex
  readonly gas: bigint
  readonly value: bigint
  readonly maxFeePerGas: bigint
  readonly maxPriorityFeePerGas: bigint
  readonly calldata: Hex
  readonly accessListEntries: number
}

/**
 * Decode a signed envelope into its public fields. Used by the verification
 * inside `signCardMoveEnvelope` and by the tests that pin the wire shape, so
 * both read the bytes rather than the intention.
 */
export function cardEnvelopeFields(signedTransaction: Hex): CardEnvelopeFields {
  // `@zkdeal/protocol`'s `Hex` is an unbranded string alias; the cast tells
  // viem the shape, and `cardEnvelopeFields` throws on anything that is not it.
  const parsed = parseTransaction(signedTransaction as ViemHex)
  if (parsed.type !== 'eip1559') {
    throw new Error(`a duel move is an EIP-1559 transaction, not ${String(parsed.type)}`)
  }
  if (parsed.to === null || parsed.to === undefined) {
    throw new Error('a duel move calls the duel contract; a room forbids contract creation')
  }
  return {
    chainId: parsed.chainId,
    nonce: parsed.nonce ?? 0,
    to: parsed.to as Hex,
    gas: parsed.gas ?? 0n,
    value: parsed.value ?? 0n,
    maxFeePerGas: parsed.maxFeePerGas ?? 0n,
    maxPriorityFeePerGas: parsed.maxPriorityFeePerGas ?? 0n,
    calldata: (parsed.data ?? '0x') as Hex,
    accessListEntries: parsed.accessList?.length ?? 0,
  }
}

export interface CardMoveEnvelopeRequest {
  readonly seat: number
  readonly move: CardDuelEntryPoint
  /** The duel contract this room pins. The envelope's only call target. */
  readonly duelAddress: Hex
  /** `room_chain_id_v5(deploymentDomain, roomId)`. */
  readonly chainId: number
  readonly nonce: number
  /** Exactly the bytes `buildCardMoveCalldata` produced. Nothing else. */
  readonly calldata: Hex
}

export interface CardMoveEnvelope {
  readonly seat: number
  readonly move: CardDuelEntryPoint
  /** Recovered from the signature, not copied from the request. */
  readonly signer: Hex
  readonly signedTransaction: Hex
  readonly bytes: number
  readonly fields: CardEnvelopeFields
}

const HEX_BYTES = /^0x([0-9a-fA-F]{2})+$/

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

/**
 * Sign one move as the seat that proved it.
 *
 * Everything after `signTransaction` is verification, not construction: the
 * envelope is decoded back and every field compared against what was asked for,
 * and the sender is RECOVERED from the signature and compared against the
 * address the circuit's `player` public input commits to. A mismatch throws
 * here - in a browser, with the two addresses in the message - instead of
 * failing inside the guest after a checkpoint has already spent its GPU time.
 */
export async function signCardMoveEnvelope(
  request: CardMoveEnvelopeRequest,
): Promise<CardMoveEnvelope> {
  if (!HEX_BYTES.test(request.calldata) || request.calldata.length < 10) {
    throw new Error('a duel move envelope carries a selector and its ABI-encoded arguments')
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(request.duelAddress)) {
    throw new Error('a duel move envelope needs the duel contract address to call')
  }
  if (!Number.isSafeInteger(request.chainId) || request.chainId <= 0) {
    throw new Error('a duel move envelope needs the room chain id')
  }
  if (!Number.isSafeInteger(request.nonce) || request.nonce < 0) {
    throw new Error('a duel move envelope needs a non-negative transaction nonce')
  }
  const account = cardDemoSeatAccount(request.seat)
  const gas = cardMoveGasLimit(request.move)
  const signedTransaction = (await account.signTransaction({
    type: 'eip1559',
    chainId: request.chainId,
    nonce: request.nonce,
    to: request.duelAddress as ViemHex,
    value: 0n,
    data: request.calldata as ViemHex,
    gas,
    // Free-gas L2: a non-zero cap is refused by `raw::inspect_one` by name.
    maxFeePerGas: 0n,
    maxPriorityFeePerGas: 0n,
    accessList: [],
  })) as Hex

  const fields = cardEnvelopeFields(signedTransaction)
  if (fields.calldata.toLowerCase() !== request.calldata.toLowerCase()) {
    throw new Error('the signed envelope does not carry the calldata that was built for it')
  }
  if (!sameAddress(fields.to, request.duelAddress)) {
    throw new Error('the signed envelope does not call the duel contract it was built for')
  }
  if (fields.chainId !== request.chainId || fields.nonce !== request.nonce) {
    throw new Error('the signed envelope does not carry the chain id and nonce it was built for')
  }
  if (fields.gas !== gas) throw new Error('the signed envelope does not carry its gas budget')
  if (fields.value !== 0n) throw new Error('a duel move transfers no ether')
  if (fields.maxFeePerGas !== 0n || fields.maxPriorityFeePerGas !== 0n) {
    throw new Error('a room runs on free gas, so a duel move may not bid a fee')
  }
  if (fields.accessListEntries !== 0) {
    throw new Error('a duel move carries no access list')
  }

  const signer = (await recoverTransactionAddress({
    serializedTransaction: signedTransaction as never,
  })) as Hex
  const owner = account.address
  if (!sameAddress(signer, owner)) {
    throw new Error(
      `this envelope recovers to ${signer} but seat ${request.seat} is owned by ${owner}`,
    )
  }
  return {
    seat: request.seat,
    move: request.move,
    signer,
    signedTransaction,
    bytes: (signedTransaction.length - 2) / 2,
    fields,
  }
}
