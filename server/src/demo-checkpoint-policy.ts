/**
 * WHEN a live room checkpoints, expressed as arithmetic over measured numbers.
 *
 * A duel is long and a batch is small, so a room that checkpoints once at the
 * end either overflows the batch or leaves the players without an L1 receipt
 * for the whole game. This module is the single place that decides "prove the
 * moves accumulated so far, now" - every constant below carries the sum that
 * produced it so a later reader can re-derive it rather than trust it.
 *
 * MEASURED INPUTS (demo stand, single RTX 4090, room proof at groth16):
 *   room proof            median 17.17 s, maximum 17.23 s
 *   L1 block time         12 s
 * These are properties of the STAND, not of this repository; `checkpointPolicy`
 * re-derives the block budget from the host's own calibration when the demo
 * service reports one, and falls back to the measured constants otherwise.
 *
 * THE POLICY, in one paragraph. A room holds its moves until it has at least
 * one in each of the two room blocks (below that the batch shape is not even
 * legal). It then checkpoints on whichever comes first: the pending set nears
 * what one batch can hold, a few minutes have passed since the last accepted
 * checkpoint, or - for a room that carries an absolute proof deadline - the
 * remaining window is down to what a whole checkpoint still needs. A rate limit
 * stops a burst of moves from monopolising the single GPU, and capacity and
 * deadline both override it because waiting past either is a lost batch rather
 * than a slow one. A room that has just started, or has just checkpointed, is
 * held: a proving slot spent on two moves is a slot the next player cannot use.
 */

/** Worst room-proof time measured on the demo stand's RTX 4090. */
export const MEASURED_ROOM_PROOF_SECONDS = 17.23

/**
 * Everything around the proof inside one checkpoint: `/v5/rooms/prepare`, the
 * local `/v5/rooms/verify` replay, journal encoding and the `submitBatch`
 * broadcast. Measured as a whole on the stand at well under ten seconds; eight
 * is the value budgeted here.
 */
export const CHECKPOINT_OVERHEAD_SECONDS = 8

/** Local Ethereum block time on the stand. */
export const L1_BLOCK_SECONDS = 12

/**
 * Blocks allowed for the submission to be included: one to be picked up and one
 * of slack, so a single missed block is not a missed deadline.
 */
export const L1_INCLUSION_BLOCKS = 2

/**
 * Wall clock a whole checkpoint occupies once it starts:
 *   17.23 s proving + 8 s overhead + 2 x 12 s inclusion = 49.23 s
 */
export const CHECKPOINT_WALL_CLOCK_SECONDS =
  MEASURED_ROOM_PROOF_SECONDS + CHECKPOINT_OVERHEAD_SECONDS + L1_INCLUSION_BLOCKS * L1_BLOCK_SECONDS

/** ceil(49.23 / 12) = 5 blocks. */
export const CHECKPOINT_BUDGET_BLOCKS = Math.ceil(CHECKPOINT_WALL_CLOCK_SECONDS / L1_BLOCK_SECONDS)

/** Publication policy: tolerate a 64-block L1 reorganization. */
export const L1_REORG_MARGIN_BLOCKS = 64

/** A disappeared settlement retains one complete prove-and-submit retry. */
export const CHECKPOINT_RETRY_BLOCKS = CHECKPOINT_BUDGET_BLOCKS

/** 64 canonical-depth blocks plus one full five-block retry. */
export const DEADLINE_SAFETY_BLOCKS =
  L1_REORG_MARGIN_BLOCKS + CHECKPOINT_RETRY_BLOCKS

/** 5 + 64 + 5 = 74 blocks before an absolute deadline, a checkpoint must start. */
export const CHECKPOINT_START_MARGIN_BLOCKS = CHECKPOINT_BUDGET_BLOCKS + DEADLINE_SAFETY_BLOCKS

/**
 * Default L1 inclusion window granted to a batch, in blocks after the head read
 * at the moment the checkpoint starts proving. It covers one whole attempt, a
 * 64-block reorg margin, and one full retry of the identical batch calldata.
 *
 * The previous default of four blocks (48 s) was BELOW the 49.23 s a checkpoint
 * actually needs, i.e. every submission raced its own deadline.
 */
export const DEFAULT_DEADLINE_BLOCKS_FROM_START = CHECKPOINT_START_MARGIN_BLOCKS

/** `env.gas_limit` for one L2 block (`v5_fixture/config.rs` GAS_LIMIT). */
export const L2_BLOCK_GAS_LIMIT = 5_000_000

/** Gas a proof-carrying duel move is signed for (`card-request.ts`). */
export const CARD_MOVE_GAS = 600_000

/** floor(5,000,000 / 600,000) = 8 moves before an L2 block runs out of gas. */
export const MOVES_PER_L2_BLOCK = Math.floor(L2_BLOCK_GAS_LIMIT / CARD_MOVE_GAS)

/** The fixture builds exactly two L2 blocks per batch. */
export const L2_BLOCKS_PER_BATCH = 2

