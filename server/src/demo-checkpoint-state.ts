/**
 * Bookkeeping for a room that checkpoints repeatedly.
 *
 * A room used to have one checkpoint and then be finished: the controller's
 * gate required phase ACTIVE, success set L1_ACCEPTED, and `room.actions` was
 * never cleared, so a second attempt would have resubmitted the first one's
 * moves. Progressive checkpointing needs three things this module supplies and
 * nothing else does: a cursor that marks each move with the checkpoint that
 * proved it, a history of attempts (failures included, so a settlement that did
 * not happen is visible rather than absent), and the plan input the policy
 * module needs.
 *
 * Pure functions over the stored room. Every clock and chain read is a
 * parameter, so the whole thing is testable without a chain.
 */

import {
  planCheckpoint,
  type CheckpointPlan,
  type CheckpointTrigger,
} from './demo-checkpoint-policy.js'
import type {
  DemoAction,
  DemoCheckpointRecord,
  DemoFailure,
  DemoRoom,
} from './demo-types.js'

/** Phases in which a room is open: accepting moves and able to checkpoint. */
export const OPEN_ROOM_PHASES = ['ACTIVE', 'L1_FINALIZED'] as const

export function roomIsOpen(room: DemoRoom): boolean {
  return (OPEN_ROOM_PHASES as readonly string[]).includes(room.phase)
}

/** Accepted moves no checkpoint has proved yet, in acceptance order. */
export function pendingActions(room: DemoRoom): DemoAction[] {
  return room.actions.filter((action) => action.checkpointSequence === null)
}

/** Seconds between `at` and the start of the previous checkpoint, or room creation. */
export function secondsSinceLastCheckpoint(room: DemoRoom, at: number): number {
  const reference = room.lastCheckpointAt ?? room.createdAt
  const elapsed = (at - Date.parse(reference)) / 1_000
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0
}

/**
 * The policy decision for `room`, given the wall clock and - when the caller
 * could read it - the L1 head. A room that is not open never plans.
 */
export function checkpointPlan(
  room: DemoRoom,
  at: number = Date.now(),
  currentBlock: number | null = null,
): CheckpointPlan {
  const pending = pendingActions(room)
  return planCheckpoint({
    pendingInBlock1: pending.filter((action) => action.block === 1).length,
    pendingInBlock2: pending.filter((action) => action.block === 2).length,
    secondsSinceLastCheckpoint: secondsSinceLastCheckpoint(room, at),
    hasCheckpointed: room.checkpoints.length > 0,
    currentBlock,
    deadlineBlock: room.proofDeadlineBlock === null ? null : Number(room.proofDeadlineBlock),
  })
}

/**
 * Refuse, with the arithmetic, when the room cannot start a checkpoint. Returns
 * the moves the attempt must carry.
 */
export function assertCheckpointable(room: DemoRoom, force: boolean): DemoAction[] {
  if (!roomIsOpen(room) || !room.chainRoomId) {
    throw new Error('room is not ready to checkpoint')
  }
  if (room.checkpoints.some((record) => record.outcome === 'RUNNING')) {
    throw new Error('a checkpoint is already running for this room')
  }
  const pending = pendingActions(room)
  if (
    !pending.some((action) => action.block === 1) ||
    !pending.some((action) => action.block === 2)
  ) {
    throw new Error('add at least one accepted action to each of the two room blocks')
  }
  if (!force) {
    const plan = checkpointPlan(room)
    if (plan.decision !== 'DUE') {
      throw new Error(`a checkpoint is not due yet: ${plan.reason}`)
    }
  }
  return pending
}

/** Open a RUNNING record for the attempt about to start. */
export function startCheckpoint(
  room: DemoRoom,
  actions: readonly DemoAction[],
  trigger: CheckpointTrigger,
  at: string,
): DemoCheckpointRecord {
  const record: DemoCheckpointRecord = {
    sequence: room.checkpoints.length + 1,
    trigger,
    actionIds: actions.map((action) => action.id),
    startedAt: at,
    finishedAt: null,
    outcome: 'RUNNING',
    queueWaitMs: 0,
  }
  room.checkpoints.push(record)
  room.lastCheckpointAt = at
  return record
}

/**
 * Mark the attempt accepted and advance the cursor. The cursor moves ONLY here:
 * a move is marked proved because an L1 transaction carrying it was accepted,
 * never because a checkpoint was attempted.
 */
export function completeCheckpoint(
  room: DemoRoom,
  record: DemoCheckpointRecord,
  result: NonNullable<DemoCheckpointRecord['result']>,
  at: string,
): void {
  record.result = result
  record.outcome = 'ACCEPTED'
  record.finishedAt = at
  const proved = new Set(record.actionIds)
  for (const action of room.actions) {
    if (proved.has(action.id)) action.checkpointSequence = record.sequence
  }
  room.checkpoint = result
}

/**
 * Mark the attempt failed. The cursor does NOT move: the moves stay pending and
 * the next checkpoint carries them again, which is the only honest outcome when
 * nothing was accepted on L1.
 */
export function failCheckpoint(
  room: DemoRoom,
  record: DemoCheckpointRecord,
  failure: DemoFailure,
  at: string,
): void {
  record.outcome = 'FAILED'
  record.failure = failure
  record.finishedAt = at
}

/**
 * Retract a checkpoint whose provisional L1 acceptance was reorganized out.
 * Only moves stamped by this exact attempt are reopened; an earlier finalized
 * checkpoint remains the room's latest durable result.
 */
export function rollbackCheckpoint(
  room: DemoRoom,
  record: DemoCheckpointRecord,
  failure: DemoFailure,
  at: string,
): void {
  for (const action of room.actions) {
    if (action.checkpointSequence === record.sequence) action.checkpointSequence = null
  }
  record.outcome = 'FAILED'
  record.failure = failure
  record.finishedAt = at
  const previous = room.checkpoints
    .filter(
      (candidate) =>
        candidate !== record && candidate.outcome === 'ACCEPTED' && candidate.result,
    )
    .sort((left, right) => right.sequence - left.sequence)[0]
  if (previous?.result) room.checkpoint = previous.result
  else delete room.checkpoint
  room.phase = 'ACTIVE'
  room.updatedAt = at
}

/**
 * Bring a room loaded from an older snapshot up to the progressive shape. A
 * room persisted before this existed has neither a cursor nor a history; its
 * single accepted checkpoint is replayed as sequence 1 over every action it
 * held, because that is exactly what was submitted.
 */
export function migrateRoom(room: DemoRoom): DemoRoom {
  room.checkpoints ??= []
  room.proofDeadlineBlock ??= null
  room.lastCheckpointAt ??= null
  room.closedAt ??= null
  for (const action of room.actions) action.checkpointSequence ??= null
  if (room.checkpoint && room.checkpoints.length === 0) {
    room.checkpoints.push({
      sequence: 1,
      trigger: 'MANUAL',
      actionIds: room.actions.map((action) => action.id),
      startedAt: room.updatedAt,
      finishedAt: room.updatedAt,
      outcome: 'ACCEPTED',
      queueWaitMs: 0,
      result: room.checkpoint,
    })
    for (const action of room.actions) action.checkpointSequence = 1
  }
  return room
}
