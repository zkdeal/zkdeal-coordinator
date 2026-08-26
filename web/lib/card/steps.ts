/**
 * Which duel moves are legal right now, derived from the public read-model and
 * the two vault views.
 *
 * The console offers exactly these and nothing else, so a player cannot reach
 * for a move the contract would revert. That is a convenience, not a safety
 * property - `applyCardMove` still rejects an illegal move when it is applied
 * - but it is what makes the phase machine legible on screen: the buttons ARE
 * the phase machine.
 *
 * Deliberately React-free and side-effect-free so the whole progression can be
 * driven in a unit test without a DOM.
 */
import { CARD_RULES, type CardDuelState, type CardSeatIndex } from '@zkdeal/card'
import type { CardDuelEntryPoint } from './calldata'
import type { CardVaultView } from './vault-messages'
import type { CardSessionState } from './session'

/** Extra input the player must choose before a step can be built. */
export type CardStepChoice = 'none' | 'hand-slot-and-board-slot' | 'attack'

export interface CardStep {
  readonly move: CardDuelEntryPoint
  readonly seat: CardSeatIndex
  readonly label: string
  /** One sentence of what this publishes, shown next to the button. */
  readonly detail: string
  /** True when the move carries an inner Groth16 proof produced in the vault. */
  readonly provesLocally: boolean
  readonly choice: CardStepChoice
}

export interface CardStepContext {
  readonly session: CardSessionState
  readonly views: readonly [CardVaultView | null, CardVaultView | null]
  /** Participant indices already registered in the mirror, by seat. */
  readonly registered: readonly [boolean, boolean]
}

const SEATS: readonly CardSeatIndex[] = [0, 1]

function unattackedSlots(duel: CardDuelState, seat: CardSeatIndex): number {
  const board = duel.seats[seat]
  let available = 0
  for (let slot = 0; slot < CARD_RULES.boardLimit; slot += 1) {
    const bit = 1 << slot
    if ((board.boardMask & bit) !== 0 && (board.attackedMask & bit) === 0) available += 1
  }
  return available
}

/**
 * The legal moves, in the order the phase machine admits them. Registration is
 * included because the escrow leaf must exist before `openDuel` can prove one.
 */
export function cardAvailableSteps(context: CardStepContext): CardStep[] {
  const { session, views, registered } = context
  const duel = session.duel
  const steps: CardStep[] = []

  for (const seat of SEATS) {
    if (!registered[seat]) {
      steps.push({
        move: 'registerDuelist',
        seat,
        label: `Register seat ${seat}`,
        detail: 'Funds the entry stake and publishes a participant leaf with a session key.',
        provesLocally: false,
        choice: 'none',
      })
    }
  }
  // Registration is a prerequisite for everything below, so nothing else is
  // offered until both leaves exist: a duel move against a missing leaf reverts
  // BadParticipantProof, which is a confusing first experience.
  if (!registered[0] || !registered[1]) return steps

  switch (duel.phase) {
    case 'Idle':
      steps.push({
        move: 'openDuel',
        seat: 0,
        label: 'Open the duel',
        detail: 'Seat 0 stakes and takes seat 0. Nothing about the deck exists yet.',
        provesLocally: false,
        choice: 'none',
      })
      break
    case 'AwaitingOpponent':
      steps.push({
        move: 'joinDuel',
        seat: 1,
        label: 'Join the duel',
        detail: 'Seat 1 matches the stake. The pot is now both entries.',
        provesLocally: false,
        choice: 'none',
      })
      steps.push({
        move: 'abandonDuel',
        seat: 0,
        label: 'Abandon',
        detail: 'Only the opener, and only before an opponent joins. The stake is refunded.',
        provesLocally: false,
        choice: 'none',
      })
      break
    case 'DeckSetup':
      for (const seat of SEATS) {
        if (duel.seats[seat].deckReady) continue
        steps.push({
          move: 'initializeDeck',
          seat,
          label: `Commit seat ${seat}'s deck`,
          detail:
            views[seat]
              ? 'Publishes two Poseidon roots and a CardDeckInit proof. The shuffled order stays in the vault.'
              : 'Shuffle a deck in the vault first.',
          provesLocally: true,
          choice: 'none',
        })
      }
      break
    case 'SeedCommit':
      for (const seat of SEATS) {
        if (duel.seats[seat].seedCommitment !== null) continue
        steps.push({
          move: 'commitSeed',
          seat,
          label: `Commit seat ${seat}'s seed`,
          detail: 'One hash. Both seats commit before either may open, so neither can pick who starts.',
          provesLocally: false,
          choice: 'none',
        })
      }
      break
    case 'SeedReveal':
      for (const seat of SEATS) {
        if (duel.seats[seat].seedRevealed) continue
        steps.push({
          move: 'revealSeed',
          seat,
          label: `Reveal seat ${seat}'s seed`,
          detail: 'Opens the commitment. The two seeds together choose the first mover.',
          provesLocally: false,
          choice: 'none',
        })
      }
      break
    case 'Active': {
      const seat = duel.turn
      const board = duel.seats[seat]
      const view = views[seat]
      const handCount = view?.handCount ?? board.handCount
      if (board.deckCursor < CARD_RULES.catalogSize) {
        if (handCount < CARD_RULES.handLimit) {
          steps.push({
            move: 'draw',
            seat,
            label: 'Draw',
            detail: 'Publishes a new hand root and a CardHandAction proof. The drawn card is not named.',
            provesLocally: true,
            choice: 'none',
          })
        } else {
          steps.push({
            move: 'burn',
            seat,
            label: 'Burn',
            detail: 'A full hand must burn the drawn card. Still just a root and a proof.',
            provesLocally: true,
            choice: 'none',
          })
        }
      }
      if (handCount > 0 && board.boardCount < CARD_RULES.boardLimit) {
        steps.push({
          move: 'play',
          seat,
          label: 'Play a card',
          detail: 'This is the one move that reveals a card id, because the board is public.',
          provesLocally: true,
          choice: 'hand-slot-and-board-slot',
        })
      }
      if (unattackedSlots(duel, seat) > 0) {
        steps.push({
          move: 'attack',
          seat,
          label: 'Attack',
          detail: 'Board-to-board or face. No proof: every value involved is already public.',
          provesLocally: false,
          choice: 'attack',
        })
      }
      steps.push({
        move: 'endTurn',
        seat,
        label: 'End turn',
        detail: 'Hands the move to the other seat and clears their attack mask.',
        provesLocally: false,
        choice: 'none',
      })
      steps.push({
        move: 'concede',
        seat,
        label: 'Concede',
        detail: 'Ends the duel and awards the pot to the opponent.',
        provesLocally: false,
        choice: 'none',
      })
      break
    }
    case 'Finished':
      if (!duel.prizeClaimed) {
        steps.push({
          move: 'claimPrize',
          seat: duel.winnerSeat,
          label: 'Claim the prize',
          detail: 'Moves the pot into the winner participant leaf as spendable escrow.',
          provesLocally: false,
          choice: 'none',
        })
      }
      break
    case 'Abandoned':
      break
  }
  return steps
}

/** Number of moves in this duel that carried a browser-generated proof. */
export function cardProvenMoveCount(session: CardSessionState): number {
  return session.entries.filter((entry) => entry.publicInputs !== null).length
}
