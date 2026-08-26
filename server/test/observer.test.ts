import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RateLimiter } from '../src/quota.js'
import {
  MAX_STREAM_SUBSCRIBERS_PER_ROOM,
  registerObserverRoutes,
  ObserverRevisionConflictError,
  ObserverStore,
  type ObservedRoom,
} from '../src/observer.js'

const h = (byte: string) => `0x${byte.repeat(64)}` as `0x${string}`
const a = (byte: string) => `0x${byte.repeat(40)}` as `0x${string}`

describe('room observer API', () => {
  const directory = mkdtempSync(join(tmpdir(), 'zkdeal-observer-'))
  const store = new ObserverStore(directory)
  const app = Fastify({ logger: false })

  beforeAll(async () => {
    const room: ObservedRoom = {
      roomId: '7',
      status: 'OPEN',
      authorizationMode: 'UNANIMOUS_APPROVERS',
      admissionSigner: null,
      serviceBond: '0',
      minimumServiceBond: '0',
      omissionPenalty: '0',
      bondEpoch: '1',
      maximumAdmissionWindow: '0',
      minimumDepositConfirmations: '64',
      latestObservedL1Block: '100',
      coldTemplateId: h('1'),
      coldTemplateDataHash: h('a'),
      policyHash: h('2'),
      participantRoot: h('e'),
      participantEpoch: '1',
      participantCount: '2',
      participantCapacity: '128',
      managedService: {
        allocationId: h('c'),
        nodeId: h('d'),
        slotId: h('e'),
        status: 'USED',
        startBlock: '90',
        proofDeadlineBlock: '127',
        priceEpoch: '4',
        lastHealthyBlock: '100',
        refundableBalance: '370000000000000000',
      },
      supportedAssets: [a('0')],
      approvers: [
        { index: '0', member: a('b'), joinedEpoch: '1', status: 'ACTIVE' },
        { index: '1', member: a('e'), joinedEpoch: '1', status: 'ACTIVE' },
      ],
      liabilities: [
        {
          asset: a('0'),
          pending: '0',
          controlled: '100',
          claimable: '0',
          paid: '0',
        },
      ],
      imports: [
        {
          importId: '1',
          sourceBlock: '120',
          source: a('f'),
          adapterId: h('e'),
          stateRoot: h('f'),
          consumedBatch: '1',
        },
      ],
      deposits: [
        {
          inboxId: '1',
          depositor: a('b'),
          asset: a('0'),
          amount: '100',
          beneficiary: a('b'),
          queuedAtBlock: '60',
          queuedAtBlockHash: h('c'),
          status: 'CONSUMED',
          consumedBatch: '1',
        },
      ],
      withdrawals: [],
      admissions: [],
      forcedTransactions: [],
      applications: [
        {
          applicationId: 'shop-1',
          kind: 'SHOP',
          contract: a('d'),
          status: 'OPEN',
          participantRoot: h('e'),
          participantCount: '2',
          participantCapacity: '128',
          metrics: { inventory: '9' },
        },
      ],
      batches: [
        {
          batchIndex: '1',
          startL2Block: '1',
          endL2Block: '2',
          preStateRoot: h('3'),
          postStateRoot: h('4'),
          batchDataHash: h('5'),
          canonicalDataHash: h('b'),
          approverRoot: h('6'),
          approverEpoch: '1',
          activeCount: '2',
          inboxCursor: '1',
          admissionCursor: '0',
          forcedCursor: '0',
          importCursor: '1',
          outboxEpoch: '1',
          withdrawalRoot: null,
          close: false,
          acceptedL1Block: '125',
          acceptedL1Transaction: h('7'),
          acceptedAt: '2026-07-23T12:00:00.000Z',
          blocks: [
            {
              blockNumber: '1',
              stateRoot: h('8'),
              transactionCommitment: h('9'),
              transactions: [
                {
                  index: 0,
                  hash: h('a'),
                  from: a('b'),
                  to: a('c'),
                  nonce: '0',
                  type: 'EIP1559',
                  status: 'SUCCEEDED',
                  gasUsed: '21000',
                  selector: '0x12345678',
                },
              ],
            },
            {
              blockNumber: '2',
              stateRoot: h('4'),
              transactionCommitment: h('d'),
              transactions: [],
            },
          ],
        },
      ],
    }
    store.put(room)
    registerObserverRoutes(app, store)
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('shows the latest accepted state without full machine identifiers', async () => {
    const response = await app.inject({ method: 'GET', url: '/rooms/7' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      roomId: '7',
      latestAcceptedBatch: '1',
      latestL2Block: '2',
      activeApprovers: '2',
      registeredParticipants: '2',
      dataAvailability: 'FULL_PUBLIC_BATCH',
      managedService: {
        status: 'USED',
        startBlock: '90',
        proofDeadlineBlock: '127',
        deadlineBlocksRemaining: '27',
        priceEpoch: '4',
      },
    })
    expect(response.body).not.toMatch(/0x[0-9a-f]{40,}/i)
  })

  it('returns the latest state, blocks, and transactions in one polling response', async () => {
    const response = await app.inject({ method: 'GET', url: '/rooms/7/latest' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      room: { latestAcceptedBatch: '1', latestL2Block: '2' },
      latestBatch: {
        batchIndex: '1',
        blocks: [
          {
            blockNumber: '1',
            transactions: [{ status: 'SUCCEEDED', gasUsed: '21000' }],
          },
          { blockNumber: '2', transactions: [] },
        ],
      },
    })
    expect(response.body).not.toMatch(/0x[0-9a-f]{40,}/i)
  })

  it('paginates blocks and filters transactions by room block', async () => {
    const blocks = await app.inject({
      method: 'GET',
      url: '/rooms/7/blocks?limit=1',
    })
    expect(blocks.json()).toMatchObject({ nextCursor: '1' })
    expect(blocks.json().items[0].blockNumber).toBe('1')

    const transactions = await app.inject({
      method: 'GET',
      url: '/rooms/7/transactions?block=1',
    })
    expect(transactions.json().items).toHaveLength(1)
    expect(transactions.json().items[0]).toMatchObject({
      blockNumber: '1',
      status: 'SUCCEEDED',
      gasUsed: '21000',
    })
    expect(transactions.body).not.toMatch(/0x[0-9a-f]{40,}/i)
  })

  it('requires an explicit machine endpoint for reproducibility identifiers', async () => {
    const response = await app.inject({ method: 'GET', url: '/rooms/7/machine' })
    expect(response.statusCode).toBe(200)
    expect(response.json().batches[0].acceptedL1Transaction).toBe(h('7'))
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('exposes approvers, imports, deposits and withdrawals as bounded public pages', async () => {
    for (const resource of [
      'approvers',
      'imports',
      'deposits',
      'withdrawals',
      'admissions',
      'forced-transactions',
      'applications',
    ]) {
      const response = await app.inject({
        method: 'GET',
        url: `/rooms/7/${resource}?limit=1`,
      })
      expect(response.statusCode).toBe(200)
      expect(response.body).not.toMatch(/0x[0-9a-f]{40,}/i)
      expect(response.json()).toHaveProperty('items')
    }
  })

  it('offers a one-shot event-stream snapshot for room observers', async () => {
    const response = await app.inject({ method: 'GET', url: '/rooms/7/stream?once=1' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')
    expect(response.body).toContain('event: room')
    expect(response.body).toContain('"registeredParticipants":"2"')
    expect(response.body).not.toMatch(/0x[0-9a-f]{40,}/i)
  })

  it('reports commitments-only when transaction data was not published', async () => {
    const room = store.get('7')!
    store.put({
      ...room,
      roomId: '8',
      batches: room.batches.map((batch) => ({ ...batch, blocks: [] })),
    })
    const response = await app.inject({ method: 'GET', url: '/rooms/8' })
    expect(response.json().dataAvailability).toBe('L1_COMMITMENTS_ONLY')
  })

  // Every observer route re-read, re-parsed and fully re-validated the archive
  // on each unauthenticated request, so cost grew with room age.
  it('reuses a validated archive until the file changes', () => {
    const first = store.get('7')!
    expect(store.get('7')).toBe(first)
    store.put({ ...first, latestObservedL1Block: '101' })
    const refreshed = store.get('7')!
    expect(refreshed).not.toBe(first)
    expect(refreshed.latestObservedL1Block).toBe('101')
    store.put({ ...refreshed, latestObservedL1Block: '100' })
  })

  it('meters unauthenticated observer reads per client', async () => {
    const metered = Fastify({ logger: false })
    registerObserverRoutes(metered, store, new RateLimiter(2, 0.001))
    await metered.ready()
    try {
      expect((await metered.inject({ method: 'GET', url: '/rooms/7' })).statusCode).toBe(200)
      expect((await metered.inject({ method: 'GET', url: '/rooms/7' })).statusCode).toBe(200)
      const limited = await metered.inject({ method: 'GET', url: '/rooms/7/machine' })
      expect(limited.statusCode).toBe(429)
      expect(limited.json().decision).toBe('RATE_LIMITED')
    } finally {
      await metered.close()
    }
  })

  // The admission path holds the whole document across two awaits, so a write
  // that lands in between must be refused rather than silently clobbered.
  it('refuses a compare-and-set write against a stale revision', () => {
    const seeded = store.get('7')!
    store.put({ ...seeded, roomId: '11' }, null)
    const observed = store.get('11')!
    expect(observed.revision).toBe('1')
    store.put({ ...observed, latestObservedL1Block: '105' }, observed.revision ?? null)
    expect(() =>
      store.put({ ...observed, latestObservedL1Block: '106' }, observed.revision ?? null),
    ).toThrow(ObserverRevisionConflictError)
    expect(store.get('11')?.latestObservedL1Block).toBe('105')
  })

  it('rejects gaps instead of publishing an invented history', () => {
    const room = store.get('7')!
    expect(() =>
      store.put({
        ...room,
        roomId: '9',
        batches: [{ ...room.batches[0]!, batchIndex: '2' }],
      }),
    ).toThrow(/contiguous/)
  })

  // A long-lived room's archive could never be trimmed or bootstrapped against
  // mid-life: contiguity was always validated from batch 1 / L2 block 1.
  it('validates contiguity from a declared retention floor', () => {
    const room = store.get('7')!
    const trimmed = {
      ...room,
      roomId: '12',
      batches: [
        {
          ...room.batches[0]!,
          batchIndex: '9',
          startL2Block: '41',
          endL2Block: '42',
          blocks: room.batches[0]!.blocks.map((block, index) => ({
            ...block,
            blockNumber: String(41 + index),
          })),
        },
      ],
    }
    // Without the floor the same document is unstorable.
    expect(() => store.put(trimmed)).toThrow(/contiguous/)
    store.put({ ...trimmed, archiveFloor: { batchIndex: '9', priorL2Block: '40' } })
    expect(store.get('12')?.batches[0]?.batchIndex).toBe('9')
    // The floor is not a licence to skip: the first batch must BE the floor.
    expect(() =>
      store.put({ ...trimmed, roomId: '13', archiveFloor: { batchIndex: '8', priorL2Block: '40' } }),
    ).toThrow(/declared archive floor/)
  })

  // An unbounded digit string reached readFileSync as a filename and surfaced
  // as a 500 carrying ENAMETOOLONG and the archive path.
  it('rejects an out-of-range room id as a caller fault, not a 500', async () => {
    // 80 digits clears Fastify's default maxParamLength of 100, so this is a
    // value that really did reach readFileSync as a filename.
    for (const id of ['9'.repeat(80), '18446744073709551616', '0', '007']) {
      const response = await app.inject({ method: 'GET', url: `/rooms/${id}` })
      expect(response.statusCode).toBe(400)
      expect(response.json().decision).toBe('INVALID_ROOM')
    }
  })

  // A saved `nextCursor` re-polled after a re-index silently returned page 1
  // with a forward-pointing cursor - an infinite re-read that looks like data.
  it('reports a stale pagination cursor instead of silently restarting', async () => {
    const beyond = await app.inject({ method: 'GET', url: '/rooms/7/approvers?cursor=99' })
    expect(beyond.statusCode).toBe(400)
    expect(beyond.json().decision).toBe('INVALID_CURSOR')
    expect((await app.inject({ method: 'GET', url: '/rooms/7/blocks?cursor=x' })).statusCode).toBe(
      400,
    )
    // A cursor exactly at the end is still a valid empty page.
    const end = await app.inject({ method: 'GET', url: '/rooms/7/approvers?cursor=2' })
    expect(end.statusCode).toBe(200)
    expect(end.json()).toMatchObject({ items: [], nextCursor: null })
  })

  // Hijacked replies skip onSend and the CORS plugin, so the stream shipped
  // none of the headers every other response carries.
  it('carries the CORS and COOP headers onto the hijacked stream response', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/rooms/7/stream?once=1',
      headers: { origin: 'http://localhost:3001' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin')
    expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin')
  })

  // A bare EventEmitter with the default 10-listener ceiling and no connection
  // accounting meant every subscriber past the tenth emitted a warning and
  // nothing bounded the fan-out at all.
  it('bounds the number of concurrent stream subscribers per room', async () => {
    const seeded = store.get('7')!
    store.put({ ...seeded, roomId: '15' })
    const detachers = Array.from({ length: MAX_STREAM_SUBSCRIBERS_PER_ROOM }, () =>
      store.subscribe('15', () => {}),
    )
    try {
      expect(store.subscriberCount('15')).toBe(MAX_STREAM_SUBSCRIBERS_PER_ROOM)
      const refused = await app.inject({ method: 'GET', url: '/rooms/15/stream' })
      expect(refused.statusCode).toBe(503)
      expect(refused.json().decision).toBe('STREAM_SATURATED')
    } finally {
      for (const detach of detachers) detach()
    }
    // Freeing a slot restores service.
    expect(store.subscriberCount('15')).toBe(0)
    const allowed = await app.inject({ method: 'GET', url: '/rooms/15/stream?once=1' })
    expect(allowed.statusCode).toBe(200)
  })

  // A listener that threw propagated out of put() AFTER the durable rename, so
  // the caller saw a failure for a write that had actually landed.
  it('does not fail a durable write because a subscriber threw', () => {
    const seeded = store.get('7')!
    store.put({ ...seeded, roomId: '14' })
    const detach = store.subscribe('14', () => {
      throw new Error('subscriber exploded')
    })
    try {
      expect(() => store.put({ ...store.get('14')!, latestObservedL1Block: '111' })).not.toThrow()
      expect(store.get('14')?.latestObservedL1Block).toBe('111')
    } finally {
      detach()
    }
  })
})
