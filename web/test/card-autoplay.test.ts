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
import {
  CARD_AUTOPLAY_LIMITS,
  cardAutoplayNarration,
  planCardAutoplayMove,
  type CardAutoplayPlan,
} from '../lib/card/autoplay'
import {
  CARD_AUTOPLAY_BOUNDED_END,
  CARD_AUTOPLAY_SETTLED_END,
  cardAutoplayFailedEnd,
  cardAutoplayReducer,
  createCardAutoplayState,
  type CardAutoplayState,
} from '../lib/card/autoplay-state'
import { cardDemoIdentity } from '../lib/card/identity'
import { buildCardStep, type CardProofResult } from '../lib/card/moves'
import {
  assertNoWitnessFieldNames,
  auditCardCalldata,
  auditCardText,
  cardBundleSecretTexts,
  cardBundleSecrets,
} from '../lib/card/privacy'
import {
  applyCardEscrowMove,
  applyCardSessionMove,
  createCardSession,
  type CardSessionState,
} from '../lib/card/session'
import { cardAvailableSteps } from '../lib/card/steps'
import type { CardVaultView } from '../lib/card/vault-messages'

/**
 * The autoplay state machine, driven headless over the console's own modules.
 *
 * What is being asserted here is that autoplay is not a second duel. It selects
 * out of `cardAvailableSteps` and hands the result to `buildCardStep`, so
 * the loop below is the hook's sequence with the timer and the worker removed:
 * plan, build, audit, apply. If autoplay could reach a move the rules refuse,
 * `applyCardMove` throws here exactly as it would in the browser.
 *
 * The Groth16 coordinates are placeholders for the same reason as in
 * `card-session.test.ts` - the PUBLIC INPUTS are real, and they are what the
 * rules check the transition against.
 */
const identity = cardDemoIdentity()
const FAKE_PROOF = `0x${'ef'.repeat(256)}` as const

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

/**
 * One rendered frame of the duel: the move about to be taken and the hand each
 * seat's panel is showing while it is taken.
 *
 * `hands` is real hidden material and it stays in this process - it is asserted
 * against and never folded into the `exposed` payload the privacy suite below
 * serializes, for the same reason `CardAutoplayPlan.choice` is kept out of
 * `CardAutoplayState`.
 */
interface Frame {
  readonly move: string
  readonly seat: CardSeatIndex
  readonly hands: readonly [readonly number[], readonly number[]]
}

interface Run {
  readonly session: CardSessionState
  readonly bundles: readonly CardWitnessBundle[]
  readonly plans: readonly CardAutoplayPlan[]
  readonly states: readonly CardAutoplayState[]
  readonly narrations: readonly string[]
  readonly moves: readonly string[]
  /** What the two hand panels held, in order, one entry per move taken. */
  readonly frames: readonly Frame[]
}

/**
 * Play a whole duel the way the hook does: plan a move, build it, audit the
 * bytes against BOTH seats' witness material, apply it, then advance the
 * private bundle. `stopAfter` mimics the presenter pressing stop mid-run.
 */
