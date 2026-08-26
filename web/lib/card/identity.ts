/**
 * The identities this stand duels with - proving identity and signing identity
 * as ONE thing.
 *
 * `owner` is a public input of the card circuits (public input 2, `player`) AND
 * the address `HiddenCardDuelV5` authenticates a move against. So the key that
 * signs a seat's EIP-1559 envelope must be the key whose address the seat's
 * Groth16 proof commits to. When those two drift, nothing fails at the edge:
 * the envelope is admitted, the batch is proved, and the guest rejects it
 * halfway through a seventeen-second GPU run with no address in the message.
 *
 * They cannot drift here because there is exactly one source for both.
 * `cardDemoSeatKey(seat)` is the only place a seat's key is written down;
 * `owner`, `sessionKey` and `playerField` are all read off the account that key
 * derives, and `signCardMoveEnvelope` signs with the same account.
 * `test/card-identity.test.ts` fails if any of those four stop agreeing.
 *
 * WHICH KEYS, AND WHY THESE. The prover host derives its fixture EOAs as
 * `SigningKey::from_bytes(index + 1)` (`v5_fixture/signing.rs`), so seat zero is
 * the well-known private key 1 and seat one private key 2. Those are the exact
 * addresses a card room's cold state funds with `RoomToken` and grants an
 * allowance to (`server/src/card-request.ts` →
 * `CARD_ROOM_DUELIST_OWNERS`), so they are the only addresses whose
 * `registerDuelist` can pass `transferFrom`. They are also distinct, which
 * `CardDuelBaseV5.joinDuel` requires of the two seats.
 *
 * THEY ARE PUBLIC. Anyone can sign for these seats. This console is a
 * presentation stand playing a demo identity, not a wallet, and the UI says so
 * next to every seat - see `CARD_DEMO_IDENTITY_NOTICE`.
 *
 * `proofDomain` is public input 0 of every card circuit and is
 * `keccak256(abi.encode(roomApplicationDomain, address(this))) % p`, written by
 * `HiddenCardDuelV5`'s constructor into storage slot 5. It is NOT derivable
 * without the deployed address, so it is recomputed here from whatever address
 * the operator points the console at - and a browser talking to a real duel
 * should read `proofDomain()` back from that contract and compare.
 *
 * NOTE ON THE TRACKED CIRCUIT FIXTURES. `circuits/fixtures/card-*-v5.json` were
 * generated against anvil account one (`0x7099…79C8`) as `player`, which these
 * seats deliberately are no longer: a proof committing to `0x7099…` cannot be
 * settled, because the room's cold state holds no stake for that address and
 * nothing in this browser can sign for it. The fixtures stay valid for the
 * Foundry verifier tests that consume them; a proof this console produces is
 * bound to a different `player` and is not interchangeable with them.
 */
import {
  CARD_APPLICATION_DOMAIN,
  CARD_PARTICIPANT_CAPACITY,
  cardProofDomain,
  type Hex,
} from '@zkdeal/protocol'
import { numberToHex, type Hex as ViemHex } from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'

/** The duel address the card fixtures were generated against. */
export const CARD_DEMO_DUEL_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as Hex

/** Seats a duel has. Two, and `joinDuel` requires their owners to differ. */
export const CARD_DEMO_SEAT_COUNT = 2

/** What the UI must say next to a seat, verbatim. Not a paraphrase. */
export const CARD_DEMO_IDENTITY_NOTICE =
  'Demo identity, not your wallet: this seat is signed by a well-known public test key ' +
  '(private key 0x01 / 0x02) that every zkdeal stand funds. Anyone can sign for it.'

/**
 * The ONE place a seat's private key is written down.
 *
 * Mirrors `roster_signing_key` in `zkvm/crates/risc0/host/src/v5_fixture/
 * signing.rs`: key `index + 1`, big-endian in 32 bytes. Nothing else in this
 * app may spell a key, an address or a player field element.
 */
export function cardDemoSeatKey(seat: number): Hex {
  if (!Number.isSafeInteger(seat) || seat < 0 || seat >= CARD_DEMO_SEAT_COUNT) {
    throw new Error(`a duel has ${CARD_DEMO_SEAT_COUNT} seats, numbered from zero`)
  }
  return numberToHex(BigInt(seat) + 1n, { size: 32 })
}

/**
 * The signing account for a seat, memoized: deriving a secp256k1 public key is
 * not free and every move asks for the same two.
 *
 * This is the account `signCardMoveEnvelope` signs with AND the account
 * `cardDemoIdentity` reads `owner` off, which is the whole point.
 */
