#!/usr/bin/env node
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CapacityController, HttpCapacityProvider } from './capacity-controller.js'
import { loadConfig } from './config.js'
import { HostedRuntime } from './hosted-runtime.js'
import { METRICS_CONTENT_TYPE, renderMetrics } from './metrics.js'
import { capacityWorkerMetricFamilies } from './metrics-worker.js'

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`capacity worker integer must be in [${minimum},${maximum}]`)
  }
  return parsed
}

export async function runHostedCapacityWorker(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? 'run'
  if (command === '--help' || command === 'help') {
    process.stdout.write('zkdeal-capacity-controller\n\nCommands:\n  run\n  once\n')
    return
  }
  if (command !== 'run' && command !== 'once') throw new Error(`unknown capacity command ${command}`)
  const config = loadConfig()
  if (!config.capacityControllerEnabled || !config.capacityProviderUrl || !config.capacityProviderAuthToken) {
    throw new Error('capacity worker requires CAPACITY_CONTROLLER_ENABLED and its scoped provider configuration')
  }
  const provider = new HttpCapacityProvider(
    config.capacityProviderUrl,
    config.capacityProviderAuthToken,
    config.capacityProviderPreviousAuthToken,
  )
  const workerId = process.env.HOSTED_WORKER_ID?.trim() || `${config.coordinatorId}-capacity`
  const runtime = await HostedRuntime.create(config, { workerComponent: 'capacity', workerId })
  if (!runtime) throw new Error('hosted capacity runtime was not created')
  const intervalMs = boundedInteger(process.env.HOSTED_WORKER_INTERVAL_MS, 3_000, 250, 60_000)
  const leaseTtlMs = boundedInteger(process.env.CAPACITY_LEASE_TTL_MS, 30_000, 5_000, 5 * 60_000)
  const batchSize = boundedInteger(process.env.CAPACITY_BATCH_SIZE, 20, 1, 200)
  const controller = new CapacityController(runtime, provider, workerId, leaseTtlMs, batchSize,config.chainId)
  try {
    await controller.assertReady()
    if (command === 'once') {
      process.stdout.write(`${JSON.stringify(await controller.processOnce(), null, 2)}\n`)
      return
    }
    const port = boundedInteger(process.env.WORKER_PORT, 3004, 1, 65_535)
    const host = process.env.WORKER_HOST?.trim() || config.bindHost
    let running = false
    let stopped = false
    let runs = 0
    let lastSuccessAt: string | null = null
    let lastError: string | null = null
    const totals = {
      signalsSent: 0, applied: 0, pending: 0, retrying: 0,
      terminal: 0, deadlineRisk: 0, failures: 0,
      nodeLifecycleApplied: 0, nodeLifecyclePending: 0,
      nodeLifecycleRetrying: 0, nodeLifecycleTerminal: 0,
      nodeLifecycleVerified: 0, nodeLifecycleRecoveryRequired: 0,
    }
    let timer: NodeJS.Timeout | null = null
    const capabilities = {
      service: 'zkdeal-capacity-controller', schemaVersion: 1,
      workerComponent: 'capacity', providerProtocol: 'zkdeal-capacity-provider-v1',
      explicitIntentExecution: true, immutableIdempotencyKeys: true,
      queueDemandSignals: true, canonicalDeadlineUrgency: true,
      staleProfileScaleDownGate: true, retryAndAlertState: 'postgresql',
      nodeDrainAndRetirement: 'provider-executed-owner-indexer-finality-verified',
      fencing: 'component-lease-bound-to-current-coordinator-epoch',
      command: ['./node_modules/.bin/tsx', 'src/hosted-capacity-worker.ts', 'run'],
      endpoints: { health: '/health', readiness: '/ready', metrics: '/metrics', capabilities: '/capabilities' },
    }
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json; charset=utf-8')
      if (request.url === '/health') response.end(JSON.stringify({ ok: true, running, lastSuccessAt, lastError }))
      else if (request.url === '/ready') {
        const fresh = lastSuccessAt !== null && Date.now() - Date.parse(lastSuccessAt) <= Math.max(30_000, intervalMs * 4)
        const ready = fresh && runtime.status().ready && !lastError
        response.statusCode = ready ? 200 : 503
        response.end(JSON.stringify({ ready, lastSuccessAt, runtime: runtime.status() }))
      } else if (request.url === '/capabilities') response.end(JSON.stringify(capabilities))
      else if (request.url === '/metrics') {
        response.setHeader('content-type', METRICS_CONTENT_TYPE)
        response.end(renderMetrics(capacityWorkerMetricFamilies({ running, runs, totals, lastSuccessAt })))
      } else {
        response.statusCode = 404
        response.end(JSON.stringify({ error: 'not found' }))
      }
    })
    const tick = async () => {
      if (stopped || running) return
      running = true
      try {
        const result = await controller.processOnce()
        for (const key of Object.keys(result) as Array<keyof typeof result>) totals[key] += result[key]
        runs += 1
        lastSuccessAt = new Date().toISOString()
        lastError = result.terminal > 0 ? `${result.terminal} capacity operations require operator action` : null
      } catch (error) {
        totals.failures += 1
        lastError = error instanceof Error ? error.message.slice(0, 500) : 'unknown capacity worker failure'
      } finally {
        running = false
        if (!stopped) {
          timer = setTimeout(() => void tick(), intervalMs)
          timer.unref?.()
        }
      }
    }
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(port, host, () => { server.off('error', rejectListen); resolveListen() })
    })
    void tick()
    await new Promise<void>((resolveStop) => {
      const stop = () => {
        if (stopped) return
        stopped = true
        if (timer) clearTimeout(timer)
        server.close(() => resolveStop())
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
  } finally {
    await runtime.close()
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : ''
if (invoked === resolve(fileURLToPath(import.meta.url))) {
  void runHostedCapacityWorker().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
