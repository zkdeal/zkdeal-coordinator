'use client'

/**
 * The timer half of autoplay: it announces the planned move, waits, and then
 * calls the console's own `run`.
 *
 * There is deliberately no `while` loop here. `run` is a `useCallback` closed
 * over the CURRENT session and vault views, so a loop holding one reference
 * would build its second move against a stale read-model and the participant
 * nonce would desynchronize on the first proof. Instead each completed move
 * re-renders the console, this effect re-plans from the fresh state, and the
 * next move is scheduled - which is also what makes stopping cheap: there is
 * never more than one pending timer to clear.
 *
 * Autoplay adds no path of its own. It picks a step out of the same
 * `cardAvailableSteps` list the buttons render and hands it to the same
 * `run`, so the validation, the witness construction, the vault audit and the
 * Groth16 proof are the ones a human click produces. If the artifacts are not
 * loaded it refuses to start and says so rather than pretending.
 */
import { useCallback, useEffect, useMemo, useRef, useReducer } from 'react'
import {
  CARD_AUTOPLAY_LIMITS,
  planCardAutoplayMove,
  type CardAutoplayPlan,
} from '@/lib/card/autoplay'
import {
  CARD_AUTOPLAY_BOUNDED_END,
  CARD_AUTOPLAY_SETTLED_END,
  cardAutoplayFailedEnd,
  cardAutoplayReducer,
  cardAutoplayUnavailableEnd,
  createCardAutoplayState,
  type CardAutoplayState,
} from '@/lib/card/autoplay-state'
import type { CardStepChoiceInput } from '@/lib/card/moves'
import type { CardSessionState } from '@/lib/card/session'
import type { CardStep } from '@/lib/card/steps'
import type { CardVaultView } from '@/lib/card/vault-messages'
import type { CardArtifactPhase } from './use-card-duel'

/** The slice of `useCardDuel` autoplay drives; nothing here is autoplay-only. */
export interface CardAutoplayDuel {
  readonly phase: CardArtifactPhase
  readonly busy: string | null
  readonly error: string | null
  readonly session: CardSessionState
  readonly views: readonly [CardVaultView | null, CardVaultView | null]
  readonly steps: readonly CardStep[]
  readonly run: (step: CardStep, choice?: CardStepChoiceInput) => Promise<void>
  readonly reset: () => Promise<void>
}

export interface CardAutoplayControls {
  readonly state: CardAutoplayState
  readonly running: boolean
  readonly canStart: boolean
  readonly start: () => void
  readonly stop: () => void
  readonly restart: () => void
  readonly setDelayMs: (delayMs: number) => void
  readonly setLoop: (loop: boolean) => void
}

const NOT_READY =
  'The circom artifacts are not loaded in this tab, so no move could carry a real proof. Fetch and verify them above; autoplay will not run without them.'

/**
 * `hold` is settlement's back-pressure. A checkpoint is ~17 s of GPU proving
 * plus L1 inclusion, and a run that kept playing through it would push more
 * moves into a batch that is already being proven - so autoplay stands still
 * for the duration, keeps its budget, and SAYS it is waiting on L1 rather than
 * looking frozen.
 */
