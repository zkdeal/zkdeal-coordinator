import { describe, expect, it } from 'vitest'
import { roomChainId, roomChainIdV5 } from '@zkdeal/protocol'
import { createCardWitnessBundle, type CardWitnessBundle } from '@zkdeal/card'
import {
  cardEnvelopeFields,
  cardRoomChainIdV5,
  cardRoomSigning,
  cardSeatNonce,
  signCardMoveEnvelope,
} from '../lib/card/envelope'
import { cardDemoIdentity } from '../lib/card/identity'
import { cardMoveBody } from '../lib/card/demo-room'
import {
  CARD_WITNESS_FIELD_NAMES,
  assertNoWitnessFieldNames,
  auditCardCalldata,
  cardBundleSecrets,
  cardBundleSecretTexts,
} from '../lib/card/privacy'
import { entry } from './helpers/card-settlement-fixtures'

/**
 * The envelope half of a duel move: chain id, nonce, wire shape, and the
 * privacy boundary the signature must not widen.
 *
 * The identity half - signer address versus the circuit's `player` public input
 * - is asserted in `card-identity.test.ts`.
 */
const identity = cardDemoIdentity()
const DEPLOYMENT_DOMAIN = `0x${'3c'.repeat(32)}`
const CALLDATA = `0x1234abcd${'11'.repeat(96)}`

describe('the chain id a room signs under', () => {
  it('is room_chain_id_v5(deploymentDomain, roomId), not a constant', () => {
    expect(cardRoomChainIdV5(DEPLOYMENT_DOMAIN, '42')).toBe(
      Number(roomChainIdV5(DEPLOYMENT_DOMAIN, 42n)),
    )
    // AND NOT THE v4 DERIVATION. `room_chain_id_v5` hashes a different typehash
    // preimage (`RoomChainIdV5(...)` vs `RoomChainIdV4(...)`), so the two return
    // different numbers. This console signed with the v4 one, which meant every
    // envelope it produced was refused at admission by `raw.rs::inspect_one`
    // ("transaction is signed for chain X, but this room is chain Y") - a
    // failure no local test could see because the chain id is only ever checked
    // on the far side of the wire.
    expect(cardRoomChainIdV5(DEPLOYMENT_DOMAIN, '42')).not.toBe(
      Number(roomChainId(DEPLOYMENT_DOMAIN, 42n)),
    )
    // A different room on the same deployment is a different chain, which is
    // what stops a move being replayed from one room into another.
    expect(cardRoomChainIdV5(DEPLOYMENT_DOMAIN, '42')).not.toBe(
      cardRoomChainIdV5(DEPLOYMENT_DOMAIN, '43'),
    )
    expect(cardRoomChainIdV5(DEPLOYMENT_DOMAIN, '42')).not.toBe(
      cardRoomChainIdV5(`0x${'7d'.repeat(32)}`, '42'),
    )
  })

  it('is always a safe JavaScript integer, because EIP-155 v depends on it', () => {
    for (const room of ['0', '1', '42', '18446744073709551615']) {
      const chainId = cardRoomChainIdV5(DEPLOYMENT_DOMAIN, room)
      expect(Number.isSafeInteger(chainId)).toBe(true)
      expect(chainId).toBeGreaterThan(0)
    }
  })

  it('refuses to guess a missing deployment domain or room id', () => {
    expect(() => cardRoomChainIdV5('', '1')).toThrow(/deployment domain/)
    expect(() => cardRoomChainIdV5('0xabc', '1')).toThrow(/deployment domain/)
    expect(() => cardRoomChainIdV5(DEPLOYMENT_DOMAIN, '')).toThrow(/uint64 id/)
    expect(() => cardRoomChainIdV5(DEPLOYMENT_DOMAIN, 'room-7')).toThrow(/uint64 id/)
  })

  it('names the missing input rather than signing under a guessed chain', () => {
    expect(cardRoomSigning(DEPLOYMENT_DOMAIN, '7')).toEqual({
      chainId: cardRoomChainIdV5(DEPLOYMENT_DOMAIN, '7'),
      reason: null,
    })
    const undeployed = cardRoomSigning(DEPLOYMENT_DOMAIN, null)
    expect(undeployed.chainId).toBeNull()
    expect(undeployed.reason).toMatch(/no on-chain id yet/)
    const noDomain = cardRoomSigning(null, '7')
    expect(noDomain.chainId).toBeNull()
    expect(noDomain.reason).toMatch(/deployment domain/)
    const malformed = cardRoomSigning('0xnope', '7')
    expect(malformed.chainId).toBeNull()
    expect(malformed.reason).toMatch(/deployment domain/)
  })
})

