/**
 * When a duel checkpoints, and what an L1 receipt is actually allowed to claim.
 *
 * A room proves a BATCH of at most two L2 blocks, each capped at 5,000,000
 * gas used (`zkvm/crates/risc0/host/src/v5_fixture/policy.rs`). A card move
 * costs roughly 600,000 gas and a registration roughly 700,000, so a batch
 * holds on the order of sixteen moves before the gas ceiling - not the 32-per-
 * block array cap - becomes the binding limit. A duel that ran to the ceiling
 * before asking for a checkpoint would have to be told, at the ceiling, that
 * nothing more can be settled. So the trigger here is a move COUNT well under
 * that, plus an age fallback, and never "the batch is nearly full".
 *
 * The measured cost of a checkpoint on the reference stand is ~17.2 s of GPU
 * proving plus one or two 12 s L1 blocks. That is why a fresh duel does not
 * checkpoint: two moves are not worth thirty seconds of the room's attention,
 * and a player who has just sat down must not be interrupted by one.
 *
 * Everything in this module is a pure function of the move log so it can be
 * driven headless. React-free by construction; the driver lives in
 * `components/card-duel/use-card-settlement.ts`.
 */
import { l1Receipt, type L1Receipt } from '../l1-receipt'
import type { CardSessionEntry } from './session'

export interface CardCheckpointPolicy {
  /** Submitted-but-unproven moves that trigger a checkpoint. */
  readonly movesPerCheckpoint: number
  /** Below this, a checkpoint is never worth the room's proving time. */
  readonly minimumMoves: number
  /** A slow duel still settles: the oldest waiting move ages into a checkpoint. */
  readonly maxPendingAgeMs: number
  /** Measured GPU proving cost of one room batch, for what the UI promises. */
  readonly proofSeconds: number
}

export const CARD_CHECKPOINT_POLICY: CardCheckpointPolicy = Object.freeze({
  movesPerCheckpoint: 6,
  minimumMoves: 2,
  maxPendingAgeMs: 120_000,
  proofSeconds: 17.2,
})

/**
 * Adopt the coordinator's own measured proof time when it publishes one
 * (`/demo/v1/system` -> `gpu.recommendedProofSeconds`). Only the number the UI
 * quotes changes; the move thresholds are set by the batch gas ceiling, which
 * no GPU makes larger.
 */
export function cardCheckpointPolicy(
  proofSeconds: number | null | undefined,
): CardCheckpointPolicy {
  const measured = typeof proofSeconds === 'number' && proofSeconds > 0 ? proofSeconds : null
  return measured === null
    ? CARD_CHECKPOINT_POLICY
    : Object.freeze({ ...CARD_CHECKPOINT_POLICY, proofSeconds: measured })
}

/* ------------------------------ move accounting ---------------------------- */

export interface CardPendingMove {
  readonly sequence: number
  readonly block: 1 | 2 | null
  readonly at: number
}

export interface CardSettlementCounts {
  readonly total: number
  /** Built and audited in this tab; the room has never seen these. */
  readonly local: number
  readonly submitting: number
  /** Accepted by the room, not yet proven on L1. */
  readonly submitted: number
  readonly checkpointed: number
  readonly failed: number
  readonly pending: readonly CardPendingMove[]
  /** Distinct room L2 blocks the pending moves occupy, ascending. */
  readonly blocks: readonly (1 | 2)[]
  readonly oldestPendingAt: number | null
}

export function cardSettlementCounts(
  entries: readonly CardSessionEntry[],
): CardSettlementCounts {
  const pending: CardPendingMove[] = []
  let local = 0
  let submitting = 0
  let checkpointed = 0
  let failed = 0
  for (const entry of entries) {
    if (entry.status === 'rehearsed') local += 1
    else if (entry.status === 'submitting') submitting += 1
    else if (entry.status === 'checkpointed') checkpointed += 1
    else if (entry.status === 'failed') failed += 1
    else pending.push({ sequence: entry.sequence, block: entry.block, at: entry.at })
  }
  const blocks = ([1, 2] as const).filter((block) =>
    pending.some((move) => move.block === block),
  )
  return {
    total: entries.length,
    local,
    submitting,
    submitted: pending.length,
    checkpointed,
    failed,
    pending,
    blocks,
    oldestPendingAt: pending.reduce<number | null>(
      (oldest, move) => (oldest === null || move.at < oldest ? move.at : oldest),
      null,
    ),
  }
}

