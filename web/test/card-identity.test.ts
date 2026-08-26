import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import {
  CARD_DEMO_IDENTITY_NOTICE,
  CARD_DEMO_SEAT_COUNT,
  CARD_DEMO_ENTRY_STAKE,
  CARD_DEMO_FUNDED_AMOUNT,
  CARD_DEMO_SEAT_OWNERS,
  cardDemoIdentity,
  cardDemoSeatAccount,
  cardDemoSeatKey,
} from '../lib/card/identity'
import {
  cardEnvelopeFields,
  cardMoveGasLimit,
  cardRoomChainIdV5,
  signCardMoveEnvelope,
} from '../lib/card/envelope'
import { buildCardMoveCalldata } from '../lib/card/calldata'

/**
 * THE ONE PROPERTY THIS FILE EXISTS FOR: the address a seat's Groth16 proof
 * commits to and the address that signs its transaction are the same address.
 *
 * `owner` is a public input of the card circuits and the account
 * `HiddenCardDuelV5` authenticates against, so a split between the proving
 * identity and the signing identity does not fail at the edge - the envelope is
 * admitted, the batch is proved, and the GUEST rejects it seventeen seconds
 * later with no address in the message. Every assertion below is a tripwire on
 * a future edit that separates them again.
 *
 * The keys themselves are pinned to the prover host's own derivation
 * (`SigningKey::from_bytes(index + 1)` in `v5_fixture/signing.rs`) because
 * those are the addresses a card room's cold state funds with `RoomToken`. An
 * owner the cold state does not fund cannot pass `registerDuelist`, whatever it
 * proves.
 */
const identity = cardDemoIdentity()

/**
 * The addresses of private keys 1 and 2. Written out ONCE, here, as the
 * external fact this app is pinned to - `server/src/card-request.ts` derives
 * the same two for the cold state's stake-token balances.
 */
const HOST_FIXTURE_SIGNERS = [
  '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
  '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF',
] as const

describe('the seat key, the seat owner and the circuit player are one thing', () => {
  it('derives every seat address from the seat key and nothing else', () => {
    expect(CARD_DEMO_SEAT_OWNERS.length).toBe(CARD_DEMO_SEAT_COUNT)
    for (let seat = 0; seat < CARD_DEMO_SEAT_COUNT; seat += 1) {
      const key = cardDemoSeatKey(seat)
      const derived = privateKeyToAccount(key as `0x${string}`).address
      expect(cardDemoSeatAccount(seat).address).toBe(derived)
      expect(CARD_DEMO_SEAT_OWNERS[seat]).toBe(derived)
      expect(identity.seats[seat as 0 | 1].owner).toBe(derived)
      // `_authorize` accepts the session key as msg.sender. The browser holds
      // exactly one key per seat, so it must be that same one.
      expect(identity.seats[seat as 0 | 1].sessionKey).toBe(derived)
    }
  })

  it('makes the circuit player public input the numeric form of that same address', () => {
    for (const seat of [0, 1] as const) {
      const owner = identity.seats[seat].owner
      // `player` is public input 2 of both card circuits and is the uint160 of
      // the owner. Compared as a NUMBER so a case or padding change cannot hide
      // a different address behind an equal-looking string.
      expect(BigInt(identity.seats[seat].playerField)).toBe(BigInt(owner))
      expect(identity.seats[seat].playerField).toMatch(/^[1-9][0-9]*$/)
    }
  })

  it('is pinned to the prover host fixture keys the cold state funds', () => {
    for (const seat of [0, 1] as const) {
      expect(cardDemoSeatKey(seat)).toBe(
        `0x${(seat + 1).toString(16).padStart(64, '0')}`,
      )
      expect(identity.seats[seat].owner).toBe(HOST_FIXTURE_SIGNERS[seat])
    }
  })

  it('gives the two seats different owners, which joinDuel requires', () => {
    expect(identity.seats[0].owner.toLowerCase()).not.toBe(identity.seats[1].owner.toLowerCase())
  })

  it('refuses a seat that does not exist rather than deriving a third key', () => {
    expect(() => cardDemoSeatKey(2)).toThrow(/two seats|seats, numbered/)
    expect(() => cardDemoSeatKey(-1)).toThrow(/seats/)
  })
})

