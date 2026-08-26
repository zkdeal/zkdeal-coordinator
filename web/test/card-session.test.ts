import { describe, expect, it } from 'vitest'
import {
  CardHandActionKind,
  applyPublicCardBoardCountChange,
  buildCardHandActionPublicInputs,
  createCardWitnessBundle,
  prepareCardHandAction,
  type CardSeatIndex,
  type CardWitnessBundle,
} from '@zkdeal/card'
import { cardDemoIdentity } from '../lib/card/identity'
import { buildCardStep, type CardProofResult, type CardStepChoiceInput } from '../lib/card/moves'
import { auditCardCalldata, cardBundleSecrets } from '../lib/card/privacy'
import {
  applyCardEscrowMove,
  applyCardSessionMove,
  cardPublishedBytes,
  createCardSession,
  type CardSessionState,
} from '../lib/card/session'
import { cardAvailableSteps, type CardStep } from '../lib/card/steps'
import { cardLedgerRoot } from '../lib/card/participants'
import type { CardVaultView } from '../lib/card/vault-messages'

/**
 * A whole duel driven through the console's own modules, with real witness
 * bundles and real ordered public inputs.
 *
 * This is the state machine `components/card-duel` renders. Running it headless
 * proves three things a screenshot cannot: the offered steps track
 * `CardDuelLibV5.Phase`, the participant nonce advances exactly once per move
 * (`_writeParticipant` reverts otherwise), and every byte the duel publishes is
 * free of the deck and hand material both bundles hold.
 *
 * The Groth16 coordinates are placeholders - a real proof takes seconds of
 * browser work and adds nothing to what is being measured here. The PUBLIC
 * INPUTS are real, and they are what the rules engine checks the transition
 * against.
 */
const identity = cardDemoIdentity()

/** A placeholder adapter payload of the right width; see the note above. */
const FAKE_PROOF = `0x${'ef'.repeat(256)}` as const

/** The exact view the vault worker builds, rebuilt here from the same bundle. */
function viewOf(bundle: CardWitnessBundle): CardVaultView {
  return {
    deckCursor: bundle.deckCursor,
    handCount: bundle.handCards.filter((card) => card !== 0).length,
    boardCount: bundle.boardCount,
    actionCursor: bundle.actionCursor,
    deckRoot: bundle.deckRoot,
    handRoot: bundle.handRoot,
    handCards: [...bundle.handCards],
    staged: false,
  }
}

function deckInitProof(bundle: CardWitnessBundle): CardProofResult {
  return {
    circuit: 'deck-init-v4',
    publicInputs: [bundle.domain, bundle.duelId, bundle.player, bundle.deckRoot, bundle.handRoot],
    innerProof: FAKE_PROOF,
  }
}

const SEED: readonly [`0x${string}`, `0x${string}`] = [
  `0x${'11'.repeat(32)}`,
  `0x${'22'.repeat(32)}`,
]