describe('the nonce a seat signs with', () => {
  /**
   * Two seats interleaved, and the first four already proved by checkpoint one.
   * This is exactly the state a duel is in after its first batch lands, and the
   * state where a naive "count what is pending" nonce restarts at zero and every
   * subsequent transaction is rejected for a consumed nonce.
   */
  const entries = [
    entry({ sequence: 1, seat: 0, status: 'checkpointed', checkpointIndex: 1 }),
    entry({ sequence: 2, seat: 1, status: 'checkpointed', checkpointIndex: 1 }),
    entry({ sequence: 3, seat: 0, status: 'checkpointed', checkpointIndex: 1 }),
    entry({ sequence: 4, seat: 1, status: 'checkpointed', checkpointIndex: 1 }),
    entry({ sequence: 5, seat: 0, status: 'submitted' }),
    entry({ sequence: 6, seat: 1, status: 'rehearsed' }),
    entry({ sequence: 7, seat: 0, status: 'rehearsed' }),
  ]

  it('counts that seat\'s own moves and ignores the other seat\'s', () => {
    expect(entries.map((item) => cardSeatNonce(entries, item.seat, item.sequence))).toEqual([
      0, 0, 1, 1, 2, 2, 3,
    ])
  })

  it('keeps advancing across a checkpoint instead of restarting at zero', () => {
    // Sequences 1..4 are already proven on L1; the room's account nonces moved
    // with them. The next move for seat 0 must be nonce 2, not nonce 0.
    expect(cardSeatNonce(entries, 0, 5)).toBe(2)
    expect(cardSeatNonce(entries, 1, 6)).toBe(2)
    expect(cardSeatNonce(entries, 0, 7)).toBe(3)
    // And it never repeats a value for one seat, whatever the statuses are.
    for (const seat of [0, 1] as const) {
      const used = entries
        .filter((item) => item.seat === seat)
        .map((item) => cardSeatNonce(entries, seat, item.sequence))
      expect(new Set(used).size).toBe(used.length)
      expect([...used].sort((left, right) => left - right)).toEqual(used)
    }
  })

  it('is a pure function of the log, so asking twice gives the same answer', () => {
    expect(cardSeatNonce(entries, 0, 7)).toBe(cardSeatNonce(entries, 0, 7))
  })

  it('signs consecutive nonces for a seat across two batches', async () => {
    const chainId = cardRoomChainIdV5(DEPLOYMENT_DOMAIN, '7')
    const signed = await Promise.all(
      entries
        .filter((item) => item.seat === 0)
        .map((item) =>
          signCardMoveEnvelope({
            seat: 0,
            move: 'draw',
            duelAddress: identity.duelAddress,
            chainId,
            nonce: cardSeatNonce(entries, 0, item.sequence),
            calldata: CALLDATA,
          }),
        ),
    )
    expect(signed.map((item) => cardEnvelopeFields(item.signedTransaction).nonce)).toEqual([
      0, 1, 2, 3,
    ])
  })
})

