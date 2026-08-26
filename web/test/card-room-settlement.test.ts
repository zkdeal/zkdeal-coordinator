import { describe, expect, it } from 'vitest'
import type { Room, RoomAction } from '../components/demo-console/api'
import { cardPendingActions } from '../lib/card/demo-room'
import {
  cardCarrySubmissions,
  markCardCheckpoint,
  markCardSubmission,
  type CardSessionState,
} from '../lib/card/session'
import {
  CARD_CHECKPOINT_POLICY,
  cardCheckpointDue,
  cardCheckpointHint,
  cardCheckpointPolicy,
  cardSettlementAction,
  cardSettlementCounts,
} from '../lib/card/settlement'
import { entry, submitted } from './helpers/card-settlement-fixtures'

/**
 * Progressive settlement, half one: MOVE STAGES and CADENCE.
 *
 * Two properties are load-bearing here and each is a claim the UI makes to a
 * room full of people:
 *
 *   1. A move that has been handed to the room is NOT settled. `submitted` and
 *      `checkpointed` are different states, only a real checkpoint promotes
 *      between them, and a concurrent write of the duel state cannot silently
 *      demote a settled move back to local.
 *   2. A duel that has only just started is never cut off by a checkpoint, and
 *      a batch is never asked to carry more than the room's gas ceiling allows.
 *
 * The receipts, the autoplay hold and the wire boundary are asserted in
 * `card-room-receipts.test.ts`; shared fixtures live in
 * `helpers/card-settlement-fixtures.ts`.
 */
describe('move stages', () => {
  it('counts built, submitted and checkpointed moves as three different things', () => {
    const counts = cardSettlementCounts([
      entry({ sequence: 1, status: 'checkpointed', block: 1, checkpointIndex: 1 }),
      submitted(2, 1, 5_000),
      submitted(3, 2, 6_000),
      entry({ sequence: 4 }),
      entry({ sequence: 5, status: 'failed', error: 'room is not active' }),
    ])
    expect(counts).toMatchObject({
      total: 5,
      local: 1,
      submitted: 2,
      checkpointed: 1,
      failed: 1,
      blocks: [1, 2],
      oldestPendingAt: 5_000,
    })
    expect(counts.pending.map((move) => move.sequence)).toEqual([2, 3])
  })

  it('only promotes a move the room actually accepted', () => {
    const base: CardSessionState = {
      duel: {} as CardSessionState['duel'],
      ledger: {} as CardSessionState['ledger'],
      entries: [entry({ sequence: 1 }), submitted(2, 1), entry({ sequence: 3, status: 'failed' })],
    }
    const settled = markCardCheckpoint(base, [1, 2, 3], 1)
    // A move that was never handed over cannot be settled by a checkpoint that
    // did not contain it, however wide the promotion list is.
    expect(settled.entries.map((item) => item.status)).toEqual([
      'rehearsed',
      'checkpointed',
      'failed',
    ])
    expect(settled.entries[1]?.checkpointIndex).toBe(1)
    expect(settled.entries[0]?.checkpointIndex).toBeNull()
  })

  it('never demotes a settled move when the duel state is written concurrently', () => {
    const previous: CardSessionState = {
      duel: { phase: 'Active' } as unknown as CardSessionState['duel'],
      ledger: {} as CardSessionState['ledger'],
      entries: [
        entry({ sequence: 1, status: 'checkpointed', checkpointIndex: 1, block: 1, actionId: 'a1' }),
        submitted(2, 2),
      ],
    }
    // What `run` would write: the same log, folded from the session it captured
    // BEFORE settlement recorded anything, plus the move it just proved.
    const next: CardSessionState = {
      duel: { phase: 'Finished' } as unknown as CardSessionState['duel'],
      ledger: {} as CardSessionState['ledger'],
      entries: [entry({ sequence: 1 }), entry({ sequence: 2 }), entry({ sequence: 3 })],
    }
    const merged = cardCarrySubmissions(previous, next)
    expect(merged.duel).toBe(next.duel)
    expect(merged.entries.map((item) => item.status)).toEqual([
      'checkpointed',
      'submitted',
      'rehearsed',
    ])
    expect(merged.entries[0]?.checkpointIndex).toBe(1)
    expect(merged.entries[1]?.actionId).toBe('act-2')
  })

  it('reports a refusal without clearing what the move already achieved', () => {
    const state: CardSessionState = {
      duel: {} as CardSessionState['duel'],
      ledger: {} as CardSessionState['ledger'],
      entries: [entry({ sequence: 1 })],
    }
    const failed = markCardSubmission(state, 1, {
      status: 'failed',
      error: 'action selector is not permitted by the cold template',
    })
    expect(failed.entries[0]?.status).toBe('failed')
    expect(failed.entries[0]?.error).toBe(
      'action selector is not permitted by the cold template',
    )
  })
})

