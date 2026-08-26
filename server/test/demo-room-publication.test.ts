/**
 * What a browser holding nothing but a room id can learn from the API.
 *
 * FOUR FAILURES THIS COVERS, all of them silent on the wire.
 *
 * 1. A ROOM THAT DOES NOT NAME ITS DUEL. `/demo/v1/rooms/:id` used to carry
 *    fifteen keys and not one of them card-related, so a console could not set
 *    `to` on a signed move and could not derive `proofDomain`, public input 0
 *    of every card circuit. The addresses lived on the template and nothing
 *    joined the two.
 *
 * 2. TWO ROOMS WITH ONE NAME. A room that is mid-checkpoint refuses moves; an
 *    operator opens "the room" again, gets a second room from the same cold
 *    template, and the moves already settled stay behind in the first. Both are
 *    called "Card duel live".
 *
 * 3. A DEADLINE THAT IS SHORTER THAN THE WORK. Four blocks is 48 s and a whole
 *    checkpoint is 49.23 s, so the historic default raced itself. The bound is
 *    now enforced, and a card room - whose batch carries an inner Groth16 proof
 *    per move - opens with two minutes of headroom rather than the generic
 *    default.
 *
 * 4. A RECEIPT THAT IS NOT A LINK. `0x05d3ac...ce78` cannot be looked up. Every
 *    hash that represents state landed on L1 is published whole, with the
 *    explorer URL beside it.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { cardProofDomain } from '@zkdeal/protocol'
import type { Hex } from 'viem'
import {
  publicDemoView,
  registerDemoRoutes,
  uniqueRoomName,
  withRoomSuffix,
  DemoController,
  CARD_ROOM_DEADLINE_BLOCKS,
  CARD_ROOM_PROVING_HEADROOM_SECONDS,
  DEFAULT_DEADLINE_BLOCKS_FROM_START,
  MAXIMUM_DEADLINE_BLOCKS,
  MAXIMUM_ROOM_NAME_LENGTH,
  MINIMUM_DEADLINE_BLOCKS,
} from '../src/demo-control.js'
import { CARD_ROOM_PRESET_ID } from '../src/card-room.js'
import { cardRoomFixture } from './helpers/card-room-fixture.js'
import { FakeRuntime } from './helpers/demo-fake-runtime.js'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function dataDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'zkdeal-room-publication-'))
  created.push(path)
  return path
}

/** A controller holding one prepared template of the requested preset. */
async function readyController(presetId: string, name = 'Duel template') {
  const controller = new DemoController(await dataDir(), new FakeRuntime())
  await controller.initialize()
  const prepared = await controller.createTemplate({ name, presetId }, `tpl-key-${presetId}-01`)
  await controller.drain()
  return { controller, templateId: prepared.template.id }
}

let key = 0
const nextKey = () => `publication-key-${(key += 1).toString().padStart(6, '0')}`

describe('the card room published on a room', () => {
  it('names the duel a console signs to, and the domain it proves against', async () => {
    const { controller, templateId } = await readyController(CARD_ROOM_PRESET_ID)
    const room = await controller.createRoom({ name: 'Card duel live', templateId }, nextKey())
    const deployment = cardRoomFixture()
    const published = controller.room(room.id)!.cardRoom!
    expect(published.duelAddress).toBe(deployment.duel.address)
    expect(published.stakeTokenAddress).toBe(deployment.stakeToken.address)
    expect(published.proofAdapterAddress).toBe(deployment.adapter.address)
    expect(published.deckVerifierAddress).toBe(deployment.deckVerifier.address)
    expect(published.handVerifierAddress).toBe(deployment.handVerifier.address)
    expect(published.roomApplicationDomain).toBe(deployment.roomApplicationDomain)
    expect(published.duelistOwners.length).toBeGreaterThan(0)
  })

  it('carries proofDomain already reduced, so the browser restates no derivation', async () => {
    const { controller, templateId } = await readyController(CARD_ROOM_PRESET_ID)
    const room = await controller.createRoom({ name: 'Domain room', templateId }, nextKey())
    const deployment = cardRoomFixture()
    const published = controller.room(room.id)!.cardRoom!
    expect(published.proofDomain).toBe(
      cardProofDomain(
        deployment.roomApplicationDomain as Hex,
        deployment.duel.address as Hex,
      ).toString(10),
    )
    // A circuit's public input is a decimal field element, not a hex string.
    expect(published.proofDomain).toMatch(/^\d+$/)
  })

  it('survives the response redaction whole: a truncated address cannot be signed for', async () => {
    const { controller, templateId } = await readyController(CARD_ROOM_PRESET_ID)
    const room = await controller.createRoom({ name: 'Redaction room', templateId }, nextKey())
    const view = publicDemoView(controller.room(room.id)!)
    expect(view.cardRoom!.duelAddress).toBe(cardRoomFixture().duel.address)
    expect(JSON.stringify(view.cardRoom)).not.toContain('...')
  })

  it('is absent from a room whose template is not a duel', async () => {
    const { controller, templateId } = await readyController('shop', 'Shop template')
    const room = await controller.createRoom({ name: 'Shop room', templateId }, nextKey())
    expect(controller.room(room.id)!.cardRoom).toBeUndefined()
  })

  it('reaches an HTTP client un-truncated on /demo/v1/rooms/:id', async () => {
    const { controller, templateId } = await readyController(CARD_ROOM_PRESET_ID)
    const room = await controller.createRoom({ name: 'HTTP room', templateId }, nextKey())
    const app = Fastify()
    registerDemoRoutes(app, controller)
    const response = await app.inject({ method: 'GET', url: `/demo/v1/rooms/${room.id}` })
    const body = response.json() as { cardRoom?: { duelAddress: string; proofDomain: string } }
    expect(body.cardRoom?.duelAddress).toBe(cardRoomFixture().duel.address)
    expect(body.cardRoom?.proofDomain).toMatch(/^\d+$/)
    await app.close()
  })
})

