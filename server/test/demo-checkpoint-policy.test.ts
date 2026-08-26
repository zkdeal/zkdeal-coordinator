/**
 * The checkpoint trigger policy, checked against the arithmetic it claims.
 *
 * Every constant in `demo-checkpoint-policy.ts` is derived from a measured
 * number (17.23 s of proving, 12 s L1 blocks, 5,000,000 gas per L2 block
 * against 600,000-gas duel moves). These tests recompute those sums
 * independently and assert the module agrees, so a later edit that changes a
 * constant without changing the reasoning fails here.
 */

import { describe, expect, it } from 'vitest'
import {
  BATCH_MOVE_CAPACITY,
  CARD_MOVE_GAS,
  CHECKPOINT_BUDGET_BLOCKS,
  CHECKPOINT_INTERVAL_SECONDS,
  CHECKPOINT_MINIMUM_INTERVAL_SECONDS,
  CHECKPOINT_MOVE_THRESHOLD,
  CHECKPOINT_OVERHEAD_SECONDS,
  CHECKPOINT_START_MARGIN_BLOCKS,
  CHECKPOINT_RETRY_BLOCKS,
  CHECKPOINT_WALL_CLOCK_SECONDS,
  DEADLINE_SAFETY_BLOCKS,
  DEFAULT_DEADLINE_BLOCKS_FROM_START,
  L1_BLOCK_SECONDS,
  L1_INCLUSION_BLOCKS,
  L1_REORG_MARGIN_BLOCKS,
  L2_BLOCK_GAS_LIMIT,
  MEASURED_ROOM_PROOF_SECONDS,
  MOVES_PER_L2_BLOCK,
  planCheckpoint,
  type CheckpointPolicyInput,
} from '../src/demo-checkpoint-policy.js'

function input(overrides: Partial<CheckpointPolicyInput> = {}): CheckpointPolicyInput {
  return {
    pendingInBlock1: 1,
    pendingInBlock2: 1,
    secondsSinceLastCheckpoint: 0,
    currentBlock: null,
    deadlineBlock: null,
    ...overrides,
  }
}

describe('the checkpoint margin arithmetic', () => {
  it('budgets a whole checkpoint from the measured proof time and L1 block time', () => {
    // 17.23 s proving + 8 s prepare/verify/submit + 2 x 12 s inclusion.
    expect(CHECKPOINT_WALL_CLOCK_SECONDS).toBeCloseTo(
      MEASURED_ROOM_PROOF_SECONDS + CHECKPOINT_OVERHEAD_SECONDS + L1_INCLUSION_BLOCKS * L1_BLOCK_SECONDS,
      6,
    )
    expect(CHECKPOINT_WALL_CLOCK_SECONDS).toBeCloseTo(49.23, 6)
    // ceil(49.23 / 12) = 5 blocks.
    expect(CHECKPOINT_BUDGET_BLOCKS).toBe(5)
    expect(CHECKPOINT_BUDGET_BLOCKS * L1_BLOCK_SECONDS).toBeGreaterThanOrEqual(
      CHECKPOINT_WALL_CLOCK_SECONDS,
    )
  })

  it('starts a checkpoint a whole budget plus slack before an absolute deadline', () => {
    expect(CHECKPOINT_START_MARGIN_BLOCKS).toBe(CHECKPOINT_BUDGET_BLOCKS + DEADLINE_SAFETY_BLOCKS)
    expect(L1_REORG_MARGIN_BLOCKS).toBe(64)
    expect(CHECKPOINT_RETRY_BLOCKS).toBe(CHECKPOINT_BUDGET_BLOCKS)
    expect(CHECKPOINT_START_MARGIN_BLOCKS).toBe(74)
  })

  it('grants a batch an inclusion window at least as long as a checkpoint takes', () => {
    // The historic default of four blocks was 48 s against a 49.23 s
    // checkpoint: every submission raced its own deadline.
    expect(DEFAULT_DEADLINE_BLOCKS_FROM_START * L1_BLOCK_SECONDS).toBeGreaterThan(
      CHECKPOINT_WALL_CLOCK_SECONDS,
    )
    expect(4 * L1_BLOCK_SECONDS).toBeLessThan(CHECKPOINT_WALL_CLOCK_SECONDS)
  })

  it('sizes a batch from gas, not from the request array cap', () => {
    // 5,000,000 gas per L2 block / 600,000 gas per proof-carrying move = 8.
    expect(MOVES_PER_L2_BLOCK).toBe(Math.floor(L2_BLOCK_GAS_LIMIT / CARD_MOVE_GAS))
    expect(MOVES_PER_L2_BLOCK).toBe(8)
    expect(BATCH_MOVE_CAPACITY).toBe(16)
    // Three quarters of capacity, so four more moves still fit while the
    // checkpoint waits for the GPU.
    expect(CHECKPOINT_MOVE_THRESHOLD).toBe(12)
    expect(BATCH_MOVE_CAPACITY - CHECKPOINT_MOVE_THRESHOLD).toBe(4)
    // The gas ceiling binds well before the 32-per-block request array cap.
    expect(MOVES_PER_L2_BLOCK).toBeLessThan(32)
  })
})

