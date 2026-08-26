/**
 * T1.4 observer write surface. The threat model throughout is a compromised
 * INDEXER_TOKEN: every rule below must hold even when the caller presents a
 * valid credential, so the suite drives the routes with the real token and
 * checks that the document-level guards - merge, reorg corroboration,
 * finalized anchor, freshness clamp - do the actual protecting.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, describe, expect, it } from 'vitest'
import { FinalizedAnchorStore } from '../src/finalized-anchor-store.js'
import {
  registerObserverWriteRoutes,
  type ObserverWriteReaders,
} from '../src/observer-write.js'
import {
  ObserverStore,
  type ObservedBatch,
  type ObservedRoom,
} from '../src/observer.js'
import { a, h, room } from './helpers/admission-harness.js'

const indexerToken = 'indexer-token-abcdefghij'
const indexer = { authorization: `Bearer ${indexerToken}` }

const contexts: Array<{ app: FastifyInstance; directory: string }> = []

afterAll(async () => {
  for (const { app, directory } of contexts.splice(0)) {
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

/** Valid v2 write-schema document on top of the shared room fixture. */
function roomV2(id: string, overrides: Partial<ObservedRoom> = {}): ObservedRoom {
  return room(id, a('1'), {
    schemaVersion: 2,
    headBlockHash: h('b'),
    ...overrides,
  })
}

function batchV2(overrides: Partial<ObservedBatch> = {}): ObservedBatch {
  return {
    batchIndex: '1',
    startL2Block: '1',
    endL2Block: '1',
    preStateRoot: h('3'),
    postStateRoot: h('4'),
    batchDataHash: h('5'),
    canonicalDataHash: h('b'),
    approverRoot: h('6'),
    approverEpoch: '1',
    activeCount: '1',
    inboxCursor: '0',
    admissionCursor: '0',
    forcedCursor: '0',
    importCursor: '0',
    outboxEpoch: '1',
    withdrawalRoot: null,
    close: false,
    acceptedL1Block: '30',
    acceptedL1BlockHash: h('9'),
    acceptedL1Transaction: h('7'),
    acceptedAt: '2026-08-01T12:00:00.000Z',
    blocks: [],
    ...overrides,
  }
}

const pendingAdmission: ObservedRoom['admissions'][number] = {
  admissionId: '1',
  transactionHash: h('7'),
  depositInboxId: '0',
  depositContentHash: h('0'),
  deadlineBlock: '100',
  maximumBatchIndex: '3',
  status: 'PENDING',
  l2BlockNumber: null,
  transactionIndex: null,
}

const pendingDeposit: ObservedRoom['deposits'][number] = {
  inboxId: '1',
  depositor: a('b'),
  asset: a('0'),
  amount: '100',
  beneficiary: a('b'),
  queuedAtBlock: '50',
  queuedAtBlockHash: h('c'),
  status: 'PENDING',
  consumedBatch: null,
}

interface WriteHarnessOptions {
  /** null registers the surface with no credential configured. */
  token?: string | null
  readers?: Partial<ObserverWriteReaders>
  /** Pre-seeded finalized anchor block (hash h('a')). */
  anchorBlock?: bigint
}

async function writeHarness(rooms: ObservedRoom[] = [], options: WriteHarnessOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'zkdeal-observer-write-'))
  const store = new ObserverStore(join(directory, 'room-observer'))
  const anchors = new FinalizedAnchorStore(join(directory, 'observer-finalized-anchor.json'))
  if (options.anchorBlock !== undefined) anchors.advance(options.anchorBlock, h('a'))
  const app = Fastify({ logger: false })
  const readers: ObserverWriteReaders = {
    getBlockHash: options.readers?.getBlockHash ?? (async () => h('f')),
    getFinalized: options.readers?.getFinalized ?? (async () => ({ number: 0n, hash: h('0') })),
  }
  registerObserverWriteRoutes(app, {
    store,
    config: {
      indexerToken: options.token === undefined ? indexerToken : options.token,
      dataDir: directory,
      l1RpcUrls: ['http://127.0.0.1:8545', 'http://127.0.0.1:8546'],
    },
    readers,
    anchors,
  })
  await app.ready()
  // Seeded through the CAS path so every stored document carries revision 1.
  for (const entry of rooms) store.put(entry, null)
  contexts.push({ app, directory })
  return { app, store, anchors }
}