describe('the signature and the proof commit to the same address', () => {
  const chainId = cardRoomChainIdV5(`0x${'ab'.repeat(32)}`, '7')

  it('recovers each seat owner out of the signature it produced', async () => {
    for (const seat of [0, 1] as const) {
      const calldata = buildCardMoveCalldata({
        move: 'registerDuelist',
        registration: {
          index: seat,
          sessionKey: identity.seats[seat].sessionKey,
          sessionExpiry: 4_102_444_800n,
          fundedAmount: identity.entryStake,
          emptyLeafProof: [],
        },
      })
      const envelope = await signCardMoveEnvelope({
        seat,
        move: 'registerDuelist',
        duelAddress: identity.duelAddress,
        chainId,
        nonce: 0,
        calldata: calldata.calldata,
      })
      // Recovered from the signature, not copied from the request: this is the
      // address the executor will treat as `msg.sender`.
      expect(envelope.signer.toLowerCase()).toBe(identity.seats[seat].owner.toLowerCase())
      // ... and the same address the proof's `player` public input carries.
      expect(BigInt(envelope.signer)).toBe(BigInt(identity.seats[seat].playerField))
      expect(cardEnvelopeFields(envelope.signedTransaction).gas).toBe(
        cardMoveGasLimit('registerDuelist'),
      )
    }
  })

  it('signs a registration for more gas than a move, as the room request declares', () => {
    expect(cardMoveGasLimit('registerDuelist')).toBe(700_000n)
    expect(cardMoveGasLimit('draw')).toBe(600_000n)
    expect(cardMoveGasLimit('attack')).toBe(600_000n)
  })
})

describe('what the console tells the room about who is playing', () => {
  it('says plainly that the seat is a public demo key and not a wallet', () => {
    expect(CARD_DEMO_IDENTITY_NOTICE).toMatch(/not your wallet/i)
    expect(CARD_DEMO_IDENTITY_NOTICE).toMatch(/Anyone can sign for it/i)
    expect(identity.notice).toBe(CARD_DEMO_IDENTITY_NOTICE)
    for (const seat of [0, 1] as const) {
      expect(identity.seats[seat].demoKeyNote).toBe(
        `well-known demo key 0x${(seat + 1).toString(16).padStart(2, '0')}`,
      )
    }
  })
})

/**
 * `registerDuelist` escrows `fundedAmount`, and `CardDuelBaseV5._stake` refuses
 * any move whose running `paymentSpent` would pass it. `openDuel`/`joinDuel`
 * already spend one entry stake, so registering for exactly one stake wedges
 * the seat on its first paid move. The room's cold state provisions four
 * stakes per seat (CARD_ROOM_FUNDED_AMOUNT, server/src/card-request.ts);
 * these tests fail if the browser and the coordinator drift apart on that.
 */
describe('duel escrow headroom', () => {
  it('funds registration with more than the single stake a duel spends', () => {
    expect(CARD_DEMO_FUNDED_AMOUNT).toBe(4n * CARD_DEMO_ENTRY_STAKE)
    expect(CARD_DEMO_FUNDED_AMOUNT).toBeGreaterThan(CARD_DEMO_ENTRY_STAKE)
  })

  it('exposes the funded amount on the identity, not just the stake', () => {
    const identity = cardDemoIdentity('0x5FbDB2315678afecb367f032d93F642f64180aa3')
    expect(identity.fundedAmount).toBe(CARD_DEMO_FUNDED_AMOUNT)
    expect(identity.entryStake).toBe(CARD_DEMO_ENTRY_STAKE)
    // Opening or joining spends one stake; the seat must still have headroom.
    expect(identity.fundedAmount - identity.entryStake).toBeGreaterThan(0n)
  })
})