describe('room names', () => {
  it('gives two rooms of the same requested name different names', async () => {
    const { controller, templateId } = await readyController(CARD_ROOM_PRESET_ID)
    const first = await controller.createRoom({ name: 'Card duel live', templateId }, nextKey())
    const second = await controller.createRoom({ name: 'Card duel live', templateId }, nextKey())
    expect(first.name).not.toBe(second.name)
    expect(first.name.startsWith('Card duel live (')).toBe(true)
    expect(second.name.startsWith('Card duel live (')).toBe(true)
  })

  it('keeps the suffix readable rather than a uuid', async () => {
    const { controller, templateId } = await readyController('shop', 'Shop template')
    const room = await controller.createRoom({ name: 'Presentation shop', templateId }, nextKey())
    expect(room.name).toMatch(/^Presentation shop \([a-z]+-[a-z]+\)$/)
    expect(room.name.length).toBeLessThanOrEqual(MAXIMUM_ROOM_NAME_LENGTH)
  })

  it('honours a name supplied verbatim, and refuses to duplicate one', async () => {
    const { controller, templateId } = await readyController('shop', 'Shop template')
    const room = await controller.createRoom(
      { name: 'Exactly this', templateId, uniqueName: false },
      nextKey(),
    )
    expect(room.name).toBe('Exactly this')
    await expect(
      controller.createRoom({ name: 'Exactly this', templateId, uniqueName: false }, nextKey()),
    ).rejects.toThrow(/already exists/)
  })

  it('trims the base rather than the suffix when the pair would not fit', () => {
    const base = 'x'.repeat(MAXIMUM_ROOM_NAME_LENGTH)
    const name = withRoomSuffix(base, 'brisk-heron')
    expect(name.length).toBeLessThanOrEqual(MAXIMUM_ROOM_NAME_LENGTH)
    expect(name.endsWith('(brisk-heron)')).toBe(true)
  })

  it('never returns a name already taken, even when every drawn pair is', () => {
    // 1,024 pairs exist; a set holding every candidate forces the counted
    // fallback, which must still terminate with an unused name.
    const taken = new Set<string>()
    for (let index = 0; index < 4_000; index += 1) {
      const name = uniqueRoomName('Crowded', taken)
      expect(taken.has(name)).toBe(false)
      taken.add(name)
    }
  })
})

