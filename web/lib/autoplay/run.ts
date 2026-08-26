/**
 * The autoplay RUN, as a reducer, shared by every self-driving demo on this
 * site.
 *
 * This module was lifted out of `lib/card/autoplay-state.ts` when the two
 * application demos needed the same behaviour: the hidden-card duel, the
 * commit-reveal auction and the persistent shop are three different
 * applications, but "a presenter pressed one button and the console is now
 * driving itself" is one thing and it should behave identically in all three.
 * The card module now adapts this reducer rather than owning a second copy, so
 * a fix to the bound, the hold or the end reporting reaches every demo at once.
 *
 * WHAT LIVES HERE. Only the run: whether it may still act, how much of its
 * budget it has spent, why it is standing still and how it ended. WHICH step to
 * take next is the application's own policy and stays with the application -
 * `lib/card/autoplay.ts` for the duel, `lib/applications/application-run.ts` for
 * the two application rooms.
 *
 * THE BOUND IS ENFORCED HERE and not only in the planner. A planner that
 * returned a step forever must still not be able to make a run exceed
 * `maxMoves`, because "it can never loop forever" is the property an unattended
 * stand depends on.
 *
 * NOTHING IN THE STATE IS SECRET, and that is deliberate rather than
 * accidental: a chosen hand slot or any other witness input belongs on the plan
 * the hook consumes and is never merged in here, so serializing the whole state
 * - which `card-autoplay.test.ts` does - cannot carry hidden material.
 *
 * React-free, so a whole run can be driven headless in a unit test.
 */

export type AutoplayStatus = 'idle' | 'running' | 'ended'

/**
 * How a run finished.
 *
 * `settled` and `bounded` are the two SELF-COMPLETED endings - the application
 * reached a terminal state, or the run spent its budget - and they are the only
 * two that loop mode is allowed to restart from. `stopped`, `failed` and
 * `unavailable` all mean a human should look at the screen, so they stay on it.
 */
export type AutoplayEndKind = 'settled' | 'bounded' | 'stopped' | 'failed' | 'unavailable'

export interface AutoplayEnd {
  readonly kind: AutoplayEndKind
  readonly headline: string
  readonly detail: string
}

/** True when this ending is one the run reached by itself. */
export function autoplayCompleted(end: AutoplayEnd | null | undefined): boolean {
  return end?.kind === 'settled' || end?.kind === 'bounded'
}

/**
 * `Focus` is whatever the application wants highlighted while the announced
 * step runs (a seat and a region, for the duel; a stage, for an application
 * room). `Acting` is what it wants labelled while the step is in flight. Both
 * are opaque here: this reducer only carries them.
 */
export interface AutoplayRunState<Focus, Acting> {
  readonly status: AutoplayStatus
  readonly movesMade: number
  readonly maxMoves: number
  readonly delayMs: number
  readonly loop: boolean
  /** How many complete runs this session has played; drives the loop counter. */
  readonly runs: number
  /** The sentence the room reads for the announced or in-flight step. */
  readonly narration: string | null
  readonly focus: Focus | null
  readonly acting: Acting | null
  /** Identifies the announced step so the hook announces it exactly once. */
  readonly announced: string | null
  /**
   * Why the run is standing still without having ended - a proof is running on
   * the single GPU, a checkpoint is due and the batch must not be overfilled, a
   * room is being deployed.
   *
   * A held run is NOT an ended run: it keeps its budget, keeps its narration,
   * and resumes by itself. It exists so a presenter sees "waiting on L1" rather
   * than a console that appears frozen for the length of a proof.
   */
  readonly hold: string | null
  readonly end: AutoplayEnd | null
}

export interface AutoplayRunOptions {
  readonly delayMs?: number
  readonly loop?: boolean
  readonly maxMoves?: number
}

