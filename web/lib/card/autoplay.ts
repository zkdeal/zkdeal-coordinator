/**
 * The presenter's autoplay policy for the hidden-card duel.
 *
 * This module decides WHICH legal move to take next and WHAT to say about it.
 * It decides nothing else. In particular it never builds calldata, never talks
 * to the vault and never touches the read-model: it is handed the exact
 * `cardAvailableSteps` list the buttons render and returns one of those
 * steps, so an autoplayed move goes through `buildCardStep`, the vault audit
 * and `applyCardMove` on the same path a human click takes. A move this
 * planner could reach that the rules would refuse is not expressible - it can
 * only return a step the phase machine already offered.
 *
 * The two choices a step can carry (`play` needs a hand slot, `attack` needs an
 * attacker and a target) are picked the way `move-controls.tsx` picks them,
 * from the seat's own vault view and the public board. The hand slot is an
 * INDEX into this tab's vault view; it is consumed by the vault worker when it
 * proves the transition and appears in no payload, which is why
 * `CardAutoplayPlan.choice` is deliberately kept out of `CardAutoplayState`
 * - the state is the part the UI renders and a test serializes.
 *
 * React-free and side-effect-free, so a whole autoplayed duel can be driven
 * headless in a unit test without a DOM or a timer.
 */
import { CARD_RULES, type CardSeatIndex, type CardSeat } from '@zkdeal/card'
import { AUTOPLAY_DELAYS } from '../autoplay/run'
import type { CardStepChoiceInput } from './moves'
import type { CardSessionState } from './session'
import type { CardStep } from './steps'
import type { CardVaultView } from './vault-messages'

/** Which region of which seat the announced move is about to change. */
export interface CardAutoplayFocus {
  readonly seat: CardSeatIndex
  readonly region: 'stake' | 'roots' | 'hand' | 'board' | 'health'
}

export interface CardAutoplayPlan {
  readonly step: CardStep
  /** Never merged into `CardAutoplayState`; see the module note. */
  readonly choice?: CardStepChoiceInput
  readonly narration: string
  readonly focus: CardAutoplayFocus
}

/**
 * Pacing and bounds.
 *
 * `settleMs` is the pause used after a move that produced a Groth16 proof: the
 * proof already took seconds of visible wall clock, and stacking the full step
 * delay on top of it only makes the demo slower without making it clearer.
 *
 * `finaleAfter` is the move count past which the planner steers to a settled
 * duel. A duel of two 20-health seats behind a five-slot board runs far longer
 * than an audience will watch, and `maxMoves` alone would end it mid-turn with
 * nothing settled; conceding is a real move on the real path, and it is
 * narrated as the deliberate close it is rather than dressed up as a defeat.
 *
 * `handTarget` and `handReserve` are the hidden hand's own pacing, and they are
 * the reason the hand panel has anything in it. The hand is the one piece of
 * state this whole demo exists to protect - it lives only in this tab's vault
 * worker and is rendered from a view nothing else can produce - so a policy
 * that drew a single card and spent it on the very next move left the panel
 * structurally empty: the hand could never hold more than one card, and the
 * play that followed the draw always took that card straight back out. So the
 * turn now tops the hand up to `handTarget` BEFORE it spends from it, and
 * `handReserve` is the floor a play may not cross. What leaves the hand is
 * never the card that just arrived, which is what makes the hand survive its
 * own turn: once a seat has drawn, its hand stays readable for the rest of the
 * duel instead of returning to empty after every play.
 */
export const CARD_AUTOPLAY_LIMITS = Object.freeze({
  delayMs: 2_000,
  settleMs: 600,
  maxMoves: 60,
  finaleAfter: 22,
  /** Cards a turn draws up to before it plays one. */
  handTarget: 3,
  /** Cards a play may never take the hand below. */
  handReserve: 1,
  /** Pause on the end card before loop mode starts the next run. */
  restartMs: 7_000,
})

export const CARD_AUTOPLAY_DELAYS: readonly number[] = AUTOPLAY_DELAYS

const FACE = CARD_RULES.faceTarget

/** Moves that only happen while a seat is on the move. */
const TURN_MOVES: readonly string[] = ['draw', 'burn', 'play', 'attack']

function occupiedSlots(seat: CardSeat): number[] {
  const slots: number[] = []
  for (let slot = 0; slot < CARD_RULES.boardLimit; slot += 1) {
    if ((seat.boardMask & (1 << slot)) !== 0) slots.push(slot)
  }
  return slots
}

function firstFreeBoardSlot(seat: CardSeat): number | null {
  for (let slot = 0; slot < CARD_RULES.boardLimit; slot += 1) {
    if ((seat.boardMask & (1 << slot)) === 0) return slot
  }
  return null
}

function firstReadyAttacker(seat: CardSeat): number | null {
  for (const slot of occupiedSlots(seat)) {
    if ((seat.attackedMask & (1 << slot)) === 0) return slot
  }
  return null
}