describe('room settings', () => {
  it('opens a card room with proof, reorg and full-retry headroom', async () => {
    const { controller, templateId } = await readyController(CARD_ROOM_PRESET_ID)
    const room = await controller.createRoom({ name: 'Headroom room', templateId }, nextKey())
    expect(room.deadlineBlocksFromStart).toBe(CARD_ROOM_DEADLINE_BLOCKS)
    expect(room.settings.deadlineSeconds).toBe(CARD_ROOM_PROVING_HEADROOM_SECONDS)
    expect(CARD_ROOM_DEADLINE_BLOCKS).toBe(74)
  })

  it('leaves a non-duel room on the generic default', async () => {
    const { controller, templateId } = await readyController('shop', 'Shop template')
    const room = await controller.createRoom({ name: 'Generic room', templateId }, nextKey())
    expect(room.deadlineBlocksFromStart).toBe(DEFAULT_DEADLINE_BLOCKS_FROM_START)
  })

  it('refuses a deadline shorter than a checkpoint, with the arithmetic', async () => {
    const { controller, templateId } = await readyController('shop', 'Shop template')
    await expect(
      controller.createRoom(
        { name: 'Too tight', templateId, deadlineBlocksFromStart: MINIMUM_DEADLINE_BLOCKS - 1 },
        nextKey(),
      ),
    ).rejects.toThrow(/one whole checkpoint takes 49\.23 s/)
  })

  it('refuses a deadline past the demo ceiling', async () => {
    const { controller, templateId } = await readyController('shop', 'Shop template')
    await expect(
      controller.createRoom(
        { name: 'Too slack', templateId, deadlineBlocksFromStart: MAXIMUM_DEADLINE_BLOCKS + 1 },
        nextKey(),
      ),
    ).rejects.toThrow(/demo ceiling/)
  })

  it('publishes the bounds and the per-preset default a client chooses from', async () => {
    const { controller } = await readyController('shop', 'Shop template')
    const app = Fastify()
    registerDemoRoutes(app, controller)
    const response = await app.inject({ method: 'GET', url: '/demo/v1/room-settings' })
    const body = response.json() as {
      deadlineBlocksFromStart: {
        minimum: number
        maximum: number
        l1BlockSeconds: number
        byPreset: Record<string, { blocks: number; seconds: number }>
      }
    }
    expect(body.deadlineBlocksFromStart.minimum).toBe(MINIMUM_DEADLINE_BLOCKS)
    expect(body.deadlineBlocksFromStart.maximum).toBe(MAXIMUM_DEADLINE_BLOCKS)
    expect(body.deadlineBlocksFromStart.byPreset[CARD_ROOM_PRESET_ID]).toEqual({
      blocks: CARD_ROOM_DEADLINE_BLOCKS,
      seconds: CARD_ROOM_PROVING_HEADROOM_SECONDS,
    })
    // The blocks-to-seconds conversion is published, not assumed.
    expect(body.deadlineBlocksFromStart.l1BlockSeconds).toBe(12)
    await app.close()
  })
})

describe('addressable transactions', () => {
  it('publishes the room deployment whole and as an explorer link', async () => {
    const { controller, templateId } = await readyController('shop', 'Shop template')
    const room = await controller.createRoom({ name: 'Deployed room', templateId }, nextKey())
    await controller.deployRoom(room.id, nextKey())
    await controller.drain()
    const view = publicDemoView(controller.room(room.id)!)
    const hash = `0x${'99'.repeat(32)}`
    expect(view.deploymentTransaction).toBe(hash)
    expect(view.deployment).toEqual({
      chainRoomId: '2',
      l1TransactionHash: hash,
      explorerUrl: `http://explorer/tx/${hash}`,
    })
    expect(JSON.stringify(view.deployment)).not.toContain('...')
  })

  it('links every settled move to the transaction that proved it', async () => {
    const { controller, templateId } = await readyController('shop', 'Shop template')
    const room = await controller.createRoom({ name: 'Settled room', templateId }, nextKey())
    await controller.deployRoom(room.id, nextKey())
    await controller.drain()
    await controller.addAction(room.id, { actionId: 'register-session', actorId: 'buyer' }, nextKey())
    await controller.addAction(room.id, { actionId: 'buy-item', actorId: 'buyer' }, nextKey())
    await controller.checkpointRoom(room.id, nextKey())
    await controller.drain()
    const view = publicDemoView(controller.room(room.id)!)
    const hash = `0x${'01'.repeat(32)}`
    for (const action of view.actions) {
      expect(action.settlement).toEqual({
        checkpointSequence: 1,
        batchIndex: 1,
        l1Block: '77',
        l1BlockHash: `0x${'cd'.repeat(32)}`,
        finalizedL1Block: '141',
        finalizedL1BlockHash: `0x${'ef'.repeat(32)}`,
        l1TransactionHash: hash,
        explorerUrl: `http://explorer/tx/${hash}`,
      })
    }
  })

  it('leaves the system canary, its contracts and the block feed openable', async () => {
    const { controller } = await readyController('shop', 'Shop template')
    const app = Fastify()
    registerDemoRoutes(app, controller)
    const system = (await app.inject({ method: 'GET', url: '/demo/v1/system' })).json() as {
      canary: { l1TransactionHash: string; transactionReference: string }
    }
    // The short reference stays for display; the whole hash stands beside it.
    expect(system.canary.l1TransactionHash).toBe(`0x${'ab'.repeat(32)}`)
    expect(system.canary.transactionReference).toContain('…')
    const blocks = (await app.inject({ method: 'GET', url: '/demo/v1/l1/blocks' })).json() as {
      blocks: Array<{ blockHash: string; explorerUrl: string }>
    }
    expect(blocks.blocks[0]!.blockHash).toBe(`0x${'ef'.repeat(32)}`)
    expect(blocks.blocks[0]!.explorerUrl).toBe('http://explorer/block/42')
    await app.close()
  })

  it('leaves a move that no checkpoint proved without a settlement', async () => {
    const { controller, templateId } = await readyController('shop', 'Shop template')
    const room = await controller.createRoom({ name: 'Pending room', templateId }, nextKey())
    await controller.deployRoom(room.id, nextKey())
    await controller.drain()
    await controller.addAction(room.id, { actionId: 'register-session', actorId: 'buyer' }, nextKey())
    expect(controller.room(room.id)!.actions[0]!.settlement).toBeNull()
  })
})

