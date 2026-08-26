/**
 * Reorg regression for provisional checkpoint acceptance.
 */
import { describe, expect, it } from 'vitest'
import * as checkpointState from '../src/demo-checkpoint-state.js'
import {
  completeCheckpoint,
  pendingActions,
  rollbackCheckpoint,
  roomIsOpen,
  OPEN_ROOM_PHASES,
} from '../src/demo-checkpoint-state.js'
import type {
  DemoAction,
  DemoCheckpoint,
  DemoCheckpointRecord,
  DemoRoom,
} from '../src/demo-types.js'

const AT = '2026-07-24T12:00:00.000Z'

function action(id: string, block: 1 | 2): DemoAction {
  return {
    id,
    actionId: 'buy-item',
    label: 'Buy item',
    actorId: 'buyer',
    calldata: '0x',
    block,
    acceptedAt: AT,
    checkpointSequence: null,
  }
}

function openRoom(): DemoRoom {
  return {
    id: 'room-1',
    name: 'Fixture room',
    templateId: 'template-1',
    managed: false,
    deadlineBlocksFromStart: 20,
    phase: 'L1_FINALIZED',
    createdAt: AT,
    updatedAt: AT,
    chainRoomId: '7',
    deploymentTransaction: null,
    actions: [action('a1', 1), action('a2', 2)],
    checkpoints: [],
    proofDeadlineBlock: null,
    lastCheckpointAt: null,
    closedAt: null,
  }
}

function runningRecord(): DemoCheckpointRecord {
  return {
    sequence: 1,
    trigger: 'MANUAL',
    actionIds: ['a1', 'a2'],
    startedAt: AT,
    finishedAt: null,
    outcome: 'RUNNING',
    queueWaitMs: 0,
  }
}

function checkpointResult(): DemoCheckpoint {
  return {
    proofMs: 1_000,
    localVerificationMs: 10,
    transaction: '0x0101...0101',
    l1TransactionHash: `0x${'01'.repeat(32)}`,
    l1Block: '55',
    l1BlockHash: `0x${'03'.repeat(32)}`,
    finalizedL1Block: '119',
    finalizedL1BlockHash: `0x${'04'.repeat(32)}`,
    batchIndex: 1,
    postStateRoot: `0x${'02'.repeat(32)}`,
    explorerUrl: null,
  }
}

describe('demo checkpoint reorg rollback', () => {
  it('unstamps moves and retracts a provisional acceptance that disappears', () => {
    const room = openRoom()
    const record = runningRecord()

    expect(pendingActions(room).map((entry) => entry.id)).toEqual(['a1', 'a2'])

    completeCheckpoint(room, record, checkpointResult(), '2026-07-24T12:05:00.000Z')

    // Every proved move now carries the checkpoint sequence and none is pending.
    expect(room.actions.map((entry) => entry.checkpointSequence)).toEqual([1, 1])
    expect(record.outcome).toBe('ACCEPTED')
    expect(room.checkpoint?.batchIndex).toBe(1)
    expect(pendingActions(room)).toHaveLength(0)

    rollbackCheckpoint(
      room,
      record,
      { explanation: 'reorg dropped the settlement tx', effect: 'none applied', recovery: 'n/a' },
      '2026-07-24T12:06:00.000Z',
    )
    expect(room.actions.map((entry) => entry.checkpointSequence)).toEqual([null, null])
    expect(record.outcome).toBe('FAILED')
    expect(room.checkpoint).toBeUndefined()
    expect(room.phase).toBe('ACTIVE')
    expect(pendingActions(room).map((entry) => entry.id)).toEqual(['a1', 'a2'])

    expect(OPEN_ROOM_PHASES).toContain('L1_FINALIZED')
    expect(OPEN_ROOM_PHASES as readonly string[]).not.toContain('L1_ACCEPTED')
    expect(roomIsOpen(room)).toBe(true)

    const exported = Object.keys(checkpointState)
    expect(
      exported.some((name) => /unstamp|demote|revert|reverify|rollback|reopen/i.test(name)),
    ).toBe(true)
  })
})
