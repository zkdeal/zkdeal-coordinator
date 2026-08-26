/**
 * The prove queue as its own process: compose and Kurtosis run this next to
 * the coordinator (which mounts the same plugin behind QUEUE_ENABLED=1).
 * Env: QUEUE_PORT (3005), QUEUE_HOST (loopback), DATA_DIR, both queue tokens,
 * and QUEUE_LEASE_TTL_MS / QUEUE_MAX_ATTEMPTS for tests that cannot wait.
 */
import { resolve } from 'node:path'
import Fastify from 'fastify'
import { METRICS_CONTENT_TYPE } from '../metrics.js'
import { registerProveQueueRoutes, renderProveQueueMetrics } from './queue-routes.js'
import { ProveQueueStore } from './queue-store.js'

function positive(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`)
  return value
}

async function main(): Promise<void> {
  const port = positive('QUEUE_PORT') ?? 3005
  const host = process.env.QUEUE_HOST?.trim() || '127.0.0.1'
  const dataDir = resolve(process.env.DATA_DIR?.trim() || 'data')
  const store = new ProveQueueStore(resolve(dataDir, 'prove-queue'), {
    leaseTtlMs: positive('QUEUE_LEASE_TTL_MS'),
    maxAttempts: positive('QUEUE_MAX_ATTEMPTS'),
  })
  const app = Fastify({ logger: true })
  // Fails closed inside the plugin when either token is missing or trivial.
  registerProveQueueRoutes(app, {
    store,
    submitToken: process.env.ZKDEAL_QUEUE_SUBMIT_TOKEN ?? '',
    nodeToken: process.env.ZKDEAL_QUEUE_NODE_TOKEN ?? '',
  })
  app.get('/health', async () => ({ status: 'ok' }))
  // Root alias of GET /queue/v1/metrics: the Kurtosis scrape target is
  // prove-queue:3005/metrics. Same open standing, same numbers-only output.
  app.get('/metrics', async (_request, reply) => {
    reply.header('content-type', METRICS_CONTENT_TYPE)
    return renderProveQueueMetrics(store)
  })
  await app.listen({ port, host })
}

main().catch((error) => {
  console.error('Decision: the prove queue did not start')
  console.error(`Blocker: ${error instanceof Error ? error.message : 'startup failed'}`)
  process.exit(1)
})