describe('a room that is not taking moves', () => {
  it('says the refusal is temporary while its own checkpoint proves', async () => {
    const { controller, templateId } = await readyController('shop', 'Shop template')
    const runtime = controller.runtime as FakeRuntime
    const room = await controller.createRoom({ name: 'Proving room', templateId }, nextKey())
    await controller.deployRoom(room.id, nextKey())
    await controller.drain()
    await controller.addAction(room.id, { actionId: 'register-session', actorId: 'buyer' }, nextKey())
    await controller.addAction(room.id, { actionId: 'buy-item', actorId: 'buyer' }, nextKey())
    // The gate is ONE promise built up front, not one built per call: binding
    // `release` inside the executor meant `release()` could run before the
    // runtime had ever called the gate, leaving a second gate nobody resolves
    // and a `drain()` that never returns. That is a race in the test, and it
    // showed up only under a loaded parallel run.
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    runtime.checkpointGate = () => gate
    await controller.checkpointRoom(room.id, nextKey())
    // Wait for the phase itself rather than a fixed delay: under a loaded
    // recursive test run a sleep is a coin flip, and a flaky assertion about
    // move admission is worse than none.
    for (let attempt = 0; attempt < 500 && controller.room(room.id)!.phase !== 'PROVING'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const moves = controller.room(room.id)!.moves
    expect(moves.phase).toBe('PROVING')
    expect(moves.accepting).toBe(false)
    expect(moves.reopens).toBe(true)
    expect(moves.reason).toMatch(/do NOT open a second room/)
    await expect(
      controller.addAction(room.id, { actionId: 'buy-item', actorId: 'buyer' }, nextKey()),
    ).rejects.toThrow(/is not accepting moves/)
    release()
    await controller.drain()
    expect(controller.room(room.id)!.moves.accepting).toBe(true)
  })

  it('names the room play continued in when a dead room is superseded', async () => {
    const { controller, templateId } = await readyController('shop', 'Shop template')
    const runtime = controller.runtime as FakeRuntime
    const dead = await controller.createRoom({ name: 'Abandoned', templateId }, nextKey())
    runtime.failAt = 'deploy'
    await controller.deployRoom(dead.id, nextKey())
    await controller.drain()
    runtime.failAt = null
    expect(controller.room(dead.id)!.phase).toBe('FAILED')
    const live = await controller.createRoom({ name: 'Continued', templateId }, nextKey())
    await controller.deployRoom(live.id, nextKey())
    await controller.drain()
    const moves = controller.room(dead.id)!.moves
    expect(moves.accepting).toBe(false)
    expect(moves.reopens).toBe(false)
    expect(moves.supersededBy).toMatchObject({ id: live.id, name: live.name, phase: 'ACTIVE' })
    await expect(
      controller.addAction(dead.id, { actionId: 'buy-item', actorId: 'buyer' }, nextKey()),
    ).rejects.toThrow(new RegExp(`play continued in '${live.name.replace(/[()]/g, '\\$&')}'`))
  })

  it('says an undeployed room has nothing to prove against, not that it is finished', async () => {
    const { controller, templateId } = await readyController('shop', 'Shop template')
    const room = await controller.createRoom({ name: 'Not yet on L1', templateId }, nextKey())
    const moves = controller.room(room.id)!.moves
    expect(moves.accepting).toBe(false)
    // Reopens, because deploying it is all that is missing; a "no longer
    // accepts moves" here would send an operator looking for a lost game.
    expect(moves.reopens).toBe(true)
    expect(moves.reason).toMatch(/does not exist on L1 yet/)
    expect(moves.reason).not.toMatch(/no longer accepts/)
    expect(moves.supersededBy).toBeNull()
  })

  it('reports an open room as accepting, with its pending count', async () => {
    const { controller, templateId } = await readyController('shop', 'Shop template')
    const room = await controller.createRoom({ name: 'Open room', templateId }, nextKey())
    await controller.deployRoom(room.id, nextKey())
    await controller.drain()
    await controller.addAction(room.id, { actionId: 'register-session', actorId: 'buyer' }, nextKey())
    const moves = controller.room(room.id)!.moves
    expect(moves.accepting).toBe(true)
    expect(moves.supersededBy).toBeNull()
    expect(moves.reason).toContain('1 move(s) are waiting')
  })
})