export function useCardAutoplay(
  duel: CardAutoplayDuel,
  hold: string | null = null,
): CardAutoplayControls {
  const [state, dispatch] = useReducer(cardAutoplayReducer, undefined, () =>
    createCardAutoplayState(),
  )
  /** Set while a move autoplay issued is in flight, holding the log length before it. */
  const issued = useRef<number | null>(null)

  const running = state.status === 'running'
  const { movesMade, maxMoves, delayMs, announced } = state

  const start = useCallback(() => {
    issued.current = null
    if (duel.phase !== 'ready') {
      dispatch({ type: 'end', end: cardAutoplayUnavailableEnd(NOT_READY) })
      return
    }
    dispatch({ type: 'start' })
  }, [duel.phase])

  const stop = useCallback(() => dispatch({ type: 'stop' }), [])

  const restart = useCallback(() => {
    issued.current = null
    const ready = duel.phase === 'ready'
    void duel.reset().then(() => {
      if (ready) dispatch({ type: 'start' })
    })
  }, [duel.reset, duel.phase])

  const setDelayMs = useCallback((value: number) => dispatch({ type: 'delay', delayMs: value }), [])
  const setLoop = useCallback((value: boolean) => dispatch({ type: 'loop', loop: value }), [])

  /* ------------------------- announce, wait, act ------------------------- */

  useEffect(() => {
    if (!running) return
    // A move is being proved or built. Autoplay never races it.
    if (duel.busy !== null) return

    const before = issued.current
    if (before !== null) {
      issued.current = null
      dispatch({ type: 'settled' })
      // `run` swallows a refusal into `error` rather than throwing, so the
      // log length is the honest signal that the move was not accepted.
      if (duel.session.entries.length === before) {
        dispatch({ type: 'end', end: cardAutoplayFailedEnd(duel.error ?? 'The move was refused.') })
        return
      }
    }

    if (duel.phase !== 'ready') {
      dispatch({ type: 'end', end: cardAutoplayUnavailableEnd(NOT_READY) })
      return
    }

    // Settlement is mid-flight. Recorded ABOVE as a hold rather than as an end,
    // so the run resumes on its own when the checkpoint lands.
    dispatch({ type: 'hold', hold })
    if (hold !== null) return

    const plan: CardAutoplayPlan | null = planCardAutoplayMove({
      session: duel.session,
      views: duel.views,
      steps: duel.steps,
      movesMade,
      maxMoves,
    })
    if (!plan) {
      // The planner returns null for two different reasons, and they must not
      // be reported as the same thing: a duel with nothing legal left is
      // settled, a duel with moves left that ran out of budget is bounded.
      dispatch({
        type: 'end',
        end: movesMade >= maxMoves ? CARD_AUTOPLAY_BOUNDED_END : CARD_AUTOPLAY_SETTLED_END,
      })
      return
    }

    // Announce first and act after the pause, so the room reads the sentence
    // before the board changes under it.
    const key = `${duel.session.entries.length}:${plan.step.move}:${plan.step.seat}`
    if (announced !== key) {
      dispatch({ type: 'announce', key, narration: plan.narration, focus: plan.focus })
    }

    // A move that produced a Groth16 proof already gave the audience seconds of
    // wall clock, so the next one follows on a short settle rather than the
    // full step delay stacked on top of the proving time.
    const last = duel.session.entries[duel.session.entries.length - 1]
    const pause =
      last && last.provingMs !== null
        ? Math.min(delayMs, CARD_AUTOPLAY_LIMITS.settleMs)
        : delayMs

    const timer = window.setTimeout(() => {
      issued.current = duel.session.entries.length
      dispatch({
        type: 'act',
        move: plan.step.move,
        seat: plan.step.seat,
        proving: plan.step.provesLocally,
      })
      void duel.run(plan.step, plan.choice)
    }, pause)
    return () => window.clearTimeout(timer)
    // `duel` is a fresh object every render, so the dependency list names the
    // fields that actually decide the next move. Depending on `duel` itself
    // would restart the pending timer on every unrelated console re-render.
  }, [
    running,
    announced,
    hold,
    movesMade,
    maxMoves,
    delayMs,
    duel.busy,
    duel.error,
    duel.phase,
    duel.session,
    duel.views,
    duel.steps,
    duel.run,
  ])

  /* ------------------------------ loop mode ------------------------------ */

  useEffect(() => {
    if (state.status !== 'ended' || !state.loop) return
    // Only a run that finished on its own restarts. A refusal, a missing
    // prover or a deliberate stop stays on screen until a human decides.
    if (state.end?.kind !== 'settled' && state.end?.kind !== 'bounded') return
    const timer = window.setTimeout(() => {
      issued.current = null
      void duel.reset().then(() => dispatch({ type: 'start' }))
    }, CARD_AUTOPLAY_LIMITS.restartMs)
    return () => window.clearTimeout(timer)
  }, [state.status, state.loop, state.end, duel.reset])

  return useMemo(
    () => ({
      state,
      running,
      canStart: duel.phase === 'ready',
      start,
      stop,
      restart,
      setDelayMs,
      setLoop,
    }),
    [state, running, duel.phase, start, stop, restart, setDelayMs, setLoop],
  )
}