async function autoplay(options: { maxMoves?: number; finaleAfter?: number; stopAfter?: number } = {}): Promise<Run> {
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
  let state = createCardAutoplayState({ maxMoves: options.maxMoves })
  state = cardAutoplayReducer(state, { type: 'start' })

  const plans: CardAutoplayPlan[] = []
  const states: CardAutoplayState[] = [state]
  const frames: Frame[] = []
  const seeds: Record<number, `0x${string}`> = {}

  for (;;) {
    if (state.status !== 'running') break
    if (options.stopAfter !== undefined && state.movesMade >= options.stopAfter) {
      state = cardAutoplayReducer(state, { type: 'stop' })
      states.push(state)
      break
    }
    const views: readonly [CardVaultView | null, CardVaultView | null] = [
      viewOf(bundles[0]!),
      viewOf(bundles[1]!),
    ]
    const steps = cardAvailableSteps({
      session,
      views,
      registered: [session.ledger.records.has(0), session.ledger.records.has(1)],
    })
    const plan = planCardAutoplayMove({
      session,
      views,
      steps,
      movesMade: state.movesMade,
      maxMoves: state.maxMoves,
      finaleAfter: options.finaleAfter,
    })
    if (!plan) break
    plans.push(plan)
    // Recorded BEFORE the move is applied: this is what `SeatPanel` renders
    // while the move is announced, proved and committed, because the hook only
    // advances a view once the vault has accepted the transition.
    frames.push({
      move: plan.step.move,
      seat: plan.step.seat,
      hands: [views[0]!.handCards, views[1]!.handCards],
    })

    state = cardAutoplayReducer(state, {
      type: 'announce',
      key: `${session.entries.length}:${plan.step.move}:${plan.step.seat}`,
      narration: plan.narration,
      focus: plan.focus,
    })
    state = cardAutoplayReducer(state, {
      type: 'act',
      move: plan.step.move,
      seat: plan.step.seat,
      proving: plan.step.provesLocally,
    })
    states.push(state)
    if (state.status !== 'running') break

    const seat = plan.step.seat
    // Exactly the hook's order: prove first, and only advance the private
    // bundle once the read-model has accepted the move.
    let proof: CardProofResult | undefined
    let staged: CardWitnessBundle | null = null
    if (plan.step.move === 'initializeDeck') {
      const bundle = bundles[seat]!
      proof = {
        circuit: 'deck-init-v4',
        publicInputs: [bundle.domain, bundle.duelId, bundle.player, bundle.deckRoot, bundle.handRoot],
        innerProof: FAKE_PROOF,
      }
    } else if (plan.step.move === 'draw' || plan.step.move === 'burn' || plan.step.move === 'play') {
      const kind =
        plan.step.move === 'draw'
          ? CardHandActionKind.Draw
          : plan.step.move === 'play'
            ? CardHandActionKind.Play
            : CardHandActionKind.Burn
      const prepared = await prepareCardHandAction(bundles[seat]!, kind, {
        handSlot: plan.choice?.handSlot,
        publicBoardCount: session.duel.seats[seat].boardCount,
      })
      proof = {
        circuit: 'hand-action-v4',
        publicInputs: buildCardHandActionPublicInputs(prepared.publicInputs).map((value) =>
          value.toString(10),
        ),
        innerProof: FAKE_PROOF,
      }
      staged = prepared.nextBundle
    }
    if (plan.step.move === 'commitSeed' && !seeds[seat]) {
      seeds[seat] = `0x${String(seat + 1).repeat(64)}` as `0x${string}`
    }

    const build = buildCardStep({
      session,
      identity,
      step: plan.step,
      choice: plan.choice,
      proof,
      seed: seeds[seat],
    })
    for (const bundle of bundles) {
      auditCardCalldata(cardBundleSecrets(bundle), build.calldata.calldata)
    }

    const defender = (seat === 0 ? 1 : 0) as CardSeatIndex
    const boardBefore = session.duel.seats[defender].boardCount
    const turnNumber = session.duel.turnNumber

    session = build.payload
      ? applyCardSessionMove(session, {
          seat,
          payload: build.payload,
          calldata: build.calldata,
          participant: build.participant,
          publicInputs: build.publicInputs ?? undefined,
        })
      : applyCardEscrowMove(session, {
          seat,
          calldata: build.calldata,
          participant: build.participant,
          publicInputs: build.publicInputs ?? undefined,
        })
    if (staged) bundles[seat] = staged

    const boardAfter = session.duel.seats[defender].boardCount
    if (plan.step.move === 'attack' && boardAfter === boardBefore - 1) {
      bundles[defender] = await applyPublicCardBoardCountChange(bundles[defender]!, {
        format: 'zkdeal/card-board-count-change/v4',
        domain: bundles[defender]!.domain,
        duelId: bundles[defender]!.duelId,
        player: bundles[defender]!.player,
        cause: 'attack-kill',
        previousBoardCount: boardBefore,
        boardCount: boardAfter,
        turnNumber,
        attackerSlot: plan.choice!.attackerSlot!,
      })
    }
    state = cardAutoplayReducer(state, { type: 'settled' })
  }

  return {
    session,
    bundles,
    plans,
    states,
    narrations: plans.map((plan) => plan.narration),
    moves: plans.map((plan) => plan.step.move),
    frames,
  }
}

/** Occupied slots of `seat`'s hand panel in `frame`, exactly as it renders. */
function held(frame: Frame, seat: CardSeatIndex): number {
  return frame.hands[seat].filter((cardId) => cardId !== 0).length
}