describe('what a signed envelope actually contains', () => {
  const chainId = cardRoomChainIdV5(DEPLOYMENT_DOMAIN, '7')

  it('decodes back to exactly the calldata, target, chain id and nonce it was built for', async () => {
    const envelope = await signCardMoveEnvelope({
      seat: 1,
      move: 'play',
      duelAddress: identity.duelAddress,
      chainId,
      nonce: 5,
      calldata: CALLDATA,
    })
    const fields = cardEnvelopeFields(envelope.signedTransaction)
    expect(fields.calldata.toLowerCase()).toBe(CALLDATA.toLowerCase())
    expect(fields.to.toLowerCase()).toBe(identity.duelAddress.toLowerCase())
    expect(fields.chainId).toBe(chainId)
    expect(fields.nonce).toBe(5)
    expect(fields.gas).toBe(600_000n)
    expect(fields.value).toBe(0n)
    // A room runs on free gas; `raw::inspect_one` refuses a fee-bearing move.
    expect(fields.maxFeePerGas).toBe(0n)
    expect(fields.maxPriorityFeePerGas).toBe(0n)
    expect(fields.accessListEntries).toBe(0)
    // Nothing beyond the envelope's own overhead rides along with the calldata:
    // an EIP-1559 envelope adds a type byte, a short RLP header and a 65-byte
    // signature, so a payload materially larger than that is carrying something.
    const overhead = envelope.bytes - (CALLDATA.length - 2) / 2
    expect(overhead).toBeGreaterThan(0)
    expect(overhead).toBeLessThan(128)
  })

  it('refuses a request it cannot honestly sign', async () => {
    const base = {
      seat: 0,
      move: 'draw' as const,
      duelAddress: identity.duelAddress,
      chainId,
      nonce: 0,
      calldata: CALLDATA,
    }
    await expect(signCardMoveEnvelope({ ...base, calldata: '0x1234' })).rejects.toThrow(
      /selector and its ABI-encoded arguments/,
    )
    await expect(signCardMoveEnvelope({ ...base, calldata: '0xzz' })).rejects.toThrow(
      /selector and its ABI-encoded arguments/,
    )
    await expect(signCardMoveEnvelope({ ...base, duelAddress: '0x00' })).rejects.toThrow(
      /duel contract address/,
    )
    await expect(signCardMoveEnvelope({ ...base, chainId: 0 })).rejects.toThrow(/room chain id/)
    await expect(signCardMoveEnvelope({ ...base, nonce: -1 })).rejects.toThrow(/nonce/)
  })

  it('rejects bytes that are not an EIP-1559 room transaction', () => {
    expect(() => cardEnvelopeFields(`0x${'11'.repeat(80)}`)).toThrow()
  })
})

describe('the privacy boundary the signature must not widen', () => {
  it('carries no hidden material, measured against a real witness bundle', async () => {
    const bundles: CardWitnessBundle[] = []
    for (const seat of [0, 1] as const) {
      bundles.push(
        await createCardWitnessBundle({
          domain: identity.proofDomainField,
          duelId: identity.duelId.toString(10),
          player: identity.seats[seat].playerField,
        }),
      )
    }
    const secrets = bundles.flatMap((bundle) => cardBundleSecrets(bundle))
    const texts = bundles.flatMap((bundle) => cardBundleSecretTexts(bundle))
    expect(secrets.length).toBeGreaterThan(0)

    const chainId = cardRoomChainIdV5(DEPLOYMENT_DOMAIN, '7')
    for (const seat of [0, 1] as const) {
      const envelope = await signCardMoveEnvelope({
        seat,
        move: 'draw',
        duelAddress: identity.duelAddress,
        chainId,
        nonce: seat,
        calldata: CALLDATA,
      })
      // The signature is over public bytes and adds none of its own: a salt or
      // a deck order appearing anywhere in the envelope would be a leak.
      auditCardCalldata(secrets, envelope.signedTransaction, 'card move envelope')
      const body = cardMoveBody({
        roomId: 'room-1',
        actorId: `seat-${seat}`,
        move: 'draw',
        calldata: CALLDATA,
        signedTransaction: envelope.signedTransaction,
        block: 1,
      })
      // The whole request body, not just the envelope: field NAMES survive JSON
      // where hex values would not, so both are checked.
      assertNoWitnessFieldNames(body, 'card move request')
      const serialized = JSON.stringify(body)
      auditCardCalldata(secrets, `0x${Buffer.from(serialized).toString('hex')}`, 'card move body')
      for (const text of texts) expect(serialized).not.toContain(text)
      for (const name of CARD_WITNESS_FIELD_NAMES) {
        expect(serialized.toLowerCase()).not.toContain(name.toLowerCase())
      }
      expect(Object.keys(body).sort()).toEqual([
        'actionId',
        'actorId',
        'block',
        'calldata',
        'signedTransaction',
      ])
    }
  })
})