describe('checkpoint cadence', () => {
  const policy = CARD_CHECKPOINT_POLICY
  const now = 100_000

  it('does not cut a duel that has only just started', () => {
    const fresh = cardSettlementCounts([submitted(1, 1, now)])
    const due = cardCheckpointDue(fresh, policy, { now })
    expect(due.due).toBe(false)
    expect(due.movesRemaining).toBe(policy.movesPerCheckpoint - 1)
    expect(
      cardSettlementAction({ entries: [submitted(1, 1, now), entry({ sequence: 2 })], hasRoom: true, policy, now }),
    ).toEqual({ kind: 'submit', sequence: 2 })
  })

  it('triggers on the move count, well under what one batch can prove', () => {
    const entries = [
      submitted(1, 1, now),
      ...[2, 3, 4, 5, 6].map((sequence) => submitted(sequence, 2, now)),
      entry({ sequence: 7 }),
    ]
    const action = cardSettlementAction({ entries, hasRoom: true, policy, now })
    expect(action).toEqual({ kind: 'checkpoint', sequences: [1, 2, 3, 4, 5, 6], because: 'moves' })
    // Precedence matters: a waiting local move must not be submitted ahead of a
    // checkpoint that is already due, or the batch grows past its gas ceiling.
    expect(policy.movesPerCheckpoint).toBeLessThan(16)
  })

  it('settles a slow duel on age rather than leaving it unsettled forever', () => {
    const entries = [submitted(1, 1, 0), submitted(2, 2, 0)]
    expect(cardCheckpointDue(cardSettlementCounts(entries), policy, { now: 1_000 }).due).toBe(
      false,
    )
    const aged = cardCheckpointDue(cardSettlementCounts(entries), policy, {
      now: policy.maxPendingAgeMs + 1,
    })
    expect(aged).toMatchObject({ due: true, because: 'age', blocked: null })
  })

  it('refuses to fire while the batch would not cover both room blocks', () => {
    const entries = [1, 2, 3, 4, 5, 6].map((sequence) => submitted(sequence, 1, now))
    const counts = cardSettlementCounts(entries)
    const due = cardCheckpointDue(counts, policy, { now })
    expect(due.due).toBe(true)
    expect(due.blocked).toMatch(/both of its L2 blocks/)
    // Blocked-because-not-enough always means "submit more", never "give up".
    expect(
      cardSettlementAction({ entries: [...entries, entry({ sequence: 7 })], hasRoom: true, policy, now }),
    ).toEqual({ kind: 'submit', sequence: 7 })
  })

  it('does nothing at all, and says so, when there is no room', () => {
    const action = cardSettlementAction({
      entries: [entry({ sequence: 1 })],
      hasRoom: false,
      policy,
      now,
    })
    expect(action.kind).toBe('idle')
    expect(action).toHaveProperty('reason', expect.stringContaining('nothing is claimed on L1'))
    expect(
      cardCheckpointHint(cardSettlementCounts([entry({ sequence: 1 })]), cardCheckpointDue(cardSettlementCounts([]), policy, { now }), policy, false),
    ).toMatch(/built and audited in this tab/i)
  })

  it('honours a human asking for a checkpoint, but not the shape rules', () => {
    const ready = [submitted(1, 1, now), submitted(2, 2, now)]
    expect(
      cardSettlementAction({ entries: ready, hasRoom: true, policy, now, requested: true }),
    ).toEqual({ kind: 'checkpoint', sequences: [1, 2], because: 'requested' })
    const nothingToProve = cardCheckpointDue(cardSettlementCounts([]), policy, {
      now,
      requested: true,
    })
    expect(nothingToProve.blocked).toMatch(/No submitted move/)
  })

  it('quotes the measured proof time the coordinator publishes', () => {
    expect(cardCheckpointPolicy(null)).toBe(CARD_CHECKPOINT_POLICY)
    expect(cardCheckpointPolicy(24.5).proofSeconds).toBe(24.5)
    expect(cardCheckpointPolicy(24.5).movesPerCheckpoint).toBe(policy.movesPerCheckpoint)
  })
})

