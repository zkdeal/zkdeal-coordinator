/**
 * The Prometheus surfaces: the coordinator's open `GET /metrics` (uptime
 * always, demo gauges only when a demo controller is mounted), the queue's
 * open `GET /queue/v1/metrics`, and the demo stream's 500 ms batching on a
 * live socket. Every assertion is about numbers and labels - the expositions
 * must never carry request, witness or payload bytes.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type AppContext } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { DemoController, registerDemoRoutes } from '../src/demo-control.js'
import {
  METRICS_CONTENT_TYPE,
  escapeLabelValue,
  gauge,
  registerMetricsRoute,
  renderMetrics,
  trackDeadlineRiskJob,
} from '../src/metrics.js'
import { registerProveQueueRoutes } from '../src/prove-queue/queue-routes.js'
import { ProveQueueStore } from '../src/prove-queue/queue-store.js'
import { createSseBatchCounters } from '../src/sse-batcher.js'
import { FakeRuntime } from './helpers/demo-fake-runtime.js'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function dataDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  created.push(path)
  return path
}

describe('the exposition helpers', () => {
  it('escapes backslash, quote and newline in label values', () => {
    expect(escapeLabelValue('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd')
  })

  it('renders a TYPE line and labeled samples', () => {
    expect(renderMetrics([gauge('x_total', [{ labels: { a: 'v' }, value: 2 }])])).toBe(
      '# TYPE x_total gauge\nx_total{a="v"} 2\n',
    )
  })
})

describe('GET /metrics on a coordinator without a demo', () => {
  let ctx: AppContext
  let dir: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'zkdeal-metrics-app-'))
    const config = loadConfig({
      dataDir: dir,
      port: 0,
      roomManager: '0x0000000000000000000000000000000000000000',
      faucetKey: null,
      faucetEnabled: false,
      webRoot: join(dir, 'no-web'),
    })
    ctx = await createApp({ config, enableRelay: false, logger: false })
  })

  afterAll(async () => {
    await ctx.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('serves process uptime openly with the Prometheus content type', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(200)
    expect(String(res.headers['content-type'])).toContain('text/plain; version=0.0.4')
    expect(res.body).toContain('# TYPE zkdeal_process_uptime_seconds gauge')
    expect(res.body).toMatch(/zkdeal_process_uptime_seconds \d/)
    // No demo controller: no demo gauges and no stream counters.
    expect(res.body).not.toContain('zkdeal_demo_')
    expect(res.body).not.toContain('zkdeal_sse_')
  })

  it('answers 404 to POST', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/metrics', payload: {} })
    expect(res.statusCode).toBe(404)
  })
})

describe('the deadline-risk gauge', () => {
  it('always publishes every bounded service class and releases idempotently', async () => {
    const app = Fastify({ logger: false })
    registerMetricsRoute(app, { demo: null })
    const before = await app.inject({ method: 'GET', url: '/metrics' })
    expect(before.body).toContain('# TYPE zkdeal_deadline_risk_jobs gauge')
    expect(before.body).toContain('zkdeal_deadline_risk_jobs{service_class="standard"} 0')
    expect(before.body).toContain('zkdeal_deadline_risk_jobs{service_class="latency"} 0')
    expect(before.body).toContain('zkdeal_deadline_risk_jobs{service_class="batch"} 0')

    const releaseFirst = trackDeadlineRiskJob('standard')
    const releaseSecond = trackDeadlineRiskJob('standard')
    const during = await app.inject({ method: 'GET', url: '/metrics' })
    expect(during.body).toContain('zkdeal_deadline_risk_jobs{service_class="standard"} 2')

    releaseFirst()
    releaseFirst() // a second release of the same job must not underflow
    const partial = await app.inject({ method: 'GET', url: '/metrics' })
    expect(partial.body).toContain('zkdeal_deadline_risk_jobs{service_class="standard"} 1')

    releaseSecond()
    const after = await app.inject({ method: 'GET', url: '/metrics' })
    await app.close()
    expect(after.body).toContain('zkdeal_deadline_risk_jobs{service_class="standard"} 0')
  })
})

describe('GET /metrics with a demo controller', () => {
  it('publishes folded gauges, checkpoint outcomes and the proof summary', async () => {
    const controller = new DemoController(await dataDir('zkdeal-metrics-demo-'), new FakeRuntime())
    await controller.initialize()
    const made = await controller.createTemplate(
      { name: 'Metrics shop', presetId: 'shop' },
      'metrics-template-1',
    )
    await controller.drain()
    const room = await controller.createRoom(
      { name: 'Metrics room', templateId: made.template.id, deadlineBlocksFromStart: 74 },
      'metrics-room-1',
    )
    await controller.deployRoom(room.id, 'metrics-deploy-1')
    await controller.drain()
    await controller.addAction(
      room.id,
      { actionId: 'register-session', actorId: 'buyer' },
      'metrics-action-1',
    )
    await controller.addAction(
      room.id,
      { actionId: 'buy-item', actorId: 'buyer' },
      'metrics-action-2',
    )
    await controller.checkpointRoom(room.id, 'metrics-checkpoint-1')
    await controller.drain()

    const app = Fastify({ logger: false })
    const counters = createSseBatchCounters()
    registerDemoRoutes(app, controller, { sseCounters: counters })
    registerMetricsRoute(app, { demo: controller, sse: counters })
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    await app.close()

    expect(res.statusCode).toBe(200)
    expect(String(res.headers['content-type'])).toBe(METRICS_CONTENT_TYPE)
    const body = res.body
    expect(body).toContain('zkdeal_demo_templates 1')
    expect(body).toContain('zkdeal_demo_rooms{phase="L1_FINALIZED"} 1')
    // Three finished jobs: prepare, deploy, checkpoint.
    expect(body).toContain('zkdeal_demo_jobs{state="running"} 0')
    expect(body).toContain('zkdeal_demo_jobs{state="finished"} 3')
    expect(body).toContain('zkdeal_demo_jobs{state="failed"} 0')
    expect(body).toContain('zkdeal_proving_slot_active 0')
    expect(body).toContain('zkdeal_proving_slot_waiting 0')
    expect(body).toContain('zkdeal_demo_checkpoints_total{outcome="accepted"} 1')
    expect(body).toContain('zkdeal_demo_checkpoints_total{outcome="failed"} 0')
    expect(body).toContain('zkdeal_sse_subscribers 0')
    // Two provable jobs held the slot: the cold template and the checkpoint.
    expect(body).toContain('zkdeal_demo_proof_seconds_count 2')
    expect(body).toMatch(/zkdeal_demo_proof_seconds_sum \d/)
    const emitted = Number(/zkdeal_demo_events_emitted_total (\d+)/.exec(body)?.[1])
    expect(emitted).toBeGreaterThan(0)
    // Nobody streamed, so the batcher never flushed.
    expect(body).toContain('zkdeal_sse_batches_flushed_total 0')
    expect(body).toContain('zkdeal_sse_events_batched_total 0')
    expect(body).toContain('zkdeal_sse_events_dropped_total 0')
  })

  it(
    'batches the demo stream into array frames on a live socket',
    { timeout: 15_000 },
    async () => {
      const controller = new DemoController(await dataDir('zkdeal-metrics-sse-'), new FakeRuntime())
      await controller.initialize()
      const counters = createSseBatchCounters()
      const app = Fastify({ logger: false })
      registerDemoRoutes(app, controller, { sseCounters: counters })
      await app.listen({ port: 0, host: '127.0.0.1' })
      const address = app.server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const abort = new AbortController()
      const response = await fetch(`http://127.0.0.1:${port}/demo/v1/stream`, {
        signal: abort.signal,
      })
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      const chunks: string[] = []
      const pump = (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(decoder.decode(value, { stream: true }))
          }
        } catch {
          /* the abort below ends the stream */
        }
      })()

      await controller.createTemplate({ name: 'Stream shop', presetId: 'shop' }, 'metrics-stream-1')
      await controller.drain()
      expect(controller.subscriberCount()).toBe(1)
      // The first event scheduled one flush 500 ms later; give it slack.
      await new Promise((resolve) => setTimeout(resolve, 900))
      abort.abort()
      await pump
      await app.close()

      const text = chunks.join('')
      expect(text).toContain('event: ready\ndata: ')
      const updates = text.split('\n\n').filter((frame) => frame.startsWith('event: update'))
      expect(updates.length).toBeGreaterThanOrEqual(1)
      const batches = updates.map(
        (frame) =>
          JSON.parse(frame.slice('event: update\ndata: '.length)) as {
            events: unknown[]
            dropped?: number
          },
      )
      const total = batches.reduce((sum, batch) => sum + batch.events.length, 0)
      // Five controller events (four phases + the finished job) landed in
      // FEWER frames than events - the per-event regression writes no arrays.
      expect(total).toBeGreaterThanOrEqual(5)
      expect(updates.length).toBeLessThan(total)
      for (const batch of batches) expect(batch.dropped).toBeUndefined()
      expect(counters.batchesFlushed).toBe(updates.length)
      expect(counters.eventsBatched).toBe(total)
      expect(counters.eventsDropped).toBe(0)
    },
  )
})