/* -------------------------------- the trigger ------------------------------ */

export type CardCheckpointReason = 'moves' | 'age' | 'requested'

export interface CardCheckpointDue {
  readonly due: boolean
  readonly because: CardCheckpointReason | null
  /** Submitted moves still needed before the count trigger fires. */
  readonly movesRemaining: number
  /** Why a due checkpoint cannot run yet, in a sentence, or null. */
  readonly blocked: string | null
}

/**
 * The coordinator refuses a batch that does not cover both of the room's L2
 * blocks (`demo-controller.checkpointRoom`), so a duel whose only submitted
 * move landed in block 1 is not checkpointable however old it is. That is a
 * blocked-not-due state and is reported as one rather than retried in a loop.
 */
export function cardCheckpointDue(
  counts: CardSettlementCounts,
  policy: CardCheckpointPolicy,
  options: { readonly now: number; readonly requested?: boolean } = { now: Date.now() },
): CardCheckpointDue {
  const movesRemaining = Math.max(0, policy.movesPerCheckpoint - counts.submitted)
  if (counts.submitted === 0) {
    return {
      due: options.requested === true,
      because: options.requested === true ? 'requested' : null,
      movesRemaining,
      blocked: options.requested === true ? 'No submitted move is waiting to be proven.' : null,
    }
  }
  const aged =
    counts.oldestPendingAt !== null &&
    options.now - counts.oldestPendingAt >= policy.maxPendingAgeMs &&
    counts.submitted >= policy.minimumMoves
  const because: CardCheckpointReason | null =
    options.requested === true
      ? 'requested'
      : counts.submitted >= policy.movesPerCheckpoint
        ? 'moves'
        : aged
          ? 'age'
          : null
  if (because === null) return { due: false, because: null, movesRemaining, blocked: null }
  const blocked =
    counts.blocks.length < 2
      ? 'A room batch must cover both of its L2 blocks; only one of them holds a submitted move so far.'
      : counts.submitted < policy.minimumMoves
        ? `A checkpoint costs about ${policy.proofSeconds.toFixed(0)} s of proving, so it waits for at least ${policy.minimumMoves} submitted moves.`
        : null
  return { due: true, because, movesRemaining, blocked }
}

/* ------------------------------- the next step ----------------------------- */

export type CardSettlementAction =
  | { readonly kind: 'idle'; readonly reason: string }
  | { readonly kind: 'submit'; readonly sequence: number }
  | {
      readonly kind: 'checkpoint'
      readonly sequences: readonly number[]
      readonly because: CardCheckpointReason
    }

export interface CardSettlementInput {
  readonly entries: readonly CardSessionEntry[]
  readonly hasRoom: boolean
  readonly policy: CardCheckpointPolicy
  readonly now: number
  /** A human pressed "checkpoint now"; skips the count trigger, not the shape rules. */
  readonly requested?: boolean
  /** False leaves submission to the per-move buttons. */
  readonly autoSubmit?: boolean
}

/**
 * One step at a time, and a due checkpoint outranks a waiting submission.
 *
 * That precedence is what keeps the batch inside its gas ceiling: if new moves
 * always went first, a fast autoplay could push the pending set past what a
 * single batch can prove, and the checkpoint that was due six moves ago would
 * fail on the room's limits instead of the policy's.
 */
