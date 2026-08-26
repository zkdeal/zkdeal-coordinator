import { parseTransaction, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  runCheckpoint,
  type CheckpointContext,
} from '../src/demo-runtime-checkpoint.js'
import {
  SHOP_FIXTURE_CONTRACT,
  signShopCheckpointActions,
} from '../src/shop-signing.js'
import type {
  DemoAction,
  DemoCheckpointRecord,
  DemoRoom,
  DemoTemplate,
} from '../src/demo-types.js'
import { validateTemplateRequest } from '../src/demo-validation.js'

const DOMAIN = `0x${'11'.repeat(32)}` as Hex
const GENESIS = `0x${'22'.repeat(32)}` as Hex
const ADVANCED = `0x${'33'.repeat(32)}` as Hex

function template(): DemoTemplate {
  return {
    ...validateTemplateRequest({ name: 'Persistent shop', presetId: 'shop' }),
    id: 'tpl-shop',
    phase: 'ROOM_READY',
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
  }
}

function action(id: string, block: 1 | 2, value: number): DemoAction {
  return {
    id,
    actionId: block === 1 ? 'register-session' : 'buy-item',
    label: id,
    actorId: 'buyer',
    calldata: `0x12345678${value.toString(16).padStart(64, '0')}`,
    block,
    acceptedAt: '2026-08-26T00:00:00.000Z',
    checkpointSequence: null,
  }
}

function accepted(sequence: number, actions: DemoAction[]): DemoCheckpointRecord {
  return {
    sequence,
    trigger: 'MOVES',
    actionIds: actions.map((entry) => entry.id),
    startedAt: '2026-08-26T00:00:00.000Z',
    finishedAt: '2026-08-26T00:00:01.000Z',
    outcome: 'ACCEPTED',
    queueWaitMs: 0,
  }
}

function room(actions: DemoAction[]): DemoRoom {
  return {
    id: 'room-shop',
    name: 'Long-running shop',
    templateId: 'tpl-shop',
    managed: false,
    deadlineBlocksFromStart: 7,
    phase: 'ACTIVE',
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
    chainRoomId: '2',
    deploymentTransaction: null,
    actions,
    checkpoints: [],
    proofDeadlineBlock: null,
    lastCheckpointAt: null,
    closedAt: null,
  }
}

function context(
  batchIndex: number,
  post: CheckpointContext['post'],
): CheckpointContext {
  return {
    manager: `0x${'ab'.repeat(20)}`,
    managerAbi: [],
    deploymentDomain: DOMAIN,
    currentBlock: 1_000n,
    cardRoom: null,
    explorerUrl: 'http://explorer',
    chainId: async () => 31_337,
    post,
    readRoom: async () => ({
      stateRoot: batchIndex === 0 ? GENESIS : ADVANCED,
      participantRoot: `0x${'44'.repeat(32)}`,
      participantEpoch: 1,
      participantCount: 1,
      batchIndex,
      l2BlockHeight: batchIndex * 2,
      outboxEpoch: batchIndex,
    }),
    submit: async () => {
      throw new Error('the wire-shape regression stops before submission')
    },
  }
}

function recorder() {
  const sent: Array<{ endpoint: string; body: Record<string, unknown> }> = []
  const post = async <T>(endpoint: string, body: unknown): Promise<T> => {
    sent.push({ endpoint, body: body as Record<string, unknown> })
    throw new Error('stop after prepare')
  }
  return { sent, post: post as CheckpointContext['post'] }
}

describe('the persistent shop continuation wire shape', () => {
  it('derives the same implicit contract address as the prover fixture', () => {
    expect(SHOP_FIXTURE_CONTRACT).toBe('0x15339a8aa09a7aa1ea4258277dfdbd6a1586c805')
  })

  it('persists batch one envelopes and replays them into batch two', async () => {
    const first = [action('first-register', 1, 9), action('first-buy', 2, 10)]
    const live = room(first)
    const opening = recorder()
    await expect(
      runCheckpoint(context(0, opening.post), live, template(), async () => undefined, {
        sequence: 1,
        trigger: 'MOVES',
        actions: first,
      }),
    ).rejects.toThrow(/stop after prepare/)
    expect(opening.sent[0]?.body.rawTransactions).toEqual([
      [first[0]!.signedTransaction],
      [first[1]!.signedTransaction],
    ])
    expect(opening.sent[0]?.body.blockCalls).toBeUndefined()

    for (const entry of first) entry.checkpointSequence = 1
    live.checkpoints.push(accepted(1, first))
    const second = [action('second-register', 1, 11), action('second-buy', 2, 12)]
    live.actions.push(...second)

    const continuation = recorder()
    await expect(
      runCheckpoint(context(1, continuation.post), live, template(), async () => undefined, {
        sequence: 2,
        trigger: 'MOVES',
        actions: second,
      }),
    ).rejects.toThrow(/stop after prepare/)

    const request = continuation.sent[0]!.body
    expect(request.batchIndex).toBe(2)
    expect(request.rawTransactions).toEqual([
      [first[0]!.signedTransaction],
      [first[1]!.signedTransaction],
      [second[0]!.signedTransaction],
      [second[1]!.signedTransaction],
    ])
    expect(request.blockCalls).toBeUndefined()
    expect(request.continuation).toMatchObject({ batchIndex: 2, startL2Block: 3 })

    const transactions = live.actions.map((entry) =>
      parseTransaction(entry.signedTransaction as Hex),
    )
    expect(transactions.map((transaction) => transaction.nonce)).toEqual([0, 1, 2, 3])
    expect(transactions.map((transaction) => transaction.to)).toEqual(
      Array(4).fill(SHOP_FIXTURE_CONTRACT),
    )
  })

  it('refuses a partially client-signed batch instead of dropping one side', async () => {
    const actions = [action('signed', 1, 9), action('unsigned', 2, 10)]
    actions[0]!.signedTransaction = `0x02${'11'.repeat(64)}`
    await expect(signShopCheckpointActions(room(actions), actions, DOMAIN)).rejects.toThrow(
      /cannot mix client-signed and canned unsigned actions/,
    )
    expect(actions[1]!.signedTransaction).toBeUndefined()
  })
})
