/**
 * A room that checkpoints repeatedly while it stays open.
 *
 * The properties under test are the ones a long game depends on: every move is
 * proved exactly once, a second checkpoint carries only what arrived after the
 * first, the merged L1 transaction hash reaches a client in full, two proofs
 * never overlap on the single GPU, and a checkpoint that fails says so instead
 * of reporting a settlement that did not happen.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import {
  publicDemoView,
  registerDemoRoutes,
  DemoController,
  CHECKPOINT_MOVE_THRESHOLD,
  DEFAULT_DEADLINE_BLOCKS_FROM_START,
} from '../src/demo-control.js'
import { FakeRuntime } from './helpers/demo-fake-runtime.js'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function dataDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'zkdeal-demo-progressive-'))
  created.push(path)
  return path
}

async function liveRoom(runtime = new FakeRuntime(), path?: string) {
  const controller = new DemoController(path ?? (await dataDir()), runtime)
  await controller.initialize()
  const template = await controller.createTemplate(
    { name: 'Shop template', presetId: 'shop' },
    'progressive-template-1',
  )
  await controller.drain()
  const room = await controller.createRoom(
    { name: 'Long running room', templateId: template.template.id },
    'progressive-room-1',
  )
  await controller.deployRoom(room.id, 'progressive-deploy-1')
  await controller.drain()
  return { controller, runtime, roomId: room.id }
}

let actionCounter = 0
async function move(controller: DemoController, roomId: string, block: 1 | 2) {
  actionCounter += 1
  return controller.addAction(
    roomId,
    { actionId: block === 1 ? 'register-session' : 'buy-item', actorId: 'buyer', block },
    `progressive-action-${String(actionCounter).padStart(4, '0')}`,
  )
}

describe('progressive checkpointing', () => {
  it('proves each move exactly once across successive checkpoints', async () => {
    const { controller, runtime, roomId } = await liveRoom()
    const first = [await move(controller, roomId, 1), await move(controller, roomId, 2)]
    await controller.checkpointRoom(roomId, 'progressive-cp-1')
    await controller.drain()

    // The room is still open: L1_ACCEPTED means the latest batch landed, not
    // that the game is over.
    expect(controller.room(roomId)?.phase).toBe('L1_FINALIZED')
    const second = [await move(controller, roomId, 1), await move(controller, roomId, 2)]
    await controller.checkpointRoom(roomId, 'progressive-cp-2')
    await controller.drain()

    expect(runtime.checkpointCalls.map((call) => call.actionIds)).toEqual([
      first.map((action) => action.id),
      second.map((action) => action.id),
    ])
    expect(runtime.checkpointCalls.map((call) => call.sequence)).toEqual([1, 2])
    const room = controller.room(roomId)!
    expect(room.checkpoints.map((record) => record.outcome)).toEqual(['ACCEPTED', 'ACCEPTED'])
    // Every action carries the sequence that proved it; none is pending.
    expect(room.actions.map((action) => action.checkpointSequence)).toEqual([1, 1, 2, 2])
    expect(room.checkpoint?.batchIndex).toBe(2)
  })

  it('refuses a second checkpoint that would carry no new move', async () => {
    const { controller, roomId } = await liveRoom()
    await move(controller, roomId, 1)
    await move(controller, roomId, 2)
    await controller.checkpointRoom(roomId, 'progressive-cp-3')
    await controller.drain()
    await expect(controller.checkpointRoom(roomId, 'progressive-cp-4')).rejects.toThrow(/each/)
  })

  it('holds a checkpoint until the policy says one is due', async () => {
    const { controller, roomId } = await liveRoom()
    await move(controller, roomId, 1)
    await move(controller, roomId, 2)
    // The room has two moves and was created moments ago: nothing is due, and
    // a policy-driven caller is refused with the arithmetic rather than
    // spending a proving slot.
    await expect(
      controller.checkpointRoom(roomId, 'progressive-cp-5', { force: false }),
    ).rejects.toThrow(/not due yet/)
    const status = controller.checkpointStatus(roomId)!
    expect(status.plan.decision).toBe('HOLD')
    expect(status.plan.movesUntilDue).toBe(CHECKPOINT_MOVE_THRESHOLD - 2)
    expect(status.policy.budgetBlocks).toBe(5)
  })

  it('checkpoints without asking once the move threshold is reached', async () => {
    const { controller, runtime, roomId } = await liveRoom()
    for (let index = 0; index < CHECKPOINT_MOVE_THRESHOLD; index += 1) {
      await move(controller, roomId, index % 2 === 0 ? 1 : 2)
    }
    const plan = controller.checkpointStatus(roomId)!.plan
    expect(plan.decision).toBe('DUE')
    expect(plan.trigger).toBe('MOVES')
    await controller.checkpointRoom(roomId, 'progressive-cp-6', { force: false })
    await controller.drain()
    expect(runtime.checkpointCalls[0]?.trigger).toBe('MOVES')
    expect(runtime.checkpointCalls[0]?.actionIds).toHaveLength(CHECKPOINT_MOVE_THRESHOLD)
  })

  it('grants a batch an inclusion window longer than a checkpoint takes', async () => {
    const { controller, roomId } = await liveRoom()
    expect(controller.room(roomId)?.deadlineBlocksFromStart).toBe(DEFAULT_DEADLINE_BLOCKS_FROM_START)
  })

  it('fires on an absolute proof deadline once the start margin is reached', async () => {
    const controller = new DemoController(await dataDir(), new FakeRuntime())
    await controller.initialize()
    const template = await controller.createTemplate(
      { name: 'Deadline template', presetId: 'shop' },
      'progressive-template-deadline',
    )
    await controller.drain()
    // Deadline at block 100 with one checkpoint, 64 reorg blocks and one retry:
    // the safe trigger is block 26; a fresh attempt is impossible after 95.
    const room = await controller.createRoom(
      { name: 'Deadline room', templateId: template.template.id, proofDeadlineBlock: 100 },
      'progressive-room-deadline',
    )
    await controller.deployRoom(room.id, 'progressive-deploy-deadline')
    await controller.drain()
    await move(controller, room.id, 1)
    await move(controller, room.id, 2)

    expect(controller.checkpointStatus(room.id, 25)!.plan.decision).toBe('HOLD')
    const due = controller.checkpointStatus(room.id, 26)!.plan
    expect(due.decision).toBe('DUE')
    expect(due.trigger).toBe('DEADLINE')
    const blocked = controller.checkpointStatus(room.id, 96)!.plan
    expect(blocked.decision).toBe('BLOCKED')
    expect(blocked.reason).toMatch(/49\.23 s of proving, submission and inclusion/)
  })

  it('serialises checkpoints through the single proving slot', async () => {
    const runtime = new FakeRuntime()
    const { controller, roomId } = await liveRoom(runtime)
    // Both rooms exist and are deployed BEFORE any proof starts, so the only
    // thing contending for the slot is the two checkpoints.
    const other = await controller.createRoom(
      { name: 'Second room', templateId: controller.listTemplates()[0]!.id },
      'progressive-room-2',
    )
    await controller.deployRoom(other.id, 'progressive-deploy-2')
    await controller.drain()
    for (const id of [roomId, other.id]) {
      await move(controller, id, 1)
      await move(controller, id, 2)
    }

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let held = false
    runtime.checkpointGate = async () => {
      // The first proof holds the slot; if the second ever entered while it was
      // held, the two calls would overlap in wall-clock time.
      if (!held) {
        held = true
        await gate
      }
    }
    await controller.checkpointRoom(roomId, 'progressive-cp-7')
    await new Promise((resolve) => setImmediate(resolve))
    await controller.checkpointRoom(other.id, 'progressive-cp-8')
    await new Promise((resolve) => setImmediate(resolve))

    // The second checkpoint is queued behind the first, and the queue says so.
    const queue = controller.provingQueue()
    expect(queue.active?.subjectId).toBe(roomId)
    expect(queue.waiting.map((entry) => entry.subjectId)).toEqual([other.id])
    expect(controller.job(queue.waiting[0]!.id)?.queuePosition).toBe(1)

    release()
    await controller.drain()
    const [first, second] = runtime.checkpointCalls
    expect(first && second).toBeTruthy()
    expect(second!.startedAt).toBeGreaterThanOrEqual(first!.finishedAt)
    expect(controller.room(other.id)?.checkpoints[0]?.queueWaitMs).toBeGreaterThan(0)
  })

  it('records a failed checkpoint instead of reporting a settlement', async () => {
    const runtime = new FakeRuntime()
    runtime.failAt = 'checkpoint'
    const { controller, roomId } = await liveRoom(runtime)
    const moves = [await move(controller, roomId, 1), await move(controller, roomId, 2)]
    await controller.checkpointRoom(roomId, 'progressive-cp-9')
    await controller.drain()

    const room = controller.room(roomId)!
    expect(room.checkpoint).toBeUndefined()
    expect(room.checkpoints[0]?.outcome).toBe('FAILED')
    expect(room.checkpoints[0]?.failure?.explanation).toMatch(/proof worker stopped/)
    // The room is still open and the moves are still pending: nothing was
    // accepted, so nothing was consumed.
    expect(room.phase).toBe('ACTIVE')
    expect(room.actions.map((action) => action.checkpointSequence)).toEqual([null, null])

    runtime.failAt = null
    await controller.checkpointRoom(roomId, 'progressive-cp-10')
    await controller.drain()
    expect(runtime.checkpointCalls[0]?.actionIds).toEqual(moves.map((action) => action.id))
    expect(controller.room(roomId)?.checkpoints.map((record) => record.outcome)).toEqual([
      'FAILED',
      'ACCEPTED',
    ])
  })

  it('fails a checkpoint the previous process left running rather than claiming it settled', async () => {
    const path = await dataDir()
    const runtime = new FakeRuntime()
    let release!: () => void
    runtime.checkpointGate = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
    const { controller, roomId } = await liveRoom(runtime, path)
    await move(controller, roomId, 1)
    await move(controller, roomId, 2)
    await controller.checkpointRoom(roomId, 'progressive-cp-11')
    await new Promise((resolve) => setImmediate(resolve))

    const restarted = new DemoController(path, new FakeRuntime())
    await restarted.initialize()
    const room = restarted.room(roomId)!
    expect(room.checkpoints[0]?.outcome).toBe('FAILED')
    expect(room.checkpoints[0]?.failure?.effect).toMatch(/pending again/)
    expect(room.actions.every((action) => action.checkpointSequence === null)).toBe(true)

    release()
    await controller.drain()
  })
})

describe('the L1 transaction hash a checkpoint lands in', () => {
  it('reaches a client in full, with an explorer link, while other hashes stay redacted', async () => {
    const { controller, roomId } = await liveRoom()
    await move(controller, roomId, 1)
    await move(controller, roomId, 2)
    await controller.checkpointRoom(roomId, 'progressive-cp-12')
    await controller.drain()

    const app = Fastify({ logger: false })
    registerDemoRoutes(app, controller)
    const response = await app.inject({ method: 'GET', url: `/demo/v1/rooms/${roomId}/checkpoints` })
    expect(response.statusCode).toBe(200)
    const record = response.json().checkpoints[0]
    const full = `0x${'01'.repeat(32)}`
    expect(record.result.l1TransactionHash).toBe(full)
    expect(record.result.explorerUrl).toBe(`http://explorer/tx/${full}`)
    // The historic, redacted field is unchanged, so no existing reader silently
    // starts seeing a different shape.
    expect(record.result.transaction).toBe(`${full.slice(0, 8)}...${full.slice(-4)}`)
    // A state root is not a transaction and stays redacted.
    expect(record.result.postStateRoot).not.toContain('bbbbbbbbbb')
    await app.close()
  })

  it('publishes the deployment domain in full so a browser can sign for the room', async () => {
    const controller = new DemoController(await dataDir(), new FakeRuntime())
    await controller.initialize()
    const app = Fastify({ logger: false })
    registerDemoRoutes(app, controller)
    const system = (await app.inject({ method: 'GET', url: '/demo/v1/system' })).json()
    expect(system.deploymentDomain).toBe(`0x${'cd'.repeat(32)}`)
    expect(system.checkpointPolicy.moveThreshold).toBe(CHECKPOINT_MOVE_THRESHOLD)
    await app.close()
  })

  it('redacts every long identifier that is not deliberately published', () => {
    const view = publicDemoView({
      l1TransactionHash: `0x${'ab'.repeat(32)}`,
      transaction: `0x${'ab'.repeat(32)}`,
      postStateRoot: `0x${'cd'.repeat(32)}`,
      deploymentDomain: `0x${'ef'.repeat(32)}`,
    })
    expect(view.l1TransactionHash).toBe(`0x${'ab'.repeat(32)}`)
    expect(view.deploymentDomain).toBe(`0x${'ef'.repeat(32)}`)
    expect(view.transaction).toMatch(/\.\.\./)
    expect(view.postStateRoot).toMatch(/\.\.\./)
  })
})

describe('browser-built moves', () => {
  it('still checks every move against the cold template selector allow-list', async () => {
    const { controller, roomId } = await liveRoom()
    await expect(
      controller.addAction(
        roomId,
        { actionId: 'forged', actorId: 'buyer', calldata: `0xdeadbeef${'00'.repeat(32)}` },
        'progressive-bad-selector',
      ),
    ).rejects.toThrow(/not permitted by the cold template/)
  })

  it('carries the signed envelope alongside the calldata', async () => {
    const { controller, runtime, roomId } = await liveRoom()
    const preset = controller.presets().find((item) => item.id === 'shop')!
    const calldata = preset.actions[0]!.calldata
    const envelope = `0x02${'11'.repeat(64)}`
    await controller.addAction(
      roomId,
      { actionId: 'register-session', actorId: 'buyer', calldata, block: 1, signedTransaction: envelope },
      'progressive-signed-1',
    )
    await controller.addAction(
      roomId,
      { actionId: 'buy-item', actorId: 'buyer', calldata: preset.actions[1]!.calldata, block: 2 },
      'progressive-signed-2',
    )
    await controller.checkpointRoom(roomId, 'progressive-cp-13')
    await controller.drain()
    expect(controller.room(roomId)?.actions[0]?.signedTransaction).toBe(envelope)
    expect(runtime.checkpointCalls[0]?.actionIds).toHaveLength(2)
  })

  it('rejects an envelope too short to be a signed transaction', async () => {
    const { controller, roomId } = await liveRoom()
    await expect(
      controller.addAction(
        roomId,
        { actionId: 'register-session', actorId: 'buyer', signedTransaction: '0x02ff' },
        'progressive-signed-3',
      ),
    ).rejects.toThrow(/at least 32 bytes/)
  })
})

describe('the L2 block a move lands in', () => {
  /**
   * A room keeps every action it ever accepted and marks the settled ones with
   * the checkpoint that proved them. The default block therefore has to be
   * chosen over PENDING actions: choosing it over all of them sends every move
   * after the first checkpoint into block 2, and because a batch must cover
   * both L2 blocks the room could then never checkpoint again.
   */
  it('starts each new batch in block 1 again', async () => {
    const { controller, roomId } = await liveRoom()
    let counter = 0
    // Caller-supplied calldata with no preset action behind it - the duel
    // shape, and the only one that reaches the default-block rule, since every
    // preset action pins its own `recommendedBlock`.
    const auto = () =>
      controller.addAction(
        roomId,
        {
          actionId: `move-${counter + 1}`,
          actorId: 'buyer',
          calldata: `0x12345678${'0'.repeat(63)}9`,
        },
        `auto-block-${(counter += 1)}`,
      )

    expect((await auto()).block).toBe(1)
    expect((await auto()).block).toBe(2)

    await controller.checkpointRoom(roomId, 'auto-block-cp-1')
    await controller.drain()
    expect(controller.room(roomId)?.actions.every((item) => item.checkpointSequence === 1)).toBe(
      true,
    )

    // The settled pair no longer occupies the batch, so the next move opens
    // block 1 of the SECOND batch rather than piling into block 2 forever.
    expect((await auto()).block).toBe(1)
    expect((await auto()).block).toBe(2)
    const pending = controller
      .room(roomId)!
      .actions.filter((item) => item.checkpointSequence === null)
    expect(pending.map((item) => item.block)).toEqual([1, 2])
  })
})