export function cardSettlementAction(input: CardSettlementInput): CardSettlementAction {
  if (!input.hasRoom) {
    return {
      kind: 'idle',
      reason: 'No room is attached, so every move stays in this tab and nothing is claimed on L1.',
    }
  }
  const counts = cardSettlementCounts(input.entries)
  const due = cardCheckpointDue(counts, input.policy, {
    now: input.now,
    requested: input.requested,
  })
  if (due.due && due.blocked === null && due.because !== null) {
    return {
      kind: 'checkpoint',
      sequences: counts.pending.map((move) => move.sequence),
      because: due.because,
    }
  }
  if (input.autoSubmit !== false) {
    const next = input.entries.find((entry) => entry.status === 'rehearsed')
    if (next) return { kind: 'submit', sequence: next.sequence }
  }
  if (due.blocked !== null) return { kind: 'idle', reason: due.blocked }
  if (counts.submitted > 0) {
    return {
      kind: 'idle',
      reason: `${counts.submitted} submitted move${counts.submitted === 1 ? '' : 's'} waiting; ${due.movesRemaining} more trigger the next checkpoint.`,
    }
  }
  return { kind: 'idle', reason: 'Nothing is waiting for the room.' }
}

/**
 * The sentence the console shows above the checkpoint ledger. It never says a
 * checkpoint "will" happen at a time - only what the trigger is and how much of
 * it is met - because the coordinator, not this tab, decides whether a batch
 * can be proven.
 */
export function cardCheckpointHint(
  counts: CardSettlementCounts,
  due: CardCheckpointDue,
  policy: CardCheckpointPolicy,
  hasRoom: boolean,
): string {
  if (!hasRoom) {
    return 'Moves are built and audited in this tab. Attach a room to settle them on L1.'
  }
  if (due.blocked !== null) return due.blocked
  if (due.due) {
    return `A checkpoint is due now: ${counts.submitted} submitted move${
      counts.submitted === 1 ? '' : 's'
    } to prove, about ${policy.proofSeconds.toFixed(1)} s of GPU proving plus L1 inclusion.`
  }
  if (counts.submitted === 0) {
    return `Nothing is waiting on L1. The next checkpoint is triggered by ${policy.movesPerCheckpoint} submitted moves, or by the oldest one reaching ${Math.round(policy.maxPendingAgeMs / 1000)} s.`
  }
  return `${counts.submitted} submitted move${counts.submitted === 1 ? '' : 's'} waiting on L1 · ${due.movesRemaining} more move${
    due.movesRemaining === 1 ? '' : 's'
  } trigger the next checkpoint.`
}

/* --------------------------------- receipts -------------------------------- */

/**
 * A checkpoint's L1 receipt.
 *
 * The recovery rule - prefer the field the coordinator publishes whole
 * (`l1TransactionHash`), else the hash inside `explorerUrl`, else nothing, and
 * NEVER a link built over an abbreviation - lives in `lib/l1-receipt.ts`, where
 * every log on this site shares it. This is the duel's name for the same thing;
 * `transaction` keeps its name so no existing reader changes meaning.
 */
export interface CardCheckpointReceipt extends L1Receipt {
  /**
   * The historical name for `hash`, kept so no existing reader of this console
   * changes meaning. Same value, same rules.
   */
  readonly transaction: string
}

export function cardCheckpointReceipt(
  checkpoint: {
    readonly transaction: string
    readonly l1TransactionHash?: string | null
    readonly explorerUrl?: string | null
  },
  explorerBase?: string | null,
): CardCheckpointReceipt {
  const receipt = l1Receipt(
    {
      hash: checkpoint.l1TransactionHash ?? null,
      transaction: checkpoint.transaction,
      explorerUrl: checkpoint.explorerUrl ?? null,
    },
    explorerBase,
  )
  return { ...receipt, transaction: receipt.hash }
}

/**
 * Which moves a landed batch may actually be credited with.
 *
 * A batch proves the actions the ROOM holds, so a move whose accepted action id
 * is no longer listed by the coordinator was not in that batch - whatever the
 * receipt says. Crediting it anyway is exactly the "claim a settlement that did
 * not happen" this console must never do, so it stays `submitted` and the
 * discrepancy is named.
 */
