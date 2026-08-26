import { describe, expect, it } from 'vitest'
import { createCardWitnessBundle, prepareCardHandAction, CardHandActionKind } from '@zkdeal/card'
import { buildCardMoveCalldata, cardFieldToBytes32 } from '../lib/card/calldata'
import { cardDemoIdentity } from '../lib/card/identity'
import {
  assertNoWitnessFieldNames,
  auditCardCalldata,
  auditCardText,
  cardBundleSecretTexts,
  cardBundleSecrets,
  CardPrivacyError,
  CARD_WITNESS_FIELD_NAMES,
} from '../lib/card/privacy'
import { cardRegisteredParticipant } from '../lib/card/participants'

/**
 * The privacy boundary, measured rather than asserted in prose.
 *
 * These tests build the SAME calldata the console publishes, from a REAL
 * witness bundle (real WebCrypto salts, a real Poseidon deck commitment, a real
 * prepared hand action), and then check the finished bytes for that bundle's
 * own secrets. If a future edit routes a salt, a deck order, a Merkle sibling
 * or a hand slot into a move argument, the audit finds it here rather than on
 * L1 - where, in a VALIDITY_ONLY room, every raw signed transaction is
 * republished verbatim as calldata.
 */
const identity = cardDemoIdentity()
const PROOF_256 = `0x${'ab'.repeat(256)}` as const

function participant() {
  return cardRegisteredParticipant({
    index: 0,
    owner: identity.seats[0].owner,
    sessionKey: identity.seats[0].sessionKey,
    sessionExpiry: 4_102_444_800n,
    fundedAmount: identity.entryStake,
  })
}

async function bundle() {
  return createCardWitnessBundle({
    domain: identity.proofDomainField,
    duelId: identity.duelId.toString(10),
    player: identity.seats[0].playerField,
  })
}

describe('card move calldata carries no witness material', () => {
  it('publishes a deck commitment without the deck order or any salt', async () => {
    const witness = await bundle()
    const calldata = buildCardMoveCalldata({
      move: 'initializeDeck',
      previous: participant(),
      participantProof: [],
      duelId: identity.duelId,
      deckRoot: cardFieldToBytes32(witness.deckRoot),
      emptyHandRoot: cardFieldToBytes32(witness.handRoot),
      innerProof: PROOF_256,
    })
    expect(() =>
      auditCardCalldata(cardBundleSecrets(witness), calldata.calldata),
    ).not.toThrow()
    // And the deck root it DOES publish is genuinely in there, so the audit
    // above is not passing because the payload is empty.
    expect(calldata.calldata.toLowerCase()).toContain(
      cardFieldToBytes32(witness.deckRoot).slice(2).toLowerCase(),
    )
  })

  it('publishes a draw as a root and a proof, with the drawn card and its salt absent', async () => {
    const witness = await bundle()
    const prepared = await prepareCardHandAction(witness, CardHandActionKind.Draw, {
      publicBoardCount: 0,
    })
    const calldata = buildCardMoveCalldata({
      move: 'draw',
      previous: participant(),
      participantProof: [],
      duelId: identity.duelId,
      newHandRoot: cardFieldToBytes32(String(prepared.publicInputs.newHandRoot)),
      innerProof: PROOF_256,
    })
    // Both the pre-move bundle and the bundle the move advances to.
    for (const state of [witness, prepared.nextBundle]) {
      expect(() => auditCardCalldata(cardBundleSecrets(state), calldata.calldata)).not.toThrow()
    }
    // The drawn card id never appears as a published argument either: `draw`
    // has no card argument at all, unlike `play`.
    expect(calldata.published.map((field) => field.name)).toEqual([
      'duelId',
      'newHandRoot',
      'innerProof',
    ])
  })

  it('catches a salt that reached the wire', async () => {
    const witness = await bundle()
    const salt = BigInt(witness.deckSalts[3]!)
    // Simulate the regression this guard exists for: a salt encoded into a
    // bytes32 argument instead of a root.
    const leaked = buildCardMoveCalldata({
      move: 'commitSeed',
      previous: participant(),
      participantProof: [],
      duelId: identity.duelId,
      commitment: cardFieldToBytes32(salt.toString(10)),
    })
    expect(() => auditCardCalldata(cardBundleSecrets(witness), leaked.calldata)).toThrow(
      CardPrivacyError,
    )
  })

  it('never names the matched value in the refusal', async () => {
    const witness = await bundle()
    const salt = witness.deckSalts[0]!
    try {
      auditCardCalldata(cardBundleSecrets(witness), cardFieldToBytes32(salt))
      throw new Error('the audit should have refused')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('hidden witness material')
      expect(message).not.toContain(BigInt(salt).toString(16))
      expect(message).not.toContain(salt)
    }
  })
})