/** 8 x 2 = 16 moves is everything one batch can carry. */
export const BATCH_MOVE_CAPACITY = MOVES_PER_L2_BLOCK * L2_BLOCKS_PER_BATCH

/**
 * 16 x 3/4 = 12. Firing at three quarters leaves four moves of headroom, so a
 * move that arrives while the checkpoint waits for the GPU still fits in the
 * batch after it rather than being stranded.
 */
export const CHECKPOINT_MOVE_THRESHOLD = Math.floor((BATCH_MOVE_CAPACITY * 3) / 4)

/** One move per room block; below that `execute_batch_v5` has no legal batch. */
export const CHECKPOINT_MINIMUM_MOVES = L2_BLOCKS_PER_BATCH

/**
 * A slow game still gets an L1 receipt this often. 180 s against a 17.23 s
 * proof is under 10% of a single GPU, so a stand can carry ten such rooms and
 * still keep a spare slot.
 */
export const CHECKPOINT_INTERVAL_SECONDS = 180

/**
 * Two checkpoints never start closer together than this. 60 s is roughly three
 * and a half proofs, so a burst of moves in one room cannot take the GPU away
 * from every other room. Capacity and deadline override it.
 */
export const CHECKPOINT_MINIMUM_INTERVAL_SECONDS = 60

export type CheckpointTrigger = 'CAPACITY' | 'MOVES' | 'ELAPSED' | 'DEADLINE' | 'MANUAL'

export interface CheckpointPolicyInput {
  /** Accepted moves not yet carried by an accepted checkpoint, per room block. */
  pendingInBlock1: number
  pendingInBlock2: number
  /** Seconds since the previous checkpoint STARTED, or since the room went live. */
  secondsSinceLastCheckpoint: number
  /**
   * Whether this room has ever started a checkpoint. The minimum interval
   * spaces checkpoints APART, so it must not delay the first one: a room whose
   * moves are piling up has nothing to be spaced from.
   */
  hasCheckpointed?: boolean
  /** Current L1 head, when known. */
  currentBlock: number | null
  /** Absolute L1 block by which the next batch must be included, when the room has one. */
  deadlineBlock: number | null
  /** Blocks a whole checkpoint needs; defaults to the measured budget. */
  budgetBlocks?: number
}

export interface CheckpointPlan {
  decision: 'HOLD' | 'DUE' | 'BLOCKED'
  trigger: CheckpointTrigger | null
  /** Caller-safe sentence naming the arithmetic that produced the decision. */
  reason: string
  pending: number
  /** Moves still accepted into this batch before capacity forces a checkpoint. */
  movesUntilDue: number
  /** Seconds until the elapsed-time trigger fires, or null when it already has. */
  secondsUntilDue: number | null
  /** Blocks until the deadline trigger fires, or null when the room has no deadline. */
  blocksUntilDeadlineTrigger: number | null
}

function hold(
  reason: string,
  pending: number,
  movesUntilDue: number,
  secondsUntilDue: number | null,
  blocksUntilDeadlineTrigger: number | null,
): CheckpointPlan {
  return {
    decision: 'HOLD',
    trigger: null,
    reason,
    pending,
    movesUntilDue,
    secondsUntilDue,
    blocksUntilDeadlineTrigger,
  }
}

/**
 * The checkpoint decision for one room. Pure: every clock and chain read
 * happens in the caller, so the whole policy is testable from a table.
 */
