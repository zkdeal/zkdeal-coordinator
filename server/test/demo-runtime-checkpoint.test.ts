/**
 * What a checkpoint sends to the prover, and what it refuses to send.
 *
 * Two failure modes are covered here because both used to produce a REAL L1
 * transaction hash for something that did not happen:
 *
 *  - a duel checkpoint whose moves cannot be expressed was answered with the
 *    host's scripted opening plan, so the stand reported a settlement for a
 *    duel nobody played;
 *  - a second checkpoint on a prover that only builds batch 1 would spend a
 *    whole GPU slot and then be rejected on L1 with BadInput.
 */

import { describe, expect, it } from 'vitest'
import { CARD_ROOM_PRESET_ID } from '../src/card-room.js'
import {
  movesOf,
  provedBlocks,
  runCheckpoint,
  type CheckpointContext,
} from '../src/demo-runtime-checkpoint.js'
import { baseSpec } from '../src/demo-runtime-spec.js'
import { validateTemplateRequest } from '../src/demo-validation.js'
import type {
  DemoAction,
  DemoCheckpointRecord,
  DemoRoom,
  DemoTemplate,
} from '../src/demo-types.js'
import { cardRoomFixture } from './helpers/card-room-fixture.js'

const DOMAIN = `0x${'11'.repeat(32)}` as const
const GENESIS = `0x${'22'.repeat(32)}` as const
const ADVANCED = `0x${'33'.repeat(32)}` as const

function template(presetId: string): DemoTemplate {
  return {
    ...validateTemplateRequest({ name: 'Checkpoint template', presetId }),
    id: `tpl-${presetId}`,
    phase: 'ROOM_READY',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  }
}

function action(id: string, block: 1 | 2, signed?: string): DemoAction {
  return {
    id,
    actionId: id,
    label: id,
    actorId: 'player',
    calldata: `0x12345678${'0'.repeat(63)}9`,
    block,
    acceptedAt: '2026-07-25T00:00:00.000Z',
    checkpointSequence: null,
    ...(signed ? { signedTransaction: signed } : {}),
  }
}

function room(): DemoRoom {
  return {
    id: 'room-1',
    name: 'Checkpoint room',
    templateId: 'tpl-shop',
    managed: false,
    deadlineBlocksFromStart: 7,
    phase: 'ACTIVE',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
    chainRoomId: '2',
    deploymentTransaction: null,
    actions: [],
    checkpoints: [],
    proofDeadlineBlock: null,
    lastCheckpointAt: null,
    closedAt: null,
  }
}

function context(overrides: Partial<CheckpointContext> = {}): CheckpointContext {
  return {
    manager: `0x${'ab'.repeat(20)}`,
    managerAbi: [],
    deploymentDomain: DOMAIN,
    currentBlock: 1_000n,
    cardRoom: null,
    explorerUrl: 'http://explorer',
    chainId: async () => 31_337,
    post: async () => ({}) as never,
    readRoom: async () => ({
      stateRoot: ADVANCED,
      participantRoot: `0x${'44'.repeat(32)}`,
      participantEpoch: 2,
      participantCount: 2,
      batchIndex: 1,
      l2BlockHeight: 2,
      outboxEpoch: 1,
    }),
    submit: async (_args, lifecycle) => {
      const transactionHash = `0x${'99'.repeat(32)}` as const
      const blockHash = `0x${'88'.repeat(32)}` as const
      await lifecycle.onAccepted({ transactionHash, blockNumber: 5n, blockHash })
      return {
        transactionHash,
        blockNumber: 5n,
        blockHash,
        finalizedBlockNumber: 69n,
        finalizedBlockHash: `0x${'77'.repeat(32)}` as const,
      }
    },
    ...overrides,
  }
}

describe('the moves a checkpoint carries', () => {
  it('splits calldata and envelopes across the two room blocks', () => {
    const moves = movesOf([
      action('a', 1, '0x02aa'),
      action('b', 2, '0x02bb'),
      action('c', 2, '0x02cc'),
    ])
    expect(moves.calldata[0]).toHaveLength(1)
    expect(moves.calldata[1]).toHaveLength(2)
    expect(moves.signed).toEqual([['0x02aa'], ['0x02bb', '0x02cc']])
  })

  it('offers no envelopes at all unless every move has one', () => {
    // A partly-signed batch is not a batch: `rawTransactions` is all-or-nothing
    // in `blocks.rs`, and quietly dropping the unsigned half would prove less
    // than the players did.
    expect(movesOf([action('a', 1, '0x02aa'), action('b', 2)]).signed).toBeUndefined()
  })
})

