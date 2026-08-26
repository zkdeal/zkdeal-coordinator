import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import {
  publicDemoView,
  registerDemoRoutes,
  validateTemplateRequest,
  DemoController,
} from '../src/demo-control.js'
import { FakeRuntime } from './helpers/demo-fake-runtime.js'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function dataDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'zkdeal-demo-control-'))
  created.push(path)
  return path
}

async function readyController(runtime = new FakeRuntime()) {
  const controller = new DemoController(await dataDir(), runtime)
  await controller.initialize()
  const createdTemplate = await controller.createTemplate(
    { name: 'Shop template', presetId: 'shop' },
    'template-key-0001',
  )
  await controller.drain()
  return { controller, runtime, templateId: createdTemplate.template.id }
}

describe('demo request validation', () => {
  it('derives a preset without accepting manual proof claims', () => {
    const result = validateTemplateRequest({ name: 'Auction template', presetId: 'auction' })
    expect(result.authorizationMode).toBe('VALIDITY_ONLY')
    expect(result.participantCapacity).toBe(32_768)
    expect(result.selectedState.map((item) => item.slot)).toEqual(['0', '1', '2', '3'])
  })

  it('includes every shop slot touched by the two-block runtime', () => {
    const result = validateTemplateRequest({ name: 'Shop template', presetId: 'shop' })
    expect(result.selectedState.map((item) => item.slot)).toEqual(['0', '1', '2', '3', '4'])
  })

  it('accepts a compiled artifact with runtime code and exact state slots', () => {
    const result = validateTemplateRequest({
      name: 'Custom counter',
      contractMode: 'artifact',
      artifact: {
        contractName: 'Counter',
        abi: [{ type: 'function', name: 'set', inputs: [{ type: 'uint256' }] }],
        bytecode: { object: '0x60006000' },
        deployedBytecode: { object: '0x6000355500' },
      },
      selectedState: [{ label: 'counter', slot: '0', value: '7', mode: 'ROOM_LOCAL' }],
      participantCapacity: 1024,
    })
    expect(result.source).toBe('artifact')
    expect(result.allowedSelectors[0]).toMatch(/^0x[0-9a-f]{8}$/)
  })

  it.each([
    [{ name: 'x', presetId: 'shop' }, /name/],
    [{ name: 'Bad capacity', presetId: 'shop', participantCapacity: 1000 }, /power of two/],
    [{ name: 'Missing artifact', contractMode: 'artifact' }, /compiled artifact/],
    [
      {
        name: 'No bytecode',
        contractMode: 'artifact',
        artifact: { contractName: 'NoCode', abi: [], bytecode: { object: '0x60' } },
      },
      /runtime bytecode/,
    ],
    [
      {
        name: 'Bad attached',
        contractMode: 'attached',
        attachedAddress: '0x1234',
      },
      /attached address/,
    ],
  ])('rejects unsafe template input', (input, message) => {
    expect(() => validateTemplateRequest(input as never)).toThrow(message as RegExp)
  })
})