describe('GET /queue/v1/metrics', () => {
  const PROVE = '/v5/rooms/prove'
  const tokens = {
    submitToken: 'submit-token-0123456789',
    nodeToken: 'node-token-0123456789',
  }

  it('is open, counts waiting jobs, and leaks no payload bytes', async () => {
    const store = new ProveQueueStore(await dataDir('zkdeal-metrics-queue-'))
    const app = Fastify({ logger: false })
    registerProveQueueRoutes(app, { store, ...tokens })
    store.submit('pj-0000000001', PROVE, { witness: 'SECRET-WITNESS-BYTES' }, 'alice')

    // Deliberately no bearer: metrics stand open the way /queue/v1/status does.
    const res = await app.inject({ method: 'GET', url: '/queue/v1/metrics' })
    await app.close()
    expect(res.statusCode).toBe(200)
    expect(String(res.headers['content-type'])).toBe(METRICS_CONTENT_TYPE)
    expect(res.body).toContain('zkdeal_queue_jobs_active 0')
    expect(res.body).toContain('zkdeal_queue_jobs_waiting 1')
    expect(res.body).toContain('zkdeal_queue_leases_expired_total 0')
    expect(res.body).toContain('zkdeal_queue_jobs_pruned_total 0')
    expect(res.body).toMatch(/zkdeal_queue_oldest_waiting_age_seconds \d/)
    expect(res.body).not.toContain('SECRET-WITNESS-BYTES')
  })

  it('labels nodes and counts expired leases across a sweep', async () => {
    let nowMs = 0
    const store = new ProveQueueStore(await dataDir('zkdeal-metrics-queue-'), {
      leaseTtlMs: 1_000,
      now: () => nowMs,
    })
    const app = Fastify({ logger: false })
    registerProveQueueRoutes(app, { store, ...tokens })
    store.submit('pj-0000000001', PROVE, { witness: 'w' }, 'alice')
    store.lease('node-a', {})

    const leased = await app.inject({ method: 'GET', url: '/queue/v1/metrics' })
    expect(leased.body).toContain('zkdeal_queue_jobs_active 1')
    expect(leased.body).toContain('zkdeal_queue_node_jobs_done{node="node-a"} 0')
    expect(leased.body).toMatch(/zkdeal_queue_node_last_lease_age_seconds\{node="node-a"\} \d/)

    // The lease dies on the store's clock; the next scrape counts it.
    nowMs = 5_000
    const swept = await app.inject({ method: 'GET', url: '/queue/v1/metrics' })
    await app.close()
    expect(swept.body).toContain('zkdeal_queue_leases_expired_total 1')
    expect(swept.body).toContain('zkdeal_queue_jobs_active 0')
    expect(swept.body).toContain('zkdeal_queue_jobs_waiting 1')
  })
})