describe('hidden-card duel session', () => {
  it('runs registration through an attack, publishing nothing private', async () => {
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
    let session = createCardSession({
      proofDomain: identity.proofDomain,
      duelId: identity.duelId,
      entryStake: identity.entryStake,
      participantCapacity: identity.participantCapacity,
    })

    const steps = (): CardStep[] =>
      cardAvailableSteps({
        session,
        views: [viewOf(bundles[0]!), viewOf(bundles[1]!)],
        registered: [session.ledger.records.has(0), session.ledger.records.has(1)],
      })

    const take = (move: string, seat?: CardSeatIndex): CardStep => {
      const step = steps().find(
        (candidate) => candidate.move === move && (seat === undefined || candidate.seat === seat),
      )
      if (!step) {
        throw new Error(
          `${move} is not offered in phase ${session.duel.phase}; offered: ${steps()
            .map((item) => `${item.move}@${item.seat}`)
            .join(', ')}`,
        )
      }
      return step
    }

    const run = async (
      move: string,
      options: {
        seat?: CardSeatIndex
        choice?: CardStepChoiceInput
        /**
         * Resolved AFTER the step is chosen, exactly as the hook orders it:
         * preparing a hand action advances the private bundle, so producing the
         * proof first would make the move that needs it look unavailable.
         */
        proof?: () => Promise<CardProofResult> | CardProofResult
        seed?: `0x${string}`
      } = {},
    ) => {
      const step = take(move, options.seat)
      const build = buildCardStep({
        session,
        identity,
        step,
        choice: options.choice,
        proof: options.proof ? await options.proof() : undefined,
        seed: options.seed,
      })
      // Every published byte, against both seats' private material.
      for (const bundle of bundles) {
        auditCardCalldata(cardBundleSecrets(bundle), build.calldata.calldata)
      }
      session = build.payload
        ? applyCardSessionMove(session, {
            seat: build.seat,
            payload: build.payload,
            calldata: build.calldata,
            participant: build.participant,
            publicInputs: build.publicInputs ?? undefined,
          })
        : applyCardEscrowMove(session, {
            seat: build.seat,
            calldata: build.calldata,
            participant: build.participant,
          })
      return build
    }

    // Registration is a prerequisite: nothing else is offered until both leaves
    // exist, because a duel move against a missing leaf reverts on the proof.
    const emptyRoot = cardLedgerRoot(session.ledger)
    expect(steps().map((step) => step.move)).toEqual(['registerDuelist', 'registerDuelist'])
    await run('registerDuelist', { seat: 0 })
    await run('registerDuelist', { seat: 1 })
    expect(cardLedgerRoot(session.ledger)).not.toBe(emptyRoot)

    expect(steps().map((step) => step.move)).toEqual(['openDuel'])
    await run('openDuel')
    expect(session.duel.phase).toBe('AwaitingOpponent')
    await run('joinDuel')
    expect(session.duel.phase).toBe('DeckSetup')
    expect(session.duel.pot).toBe(identity.entryStake * 2n)

    for (const seat of [0, 1] as const) {
      await run('initializeDeck', { seat, proof: () => deckInitProof(bundles[seat]!) })
    }
    expect(session.duel.phase).toBe('SeedCommit')

    for (const seat of [0, 1] as const) await run('commitSeed', { seat, seed: SEED[seat] })
    expect(session.duel.phase).toBe('SeedReveal')
    for (const seat of [0, 1] as const) await run('revealSeed', { seat, seed: SEED[seat] })
    expect(session.duel.phase).toBe('Active')

    /** Prove, publish and only then advance the private bundle - as the hook does. */
    const handAction = async (
      seat: CardSeatIndex,
      action: CardHandActionKind,
      handSlot?: number,
    ): Promise<CardProofResult> => {
      const prepared = await prepareCardHandAction(bundles[seat]!, action, {
        handSlot,
        publicBoardCount: session.duel.seats[seat].boardCount,
      })
      const vector = buildCardHandActionPublicInputs(prepared.publicInputs).map((value) =>
        value.toString(10),
      )
      bundles[seat] = prepared.nextBundle
      return { circuit: 'hand-action-v4', publicInputs: vector, innerProof: FAKE_PROOF }
    }

    // Both seats draw one card and play it, so there is a board to attack.
    for (const round of [0, 1] as const) {
      const seat = session.duel.turn
      await run('draw', { proof: () => handAction(seat, CardHandActionKind.Draw) })
      const handSlot = bundles[seat]!.handCards.findIndex((card) => card !== 0)
      await run('play', {
        proof: () => handAction(seat, CardHandActionKind.Play, handSlot),
        choice: { handSlot, boardSlot: round },
      })
      expect(session.duel.seats[seat].boardCount).toBe(1)
      await run('endTurn')
    }

    const attacker = session.duel.turn
    const defender = (attacker === 0 ? 1 : 0) as CardSeatIndex
    const attackerSlot = session.duel.seats[attacker].boardCards.findIndex((card) => card !== 0)
    const targetSlot = session.duel.seats[defender].boardCards.findIndex((card) => card !== 0)
    const before = session.duel.seats[defender].boardCount
    const turnNumber = session.duel.turnNumber
    await run('attack', { choice: { attackerSlot, targetSlot } })
    const after = session.duel.seats[defender].boardCount

    // A kill leaves a HOLE, and the defender's private bundle has to fold the
    // public board-count change in or its next proof carries a stale
    // `oldBoardCount`.
    if (after === before - 1) {
      bundles[defender] = await applyPublicCardBoardCountChange(bundles[defender]!, {
        format: 'zkdeal/card-board-count-change/v4',
        domain: bundles[defender]!.domain,
        duelId: bundles[defender]!.duelId,
        player: bundles[defender]!.player,
        cause: 'attack-kill',
        previousBoardCount: before,
        boardCount: after,
        turnNumber,
        attackerSlot,
      })
      expect(bundles[defender]!.boardCount).toBe(after)
    }

    // The attacker's slot is spent for this turn, per SLOT not per card.
    expect(session.duel.seats[attacker].attackedMask & (1 << attackerSlot)).not.toBe(0)
    expect(steps().some((step) => step.move === 'attack')).toBe(false)

    // Participant nonces: exactly one increment per move by that seat.
    for (const seat of [0, 1] as const) {
      const moves = session.entries.filter(
        (entry) => entry.seat === seat && entry.move !== 'registerDuelist',
      ).length
      expect(session.ledger.records.get(seat)!.nonce).toBe(BigInt(moves))
    }
    expect(cardPublishedBytes(session)).toBeGreaterThan(0)
  })

  it('leaves the session untouched when a move breaks a rule', async () => {
    let session: CardSessionState = createCardSession({
      proofDomain: identity.proofDomain,
      duelId: identity.duelId,
      entryStake: identity.entryStake,
      participantCapacity: identity.participantCapacity,
    })
    const register = (seat: CardSeatIndex) => {
      const build = buildCardStep({
        session,
        identity,
        step: {
          move: 'registerDuelist',
          seat,
          label: '',
          detail: '',
          provesLocally: false,
          choice: 'none',
        },
      })
      session = applyCardEscrowMove(session, {
        seat: build.seat,
        calldata: build.calldata,
        participant: build.participant,
      })
    }
    register(0)
    register(1)
    const before = session

    // joinDuel before openDuel: the read-model refuses with the Solidity error
    // the chain would have used, and nothing is appended.
    expect(() =>
      applyCardSessionMove(session, {
        seat: 1,
        payload: { move: 'joinDuel' as never, participantIndex: 1n, owner: identity.seats[1].owner } as never,
        calldata: buildCardStep({
          session,
          identity,
          step: { move: 'openDuel', seat: 0, label: '', detail: '', provesLocally: false, choice: 'none' },
        }).calldata,
        participant: session.ledger.records.get(1)!,
      }),
    ).toThrow(/BadPhase/)
    expect(session).toBe(before)
    expect(session.entries).toHaveLength(2)
  })
})
