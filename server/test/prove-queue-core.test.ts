/**
 * The prove-queue state machine and its disk mirror.
 *
 * These tests are about the properties that matter: FIFO with honest,
 * never-growing positions; one GPU lease per node while CPU jobs stay
 * co-leasable; a dead node's job surviving it; a condemned job answering its
 * submitter instead of looping forever; and a restart changing nothing an
 * agent or submitter can observe.
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProveQueueCore } from '../src/prove-queue/queue-core.js'
import { ProveQueueStore } from '../src/prove-queue/queue-store.js'
import { ProveQueueRejection } from '../src/prove-queue/queue-types.js'

/** Valid `pj-` ids without randomness, so failures read deterministically. */
const id = (n: number): string => `pj-${String(n).padStart(10, '0')}`

const PROVE = '/v5/rooms/prove' // needsGpu
const VERIFY = '/v5/rooms/verify' // CPU-only

describe('the prove-queue state machine', () => {
  it('serves jobs FIFO and reports never-growing positions', () => {
    const core = new ProveQueueCore()
    for (let n = 1; n <= 3; n += 1) core.submit(id(n), PROVE, 'alice', n)
    expect(core.position(id(1))).toBe(1)
    expect(core.position(id(3))).toBe(3)

    const leased = core.lease('node-a', {}, 10)
    expect(leased?.id).toBe(id(1))
    expect(core.position(id(1))).toBe(0) // 0 = running
    expect(core.position(id(2))).toBe(1)
    expect(core.position(id(3))).toBe(2)
  })

  it('requeues an expired lease at the BACK so waiting positions never grow', () => {
    const core = new ProveQueueCore({ leaseTtlMs: 100 })
    core.submit(id(1), PROVE, 'alice', 0)
    core.submit(id(2), PROVE, 'bob', 1)
    core.lease('node-a', {}, 2)
    expect(core.position(id(2))).toBe(1)
    const expired = core.expireLeases(200)
    expect(expired.map((job) => job.id)).toEqual([id(1)])
    // Job 2 keeps its place; the returned job goes behind it.
    expect(core.position(id(2))).toBe(1)
    expect(core.position(id(1))).toBe(2)
    expect(core.job(id(1))?.status).toBe('QUEUED')
    expect(core.job(id(1))?.failure?.reason).toMatch(/lease held by node-a expired/)
  })

  it('refuses a second GPU lease to a node but co-leases CPU jobs to it', () => {
    const core = new ProveQueueCore()
    core.submit(id(1), PROVE, 'alice', 0)
    core.submit(id(2), PROVE, 'alice', 1)
    core.submit(id(3), VERIFY, 'alice', 2)
    expect(core.lease('node-a', {}, 3)?.id).toBe(id(1))
    // The next GPU job is skipped for node-a: its prover runs one proof at a
    // time, so a second GPU lease would only die on the clock.
    expect(core.lease('node-a', {}, 4)?.id).toBe(id(3))
    expect(core.lease('node-a', {}, 5)).toBeNull()
    // Another node takes the second GPU job immediately.
    expect(core.lease('node-b', {}, 6)?.id).toBe(id(2))
  })

  it('never hands a GPU job to a worker that declared itself CPU-only', () => {
    const core = new ProveQueueCore()
    core.submit(id(1), PROVE, 'alice', 0)
    core.submit(id(2), VERIFY, 'alice', 1)
    expect(core.lease('cpu-node', { gpu: false }, 2)?.id).toBe(id(2))
    expect(core.lease('cpu-node', { gpu: false }, 3)).toBeNull()
  })

  it('extends a lease on heartbeat', () => {
    const core = new ProveQueueCore({ leaseTtlMs: 100 })
    core.submit(id(1), PROVE, 'alice', 0)
    core.lease('node-a', {}, 0)
    core.heartbeat(id(1), 'node-a', 90)
    expect(core.expireLeases(150)).toEqual([])
    expect(core.expireLeases(200)).toHaveLength(1)
  })

  it('condemns a job once its attempts are spent', () => {
    const core = new ProveQueueCore({ leaseTtlMs: 100, maxAttempts: 2 })
    core.submit(id(1), PROVE, 'alice', 0)
    core.lease('node-a', {}, 0)
    core.expireLeases(200) // attempt 1 dies -> requeued
    expect(core.job(id(1))?.status).toBe('QUEUED')
    core.lease('node-b', {}, 300)
    core.fail(id(1), 'node-b', 'CUDA fell over', true, 400) // attempt 2 dies
    const job = core.job(id(1))!
    expect(job.status).toBe('FAILED')
    expect(job.attempts).toBe(2)
    expect(job.failure).toEqual({ reason: 'CUDA fell over', retryable: true })
  })

  it('fails a job immediately on a non-retryable report', () => {
    const core = new ProveQueueCore()
    core.submit(id(1), PROVE, 'alice', 0)
    core.lease('node-a', {}, 0)
    core.fail(id(1), 'node-a', 'the witness is malformed', false, 1)
    expect(core.job(id(1))?.status).toBe('FAILED')
    expect(core.job(id(1))?.failure?.retryable).toBe(false)
  })

  it('accepts complete only from the lease holder, idempotently', () => {
    const core = new ProveQueueCore()
    core.submit(id(1), PROVE, 'alice', 0)
    core.lease('node-a', {}, 0)
    expect(() => core.complete(id(1), 'node-b', 1)).toThrow(ProveQueueRejection)
    expect(core.complete(id(1), 'node-a', 2)).toMatchObject({ already: false })
    expect(core.complete(id(1), 'node-a', 3)).toMatchObject({ already: true })
    // A stranger stays refused even after DONE.
    expect(() => core.complete(id(1), 'node-b', 4)).toThrow(/not leased to node-b/)
  })

  it('refuses a complete from a node whose lease expired and moved on', () => {
    const core = new ProveQueueCore({ leaseTtlMs: 100 })
    core.submit(id(1), PROVE, 'alice', 0)
    core.lease('node-a', {}, 0)
    core.expireLeases(200)
    core.lease('node-b', {}, 300)
    // node-a wakes up with a result for a lease it no longer holds.
    expect(() => core.complete(id(1), 'node-a', 400)).toThrow(ProveQueueRejection)
    expect(core.complete(id(1), 'node-b', 500).job.status).toBe('DONE')
  })

  it('refuses an endpoint outside the prover whitelist', () => {
    const core = new ProveQueueCore()
    expect(() => core.submit(id(1), '/v5/rooms/../secrets', 'mallory', 0)).toThrow(
      /not a proveable endpoint/,
    )
    expect(() => core.submit(id(2), '/healthz', 'mallory', 0)).toThrow(ProveQueueRejection)
  })

  it('counts node work in the observable status', () => {
    const core = new ProveQueueCore()
    core.submit(id(1), PROVE, 'alice', 0)
    core.submit(id(2), PROVE, 'bob', 1)
    core.lease('node-a', {}, 2)
    core.complete(id(1), 'node-a', 3)
    const status = core.status()
    expect(status.active).toEqual([])
    expect(status.waiting.map((entry) => entry.id)).toEqual([id(2)])
    expect(status.waiting[0]?.position).toBe(1)
    expect(status.nodes).toMatchObject([{ nodeId: 'node-a', jobsDone: 1 }])
  })

  it('uses deadline latest-start slack, not a fixed near-deadline window', () => {
    const core = new ProveQueueCore()
    core.submit(id(1), PROVE, 'ordinary', 0)
    core.submit(id(2), PROVE, 'urgent', 1, {
      deadlineAtMs: 100_000,
      deadlineTrusted: true,
      estimatedProofTimeMs: 60_000,
      settlementMarginMs: 50_000,
    })
    // Deadline is still 100 seconds away, but its measured work plus
    // inclusion margin means its latest safe start already passed.
    expect(core.lease('node-a', {}, 2)?.id).toBe(id(2))
  })

  it('fences reserved and dedicated partitions to entitled workers', () => {
    const core = new ProveQueueCore()
    core.submit(id(1), PROVE, 'tenant-a', 0, {
      partition: 'reserved',
      allocationId: 'allocation-a',
    })
    core.submit(id(2), PROVE, 'tenant-b', 1, { partition: 'shared' })
    expect(core.lease('shared-node', {}, 2)?.id).toBe(id(2))
    expect(core.lease('wrong-reservation', {
      partitions: ['reserved'],
      allocationIds: ['allocation-b'],
      tenantIds: ['tenant-a'],
    }, 3)).toBeNull()
    expect(core.lease('right-reservation', {
      partitions: ['reserved'],
      allocationIds: ['allocation-a'],
      tenantIds: ['tenant-a'],
    }, 4)?.id).toBe(id(1))

    core.submit(id(3), VERIFY, 'tenant-c', 5, { partition: 'dedicated' })
    expect(core.lease('wrong-tenant', { partitions: ['dedicated'], tenantIds: ['tenant-d'] }, 6))
      .toBeNull()
    expect(core.lease('right-tenant', { partitions: ['dedicated'], tenantIds: ['tenant-c'] }, 7)?.id)
      .toBe(id(3))
  })

  it('charges weighted service by estimated work and ages a starved tenant back into service', () => {
    const core = new ProveQueueCore({ agingIntervalMs: 100 })
    core.submit(id(1), VERIFY, 'tenant-a', 0, { estimatedWork: 100 })
    core.lease('cpu', { gpu: false }, 0)
    core.complete(id(1), 'cpu', 1)
    core.submit(id(2), VERIFY, 'tenant-a', 2, { estimatedWork: 1 })
    core.submit(id(3), VERIFY, 'tenant-b', 3, { estimatedWork: 1 })
    expect(core.lease('cpu', { gpu: false }, 4)?.id).toBe(id(3))
    core.complete(id(3), 'cpu', 5)
    core.submit(id(4), VERIFY, 'tenant-b', 9_999, { estimatedWork: 1 })
    // tenant-a's 100 units of prior service normally put it behind tenant-b;
    // one hundred aging intervals erase that debt and prevent starvation.
    expect(core.lease('cpu', { gpu: false }, 10_002)?.id).toBe(id(2))
    expect(core.status(10_002).waiting[0]).toMatchObject({
      serviceClass: 'standard',
      partition: 'shared',
      sponsorshipId: null,
      correlationId: null,
    })
  })

  it('persists sponsorship, service class, correlation and scheduling estimates', () => {
    const core = new ProveQueueCore()
    const job = core.submit(id(1), PROVE, 'tenant-a', 0, {
      sponsorshipId: 'sponsor-7',
      serviceClass: 'latency',
      correlationId: 'trace-123',
      estimatedWork: 3.5,
      estimatedProofTimeMs: 30_000,
      settlementMarginMs: 12_000,
      deadlineAtMs: 100_000,
    })
    expect(job).toMatchObject({
      sponsorshipId: 'sponsor-7',
      serviceClass: 'latency',
      correlationId: 'trace-123',
      estimatedWork: 3.5,
      latestStartAt: new Date(58_000).toISOString(),
      agingStartedAt: new Date(0).toISOString(),
    })
    const restored = new ProveQueueCore()
    restored.restore([job], [])
    expect(restored.job(id(1))).toMatchObject({
      sponsorshipId: 'sponsor-7',
      serviceClass: 'latency',
      correlationId: 'trace-123',
      estimatedWork: 3.5,
    })
  })
})