describe('demo lifecycle', () => {
  it('prepares, deploys, records actions, and accepts a checkpoint', async () => {
    const { controller, templateId } = await readyController()
    expect(controller.template(templateId)?.phase).toBe('ROOM_READY')
    // 74 blocks carries a whole attempt, the 64-block reorg margin and a retry.
    const room = await controller.createRoom(
      { name: 'Presentation shop', templateId, deadlineBlocksFromStart: 74 },
      'room-key-0000001',
    )
    expect(room.deadlineBlocksFromStart).toBe(74)
    expect(room.settings.deadlineSeconds).toBe(888)
    await controller.deployRoom(room.id, 'deploy-key-0001')
    await controller.drain()
    expect(controller.room(room.id)?.phase).toBe('ACTIVE')
    await controller.addAction(
      room.id,
      { actionId: 'register-session', actorId: 'buyer' },
      'action-key-0001',
    )
    await controller.addAction(
      room.id,
      { actionId: 'buy-item', actorId: 'buyer' },
      'action-key-0002',
    )
    await controller.checkpointRoom(room.id, 'checkpoint-key-1')
    await controller.drain()
    expect(controller.room(room.id)?.phase).toBe('L1_FINALIZED')
    expect(controller.room(room.id)?.checkpoint?.l1Block).toBe('77')
  })

  it('makes every mutation idempotent', async () => {
    const { controller, templateId } = await readyController()
    const first = await controller.createRoom(
      { name: 'Idempotent room', templateId },
      'same-room-key-1',
    )
    const second = await controller.createRoom(
      { name: 'Ignored duplicate', templateId },
      'same-room-key-1',
    )
    expect(second.id).toBe(first.id)
    expect(controller.listRooms()).toHaveLength(1)
  })

  it('closes a stopped room, keeps its history, and refuses later actions', async () => {
    const { controller, templateId } = await readyController()
    const room = await controller.createRoom(
      { name: 'Stopped presentation', templateId },
      'room-close-key-1',
    )
    await controller.deployRoom(room.id, 'room-close-deploy-1')
    await controller.drain()
    await controller.addAction(
      room.id,
      { actionId: 'register-session', actorId: 'buyer' },
      'room-close-action-1',
    )

    const closed = await controller.closeRoom(room.id, 'room-close-request-1')
    expect(closed.phase).toBe('CLOSED')
    expect(closed.closedAt).toMatch(/T/)
    expect(closed.actions).toHaveLength(1)
    expect(closed.moves).toMatchObject({ accepting: false, reopens: false })
    await expect(
      controller.addAction(
        room.id,
        { actionId: 'buy-item', actorId: 'buyer' },
        'room-close-action-2',
      ),
    ).rejects.toThrow(/no longer accepts moves/)

    const repeated = await controller.closeRoom(room.id, 'room-close-request-1')
    expect(repeated.closedAt).toBe(closed.closedAt)
    expect(repeated.actions).toHaveLength(1)
  })

  it('does not checkpoint a room without one action in each block', async () => {
    const { controller, templateId } = await readyController()
    const room = await controller.createRoom({ name: 'Incomplete room', templateId }, 'room-key-2')
    await controller.deployRoom(room.id, 'deploy-key-2')
    await controller.drain()
    await controller.addAction(
      room.id,
      { actionId: 'register-session', actorId: 'buyer' },
      'action-key-only',
    )
    await expect(controller.checkpointRoom(room.id, 'checkpoint-key-2')).rejects.toThrow(/each/)
  })

  it('redacts full identifiers in persisted public failures', async () => {
    const runtime = new FakeRuntime()
    runtime.failAt = 'prepare'
    const controller = new DemoController(await dataDir(), runtime)
    await controller.initialize()
    const result = await controller.createTemplate(
      { name: 'Failing template', presetId: 'shop' },
      'failure-key-0001',
    )
    await controller.drain()
    const failed = controller.job(result.job.id)
    expect(failed?.phase).toBe('FAILED')
    expect(failed?.failure?.explanation).toContain('0xabab…abab')
    expect(failed?.failure?.explanation).not.toContain('ab'.repeat(32))
  })

  it('marks interrupted jobs failed during restart without changing accepted rooms', async () => {
    const path = await dataDir()
    const runtime = new FakeRuntime()
    const first = new DemoController(path, runtime)
    await first.initialize()
    const template = await first.createTemplate(
      { name: 'Restart template', presetId: 'shop' },
      'restart-key-0001',
    )
    const second = new DemoController(path, runtime)
    await second.initialize()
    expect(second.job(template.job.id)?.phase).toBe('FAILED')
    await first.drain()
  })
})

