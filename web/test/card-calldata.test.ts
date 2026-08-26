import { describe, expect, it } from 'vitest'
import {
  CARD_DUEL_ENTRY_POINT_SIGNATURES,
  CARD_DUEL_SELECTORS,
  type CardDuelEntryPoint,
} from '@zkdeal/protocol'
import { decodeAbiParameters, toFunctionSelector } from 'viem'
import { buildCardMoveCalldata, cardFieldToBytes32 } from '../lib/card/calldata'
import { cardRegisteredParticipant } from '../lib/card/participants'
import { cardDemoIdentity } from '../lib/card/identity'

/**
 * The published argument list of every duel entry point, pinned.
 *
 * Hand contents cannot be scanned for in raw calldata - a card id is one byte
 * and indistinguishable from any counter - so the guarantee that they never
 * reach the wire rests on this: the complete, enumerated set of arguments each
 * move carries. If a witness field is ever added to `CardMoveRequest` and
 * routed into an encoder, one of these lists changes.
 */
const identity = cardDemoIdentity()
const PROOF_256 = `0x${'cd'.repeat(256)}` as const
const ROOT = cardFieldToBytes32('12345678901234567890')

const previous = cardRegisteredParticipant({
  index: 0,
  owner: identity.seats[0].owner,
  sessionKey: identity.seats[0].sessionKey,
  sessionExpiry: 4_102_444_800n,
  fundedAmount: identity.entryStake,
})
const shared = { previous, participantProof: [ROOT], duelId: 1n } as const

const EXPECTED_ARGUMENTS: Record<string, readonly string[]> = {
  registerDuelist: ['index', 'sessionKey', 'fundedAmount'],
  openDuel: [],
  joinDuel: ['duelId'],
  abandonDuel: ['duelId'],
  initializeDeck: ['duelId', 'deckRoot', 'emptyHandRoot', 'innerProof'],
  commitSeed: ['duelId', 'commitment'],
  revealSeed: ['duelId', 'seed'],
  draw: ['duelId', 'newHandRoot', 'innerProof'],
  burn: ['duelId', 'newHandRoot', 'innerProof'],
  play: ['duelId', 'newHandRoot', 'cardId', 'boardSlot', 'innerProof'],
  attack: ['duelId', 'attackerSlot', 'targetSlot'],
  endTurn: ['duelId'],
  concede: ['duelId'],
  claimPrize: ['duelId'],
  withdrawUnspent: [],
}

function build(move: CardDuelEntryPoint) {
  switch (move) {
    case 'registerDuelist':
      return buildCardMoveCalldata({
        move,
        registration: {
          index: 0,
          sessionKey: identity.seats[0].sessionKey,
          sessionExpiry: 4_102_444_800n,
          fundedAmount: identity.entryStake,
          emptyLeafProof: [ROOT],
        },
      })
    case 'initializeDeck':
      return buildCardMoveCalldata({
        ...shared,
        move,
        deckRoot: ROOT,
        emptyHandRoot: ROOT,
        innerProof: PROOF_256,
      })
    case 'commitSeed':
      return buildCardMoveCalldata({ ...shared, move, commitment: ROOT })
    case 'revealSeed':
      return buildCardMoveCalldata({ ...shared, move, seed: ROOT })
    case 'draw':
    case 'burn':
      return buildCardMoveCalldata({ ...shared, move, newHandRoot: ROOT, innerProof: PROOF_256 })
    case 'play':
      return buildCardMoveCalldata({
        ...shared,
        move,
        newHandRoot: ROOT,
        cardId: 7,
        boardSlot: 2,
        innerProof: PROOF_256,
      })
    case 'attack':
      return buildCardMoveCalldata({ ...shared, move, attackerSlot: 1, targetSlot: 255 })
    default:
      return buildCardMoveCalldata({ ...shared, move })
  }
}

describe('card move calldata', () => {
  it('uses the compiled selector for every entry point', () => {
    for (const move of Object.keys(CARD_DUEL_ENTRY_POINT_SIGNATURES) as CardDuelEntryPoint[]) {
      const calldata = build(move)
      expect(calldata.signature).toBe(CARD_DUEL_ENTRY_POINT_SIGNATURES[move])
      expect(calldata.selector).toBe(CARD_DUEL_SELECTORS[move])
      // Independently derived, so a wrong signature table would show up here
      // rather than as a transaction that reaches the wrong function.
      expect(calldata.selector).toBe(toFunctionSelector(CARD_DUEL_ENTRY_POINT_SIGNATURES[move]))
      expect(calldata.calldata.startsWith(calldata.selector)).toBe(true)
      expect(calldata.bytes).toBe((calldata.calldata.length - 2) / 2)
    }
  })

  it('publishes exactly the enumerated arguments and nothing else', () => {
    for (const move of Object.keys(EXPECTED_ARGUMENTS) as CardDuelEntryPoint[]) {
      expect(build(move).published.map((field) => field.name)).toEqual(EXPECTED_ARGUMENTS[move])
    }
  })

  it('round-trips the participant tuple so a move cannot be silently mis-encoded', () => {
    const calldata = build('endTurn')
    const [participant, proof, duelId] = decodeAbiParameters(
      [
        {
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
        },
        { type: 'bytes32[]' },
        { type: 'uint64' },
      ],
      // `@zkdeal/protocol`'s Hex is a plain string; viem wants the template type.
      calldata.args as `0x${string}`,
    )
    expect(participant.owner.toLowerCase()).toBe(previous.owner.toLowerCase())
    expect(participant.spendLimit).toBe(identity.entryStake)
    expect(participant.nonce).toBe(0n)
    expect(proof).toEqual([ROOT])
    expect(duelId).toBe(1n)
  })

  it('refuses an inner proof that is not the 256-byte adapter payload', () => {
    expect(() =>
      buildCardMoveCalldata({ ...shared, move: 'draw', newHandRoot: ROOT, innerProof: '0xdeadbeef' }),
    ).toThrow(/256-byte/)
  })

  it('refuses a move that is missing its participant proof', () => {
    expect(() => buildCardMoveCalldata({ move: 'endTurn', previous, duelId: 1n })).toThrow(
      /participant Merkle proof/,
    )
  })
})