describe('a duel checkpoint that cannot express its moves', () => {
  it('is refused rather than answered with the scripted opening plan', () => {
    const duel = template(CARD_ROOM_PRESET_ID)
    const moves = movesOf([action('a', 1), action('b', 2)])
    expect(() => baseSpec(duel, 7, 1_000, DOMAIN, moves, null, cardRoomFixture())).toThrow(
      /no signed transaction/,
    )
  })

  it('sends browser-signed envelopes as rawTransactions, never as blockCalls', () => {
    const duel = template(CARD_ROOM_PRESET_ID)
    const moves = movesOf([action('a', 1, '0x02aa'), action('b', 2, '0x02bb')])
    const spec = baseSpec(duel, 7, 1_000, DOMAIN, moves, null, cardRoomFixture())
    expect(spec.rawTransactions).toEqual([['0x02aa'], ['0x02bb']])
    // `blocks.rs` consumes `blockCalls` first and the host refuses a request
    // carrying both, so the duel path must never emit it.
    expect(spec.blockCalls).toBeUndefined()
    expect(spec.workload).toBe('card-duel')
  })

  it('leaves a storage room on its historic blockCalls path', () => {
    const shop = template('shop')
    const moves = movesOf([action('a', 1), action('b', 2)])
    const spec = baseSpec(shop, 7, 1_000, DOMAIN, moves, null, null)
    expect(spec.blockCalls).toEqual(moves.calldata)
    expect(spec.rawTransactions).toBeUndefined()
  })
})

describe('a continuation checkpoint', () => {
  /** Records what was posted and stops the flow at the first call. */
  function recorder(reply?: (endpoint: string) => unknown) {
    const sent: Array<{ endpoint: string; body: Record<string, unknown> }> = []
    const post = async <T>(endpoint: string, body: unknown): Promise<T> => {
      sent.push({ endpoint, body: body as Record<string, unknown> })
      if (reply) return reply(endpoint) as T
      throw new Error('stop after prepare')
    }
    return { sent, post }
  }

  it('asks the prover to open batch N from the room state L1 actually holds', async () => {
    const { sent, post } = recorder()
    await expect(
      runCheckpoint(context({ post }), room(), template('auction'), async () => undefined, {
        sequence: 2,
        trigger: 'MOVES',
        actions: [action('a', 1), action('b', 2)],
      }),
    ).rejects.toThrow(/stop after prepare/)
    expect(sent[0]?.endpoint).toBe('/v5/rooms/prepare')
    expect(sent[0]?.body.continuation).toEqual({
      batchIndex: 2,
      startL2Block: 3,
      preStateRoot: ADVANCED,
      preParticipantRoot: `0x${'44'.repeat(32)}`,
      preParticipantEpoch: 2,
      preParticipantCount: 2,
      outboxEpoch: 2,
    })
  })

  it('refuses a prover that rebuilt batch one, before spending a proving slot', async () => {
    const { sent, post } = recorder((endpoint) => {
      if (endpoint !== '/v5/rooms/prepare') throw new Error('a proof must not have been started')
      // What every host built before continuations existed returns:
      // `v5_fixture.rs` hardcodes batch_index 1 and the cold opening root.
      return {
        roomRequest: { roomWitness: { journal: { batch_index: 1, pre_state_root: GENESIS } } },
        coldRequest: {},
        contractConfig: {},
      }
    })
    await expect(
      runCheckpoint(context({ post }), room(), template('auction'), async () => undefined, {
        sequence: 2,
        trigger: 'MOVES',
        actions: [action('a', 1), action('b', 2)],
      }),
    ).rejects.toThrow(/prover prepared batch 1 opening from/)
    expect(sent).toHaveLength(1)
  })

  it('does not constrain the opening batch of a room that has never settled', async () => {
    const { sent, post } = recorder()
    const fresh = context({
      post,
      readRoom: async () => ({
        stateRoot: GENESIS,
        participantRoot: `0x${'44'.repeat(32)}`,
        participantEpoch: 1,
        participantCount: 0,
        batchIndex: 0,
        l2BlockHeight: 0,
        outboxEpoch: 0,
      }),
    })
    await expect(
      runCheckpoint(fresh, room(), template('auction'), async () => undefined, {
        sequence: 1,
        trigger: 'MANUAL',
        actions: [action('a', 1), action('b', 2)],
      }),
    ).rejects.toThrow(/stop after prepare/)
    expect(sent[0]?.body.continuation).toBeUndefined()
  })
})

