/**
 * The duel's autoplay run.
 *
 * The run itself - budget, hold, endings - is the SHARED reducer in
 * `lib/autoplay/run.ts`, which the two application demos drive as well; this
 * module is the duel's adapter over it. It fixes the two type parameters to the
 * duel's own focus and acting shapes, supplies the two endings in the duel's
 * own words, and keeps the action shape (`{ type: 'act', move, seat, proving }`)
 * that the console and the headless test already speak.
 *
 * The React hook in `components/card-duel/use-card-autoplay.ts` owns the timer
 * and calls the duel's real `run`; everything about WHEN a run may still act,
 * how many moves it has spent and how it ended lives in the shared reducer,
 * where it can be driven without a DOM.
 *
 * The move bound is enforced in the reducer and not only in the planner. A
 * planner that returned a step forever must still not be able to make the run
 * exceed `maxMoves`, because "it can never loop forever" is the property the
 * unattended stand depends on.
 *
 * Nothing in `CardAutoplayState` is secret, and that is a deliberate shape
 * rather than an accident: the chosen hand slot lives on the plan the hook
 * consumes and is never merged into this state, so serializing the whole state
 * - which `card-autoplay.test.ts` does - cannot carry hidden material.
 */
import type { CardSeatIndex } from '@zkdeal/card'
import {
  autoplayExhausted,
  createAutoplayRunReducer,
  createAutoplayRunState,
  type AutoplayEndKind,
  type AutoplayEnd,
  type AutoplayRunAction,
  type AutoplayRunState,
  type AutoplayStatus,
} from '../autoplay/run'
import { CARD_AUTOPLAY_LIMITS, type CardAutoplayFocus } from './autoplay'

export type CardAutoplayStatus = AutoplayStatus

export type CardAutoplayEndKind = AutoplayEndKind

export type CardAutoplayEnd = AutoplayEnd

export interface CardAutoplayActing {
  readonly move: string
  readonly seat: CardSeatIndex
  /** True while a Groth16 proof is being produced in the vault for this move. */
  readonly proving: boolean
}

export type CardAutoplayState = AutoplayRunState<CardAutoplayFocus, CardAutoplayActing>

export function createCardAutoplayState(
  options: { delayMs?: number; loop?: boolean; maxMoves?: number } = {},
): CardAutoplayState {
  return createAutoplayRunState<CardAutoplayFocus, CardAutoplayActing>(
    { delayMs: CARD_AUTOPLAY_LIMITS.delayMs, maxMoves: CARD_AUTOPLAY_LIMITS.maxMoves },
    options,
  )
}

export type CardAutoplayAction =
  | { readonly type: 'start' }
  | { readonly type: 'hold'; readonly hold: string | null }
  | { readonly type: 'announce'; readonly key: string; readonly narration: string; readonly focus: CardAutoplayFocus }
  | { readonly type: 'act'; readonly move: string; readonly seat: CardSeatIndex; readonly proving: boolean }
  | { readonly type: 'settled' }
  | { readonly type: 'stop' }
  | { readonly type: 'end'; readonly end: CardAutoplayEnd }
  | { readonly type: 'delay'; readonly delayMs: number }
  | { readonly type: 'loop'; readonly loop: boolean }

export const CARD_AUTOPLAY_BOUNDED_END: CardAutoplayEnd = {
  kind: 'bounded',
  headline: 'Demo run complete',
  detail:
    'Autoplay stopped at its move bound rather than running on. Every move it made went through the same validation, the same witness and the same proof a click would have used.',
}

const STOPPED_END: CardAutoplayEnd = {
  kind: 'stopped',
  headline: 'Autoplay stopped',
  detail:
    'The run was stopped by hand. Any move already in flight finishes on its own; the duel is left exactly where it stands and stays playable by clicking.',
}

const run = createAutoplayRunReducer<CardAutoplayFocus, CardAutoplayActing>({
  bounded: CARD_AUTOPLAY_BOUNDED_END,
  stopped: STOPPED_END,
})

/**
 * The duel's action shape translated into the shared one. `act` is the only
 * case that differs: the duel names its acting fields inline, and the shared
 * reducer carries an opaque payload.
 */
export function cardAutoplayReducer(
  state: CardAutoplayState,
  action: CardAutoplayAction,
): CardAutoplayState {
  const shared: AutoplayRunAction<CardAutoplayFocus, CardAutoplayActing> =
    action.type === 'act'
      ? { type: 'act', acting: { move: action.move, seat: action.seat, proving: action.proving } }
      : action
  return run(state, shared)
}

/** True when the run has no budget left, whoever asks. */
export function cardAutoplayExhausted(state: CardAutoplayState): boolean {
  return autoplayExhausted(state)
}

export const CARD_AUTOPLAY_SETTLED_END: CardAutoplayEnd = {
  kind: 'settled',
  headline: 'The duel is settled',
  detail:
    'Autoplay ran the duel to a terminal state and stopped. The pot is resolved and no legal move remains.',
}

export function cardAutoplayFailedEnd(reason: string): CardAutoplayEnd {
  return {
    kind: 'failed',
    headline: 'Autoplay stopped on a refused move',
    detail: reason,
  }
}

export function cardAutoplayUnavailableEnd(reason: string): CardAutoplayEnd {
  return {
    kind: 'unavailable',
    headline: 'Autoplay cannot prove here',
    detail: reason,
  }
}