describe('a room that has already checkpointed keeps filling both L2 blocks', () => {
  /**
   * A room RETAINS every action it ever accepted and marks the settled ones
   * with the checkpoint that proved them. Choosing the next L2 block from all
   * of them - rather than from the pending ones - sends every move after the
   * first checkpoint into block 2, and since a batch must cover BOTH blocks the
   * room can then never checkpoint again. This pins the pending-only rule that
   * makes progressive checkpointing actually progressive.
   */
  const action = (id: string, block: 1 | 2, checkpointSequence: number | null): RoomAction => ({
    id,
    actionId: id,
    label: id,
    actorId: 'seat-0',
    block,
    acceptedAt: '2026-01-01T00:00:00.000Z',
    checkpointSequence,
  })

  const roomWith = (actions: RoomAction[]): Room =>
    ({
      id: 'room-1',
      name: 'duel',
      templateId: 'tpl-1',
      managed: false,
      deadlineBlocksFromStart: 8,
      phase: 'ACTIVE',
      chainRoomId: '1',
      deploymentTransaction: null,
      actions,
    }) as Room

  it('counts only the moves the next batch would carry', () => {
    const settled = [action('a1', 1, 1), action('a2', 2, 1), action('a3', 2, 1)]
    expect(cardPendingActions(roomWith(settled))).toEqual([])
    const mixed = roomWith([...settled, action('a4', 1, null), action('a5', 2, null)])
    expect(cardPendingActions(mixed).map((item) => item.id)).toEqual(['a4', 'a5'])
  })

  it('treats an action with no checkpoint field as pending', () => {
    // A coordinator that predates the cursor publishes no `checkpointSequence`;
    // reading that as "settled" would silently drop every move it holds.
    const legacy = { ...action('a1', 1, null) } as RoomAction
    delete (legacy as { checkpointSequence?: number | null }).checkpointSequence
    expect(cardPendingActions(roomWith([legacy])).map((item) => item.id)).toEqual(['a1'])
  })

  it('sends the first move of a NEW batch to block 1, not to block 2 forever', () => {
    // Everything settled by checkpoint 1: the next batch starts empty, so its
    // first move belongs in block 1 again.
    const afterCheckpoint = roomWith([action('a1', 1, 1), action('a2', 2, 1)])
    expect(cardPendingActions(afterCheckpoint).some((item) => item.block === 1)).toBe(false)

    // Once that move is pending in block 1, the following ones go to block 2 so
    // the batch covers both and the duel keeps its move order.
    const secondBatch = roomWith([action('a1', 1, 1), action('a2', 2, 1), action('a3', 1, null)])
    expect(cardPendingActions(secondBatch).some((item) => item.block === 1)).toBe(true)
  })

  it('lets a second batch satisfy the both-blocks rule the first one did', () => {
    const counts = cardSettlementCounts([submitted(3, 1, 5_000), submitted(4, 2, 5_100)])
    expect(counts.blocks).toEqual([1, 2])
    const due = cardCheckpointDue(counts, CARD_CHECKPOINT_POLICY, {
      now: 5_000 + CARD_CHECKPOINT_POLICY.maxPendingAgeMs,
      requested: true,
    })
    expect(due.due).toBe(true)
    expect(due.blocked).toBeNull()

    // The same two moves both filed into block 2 - what the old rule produced -
    // is refused, which is exactly the stall this fix removes.
    const oneBlock = cardSettlementCounts([submitted(3, 2, 5_000), submitted(4, 2, 5_100)])
    expect(oneBlock.blocks).toEqual([2])
    expect(
      cardCheckpointDue(oneBlock, CARD_CHECKPOINT_POLICY, { now: 5_000, requested: true })
        .blocked,
    ).toMatch(/both of its L2 blocks/)
  })
})