function put(app: FastifyInstance, id: string, body: ObservedRoom, ifMatch?: string) {
  return app.inject({
    method: 'PUT',
    url: `/observer/v1/rooms/${id}`,
    headers: ifMatch === undefined ? indexer : { ...indexer, 'if-match': ifMatch },
    payload: body,
  })
}

describe('observer write surface', () => {
  it('answers 503 while no indexer credential is configured', async () => {
    const { app } = await writeHarness([], { token: null })
    const rejected = await put(app, '7', roomV2('7'), '0')
    expect(rejected.statusCode).toBe(503)
    expect(rejected.json().decision).toBe('INDEXER_WRITES_UNAVAILABLE')
    const heartbeat = await app.inject({
      method: 'PATCH',
      url: '/observer/v1/rooms/7/freshness',
      headers: indexer,
      payload: { latestObservedL1Block: '70', headBlockHash: h('d') },
    })
    expect(heartbeat.statusCode).toBe(503)
  })

  it('refuses a missing or wrong bearer token', async () => {
    const { app, store } = await writeHarness([roomV2('7')])
    const anonymous = await app.inject({
      method: 'PUT',
      url: '/observer/v1/rooms/7',
      headers: { 'if-match': '1' },
      payload: roomV2('7'),
    })
    expect(anonymous.statusCode).toBe(401)
    expect(anonymous.headers['www-authenticate']).toMatch(/zkdeal-indexer/)
    const wrong = await app.inject({
      method: 'PUT',
      url: '/observer/v1/rooms/7',
      headers: { authorization: `Bearer ${indexerToken}x`, 'if-match': '1' },
      payload: roomV2('7'),
    })
    expect(wrong.statusCode).toBe(401)
    expect(store.get('7')?.revision).toBe('1')
  })

  it('requires If-Match so every write is a compare-and-set', async () => {
    const { app } = await writeHarness([roomV2('7')])
    const missing = await put(app, '7', roomV2('7'))
    expect(missing.statusCode).toBe(428)
    expect(missing.json().decision).toBe('PRECONDITION_REQUIRED')
  })

  it('reports a revision conflict instead of clobbering a concurrent write', async () => {
    const { app, store } = await writeHarness([roomV2('7')])
    const stale = await put(app, '7', roomV2('7'), '5')
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error).toBe('REVISION_CONFLICT')
    expect(store.get('7')?.revision).toBe('1')
  })

  it('rejects a v1-shaped body: every PUT must carry the v2 provenance', async () => {
    const { app } = await writeHarness([roomV2('7')])
    const v1 = room('7', a('1'))
    const rejected = await put(app, '7', v1, '1')
    expect(rejected.statusCode).toBe(422)
    expect(rejected.json().decision).toBe('INVALID_ARCHIVE')
    expect(rejected.json().reason).toMatch(/schema version 2/)
    // The provenance hashes are required, not merely the marker.
    const unhashed = await put(app, '7', { ...roomV2('7'), headBlockHash: undefined }, '1')
    expect(unhashed.statusCode).toBe(422)
    expect(unhashed.json().reason).toMatch(/head block hash/)
  })

  it('refuses to drop a pending admission whose horizon is still open', async () => {
    const { app, store } = await writeHarness([
      roomV2('7', { admissions: [pendingAdmission] }),
    ])
    const dropped = await put(
      app,
      '7',
      roomV2('7', { latestObservedL1Block: '70', admissions: [] }),
      '1',
    )
    expect(dropped.statusCode).toBe(409)
    expect(dropped.json()).toMatchObject({
      error: 'MERGE_CONFLICT',
      droppedKeys: ['admission:1'],
    })
    // A mutated identity is the same silent drop wearing the original id.
    const mutated = await put(
      app,
      '7',
      roomV2('7', {
        latestObservedL1Block: '70',
        admissions: [{ ...pendingAdmission, transactionHash: h('8') }],
      }),
      '1',
    )
    expect(mutated.statusCode).toBe(409)
    expect(mutated.json().droppedKeys).toEqual(['admission:1'])
    expect(store.get('7')?.admissions[0]?.transactionHash).toBe(h('7'))
  })

  it('refuses to drop a pending deposit', async () => {
    const { app } = await writeHarness([roomV2('7', { deposits: [pendingDeposit] })])
    const dropped = await put(
      app,
      '7',
      roomV2('7', { latestObservedL1Block: '70', deposits: [] }),
      '1',
    )
    expect(dropped.statusCode).toBe(409)
    expect(dropped.json()).toMatchObject({
      error: 'MERGE_CONFLICT',
      droppedKeys: ['deposit:1'],
    })
  })

  it('accepts a pending admission transitioning to a terminal outcome', async () => {
    const { app, store } = await writeHarness([
      roomV2('7', { admissions: [pendingAdmission] }),
    ])
    const settled = await put(
      app,
      '7',
      roomV2('7', {
        latestObservedL1Block: '70',
        admissions: [
          { ...pendingAdmission, status: 'SUCCEEDED', l2BlockNumber: '1', transactionIndex: 0 },
        ],
      }),
      '1',
    )
    expect(settled.statusCode, settled.body).toBe(200)
    expect(settled.json()).toEqual({ revision: '2' })
    expect(store.get('7')?.admissions[0]?.status).toBe('SUCCEEDED')
  })

  it('rejects a freshness regression without a corroborated reorg declaration', async () => {
    const { app, store } = await writeHarness(
      [roomV2('7', { latestObservedL1Block: '100' })],
      {
        readers: {
          // The two providers disagree: no corroboration is possible.
          getBlockHash: async () => {
            throw new Error('L1 RPC providers disagree on canonical block 85')
          },
        },
      },
    )
    const undeclared = await put(
      app,
      '7',
      roomV2('7', { latestObservedL1Block: '90' }),
      '1',
    )
    expect(undeclared.statusCode).toBe(409)
    expect(undeclared.json().error).toBe('REORG_UNCORROBORATED')

    const uncorroborated = await put(
      app,
      '7',
      roomV2('7', {
        latestObservedL1Block: '90',
        reorg: { forkPointBlock: '85', forkPointHash: h('f'), detectedAtBlock: '91' },
      }),
      '1',
    )
    expect(uncorroborated.statusCode).toBe(409)
    expect(uncorroborated.json().error).toBe('REORG_UNCORROBORATED')
    expect(store.get('7')?.latestObservedL1Block).toBe('100')
  })

  it('accepts a corroborated reorg and lets freshness regress with it', async () => {
    const { app, store } = await writeHarness(
      [roomV2('7', { latestObservedL1Block: '100' })],
      { readers: { getBlockHash: async () => h('f') } },
    )
    const rewound = await put(
      app,
      '7',
      roomV2('7', {
        latestObservedL1Block: '90',
        headBlockHash: h('e'),
        reorg: { forkPointBlock: '85', forkPointHash: h('f'), detectedAtBlock: '91' },
      }),
      '1',
    )
    expect(rewound.statusCode, rewound.body).toBe(200)
    const current = store.get('7')!
    expect(current.latestObservedL1Block).toBe('90')
    expect(current.headBlockHash).toBe(h('e'))
    expect(current.revision).toBe('2')
  })

  it('refuses a reorg fork point below the finalized anchor', async () => {
    const { app, store } = await writeHarness(
      [roomV2('7', { latestObservedL1Block: '100' })],
      { anchorBlock: 40n, readers: { getBlockHash: async () => h('f') } },
    )
    // Corroborated - the hash matches - yet still refused: finalized history
    // is not renegotiable through this surface.
    const undercut = await put(
      app,
      '7',
      roomV2('7', {
        latestObservedL1Block: '90',
        reorg: { forkPointBlock: '39', forkPointHash: h('f'), detectedAtBlock: '91' },
      }),
      '1',
    )
    expect(undercut.statusCode).toBe(409)
    expect(undercut.json().error).toBe('FINALITY_VIOLATION')
    expect(store.get('7')?.latestObservedL1Block).toBe('100')
  })

  it('refuses to rewrite a fact at or below the finalized anchor', async () => {
    const finalizedDeposit: ObservedRoom['deposits'][number] = {
      ...pendingDeposit,
      queuedAtBlock: '30',
      status: 'CONSUMED',
      consumedBatch: '1',
    }
    const { app, store } = await writeHarness(
      [roomV2('7', { deposits: [finalizedDeposit], batches: [batchV2()] })],
      { anchorBlock: 40n },
    )
    const editedDeposit = await put(
      app,
      '7',
      roomV2('7', {
        latestObservedL1Block: '70',
        deposits: [{ ...finalizedDeposit, amount: '200' }],
        batches: [batchV2()],
      }),
      '1',
    )
    expect(editedDeposit.statusCode).toBe(409)
    expect(editedDeposit.json()).toMatchObject({ error: 'FINALITY_VIOLATION' })
    expect(editedDeposit.json().reason).toMatch(/finalized deposit 1/)

    const editedBatch = await put(
      app,
      '7',
      roomV2('7', {
        latestObservedL1Block: '70',
        deposits: [finalizedDeposit],
        batches: [batchV2({ postStateRoot: h('5') })],
      }),
      '1',
    )
    expect(editedBatch.statusCode).toBe(409)
    expect(editedBatch.json().reason).toMatch(/finalized batch 1/)
    expect(store.get('7')?.deposits[0]?.amount).toBe('100')
  })

  it('advances freshness through the heartbeat without bumping the revision', async () => {
    const { app, store } = await writeHarness([roomV2('7')])
    const advanced = await app.inject({
      method: 'PATCH',
      url: '/observer/v1/rooms/7/freshness',
      headers: indexer,
      payload: { latestObservedL1Block: '120', headBlockHash: h('d') },
    })
    expect(advanced.statusCode, advanced.body).toBe(200)
    const current = store.get('7')!
    expect(current.latestObservedL1Block).toBe('120')
    expect(current.headBlockHash).toBe(h('d'))
    // No revision bump: a CAS writer holding the pre-heartbeat document must
    // still win its write (the put clamp preserves what this merge advanced).
    expect(current.revision).toBe('1')

    const regressed = await app.inject({
      method: 'PATCH',
      url: '/observer/v1/rooms/7/freshness',
      headers: indexer,
      payload: { latestObservedL1Block: '110', headBlockHash: h('d') },
    })
    expect(regressed.statusCode).toBe(409)
    expect(regressed.json().error).toBe('FRESHNESS_CONFLICT')
    expect(store.get('7')?.latestObservedL1Block).toBe('120')
  })

  // The admission path reads the document, awaits recovery and signing, then
  // writes it back; a heartbeat landing in between must not be re-staled.
  it('clamps a stale full put so it cannot regress a newer heartbeat', async () => {
    const { store } = await writeHarness([roomV2('7', { latestObservedL1Block: '100' })])
    const stale = store.get('7')!
    store.mergeFreshness('7', { latestObservedL1Block: '120', headBlockHash: h('d') })
    // The stale writer's CAS still passes - the heartbeat did not bump the
    // revision - but the freshness it would rewind is kept.
    const written = store.put(
      { ...stale, admissions: [pendingAdmission] },
      stale.revision ?? null,
    )
    expect(written.latestObservedL1Block).toBe('120')
    expect(written.headBlockHash).toBe(h('d'))
    const current = store.get('7')!
    expect(current.latestObservedL1Block).toBe('120')
    expect(current.revision).toBe('2')
    expect(current.admissions).toHaveLength(1)
  })
})