/** The weakest occupied defender slot, so an attack more often reads as a kill. */
function weakestTarget(defender: CardSeat): number | null {
  let best: number | null = null
  for (const slot of occupiedSlots(defender)) {
    if (best === null || (defender.boardHealth[slot] ?? 0) < (defender.boardHealth[best] ?? 0)) best = slot
  }
  return best
}

/**
 * The moves the seat on the move has already made this turn. Derived from the
 * log rather than tracked, so it stays correct across a reset and a reload.
 */
export function cardAutoplayTurnMoves(session: CardSessionState): Set<string> {
  const entries = session.entries
  let start = 0
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]!.move === 'endTurn') {
      start = index + 1
      break
    }
  }
  const taken = new Set<string>()
  for (let index = start; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (entry.seat === session.duel.turn && TURN_MOVES.includes(entry.move)) taken.add(entry.move)
  }
  return taken
}

export interface CardAutoplayContext {
  readonly session: CardSessionState
  readonly views: readonly [CardVaultView | null, CardVaultView | null]
  /** Exactly the list the move buttons render. */
  readonly steps: readonly CardStep[]
  readonly movesMade: number
  readonly maxMoves?: number
  readonly finaleAfter?: number
  /** Overrides for the hand pacing; the shipped values are the defaults. */
  readonly handTarget?: number
  readonly handReserve?: number
}

function pick(steps: readonly CardStep[], move: string): CardStep | undefined {
  return steps.find((step) => step.move === move)
}

/**
 * The next move, or null when autoplay should stop.
 *
 * Null means one of three things, all of which end a run: the duel has no legal
 * move left, the duel is settled and paid, or the move bound is reached.
 */
export function planCardAutoplayMove(context: CardAutoplayContext): CardAutoplayPlan | null {
  const maxMoves = context.maxMoves ?? CARD_AUTOPLAY_LIMITS.maxMoves
  if (context.movesMade >= maxMoves) return null
  const step = chooseCardAutoplayStep(context)
  if (!step) return null
  const choice = cardAutoplayChoice(context, step)
  return {
    step,
    choice,
    narration: cardAutoplayNarration(step, choice),
    focus: cardAutoplayFocus(context, step),
  }
}

/**
 * Which of the offered steps to take. Setup phases have exactly one sensible
 * answer each; the interesting policy is the Active turn, which is scripted as
 * draw… → play → attack → end so every move type is demonstrated once per turn
 * at a pace an audience can follow.
 *
 * The draw phase is plural and it runs BEFORE the play rather than after it:
 * the turn tops the hand up to `handTarget` and then spends one card, never
 * below `handReserve`. That ordering is the whole difference between a hand the
 * audience can see and a hand that is a pass-through - see the note on
 * `CARD_AUTOPLAY_LIMITS`. It is gated on `play` not yet being taken so the
 * hand is filled once per turn instead of refilled behind every card spent.
 */
export function chooseCardAutoplayStep(context: CardAutoplayContext): CardStep | undefined {
  const { steps, session } = context
  if (steps.length === 0) return undefined
  const duel = session.duel

  if (duel.phase !== 'Active') {
    // Every non-Active phase offers only forward moves plus, in
    // AwaitingOpponent, `abandonDuel` - which would end the demo before it
    // starts, so it is the one offered step autoplay never takes.
    return steps.find((candidate) => candidate.move !== 'abandonDuel')
  }

  const finaleAfter = context.finaleAfter ?? CARD_AUTOPLAY_LIMITS.finaleAfter
  if (context.movesMade >= finaleAfter) {
    const concede = pick(steps, 'concede')
    if (concede) return concede
  }

  const taken = cardAutoplayTurnMoves(session)
  if (!taken.has('play')) {
    // The same reading `steps.ts` uses: the vault view when this tab holds one,
    // the published counter otherwise. Both are this seat's own hand size.
    const handCount = context.views[duel.turn]?.handCount ?? duel.seats[duel.turn].handCount
    if (handCount < (context.handTarget ?? CARD_AUTOPLAY_LIMITS.handTarget)) {
      // `burn` is the same transition against a full hand, so the deck keeps
      // advancing rather than the turn stalling on an offer that is not there.
      const drawn = pick(steps, 'draw') ?? pick(steps, 'burn')
      if (drawn) return drawn
    }
    const play = pick(steps, 'play')
    if (
      play &&
      handCount > (context.handReserve ?? CARD_AUTOPLAY_LIMITS.handReserve) &&
      cardAutoplayHandSlot(context, play.seat) !== null
    ) {
      return play
    }
  }
  const attack = pick(steps, 'attack')
  if (attack && cardAutoplayAttack(context, attack.seat) !== null) return attack
  return pick(steps, 'endTurn') ?? steps.find((candidate) => candidate.move !== 'concede')
}