describe('demo HTTP routes', () => {
  it('awaits and returns the live system decision', async () => {
    const controller = new DemoController(await dataDir(), new FakeRuntime())
    await controller.initialize()
    const app = Fastify({ logger: false })
    registerDemoRoutes(app, controller)

    const response = await app.inject({ method: 'GET', url: '/demo/v1/system' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      decision: 'READY',
      services: [{ label: 'Local Ethereum', status: 'READY' }],
      gpu: { name: 'Test GPU', recommendedProofSeconds: 17 },
    })
    await app.close()
  })

  it('refuses to redact an unresolved promise instead of returning an empty body', () => {
    // A Promise has no own enumerable properties, so a route that forgot to
    // await returned 200 {} and an operator could not tell READY from a dead
    // L1. The redaction layer now fails loudly instead.
    expect(() => publicDemoView(Promise.resolve({ decision: 'READY' }))).toThrow(/await/)
    expect(() => publicDemoView({ nested: Promise.resolve(1) })).toThrow(/await/)
    expect(publicDemoView({ decision: 'READY', services: [] })).toEqual({
      decision: 'READY',
      services: [],
    })
  })

  // `this.writes.then(...)` on an ALREADY-REJECTED promise forwards the
  // rejection without ever calling save, so one ENOSPC permanently stopped
  // every later persist - and the failure path in `launch` rethrew into a
  // stored-then-deleted promise, i.e. an unhandled rejection.
  it('recovers persistence after a failed demo state write', async () => {
    const runtime = new FakeRuntime()
    const controller = new DemoController(await dataDir(), runtime)
    await controller.initialize()
    const store = controller.store as unknown as { save: (snapshot: unknown) => Promise<void> }
    const original = store.save.bind(store)
    let failNext = false
    let failAll = false
    store.save = async (snapshot) => {
      if (failAll || failNext) {
        failNext = false
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      }
      return original(snapshot)
    }

    failNext = true
    await expect(
      controller.createTemplate({ name: 'Shop', presetId: 'shop' }, 'persist-key-1'),
    ).rejects.toThrow(/ENOSPC/)
    expect(controller.persistenceFailure()).not.toBeNull()

    // The very next write must actually run `save` again rather than replay
    // the original rejection forever: `.then()` on a rejected promise never
    // invoked `save` at all.
    const recovered = await controller.createTemplate(
      { name: 'Shop again', presetId: 'shop' },
      'persist-key-2',
    )
    expect(recovered.template.name).toBe('Shop again')
    expect(controller.persistenceFailure()).toBeNull()
    await controller.drain()

    // A worker whose TERMINAL persist fails must not leave an unhandled
    // rejection behind: `launch` stores the promise and `.finally` deletes it,
    // which on Node 22 is fatal by default. `drain` must simply resolve.
    runtime.failAt = 'prepare'
    const third = await controller.createTemplate({ name: 'Third', presetId: 'shop' }, 'persist-key-3')
    expect(third.job.kind).toBe('PREPARE_TEMPLATE')
    failAll = true
    await expect(controller.drain()).resolves.toBeUndefined()
    failAll = false
    store.save = original
  })

  it('requires idempotency keys and returns human failures', async () => {
    const controller = new DemoController(await dataDir(), new FakeRuntime())
    await controller.initialize()
    const app = Fastify({ logger: false })
    registerDemoRoutes(app, controller)
    const missing = await app.inject({
      method: 'POST',
      url: '/demo/v1/templates',
      payload: { name: 'Shop', presetId: 'shop' },
    })
    expect(missing.statusCode).toBe(400)
    expect(missing.json().error.explanation).toMatch(/Idempotency-Key/)
    const accepted = await app.inject({
      method: 'POST',
      url: '/demo/v1/templates',
      headers: { 'idempotency-key': 'route-template-1' },
      payload: { name: 'Route shop', presetId: 'shop' },
    })
    expect(accepted.statusCode).toBe(202)
    await controller.drain()
    expect((await app.inject({ method: 'GET', url: '/demo/v1/templates' })).json().templates).toHaveLength(1)
    await app.close()
  })

  it('publishes the room-close mutation used by the Stop button', async () => {
    const { controller, templateId } = await readyController()
    const room = await controller.createRoom(
      { name: 'Route close room', templateId },
      'route-close-room-1',
    )
    const app = Fastify({ logger: false })
    registerDemoRoutes(app, controller)

    const response = await app.inject({
      method: 'POST',
      url: `/demo/v1/rooms/${room.id}/close`,
      headers: { 'idempotency-key': 'route-close-request-1' },
      payload: {},
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      id: room.id,
      phase: 'CLOSED',
      moves: { accepting: false, reopens: false },
    })
    await app.close()
  })
})