const ACCOUNTS = new Map<number, PrivateKeyAccount>()
export function cardDemoSeatAccount(seat: number): PrivateKeyAccount {
  const cached = ACCOUNTS.get(seat)
  if (cached) return cached
  // `@zkdeal/protocol`'s `Hex` is an unbranded string alias, so the cast is a
  // no-op that only tells viem the shape `cardDemoSeatKey` already guarantees.
  const account = privateKeyToAccount(cardDemoSeatKey(seat) as ViemHex)
  ACCOUNTS.set(seat, account)
  return account
}

/**
 * Seat owners, in participant-index order. Derived, never pasted: these are the
 * addresses a card room's cold state funds, and a literal here could be edited
 * away from the key that signs.
 */
export const CARD_DEMO_SEAT_OWNERS: readonly Hex[] = Object.freeze(
  Array.from(
    { length: CARD_DEMO_SEAT_COUNT },
    (_unused, seat) => cardDemoSeatAccount(seat).address as Hex,
  ),
)

/** `RoomToken` units staked by each seat; the pot is twice this. */
export const CARD_DEMO_ENTRY_STAKE = 10n ** 18n
/**
 * What `registerDuelist` escrows into the duel, which is NOT the entry stake.
 *
 * `CardDuelBaseV5._stake` refuses any move whose running `paymentSpent` would
 * pass the seat's `fundedAmount`, and `openDuel`/`joinDuel` already spend one
 * entry stake. Registering with exactly one stake therefore leaves the seat
 * with zero headroom and wedges it on its first paid move. The room's cold
 * state funds and grants an allowance of four stakes per seat
 * (`CARD_ROOM_FUNDED_AMOUNT` in server/src/card-request.ts) - register
 * for that same amount, or the transferFrom escrows less than the room
 * provisioned. These two constants must move together.
 */
export const CARD_DEMO_FUNDED_AMOUNT = 4n * CARD_DEMO_ENTRY_STAKE
export const CARD_DEMO_DUEL_ID = 1n
/** 2100-01-01, so a demo session key never expires mid-presentation. */
export const CARD_DEMO_SESSION_EXPIRY = 4_102_444_800n

export interface CardDemoSeat {
  readonly owner: Hex
  /**
   * The key that actually signs a move. `_authorize` accepts `msg.sender ==
   * sessionKey` while the expiry holds, which is what lets a duel proceed
   * under VALIDITY_ONLY with no checkpoint consensus from either customer.
   *
   * Equal to `owner` here: the browser holds one key per seat, so making the
   * session key a second address would mean holding a key the circuit's
   * `player` input does not commit to.
   */
  readonly sessionKey: Hex
  readonly participantIndex: number
  /** The owner as the field element public input 2 carries. */
  readonly playerField: string
  /** What the UI must show beside this seat. A demo key is not a wallet. */
  readonly demoKeyNote: string
}

export interface CardDemoIdentity {
  readonly duelAddress: Hex
  readonly roomApplicationDomain: Hex
  /** `proofDomain` as bytes32, the form the read-model and commitments hash. */
  readonly proofDomain: Hex
  /** The same value as the decimal field element the circuits take. */
  readonly proofDomainField: string
  readonly duelId: bigint
  readonly entryStake: bigint
  /** Escrowed by `registerDuelist`; four entry stakes, see the constant. */
  readonly fundedAmount: bigint
  readonly participantCapacity: number
  readonly seats: readonly [CardDemoSeat, CardDemoSeat]
  /** The single sentence a presenter must be able to read off the screen. */
  readonly notice: string
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

export function cardDemoIdentity(
  duelAddress: string = CARD_DEMO_DUEL_ADDRESS,
): CardDemoIdentity {
  if (!ADDRESS.test(duelAddress)) {
    throw new Error('the duel contract address must be a 20-byte 0x-prefixed address')
  }
  const domain = cardProofDomain(CARD_APPLICATION_DOMAIN, duelAddress as Hex)
  const seat = (index: 0 | 1): CardDemoSeat => {
    // Read off the ACCOUNT, so the address that signs and the address the proof
    // commits to are the same value and not two copies of one.
    const address = cardDemoSeatAccount(index).address as Hex
    return {
      owner: address,
      sessionKey: address,
      participantIndex: index,
      playerField: BigInt(address).toString(10),
      demoKeyNote: `well-known demo key 0x${(index + 1).toString(16).padStart(2, '0')}`,
    }
  }
  return {
    duelAddress: duelAddress as Hex,
    roomApplicationDomain: CARD_APPLICATION_DOMAIN,
    proofDomain: `0x${domain.toString(16).padStart(64, '0')}` as Hex,
    proofDomainField: domain.toString(10),
    duelId: CARD_DEMO_DUEL_ID,
    entryStake: CARD_DEMO_ENTRY_STAKE,
    fundedAmount: CARD_DEMO_FUNDED_AMOUNT,
    participantCapacity: CARD_PARTICIPANT_CAPACITY,
    seats: [seat(0), seat(1)],
    notice: CARD_DEMO_IDENTITY_NOTICE,
  }
}