describe('the prove-queue store', () => {
  const dirs: string[] = []
  const makeDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'prove-queue-'))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('recovers a restart: a lease that died with the process is requeued', () => {
    const dir = makeDir()
    let nowMs = 0
    const clock = () => nowMs
    const first = new ProveQueueStore(dir, { leaseTtlMs: 1_000, now: clock })
    first.submit(id(1), PROVE, { witness: 'w' }, 'alice')
    first.lease('node-a', {})
    // The process dies; the lease clock keeps running.
    nowMs = 5_000
    const second = new ProveQueueStore(dir, { leaseTtlMs: 1_000, now: clock })
    const found = second.job(id(1))!
    expect(found.job.status).toBe('QUEUED')
    expect(found.job.attempts).toBe(1)
    // The requeued request body survived on disk verbatim.
    expect(second.lease('node-b', {})?.request).toEqual({ witness: 'w' })
  })

  it('keeps a still-live lease across a restart so the agent never notices', () => {
    const dir = makeDir()
    let nowMs = 0
    const clock = () => nowMs
    const first = new ProveQueueStore(dir, { leaseTtlMs: 60_000, now: clock })
    first.submit(id(1), PROVE, {}, 'alice')
    first.lease('node-a', {})
    nowMs = 1_000
    const second = new ProveQueueStore(dir, { leaseTtlMs: 60_000, now: clock })
    expect(second.job(id(1))?.job.status).toBe('LEASED')
    expect(second.complete(id(1), 'node-a', { proofMode: 'groth16' }).job.status).toBe('DONE')
  })

  it('serves the verbatim result only once DONE, across a restart', () => {
    const dir = makeDir()
    let nowMs = 0
    const clock = () => nowMs
    const store = new ProveQueueStore(dir, { now: clock })
    store.submit(id(1), PROVE, { in: true }, 'alice')
    expect(store.result(id(1))).toBeNull()
    store.lease('node-a', {})
    expect(store.result(id(1))).toBeNull()
    store.complete(id(1), 'node-a', { proofMode: 'groth16', sealed: true })
    expect(store.result(id(1))).toEqual({ proofMode: 'groth16', sealed: true })
    const reopened = new ProveQueueStore(dir, { now: clock })
    expect(reopened.result(id(1))).toEqual({ proofMode: 'groth16', sealed: true })
  })

  it('forgets finished jobs and their files after the result TTL', () => {
    const dir = makeDir()
    let nowMs = 0
    const clock = () => nowMs
    const store = new ProveQueueStore(dir, { resultTtlMs: 2 * 60 * 60_000, now: clock })
    store.submit(id(1), PROVE, {}, 'alice')
    store.lease('node-a', {})
    store.complete(id(1), 'node-a', { ok: true })
    const resultPath = join(dir, 'jobs', `${id(1)}.result.json`)
    expect(existsSync(resultPath)).toBe(true)
    nowMs = 60 * 60_000 // one hour: still fetchable
    store.sweep()
    expect(store.result(id(1))).toEqual({ ok: true })
    nowMs = 3 * 60 * 60_000 // three hours: gone, files included
    store.sweep()
    expect(store.job(id(1))).toBeNull()
    expect(existsSync(resultPath)).toBe(false)
    expect(existsSync(join(dir, 'jobs', `${id(1)}.request.json`))).toBe(false)
  })

  it('refuses a path-shaped job id before it can touch the filesystem', () => {
    const store = new ProveQueueStore(makeDir())
    expect(() => store.submit('../../etc/passwd', PROVE, {}, 'mallory')).toThrow(
      /invalid prove-queue job id/,
    )
  })
})