export function planCheckpoint(input: CheckpointPolicyInput): CheckpointPlan {
  const budget = input.budgetBlocks ?? CHECKPOINT_BUDGET_BLOCKS
  const pending = input.pendingInBlock1 + input.pendingInBlock2
  const movesUntilDue = Math.max(0, CHECKPOINT_MOVE_THRESHOLD - pending)
  const secondsUntilDue =
    input.secondsSinceLastCheckpoint >= CHECKPOINT_INTERVAL_SECONDS
      ? null
      : CHECKPOINT_INTERVAL_SECONDS - input.secondsSinceLastCheckpoint
  const blocksLeft =
    input.deadlineBlock !== null && input.currentBlock !== null
      ? input.deadlineBlock - input.currentBlock
      : null
  const blocksUntilDeadlineTrigger =
    blocksLeft === null ? null : blocksLeft - CHECKPOINT_START_MARGIN_BLOCKS

  // A batch needs one move in each of the two room blocks; a room below that
  // has nothing provable, however old it is.
  if (input.pendingInBlock1 < 1 || input.pendingInBlock2 < 1) {
    return hold(
      `a batch carries two room blocks, and ${input.pendingInBlock1} move(s) are pending in the ` +
        `first and ${input.pendingInBlock2} in the second`,
      pending,
      movesUntilDue,
      secondsUntilDue,
      blocksUntilDeadlineTrigger,
    )
  }

  // The window is already shorter than a whole checkpoint: say so instead of
  // spending a proving slot on a batch that cannot be included in time.
  if (blocksLeft !== null && blocksLeft < budget) {
    return {
      decision: 'BLOCKED',
      trigger: 'DEADLINE',
      reason:
        `only ${blocksLeft} L1 block(s) remain before the proof deadline, and a checkpoint needs ` +
        `${budget} (${CHECKPOINT_WALL_CLOCK_SECONDS.toFixed(2)} s of proving, submission and inclusion)`,
      pending,
      movesUntilDue,
      secondsUntilDue,
      blocksUntilDeadlineTrigger,
    }
  }

  const capacityFull =
    input.pendingInBlock1 >= MOVES_PER_L2_BLOCK ||
    input.pendingInBlock2 >= MOVES_PER_L2_BLOCK ||
    pending >= BATCH_MOVE_CAPACITY
  if (capacityFull) {
    return {
      decision: 'DUE',
      trigger: 'CAPACITY',
      reason:
        `a room block holds ${MOVES_PER_L2_BLOCK} moves at ${CARD_MOVE_GAS} gas against a ` +
        `${L2_BLOCK_GAS_LIMIT} gas L2 block, and ${pending} move(s) are pending`,
      pending,
      movesUntilDue: 0,
      secondsUntilDue,
      blocksUntilDeadlineTrigger,
    }
  }

  if (blocksUntilDeadlineTrigger !== null && blocksUntilDeadlineTrigger <= 0) {
    return {
      decision: 'DUE',
      trigger: 'DEADLINE',
      reason:
        `${blocksLeft} L1 block(s) remain before the proof deadline, at or under the ` +
        `${CHECKPOINT_START_MARGIN_BLOCKS} block start margin (${budget} blocks of checkpoint ` +
        `plus ${DEADLINE_SAFETY_BLOCKS} blocks of slack)`,
      pending,
      movesUntilDue,
      secondsUntilDue,
      blocksUntilDeadlineTrigger,
    }
  }

  // Rate limit. Capacity and deadline are already past; everything below is a
  // preference, and a preference does not get to take the GPU every few
  // seconds. It spaces checkpoints apart, so it does not apply to the first.
  if (
    (input.hasCheckpointed ?? false) &&
    input.secondsSinceLastCheckpoint < CHECKPOINT_MINIMUM_INTERVAL_SECONDS
  ) {
    return hold(
      `the previous checkpoint started ${Math.floor(input.secondsSinceLastCheckpoint)} s ago and ` +
        `two checkpoints stay at least ${CHECKPOINT_MINIMUM_INTERVAL_SECONDS} s apart`,
      pending,
      movesUntilDue,
      secondsUntilDue,
      blocksUntilDeadlineTrigger,
    )
  }

  if (pending >= CHECKPOINT_MOVE_THRESHOLD) {
    return {
      decision: 'DUE',
      trigger: 'MOVES',
      reason:
        `${pending} move(s) are pending, at or over the ${CHECKPOINT_MOVE_THRESHOLD} move ` +
        `threshold (three quarters of the ${BATCH_MOVE_CAPACITY} a batch can carry)`,
      pending,
      movesUntilDue: 0,
      secondsUntilDue,
      blocksUntilDeadlineTrigger,
    }
  }

  if (secondsUntilDue === null) {
    return {
      decision: 'DUE',
      trigger: 'ELAPSED',
      reason:
        `${Math.floor(input.secondsSinceLastCheckpoint)} s have passed since the previous ` +
        `checkpoint, at or over the ${CHECKPOINT_INTERVAL_SECONDS} s progress interval`,
      pending,
      movesUntilDue,
      secondsUntilDue,
      blocksUntilDeadlineTrigger,
    }
  }

  return hold(
    `${pending} move(s) pending; ${movesUntilDue} more or ${Math.ceil(secondsUntilDue)} s would ` +
      'make a checkpoint due',
    pending,
    movesUntilDue,
    secondsUntilDue,
    blocksUntilDeadlineTrigger,
  )
}

export type CheckpointPolicyDocument = ReturnType<typeof checkpointPolicyDocument>

/** The constants a client needs to explain the policy without restating it. */
export function checkpointPolicyDocument() {
  return {
    measuredProofSeconds: MEASURED_ROOM_PROOF_SECONDS,
    overheadSeconds: CHECKPOINT_OVERHEAD_SECONDS,
    l1BlockSeconds: L1_BLOCK_SECONDS,
    inclusionBlocks: L1_INCLUSION_BLOCKS,
    wallClockSeconds: CHECKPOINT_WALL_CLOCK_SECONDS,
    budgetBlocks: CHECKPOINT_BUDGET_BLOCKS,
    startMarginBlocks: CHECKPOINT_START_MARGIN_BLOCKS,
    defaultDeadlineBlocks: DEFAULT_DEADLINE_BLOCKS_FROM_START,
    movesPerL2Block: MOVES_PER_L2_BLOCK,
    batchMoveCapacity: BATCH_MOVE_CAPACITY,
    moveThreshold: CHECKPOINT_MOVE_THRESHOLD,
    minimumMoves: CHECKPOINT_MINIMUM_MOVES,
    intervalSeconds: CHECKPOINT_INTERVAL_SECONDS,
    minimumIntervalSeconds: CHECKPOINT_MINIMUM_INTERVAL_SECONDS,
  }
}