describe('the checkpoint trigger', () => {
  it('holds a room that has no move in one of its two blocks', () => {
    const plan = planCheckpoint(input({ pendingInBlock2: 0, secondsSinceLastCheckpoint: 10_000 }))
    expect(plan.decision).toBe('HOLD')
    expect(plan.reason).toMatch(/two room blocks/)
  })

  it('does not spend a proving slot on a room that has only just started', () => {
    const plan = planCheckpoint(input({ secondsSinceLastCheckpoint: 5 }))
    expect(plan.decision).toBe('HOLD')
    expect(plan.secondsUntilDue).toBe(CHECKPOINT_INTERVAL_SECONDS - 5)
    expect(plan.movesUntilDue).toBe(CHECKPOINT_MOVE_THRESHOLD - 2)
  })

  it('fires on the move threshold once the rate limit has passed', () => {
    const ready = {
      secondsSinceLastCheckpoint: CHECKPOINT_MINIMUM_INTERVAL_SECONDS,
      hasCheckpointed: true,
    }
    expect(
      planCheckpoint(input({ ...ready, pendingInBlock1: 6, pendingInBlock2: 5 })).decision,
    ).toBe('HOLD')
    const plan = planCheckpoint(input({ ...ready, pendingInBlock1: 6, pendingInBlock2: 6 }))
    expect(plan.decision).toBe('DUE')
    expect(plan.trigger).toBe('MOVES')
    expect(plan.pending).toBe(CHECKPOINT_MOVE_THRESHOLD)
  })

  it('fires on elapsed time so a slow game still gets an L1 receipt', () => {
    const plan = planCheckpoint(input({ secondsSinceLastCheckpoint: CHECKPOINT_INTERVAL_SECONDS }))
    expect(plan.decision).toBe('DUE')
    expect(plan.trigger).toBe('ELAPSED')
    expect(plan.secondsUntilDue).toBeNull()
  })

  it('rate-limits a burst so one room cannot monopolise the single GPU', () => {
    const burst = { pendingInBlock1: 7, pendingInBlock2: 5, secondsSinceLastCheckpoint: 5 }
    const plan = planCheckpoint(input({ ...burst, hasCheckpointed: true }))
    expect(plan.decision).toBe('HOLD')
    expect(plan.reason).toMatch(/at least 60 s apart/)
    // The limit spaces checkpoints apart, so it never delays the first one: a
    // room whose moves are piling up has nothing to be spaced from.
    expect(planCheckpoint(input({ ...burst, hasCheckpointed: false })).decision).toBe('DUE')
  })

  it('lets a full room block override the rate limit, because waiting loses moves', () => {
    const plan = planCheckpoint(
      input({
        pendingInBlock1: MOVES_PER_L2_BLOCK,
        pendingInBlock2: 1,
        secondsSinceLastCheckpoint: 1,
      }),
    )
    expect(plan.decision).toBe('DUE')
    expect(plan.trigger).toBe('CAPACITY')
    expect(plan.reason).toMatch(/5000000 gas L2 block/)
  })

  it('fires exactly at the start margin before an absolute deadline', () => {
    // Deadline 100, so a checkpoint must start at block 26 = 100 - 74.
    const at = (currentBlock: number) =>
      planCheckpoint(
        input({
          currentBlock,
          deadlineBlock: 100,
          secondsSinceLastCheckpoint: 1,
          hasCheckpointed: true,
        }),
      )
    expect(at(25).decision).toBe('HOLD')
    expect(at(25).blocksUntilDeadlineTrigger).toBe(1)
    expect(at(26).decision).toBe('DUE')
    expect(at(26).trigger).toBe('DEADLINE')
    expect(at(26).blocksUntilDeadlineTrigger).toBe(0)
    // The deadline arm outranks the rate limit: at(26) fired one second after
    // the previous checkpoint.
    expect(at(27).decision).toBe('DUE')
  })

  it('refuses instead of proving a batch that cannot be included in time', () => {
    // 4 blocks left against a 5-block budget: nothing this room can do makes
    // that deadline, and saying so beats burning 17 s of GPU on it.
    const plan = planCheckpoint(
      input({ currentBlock: 96, deadlineBlock: 100, secondsSinceLastCheckpoint: 1 }),
    )
    expect(plan.decision).toBe('BLOCKED')
    expect(plan.trigger).toBe('DEADLINE')
    expect(plan.reason).toMatch(/4 L1 block\(s\) remain/)
    expect(plan.reason).toMatch(/needs 5/)
  })

  it('never consults a deadline a room does not have', () => {
    // The demo path creates rooms with `createRoom`, so there is no pool
    // allocation and no absolute deadline; the arm simply does not fire.
    const plan = planCheckpoint(input({ currentBlock: 10_000, deadlineBlock: null }))
    expect(plan.blocksUntilDeadlineTrigger).toBeNull()
    expect(plan.decision).toBe('HOLD')
  })
})