export function cardProvenSequences(
  sequences: readonly number[],
  entries: readonly CardSessionEntry[],
  heldActionIds: readonly string[],
): { readonly proven: readonly number[]; readonly dropped: readonly number[] } {
  const held = new Set(heldActionIds)
  const bySequence = new Map(entries.map((entry) => [entry.sequence, entry]))
  const proven: number[] = []
  const dropped: number[] = []
  for (const sequence of sequences) {
    const actionId = bySequence.get(sequence)?.actionId ?? null
    if (actionId !== null && held.has(actionId)) proven.push(sequence)
    else dropped.push(sequence)
  }
  return { proven, dropped }
}

export interface CardCheckpointSource {
  readonly transaction: string
  /** The same hash published whole; on the server's `PUBLISHED_IN_FULL` list. */
  readonly l1TransactionHash?: string | null
  readonly l1Block: string
  readonly postStateRoot: string
  readonly proofMs: number
  readonly localVerificationMs: number
  readonly explorerUrl?: string | null
}

/**
 * One checkpoint ATTEMPT as the coordinator publishes it: what it tried to
 * prove, how it ended, and a `result` only once it was accepted.
 */
export interface CardCheckpointAttempt {
  readonly sequence?: number
  readonly outcome?: string
  readonly actionIds?: readonly string[]
  readonly result?: CardCheckpointSource
}

export interface CardCheckpointRecord {
  /** 1-based ordinal within this duel, so a long game reads as a progression. */
  readonly index: number
  readonly roomId: string
  readonly l1Block: string
  readonly postStateRoot: string
  readonly proofMs: number
  readonly localVerificationMs: number
  readonly receipt: CardCheckpointReceipt
  /** The move sequences this batch proved. */
  readonly sequences: readonly number[]
  readonly at: number
}

export function cardCheckpointRecord(input: {
  readonly index: number
  readonly roomId: string
  readonly checkpoint: CardCheckpointSource
  readonly sequences: readonly number[]
  readonly explorerBase?: string | null
  readonly at?: number
}): CardCheckpointRecord {
  return {
    index: input.index,
    roomId: input.roomId,
    l1Block: input.checkpoint.l1Block,
    postStateRoot: input.checkpoint.postStateRoot,
    proofMs: input.checkpoint.proofMs,
    localVerificationMs: input.checkpoint.localVerificationMs,
    receipt: cardCheckpointReceipt(input.checkpoint, input.explorerBase),
    sequences: [...input.sequences],
    at: input.at ?? Date.now(),
  }
}

/**
 * Every checkpoint RECEIPT the coordinator publishes for a room, oldest first.
 *
 * `room.checkpoints` is a list of ATTEMPTS, not receipts: an attempt carries
 * when it started, what it tried to prove and how it ended, and only an
 * ACCEPTED one has a `result` with a transaction and an L1 block. Reading an
 * attempt as a receipt produced a row claiming "L1 block undefined" with an
 * unlookupable hash, so an attempt without a result is dropped here rather than
 * rendered as a settlement that did not happen.
 *
 * A flat element is still accepted, so a coordinator that publishes receipts
 * directly in that list keeps working.
 */
export function cardRoomCheckpoints(
  room: {
    readonly checkpoint?: CardCheckpointSource
    readonly checkpoints?: readonly (CardCheckpointSource | CardCheckpointAttempt)[]
  } | null,
): readonly CardCheckpointSource[] {
  if (!room) return []
  if (Array.isArray(room.checkpoints)) {
    const receipts: CardCheckpointSource[] = []
    for (const entry of room.checkpoints) {
      const receipt =
        'result' in entry && entry.result !== undefined
          ? entry.result
          : ((entry as CardCheckpointSource).transaction !== undefined
              ? (entry as CardCheckpointSource)
              : null)
      if (receipt) receipts.push(receipt)
    }
    // A room mid-checkpoint has attempts but no accepted receipt yet; the
    // single latest checkpoint is then still the honest answer.
    if (receipts.length > 0) return receipts
    return room.checkpoint ? [room.checkpoint] : []
  }
  return room.checkpoint ? [room.checkpoint] : []
}