describe('a diagnostic string is audited as text, not as nibbles', () => {
  /**
   * Regression for a real gap: the vault worker used to protect error messages
   * by hex-encoding them and running the CALLDATA audit over the result. That
   * can never match. Hex-encoding `salt 12345678901234567890 rejected` yields
   * the ASCII codes of those digits, and the ASCII of a number does not contain
   * that number's own hex spelling - so a salt quoted in a thrown message
   * passed the check every time. Each case below fails against the old scan.
   */
  const textOnly = async () => {
    const witness = await bundle()
    return { witness, texts: cardBundleSecretTexts(witness) }
  }

  it('refuses a message quoting a salt in decimal', async () => {
    const { witness, texts } = await textOnly()
    const salt = witness.deckSalts[0]!
    expect(() => auditCardText(texts, `deck salt ${salt} was rejected`)).toThrow(CardPrivacyError)
  })

  it('refuses a message quoting a salt in hex, either spelling', async () => {
    const { witness, texts } = await textOnly()
    const hex = BigInt(witness.deckSalts[0]!).toString(16)
    expect(() => auditCardText(texts, `salt 0x${hex} rejected`)).toThrow(CardPrivacyError)
    expect(() => auditCardText(texts, `salt 0x${hex.toUpperCase()} rejected`)).toThrow(
      CardPrivacyError,
    )
  })

  it('refuses a message quoting the deck order', async () => {
    const { witness, texts } = await textOnly()
    expect(() => auditCardText(texts, `deck [${witness.deckCards.join(',')}] is invalid`)).toThrow(
      CardPrivacyError,
    )
  })

  it('demonstrates that the old nibble scan missed all of that', async () => {
    const { witness } = await textOnly()
    const salt = witness.deckSalts[0]!
    const asHex = (text: string) =>
      `0x${Array.from(new TextEncoder().encode(text), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
    // The scan the worker used to rely on, applied to the same three messages.
    const secrets = cardBundleSecrets(witness)
    for (const message of [
      `deck salt ${salt} was rejected`,
      `salt 0x${BigInt(salt).toString(16)} rejected`,
      `deck [${witness.deckCards.join(',')}] is invalid`,
    ]) {
      expect(() => auditCardCalldata(secrets, asHex(message))).not.toThrow()
    }
  })

  it('passes an ordinary diagnostic through unchanged', async () => {
    const { texts } = await textOnly()
    expect(() => auditCardText(texts, 'Play requires an occupied hand slot')).not.toThrow()
    expect(() => auditCardText(texts, 'the committed deck is exhausted')).not.toThrow()
    expect(() => auditCardText(texts, 'a full hand must Burn the drawn card')).not.toThrow()
  })

  it('never names the matched value in a text refusal', async () => {
    const { witness, texts } = await textOnly()
    const salt = witness.deckSalts[0]!
    try {
      auditCardText(texts, `salt ${salt}`)
      throw new Error('the audit should have refused')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('hidden witness material')
      expect(message).not.toContain(salt)
      expect(message).not.toContain(BigInt(salt).toString(16))
    }
  })
})

describe('witness field names are refused in any serialized payload', () => {
  it('rejects a prepared action being sent anywhere', async () => {
    const witness = await bundle()
    const prepared = await prepareCardHandAction(witness, CardHandActionKind.Draw, {
      publicBoardCount: 0,
    })
    expect(() => assertNoWitnessFieldNames({ body: prepared })).toThrow(CardPrivacyError)
    expect(() => assertNoWitnessFieldNames({ witness: prepared.witness })).toThrow(CardPrivacyError)
    expect(() => assertNoWitnessFieldNames(witness)).toThrow(CardPrivacyError)
  })

  it('accepts a move submission body', () => {
    expect(() =>
      assertNoWitnessFieldNames({
        actionId: 'draw',
        actorId: 'seat-0',
        calldata: '0xdeadbeef',
        block: 1,
      }),
    ).not.toThrow()
  })

  it('names every field the witness bundle actually has', async () => {
    const witness = await bundle()
    const bundleKeys = Object.keys(witness).filter((key) =>
      ['deckCards', 'deckSalts', 'handCards', 'handSalts'].includes(key),
    )
    for (const key of bundleKeys) expect(CARD_WITNESS_FIELD_NAMES).toContain(key)
  })
})