export function createAutoplayRunState<Focus, Acting>(
  defaults: { readonly delayMs: number; readonly maxMoves: number },
  options: AutoplayRunOptions = {},
): AutoplayRunState<Focus, Acting> {
  return {
    status: 'idle',
    movesMade: 0,
    maxMoves: options.maxMoves ?? defaults.maxMoves,
    delayMs: options.delayMs ?? defaults.delayMs,
    loop: options.loop ?? false,
    runs: 0,
    narration: null,
    focus: null,
    acting: null,
    announced: null,
    hold: null,
    end: null,
  }
}

export type AutoplayRunAction<Focus, Acting> =
  | { readonly type: 'start' }
  | { readonly type: 'hold'; readonly hold: string | null }
  | {
      readonly type: 'announce'
      readonly key: string
      readonly narration: string
      readonly focus: Focus
    }
  | { readonly type: 'act'; readonly acting: Acting }
  | { readonly type: 'settled' }
  | { readonly type: 'stop' }
  | { readonly type: 'end'; readonly end: AutoplayEnd }
  | { readonly type: 'delay'; readonly delayMs: number }
  | { readonly type: 'loop'; readonly loop: boolean }

/**
 * The two endings the reducer itself produces, in the application's own words.
 *
 * They are injected rather than fixed here because the sentence a presenter
 * reads has to be about the thing on screen: "the duel is left exactly where it
 * stands and stays playable by clicking" is not true of an auction room.
 */
export interface AutoplayRunEnds {
  readonly bounded: AutoplayEnd
  readonly stopped: AutoplayEnd
}

/**
 * `act` is the only transition that spends the budget, and it refuses rather
 * than overspends: a run at its bound ends instead of taking one more step.
 */
export function createAutoplayRunReducer<Focus, Acting>(ends: AutoplayRunEnds) {
  return function autoplayRunReducer(
    state: AutoplayRunState<Focus, Acting>,
    action: AutoplayRunAction<Focus, Acting>,
  ): AutoplayRunState<Focus, Acting> {
    switch (action.type) {
      case 'start':
        return {
          ...state,
          status: 'running',
          movesMade: 0,
          narration: null,
          focus: null,
          acting: null,
          announced: null,
          hold: null,
          end: null,
          runs: state.runs + 1,
        }
      case 'hold':
        // Only a running run can be held, and an identical hold is not a state
        // change: this action is driven from a render-derived string, so
        // returning a new object for it would re-render on every tick.
        if (state.status !== 'running') return state
        return state.hold === action.hold ? state : { ...state, hold: action.hold }
      case 'announce':
        if (state.status !== 'running') return state
        if (state.announced === action.key) return state
        return { ...state, announced: action.key, narration: action.narration, focus: action.focus }
      case 'act': {
        if (state.status !== 'running') return state
        if (state.movesMade >= state.maxMoves) {
          return { ...state, status: 'ended', acting: null, end: ends.bounded }
        }
        return { ...state, movesMade: state.movesMade + 1, acting: action.acting }
      }
      case 'settled':
        return state.acting === null ? state : { ...state, acting: null }
      case 'stop':
        return state.status === 'running'
          ? { ...state, status: 'ended', acting: null, hold: null, end: ends.stopped }
          : state
      case 'end':
        return { ...state, status: 'ended', acting: null, hold: null, end: action.end }
      case 'delay':
        return { ...state, delayMs: action.delayMs }
      case 'loop':
        return { ...state, loop: action.loop }
      default:
        return state
    }
  }
}

/** True when the run has no budget left, whoever asks. */
export function autoplayExhausted(state: {
  readonly movesMade: number
  readonly maxMoves: number
}): boolean {
  return state.movesMade >= state.maxMoves
}

/** The step delays a presenter can choose between, in milliseconds. */
export const AUTOPLAY_DELAYS: readonly number[] = Object.freeze([
  1_000, 1_500, 2_000, 2_500, 3_500,
])

export function autoplayFailedEnd(reason: string, headline: string): AutoplayEnd {
  return { kind: 'failed', headline, detail: reason }
}

export function autoplayUnavailableEnd(reason: string, headline: string): AutoplayEnd {
  return { kind: 'unavailable', headline, detail: reason }
}
