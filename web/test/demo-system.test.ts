import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEMO_L1_BLOCK_SECONDS_FALLBACK,
  deadlineBlocksForSeconds,
  deadlineSecondsForBlocks,
  EMPTY_DEMO_SYSTEM,
  readDemoSystemPayload,
  readDemoSystem,
} from '../lib/demo-system'
import { readCardCoordinator } from '../lib/card/demo-room'
import { l1Receipt } from '../lib/l1-receipt'

/**
 * Where the block explorer comes from, and why it is never a constant.
 *
 * The same build runs against a laptop stand and against the RTX 4090 box. A
 * host baked into the bundle would produce links that are confidently wrong on
 * every stand but one - and a confidently wrong link to a block explorer is
 * indistinguishable from a fabricated receipt. So the root is read from
 * `/demo/v1/system`, and when that endpoint offers none, the UI says so instead
 * of guessing.
 *
 * This suite also pins the GPU-queue reading, because that is what the two
 * self-driving application demos wait on: one CUDA worker, proofs serialize.
 */

const HASH = '0x07fe97e390d52372ff7d59750b477fb9179f38756cfc93bc417ad34f81fec66b'

/** The live stand's own `/demo/v1/system` body, trimmed to what is read. */
const LIVE = {
  decision: 'READY',
  explorerUrl: 'http://192.168.0.11:3200',
  deploymentDomain: '0x19e48eca7612a042b369bec73a1193e72e6039c3006019269ad93e214ad9ceaa',
  gpu: {
    name: 'NVIDIA B200',
    recommendedProofSeconds: 25,
    recommendedDeadlineBlocks: 4,
  },
  checkpointPolicy: { l1BlockSeconds: 12, defaultDeadlineBlocks: 7, wallClockSeconds: 49.23 },
  provingQueue: { active: null, waiting: [] },
}

function stubFetch(body: unknown, ok = true) {
  const fetchStub = vi.fn(async (input: unknown, _init?: unknown) => {
    void input
    return new Response(JSON.stringify(body), {
      status: ok ? 200 : 503,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchStub)
  return fetchStub
}

afterEach(() => vi.unstubAllGlobals())

describe('the explorer base comes from /demo/v1/system', () => {
  it('is whatever that endpoint published, and reaches the link builder unchanged', async () => {
    const fetchStub = stubFetch(LIVE)
    const system = await readDemoSystem()

    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(String(fetchStub.mock.calls[0]![0])).toContain('/demo/v1/system')
    expect(system.explorerUrl).toBe('http://192.168.0.11:3200/')

    // The one consumer that matters: a hash becomes a link under THAT root.
    expect(l1Receipt({ hash: HASH }, system.explorerUrl).url).toBe(
      `http://192.168.0.11:3200/tx/${HASH}`,
    )
  })

  it('follows the coordinator to a different host without a code change', async () => {
    stubFetch({ ...LIVE, explorerUrl: 'https://scan.internal.example/' })
    const system = await readDemoSystem()
    expect(l1Receipt({ hash: HASH }, system.explorerUrl).url).toBe(
      `https://scan.internal.example/tx/${HASH}`,
    )
  })

  it('yields no explorer at all when the coordinator advertises none', async () => {
    stubFetch({ ...LIVE, explorerUrl: null })
    const system = await readDemoSystem()
    expect(system.explorerUrl).toBeNull()
    const receipt = l1Receipt({ hash: HASH }, system.explorerUrl)
    expect(receipt.url).toBeNull()
    expect(receipt.note).toMatch(/no block explorer/i)
  })

  it('drops a published root that is not an http(s) URL', () => {
    expect(readDemoSystemPayload({ explorerUrl: 'javascript:alert(1)' }).explorerUrl).toBeNull()
    expect(readDemoSystemPayload({ explorerUrl: 'not a url' }).explorerUrl).toBeNull()
  })

  it('never throws, and reports nothing rather than something invented', async () => {
    stubFetch({ error: 'unavailable' }, false)
    await expect(readDemoSystem()).resolves.toEqual(EMPTY_DEMO_SYSTEM)
    expect(EMPTY_DEMO_SYSTEM.explorerUrl).toBeNull()
  })

  it('is the same reading the card duel uses, so both pages link to one place', async () => {
    stubFetch(LIVE)
    const coordinator = await readCardCoordinator()
    expect(coordinator.explorerUrl).toBe('http://192.168.0.11:3200/')
    expect(coordinator.deploymentDomain).toBe(LIVE.deploymentDomain)
    expect(coordinator.gpuName).toBe('NVIDIA B200')
    expect(coordinator.proofSeconds).toBe(25)
    expect(coordinator.l1BlockSeconds).toBe(12)
  })
})

describe('the single GPU', () => {
  it('reads busy from the coordinator queue, active or merely waiting', () => {
    expect(readDemoSystemPayload(LIVE).proverBusy).toBe(false)
    const active = readDemoSystemPayload({
      ...LIVE,
      provingQueue: { active: { roomId: 'room-1' }, waiting: [] },
    })
    expect(active.proverBusy).toBe(true)
    expect(active.proverQueueDepth).toBe(1)
    const queued = readDemoSystemPayload({
      ...LIVE,
      provingQueue: { active: { roomId: 'room-1' }, waiting: [{}, {}] },
    })
    expect(queued.proverBusy).toBe(true)
    expect(queued.proverQueueDepth).toBe(3)
  })
})

describe('a proving deadline in the unit a presenter thinks in', () => {
  it('converts seconds to blocks with the stand’s own block time', () => {
    // The duel's shipped default: two minutes of allowance for a job that needs
    // about fifty seconds on an idle prover.
    expect(deadlineBlocksForSeconds(120, 12)).toBe(10)
    expect(deadlineSecondsForBlocks(10, 12)).toBe(120)
    // A stand with faster blocks needs more of them for the same wall clock.
    expect(deadlineBlocksForSeconds(120, 2)).toBe(60)
    // And it never returns something the coordinator would refuse.
    expect(deadlineBlocksForSeconds(1, 12)).toBe(2)
    expect(deadlineBlocksForSeconds(10_000_000, 12)).toBe(7_200)
  })

  it('falls back to the reference block time only when none is published', () => {
    expect(readDemoSystemPayload({}).l1BlockSeconds).toBe(DEMO_L1_BLOCK_SECONDS_FALLBACK)
    expect(readDemoSystemPayload(LIVE).l1BlockSeconds).toBe(12)
    expect(readDemoSystemPayload(LIVE).defaultDeadlineBlocks).toBe(7)
  })
})
