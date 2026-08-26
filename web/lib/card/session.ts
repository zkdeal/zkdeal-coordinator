/**
 * The public half of a duel: the read-model, the participant mirror and the log
 * of what each move published.
 *
 * `applyCardMove` in `@zkdeal/card` is the rules authority (pinned against
 * `contracts/src/l2/v5/HiddenCardDuel.sol` by that package's parity test), so
 * this module never decides a rule. It applies a move OPTIMISTICALLY before the
 * transaction is offered, which is the point: a move the duel would revert is
 * rejected here, in the browser, without spending a transaction, and the thrown
 * message is already prefixed with the Solidity custom error the chain would
 * have used.
 *
 * Nothing in `CardSessionState` is secret. The witness lives in the vault
 * worker; what a log entry holds is the calldata that was (or would be)
 * published, which is by definition public in a VALIDITY_ONLY room.
 */
import {
  applyCardMove,
  createCardDuelState,
  type CardDuelState,
  type CardMovePayload,
  type CardSeatIndex,
} from '@zkdeal/card'
import type { CardDuelEntryPoint, CardCalldata } from './calldata'
import {
  cardLedgerWith,
  createCardLedger,
  type CardParticipantLedger,
  type ParticipantLeaf,
} from './participants'

/**
 * Where one move stands, from built-in-this-tab to proven on L1.
 *
 * The four values are deliberately not interchangeable, because the difference
 * between them is the difference between a claim and a settlement:
 *
 *   `rehearsed`    built and audited here; the room has never seen it.
 *   `submitting`   handed to the coordinator, no answer yet.
 *   `submitted`    the room accepted it as an action. NOT on L1.
 *   `checkpointed` covered by a batch that was proven and accepted on L1.
 *   `failed`       the coordinator refused it, and `error` says why in its words.
 */
export type CardSubmissionStatus =
  | 'rehearsed'
  | 'submitting'
  | 'submitted'
  | 'checkpointed'
  | 'failed'

export interface CardSessionEntry {
  readonly sequence: number
  readonly seat: CardSeatIndex
  readonly move: CardDuelEntryPoint
  readonly calldata: CardCalldata
  /** Measured wall-clock cost of the inner proof, when the move carried one. */
  readonly provingMs: number | null
  /** Ordered circuit public inputs, decimal, when the move carried a proof. */
  readonly publicInputs: readonly string[] | null
  readonly status: CardSubmissionStatus
  /**
   * The coordinator's id for the accepted room ACTION. This is not a
   * transaction hash and is never rendered as one - a room action is a queued
   * L2 call, and nothing about it has touched L1 yet.
   */
  readonly actionId: string | null
  /** Which of the room's two L2 blocks the action was filed into. */
  readonly block: 1 | 2 | null
  /** Ordinal of the L1 checkpoint that proved this move, once one has. */
  readonly checkpointIndex: number | null
  readonly error: string | null
  readonly at: number
}

export interface CardSessionState {
  readonly duel: CardDuelState
  readonly ledger: CardParticipantLedger
  readonly entries: readonly CardSessionEntry[]
}

export interface CardSessionIdentity {
  /** `HiddenCardDuelV5.proofDomain()`, as bytes32. */
  readonly proofDomain: string
  readonly duelId: bigint
  readonly entryStake: bigint
  readonly participantCapacity?: number
}

export function createCardSession(identity: CardSessionIdentity): CardSessionState {
  return {
    duel: createCardDuelState({
      proofDomain: identity.proofDomain,
      duelId: identity.duelId,
      entryStake: identity.entryStake,
    }),
    ledger: createCardLedger(identity.participantCapacity),
    entries: [],
  }
}

export interface CardSessionMove {
  readonly seat: CardSeatIndex
  /** The rules payload, containing only public duel data and a proof verdict. */
  readonly payload: CardMovePayload
  readonly calldata: CardCalldata
  /** The leaf `_writeParticipant` will store; folded into the mirror on accept. */
  readonly participant: ParticipantLeaf
  readonly provingMs?: number
  readonly publicInputs?: readonly string[]
  readonly at?: number
}

/**
 * Fold one move into the session. The rules run FIRST: a rejected move leaves
 * the state, the participant mirror and the log untouched, so a failed local
 * rehearsal can never desynchronize the nonce the next transaction depends on.
 */
export function applyCardSessionMove(
  state: CardSessionState,
  move: CardSessionMove,
): CardSessionState {
  const duel = applyCardMove(state.duel, move.seat, move.payload)
  const entry: CardSessionEntry = {
    sequence: state.entries.length + 1,
    seat: move.seat,
    move: move.calldata.move,
    calldata: move.calldata,
    provingMs: move.provingMs ?? null,
    publicInputs: move.publicInputs ?? null,
    status: 'rehearsed',
    actionId: null,
    block: null,
    checkpointIndex: null,
    error: null,
    at: move.at ?? Date.now(),
  }
  return {
    duel,
    ledger: cardLedgerWith(state.ledger, move.participant),
    entries: [...state.entries, entry],
  }
}