/** The first occupied slot of this seat's own hand, read from its vault view. */
function cardAutoplayHandSlot(context: CardAutoplayContext, seat: CardSeatIndex): number | null {
  const hand = context.views[seat]?.handCards
  if (!hand) return null
  const slot = hand.findIndex((cardId) => cardId !== 0)
  return slot < 0 ? null : slot
}

function cardAutoplayAttack(
  context: CardAutoplayContext,
  seat: CardSeatIndex,
): { attackerSlot: number; targetSlot: number } | null {
  const duel = context.session.duel
  const attacker = duel.seats[seat]
  const defender = duel.seats[seat === 0 ? 1 : 0]
  const attackerSlot = firstReadyAttacker(attacker)
  if (attackerSlot === null) return null
  // The face is legal only against a cleared board, exactly as `applyAttack`
  // requires; anything else would be a move the rules refuse.
  const targetSlot = defender.boardMask === 0 ? FACE : weakestTarget(defender)
  return targetSlot === null ? null : { attackerSlot, targetSlot }
}

export function cardAutoplayChoice(
  context: CardAutoplayContext,
  step: CardStep,
): CardStepChoiceInput | undefined {
  if (step.choice === 'hand-slot-and-board-slot') {
    const handSlot = cardAutoplayHandSlot(context, step.seat)
    const boardSlot = firstFreeBoardSlot(context.session.duel.seats[step.seat])
    if (handSlot === null || boardSlot === null) return undefined
    return { handSlot, boardSlot }
  }
  if (step.choice === 'attack') return cardAutoplayAttack(context, step.seat) ?? undefined
  return undefined
}

function cardAutoplayFocus(context: CardAutoplayContext, step: CardStep): CardAutoplayFocus {
  const other = (step.seat === 0 ? 1 : 0) as CardSeatIndex
  switch (step.move) {
    case 'registerDuelist':
    case 'openDuel':
    case 'joinDuel':
    case 'abandonDuel':
    case 'claimPrize':
      return { seat: step.seat, region: 'stake' }
    case 'initializeDeck':
    case 'commitSeed':
    case 'revealSeed':
      return { seat: step.seat, region: 'roots' }
    case 'draw':
    case 'burn':
      return { seat: step.seat, region: 'hand' }
    case 'play':
      return { seat: step.seat, region: 'board' }
    case 'attack':
      return {
        seat: other,
        region: context.session.duel.seats[other].boardMask === 0 ? 'health' : 'board',
      }
    default:
      return { seat: step.seat, region: 'stake' }
  }
}

/**
 * What to say about the move, in the plain language a room can read.
 *
 * Every sentence is derived from the step, the chosen slots and the public
 * rules. No hand contents, no card names, no roots and no salts: the narration
 * is rendered on screen and serialized by the autoplay tests, and the only
 * card identity it may name is the one `play` publishes anyway - which it
 * describes rather than names.
 */
export function cardAutoplayNarration(
  step: CardStep,
  choice?: CardStepChoiceInput,
): string {
  const seat = `Player ${step.seat + 1}`
  switch (step.move) {
    case 'registerDuelist':
      return `${seat} registers: it funds the entry stake and publishes a participant leaf. No deck exists yet.`
    case 'openDuel':
      return `${seat} opens the duel and stakes. The board is public and empty.`
    case 'joinDuel':
      return `${seat} matches the stake. The pot is now both entries.`
    case 'abandonDuel':
      return `${seat} abandons before an opponent joined, and the stake is refunded.`
    case 'initializeDeck':
      return `${seat} shuffles a ${CARD_RULES.catalogSize}-card deck inside this tab and proves the commitment locally - the coordinator receives two Poseidon roots and never the order.`
    case 'commitSeed':
      return `${seat} commits a secret seed. Both seats commit before either may open, so neither can choose who starts.`
    case 'revealSeed':
      return `${seat} opens its commitment. The two seeds together pick the first mover.`
    case 'draw':
      return `${seat} draws a hidden card - proving the hand transition locally, so the coordinator learns a new hand root and never the card.`
    case 'burn':
      return `${seat} has a full hand, so the drawn card is burned. Proved locally; only a root leaves this tab.`
    case 'play':
      return `${seat} plays one hidden card onto board slot ${choice?.boardSlot ?? 0}. This is the only move that reveals a card id, because the board is public.`
    case 'attack':
      return choice?.targetSlot === FACE
        ? `${seat} attacks the opponent directly - the defending board is clear, so the damage lands on health. No proof: every value is already public.`
        : `${seat} attacks board slot ${choice?.targetSlot ?? 0}. No proof is needed: both minions are already public.`
    case 'endTurn':
      return `${seat} ends the turn and hands the move over.`
    case 'concede':
      return `${seat} concedes to close the demo. The duel settles and the pot becomes claimable.`
    case 'claimPrize':
      return `${seat} claims the pot into its participant leaf as spendable escrow.`
    default:
      return `${seat} makes a ${step.move} move.`
  }
}