/**
 * The wire shape a long-lived room's second and later checkpoints actually
 * send. The prover's `prepare` is a pure function of its request and remembers
 * no rooms, so it cannot be *told* where batch N opens - it replays L2 blocks
 * `1..=2N-2` and continues from them. A request that names `batchIndex` without
 * carrying that history, or carries a history that is not the one the room ran,
 * prepares a batch Ethereum refuses.
 */
describe('the replay history a continuation carries', () => {
  /** A duel move whose envelope is derived from its id, so ordering is visible. */
  function move(id: string, block: 1 | 2, sequence: number | null): DemoAction {
    return { ...action(id, block, `0x02${id}`), checkpointSequence: sequence }
  }

  function record(sequence: number, actionIds: string[]): DemoCheckpointRecord {
    return {
      sequence,
      trigger: 'MOVES',
      actionIds,
      startedAt: '2026-07-25T00:00:00.000Z',
      finishedAt: '2026-07-25T00:00:01.000Z',
      outcome: 'ACCEPTED',
      queueWaitMs: 0,
    }
  }

  /** A duel room that has already settled `batches` checkpoints on Ethereum. */
  function settledRoom(batches: number, pending: DemoAction[] = []): DemoRoom {
    const base = room()
    const actions: DemoAction[] = []
    const checkpoints: DemoCheckpointRecord[] = []
    for (let sequence = 1; sequence <= batches; sequence += 1) {
      const first = move(`a${sequence}`, 1, sequence)
      const second = move(`b${sequence}`, 2, sequence)
      actions.push(first, second)
      checkpoints.push(record(sequence, [first.id, second.id]))
    }
    return { ...base, templateId: 'tpl-card', actions: [...actions, ...pending], checkpoints }
  }

  function duelContext(
    batchIndex: number,
    l2BlockHeight: number,
    post: CheckpointContext['post'],
  ): CheckpointContext {
    return context({
      post,
      cardRoom: cardRoomFixture(),
      readRoom: async () => ({
        stateRoot: ADVANCED,
        participantRoot: `0x${'44'.repeat(32)}`,
        participantEpoch: 2,
        participantCount: 2,
        batchIndex,
        l2BlockHeight,
        outboxEpoch: batchIndex,
      }),
    })
  }

  function recorder() {
    const sent: Array<{ endpoint: string; body: Record<string, unknown> }> = []
    const post = async <T>(endpoint: string, body: unknown): Promise<T> => {
      sent.push({ endpoint, body: body as Record<string, unknown> })
      throw new Error('stop after prepare')
    }
    return { sent, post: post as CheckpointContext['post'] }
  }

  it('reproduces two blocks per accepted checkpoint, oldest block first', () => {
    expect(provedBlocks(settledRoom(3))).toEqual([
      [`0x02a1`],
      [`0x02b1`],
      [`0x02a2`],
      [`0x02b2`],
      [`0x02a3`],
      [`0x02b3`],
    ])
  })

  it('reproduces nothing for a room that has never settled', () => {
    expect(provedBlocks(settledRoom(0))).toEqual([])
  })

  it('ignores a failed attempt, because a failure advanced no block on Ethereum', () => {
    const room = settledRoom(1)
    room.checkpoints.push({ ...record(2, []), outcome: 'FAILED' })
    expect(provedBlocks(room)).toEqual([[`0x02a1`], [`0x02b1`]])
  })

  it('ignores the attempt currently running, which is the one asking', () => {
    // `startCheckpoint` pushes a RUNNING record BEFORE the runtime is called,
    // so the in-flight attempt is always in `room.checkpoints` while its own
    // history is being built. Counting it would replay the blocks it is trying
    // to prove and ask for a batch two ahead of the room.
    const room = settledRoom(1)
    const pending = [move('c', 1, null), move('d', 2, null)]
    room.actions.push(...pending)
    room.checkpoints.push({
      ...record(2, ['c', 'd']),
      outcome: 'RUNNING',
      finishedAt: null,
    })
    expect(provedBlocks(room)).toEqual([[`0x02a1`], [`0x02b1`]])
  })

  it('asks for batch two with block one, block two and the new pair, in that order', async () => {
    const { sent, post } = recorder()
    const pending = [move('c', 1, null), move('d', 2, null)]
    await expect(
      runCheckpoint(
        duelContext(1, 2, post),
        settledRoom(1, pending),
        template(CARD_ROOM_PRESET_ID),
        async () => undefined,
        { sequence: 2, trigger: 'MOVES', actions: pending },
      ),
    ).rejects.toThrow(/stop after prepare/)
    const body = sent[0]!.body
    expect(body.batchIndex).toBe(2)
    // 2 * batchIndex blocks: everything already proved, then this batch.
    expect(body.rawTransactions).toEqual([[`0x02a1`], [`0x02b1`], [`0x02c`], [`0x02d`]])
    expect(body.blockCalls).toBeUndefined()
    // The descriptor still travels: it is what `assertPreparedMatches` checks
    // the prepared journal against on the way back.
    expect(body.continuation).toMatchObject({ batchIndex: 2, startL2Block: 3 })
  })

  it('grows the history by exactly one batch per checkpoint', async () => {
    const { sent, post } = recorder()
    const pending = [move('c', 1, null), move('d', 2, null)]
    await expect(
      runCheckpoint(
        duelContext(3, 6, post),
        settledRoom(3, pending),
        template(CARD_ROOM_PRESET_ID),
        async () => undefined,
        { sequence: 4, trigger: 'MOVES', actions: pending },
      ),
    ).rejects.toThrow(/stop after prepare/)
    expect(sent[0]!.body.batchIndex).toBe(4)
    expect(sent[0]!.body.rawTransactions).toHaveLength(8)
    expect((sent[0]!.body.rawTransactions as string[][]).at(-2)).toEqual([`0x02c`])
  })

  it('sends the opening batch exactly as it always did: two blocks, no batchIndex', async () => {
    const { sent, post } = recorder()
    const pending = [move('c', 1, null), move('d', 2, null)]
    await expect(
      runCheckpoint(
        duelContext(0, 0, post),
        settledRoom(0, pending),
        template(CARD_ROOM_PRESET_ID),
        async () => undefined,
        { sequence: 1, trigger: 'MANUAL', actions: pending },
      ),
    ).rejects.toThrow(/stop after prepare/)
    expect(sent[0]!.body.batchIndex).toBeUndefined()
    expect(sent[0]!.body.rawTransactions).toEqual([[`0x02c`], [`0x02d`]])
    expect(sent[0]!.body.continuation).toBeUndefined()
  })

  it('refuses, before any prepare, a history that disagrees with the on-chain height', async () => {
    const { sent, post } = recorder()
    const pending = [move('c', 1, null), move('d', 2, null)]
    await expect(
      // Ethereum says batch 2 is next, so 2 blocks must be replayed; the room
      // remembers 3 batches, so it would replay 6 and open somewhere else.
      runCheckpoint(
        duelContext(1, 2, post),
        settledRoom(3, pending),
        template(CARD_ROOM_PRESET_ID),
        async () => undefined,
        { sequence: 2, trigger: 'MOVES', actions: pending },
      ),
    ).rejects.toThrow(/replay 2 already-proved L2 block\(s\); this room's move log reproduces 6/)
    expect(sent).toHaveLength(0)
  })

  it('refuses a history whose earlier move kept no envelope, naming the move', () => {
    const stale = settledRoom(1)
    delete stale.actions[0]!.signedTransaction
    expect(() => provedBlocks(stale)).toThrow(/move a1, proved by checkpoint 1, holds no signed/)
  })

  it('refuses a history missing a move an accepted checkpoint proved', () => {
    const stale = settledRoom(1)
    stale.actions = stale.actions.filter((item) => item.id !== 'b1')
    expect(() => provedBlocks(stale)).toThrow(/no longer in this room's move log/)
  })

  it('refuses a history whose batch left an L2 block empty', () => {
    const lopsided = settledRoom(1)
    // Both moves in block 1: the prover requires 1..32 transactions per block,
    // so an empty second block is not a replayable batch.
    lopsided.actions[1]!.block = 1
    expect(() => provedBlocks(lopsided)).toThrow(/left one of its two L2 blocks empty/)
  })
})