/**
 * Register a registration-only move (`registerDuelist`, `withdrawUnspent`),
 * which touches escrow rather than duel state and therefore has no
 * `CardMovePayload`.
 */
export function applyCardEscrowMove(
  state: CardSessionState,
  move: Omit<CardSessionMove, 'payload'>,
): CardSessionState {
  const entry: CardSessionEntry = {
    sequence: state.entries.length + 1,
    seat: move.seat,
    move: move.calldata.move,
    calldata: move.calldata,
    provingMs: move.provingMs ?? null,
    publicInputs: move.publicInputs ?? null,
    status: 'rehearsed',
    actionId: null,
    block: null,
    checkpointIndex: null,
    error: null,
    at: move.at ?? Date.now(),
  }
  return {
    duel: state.duel,
    ledger: cardLedgerWith(state.ledger, move.participant),
    entries: [...state.entries, entry],
  }
}

export function markCardSubmission(
  state: CardSessionState,
  sequence: number,
  patch: {
    status: CardSubmissionStatus
    actionId?: string | null
    block?: 1 | 2 | null
    error?: string | null
  },
): CardSessionState {
  return {
    ...state,
    entries: state.entries.map((entry) =>
      entry.sequence === sequence
        ? {
            ...entry,
            status: patch.status,
            actionId: patch.actionId ?? entry.actionId,
            block: patch.block ?? entry.block,
            error: patch.error ?? null,
          }
        : entry,
    ),
  }
}

/**
 * Promote the named moves to `checkpointed`.
 *
 * Only a move the room already ACCEPTED can be promoted: a batch proves the
 * actions the room holds, so promoting anything else would assert an L1
 * settlement for bytes that were never handed over. A sequence that is not in
 * `submitted` is left exactly as it is rather than silently upgraded.
 */
export function markCardCheckpoint(
  state: CardSessionState,
  sequences: readonly number[],
  checkpointIndex: number,
): CardSessionState {
  const covered = new Set(sequences)
  return {
    ...state,
    entries: state.entries.map((entry) =>
      covered.has(entry.sequence) && entry.status === 'submitted'
        ? { ...entry, status: 'checkpointed' as const, checkpointIndex }
        : entry,
    ),
  }
}

/**
 * Carry the settlement bookkeeping of `previous` onto `next`.
 *
 * `run` folds a move into the session it captured and writes the result
 * ABSOLUTELY, because the calldata, the participant nonce and the proof's
 * public inputs were all built against that exact read-model. Settlement, on
 * the other hand, writes concurrently and only ever touches status fields. This
 * merge lets both be true: the duel state and the log come from `next`, the
 * status of every move that already existed comes from `previous`.
 *
 * Nothing about the rules, the ledger or the calldata is merged - only the four
 * fields that describe where a move stands with the room.
 */
export function cardCarrySubmissions(
  previous: CardSessionState,
  next: CardSessionState,
): CardSessionState {
  const before = new Map(previous.entries.map((entry) => [entry.sequence, entry]))
  return {
    ...next,
    entries: next.entries.map((entry) => {
      const prior = before.get(entry.sequence)
      if (!prior || prior.status === 'rehearsed') return entry
      return {
        ...entry,
        status: prior.status,
        actionId: prior.actionId,
        block: prior.block,
        checkpointIndex: prior.checkpointIndex,
        error: prior.error,
      }
    }),
  }
}

/** Total bytes this duel has published, i.e. what an observer of L1 sees. */
export function cardPublishedBytes(state: CardSessionState): number {
  return state.entries.reduce((total, entry) => total + entry.calldata.bytes, 0)
}

/** Total measured browser proving time, so the demo can show its real cost. */
export function cardProvingMs(state: CardSessionState): number {
  return state.entries.reduce((total, entry) => total + (entry.provingMs ?? 0), 0)
}

/**
 * One-line description of what the duel is waiting for, derived from the phase
 * enum rather than from the UI's own idea of progress.
 */
export function cardTurnSummary(state: CardSessionState): string {
  const duel = state.duel
  switch (duel.phase) {
    case 'Idle':
      return 'No duel is open. Seat 0 opens one.'
    case 'AwaitingOpponent':
      return 'Waiting for a second duelist to join.'
    case 'DeckSetup':
      return 'Each seat commits a shuffled deck with a CardDeckInit proof.'
    case 'SeedCommit':
      return 'Both seats commit a seed before either may reveal.'
    case 'SeedReveal':
      return 'Both seats reveal; the opened seeds pick who moves first.'
    case 'Active':
      return `Seat ${duel.turn} is on the move (turn ${duel.turnNumber}).`
    case 'Finished':
      return `Seat ${duel.winnerSeat} won.${duel.prizeClaimed ? ' The prize is claimed.' : ' The prize is unclaimed.'}`
    case 'Abandoned':
      return 'The opener abandoned before an opponent joined.'
  }
}