describe('card duel autoplay', () => {
  it('advances the real duel from an empty room to a settled, claimed pot', async () => {
    // Shipped configuration, so this pins the arc a presenter actually sees.
    const run = await autoplay()

    // Every move it chose was one the phase machine offered, in the order the
    // contract admits them.
    expect(run.moves.slice(0, 10)).toEqual([
      'registerDuelist',
      'registerDuelist',
      'openDuel',
      'joinDuel',
      'initializeDeck',
      'initializeDeck',
      'commitSeed',
      'commitSeed',
      'revealSeed',
      'revealSeed',
    ])
    // It reached real play, with locally proved hand transitions.
    expect(run.moves).toContain('draw')
    expect(run.moves).toContain('play')
    expect(run.moves).toContain('endTurn')
    expect(run.session.entries.filter((entry) => entry.publicInputs !== null).length).toBeGreaterThan(4)

    // And it terminates: settled, paid, and nothing legal left to do.
    expect(run.session.duel.phase).toBe('Finished')
    expect(run.session.duel.prizeClaimed).toBe(true)
    expect(run.moves.at(-1)).toBe('claimPrize')
    expect(run.session.entries).toHaveLength(run.moves.length)
    // Short enough to hold a room, and well inside the hard bound.
    expect(run.moves.length).toBeLessThan(CARD_AUTOPLAY_LIMITS.maxMoves)
    expect(run.moves.filter((move) => move === 'endTurn').length).toBeGreaterThanOrEqual(2)
  }, 120_000)

  /**
   * The regression this suite exists to hold from now on.
   *
   * The hidden hand is the demonstration: it is the one piece of state that
   * lives only in this tab's vault worker, and `SeatPanel` renders it from a
   * `CardVaultView` nothing off-tab can produce. The policy used to draw one
   * card and spend it on the very next move, so the hand was a pass-through -
   * across the shipped run BOTH panels read "empty" in 21 of 24 frames, the
   * peak hand was one card, and the duel finished with both hands empty. The
   * vault was returning the right payload the whole time and React was holding
   * it correctly; there was simply never a card in the hand to show.
   *
   * These assertions are about the frames a viewer actually sees, not about the
   * planner's internals, which is why they are made against `Frame.hands` - the
   * exact array `SeatPanel` maps over.
   */
  it('keeps both hidden hands readable once a seat has drawn', async () => {
    const run = await autoplay()
    const { handTarget, handReserve } = CARD_AUTOPLAY_LIMITS

    // A seat cannot hold a card before it has taken a turn, so the property
    // starts at each seat's first occupied frame. From there it is absolute:
    // the panel never returns to empty for the rest of the duel.
    for (const seat of [0, 1] as const) {
      const first = run.frames.findIndex((frame) => held(frame, seat) > 0)
      expect(first, `seat ${seat} never held a card in ${run.frames.length} frames`).toBeGreaterThan(-1)
      for (const frame of run.frames.slice(first)) {
        expect(
          held(frame, seat),
          `seat ${seat}'s hand emptied at ${frame.move}@${frame.seat}`,
        ).toBeGreaterThanOrEqual(handReserve)
      }
      // And it is a hand rather than a single card in transit.
      expect(Math.max(...run.frames.map((frame) => held(frame, seat)))).toBeGreaterThanOrEqual(
        handTarget,
      )
    }

    // The reserve is what makes the property hold: a play is only ever chosen
    // above it, so what leaves the hand is never the card that just arrived.
    for (const [index, frame] of run.frames.entries()) {
      if (frame.move !== 'play') continue
      expect(held(frame, frame.seat)).toBeGreaterThan(handReserve)
      const next = run.frames[index + 1]
      if (next) expect(held(next, frame.seat)).toBeGreaterThanOrEqual(handReserve)
    }

    // Both panels are populated at the same time, and still are at the end -
    // the reported symptom was precisely that neither ever was.
    expect(run.frames.filter((frame) => held(frame, 0) > 0 && held(frame, 1) > 0).length).toBeGreaterThan(0)
    expect(held(run.frames.at(-1)!, 0)).toBeGreaterThan(0)
    expect(held(run.frames.at(-1)!, 1)).toBeGreaterThan(0)

    // None of which was bought by weakening the duel: the arc still settles.
    expect(run.moves).toContain('draw')
    expect(run.moves).toContain('play')
    expect(run.session.duel.phase).toBe('Finished')
    expect(run.session.duel.prizeClaimed).toBe(true)
    expect(handReserve).toBeLessThan(handTarget)
  }, 120_000)

  it('never exceeds its move bound, whatever the duel does', async () => {
    // A bound far below the length of a duel: the run must stop at it rather
    // than at a terminal state.
    const run = await autoplay({ maxMoves: 7, finaleAfter: 1_000 })
    expect(run.moves).toHaveLength(7)
    expect(run.session.entries).toHaveLength(7)
    expect(run.states.at(-1)!.movesMade).toBe(7)
    expect(run.session.duel.phase).not.toBe('Finished')

    // The reducer, not the planner, is the authority: an extra `act` at the
    // bound ends the run instead of spending a move that does not exist.
    const exhausted = cardAutoplayReducer(run.states.at(-1)!, {
      type: 'act',
      move: 'draw',
      seat: 0,
      proving: true,
    })
    expect(exhausted.movesMade).toBe(7)
    expect(exhausted.status).toBe('ended')
    expect(exhausted.end).toBe(CARD_AUTOPLAY_BOUNDED_END)
    // A run that stopped at its bound must not claim the duel settled.
    expect(CARD_AUTOPLAY_BOUNDED_END.kind).not.toBe(CARD_AUTOPLAY_SETTLED_END.kind)
  }, 120_000)

  it('stops on request without wedging the duel', async () => {
    const run = await autoplay({ stopAfter: 5 })
    const final = run.states.at(-1)!
    expect(final.status).toBe('ended')
    expect(final.end?.kind).toBe('stopped')
    expect(final.acting).toBeNull()
    expect(run.moves).toHaveLength(5)

    // The duel is left mid-setup and still playable by hand: the phase machine
    // offers the very next move a click would need.
    const steps = cardAvailableSteps({
      session: run.session,
      views: [viewOf(run.bundles[0]!), viewOf(run.bundles[1]!)],
      registered: [run.session.ledger.records.has(0), run.session.ledger.records.has(1)],
    })
    expect(steps.length).toBeGreaterThan(0)

    // A stopped run ignores further actions until it is started again.
    expect(cardAutoplayReducer(final, { type: 'act', move: 'draw', seat: 0, proving: true })).toBe(final)
    const restarted = cardAutoplayReducer(final, { type: 'start' })
    expect(restarted.status).toBe('running')
    expect(restarted.movesMade).toBe(0)
    expect(restarted.end).toBeNull()
    expect(restarted.runs).toBe(final.runs + 1)
  }, 120_000)

  it('serializes no hidden material in anything it narrates or exposes', async () => {
    const run = await autoplay()

    // The rendered state and the narration together, as a payload.
    const exposed = { states: run.states, narrations: run.narrations }
    assertNoWitnessFieldNames(exposed, 'autoplay state')
    const serialized = JSON.stringify(exposed)
    for (const bundle of run.bundles) {
      auditCardText(cardBundleSecretTexts(bundle), serialized, 'autoplay state')
    }

    // The hand slot is real witness input; it lives on the plan the hook hands
    // to `run` and must never have been merged into the rendered state.
    expect(serialized).not.toContain('handSlot')
    expect(run.plans.some((plan) => plan.choice?.handSlot !== undefined)).toBe(true)
    for (const plan of run.plans) {
      auditCardText(cardBundleSecretTexts(run.bundles[0]!), plan.narration)
      auditCardText(cardBundleSecretTexts(run.bundles[1]!), plan.narration)
    }
  }, 120_000)

  it('reports an honest end rather than continuing past a refusal', () => {
    let state = cardAutoplayReducer(createCardAutoplayState(), { type: 'start' })
    state = cardAutoplayReducer(state, { type: 'act', move: 'draw', seat: 0, proving: true })
    state = cardAutoplayReducer(state, {
      type: 'end',
      end: cardAutoplayFailedEnd('BadProof: the inner CardHandAction proof was not accepted'),
    })
    expect(state.status).toBe('ended')
    expect(state.end?.kind).toBe('failed')
    expect(state.end?.detail).toContain('BadProof')
    // No further move is taken after the failure.
    expect(cardAutoplayReducer(state, { type: 'act', move: 'play', seat: 0, proving: true })).toBe(state)
  })

  it('narrates every entry point in plain language, naming no card', () => {
    const moves = [
      'registerDuelist',
      'openDuel',
      'joinDuel',
      'abandonDuel',
      'initializeDeck',
      'commitSeed',
      'revealSeed',
      'draw',
      'burn',
      'play',
      'attack',
      'endTurn',
      'concede',
      'claimPrize',
    ] as const
    for (const move of moves) {
      const text = cardAutoplayNarration(
        { move, seat: 0, label: '', detail: '', provesLocally: false, choice: 'none' },
        { boardSlot: 2, targetSlot: 1 },
      )
      expect(text.length).toBeGreaterThan(20)
      expect(text).toMatch(/^Player [12] /)
    }
    expect(CARD_AUTOPLAY_LIMITS.settleMs).toBeLessThan(CARD_AUTOPLAY_LIMITS.delayMs)
  })
})
