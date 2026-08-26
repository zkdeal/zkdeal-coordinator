import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.js'
import {
  HostedIndexer,
  HOSTED_INDEXER_PROJECTION_SCHEMA,
  HOSTED_OBSERVATION_SCHEMA,
  loadContractAbi,
  mergeContractAbis,
  ROOM_MANAGER_CALL_KINDS,
  ROOM_MANAGER_EVENT_KINDS,
  ROOM_POOL_CALL_KINDS,
  ROOM_POOL_EVENT_KINDS,
} from './hosted-indexer.js'
import { HostedRuntime } from './hosted-runtime.js'
import { METRICS_CONTENT_TYPE, renderMetrics } from './metrics.js'
import { hostedWorkerMetricFamilies } from './metrics-worker.js'
import { BlobArchiveCoordinator, initializeBlobKzg } from './blob-archive.js'

type WorkerRole = 'indexer' | 'reconciler'

const ZERO_ADDRESS = `0x${'00'.repeat(20)}`

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`worker integer must be in [${minimum},${maximum}]`)
  }
  return parsed
}

function bootstrapBlock(value: string | undefined): 'finalized' | `0x${string}` {
  if (value === 'finalized') return value
  if (value && /^0x[0-9a-fA-F]+$/.test(value)) return value.toLowerCase() as `0x${string}`
  throw new Error('INDEXER_BOOTSTRAP_BLOCK must be finalized or an explicit hexadecimal deployment anchor')
}

export async function runHostedWorker(
  role = (process.argv[2] ?? process.env.HOSTED_WORKER_ROLE ?? 'indexer') as WorkerRole,
): Promise<never> {
  if (!['indexer', 'reconciler'].includes(role)) throw new Error(`unsupported hosted worker role ${role}`)
  const config = loadConfig()
  if (!config.databaseUrl) throw new Error('hosted worker requires DATABASE_URL')
  if (config.roomManager === ZERO_ADDRESS || config.roomPool === ZERO_ADDRESS) {
    throw new Error('hosted indexer requires configured ROOM_MANAGER and ROOM_POOL addresses')
  }
  // Preload the synchronous c-kzg WASM before owning a coordinator-delegated
  // lease; lazy first-use initialization can otherwise outlive the lease TTL.
  await initializeBlobKzg()
  const workerId = process.env.HOSTED_WORKER_ID?.trim() || `${config.coordinatorId}-${role}`
  const runtime = await HostedRuntime.create(config, { workerComponent: role, workerId })
  if (!runtime) throw new Error('hosted runtime was not created')

  const managerAbi = mergeContractAbis(
    loadContractAbi(join(config.contractsOut, 'RoomManagerObservationFacet.sol', 'RoomManagerObservationFacet.json')),
    loadContractAbi(join(config.contractsOut, 'IRoomManager.sol', 'IRoomManager.json')),
    loadContractAbi(join(config.contractsOut, 'RoomManager.sol', 'RoomManager.json')),
  )
  const poolAbi = mergeContractAbis(
    loadContractAbi(join(config.contractsOut, 'RoomPoolManager.sol', 'RoomPoolManager.json')),
    loadContractAbi(join(config.contractsOut, 'RoomPoolHostingFacet.sol', 'RoomPoolHostingFacet.json')),
    loadContractAbi(join(config.contractsOut, 'RoomPoolNodeRegistry.sol', 'RoomPoolNodeRegistry.json')),
  )
  const indexer = new HostedIndexer({
    runtime,
    blobArchive: new BlobArchiveCoordinator(runtime, config.beaconSidecarUrls),
    bootstrapBlock: bootstrapBlock(process.env.INDEXER_BOOTSTRAP_BLOCK),
    maxBlocksPerRun: boundedInteger(process.env.INDEXER_MAX_BLOCKS_PER_RUN, 64, 1, 1_000),
    maxRoomsPerReconciliation: boundedInteger(process.env.INDEXER_MAX_ROOMS_PER_RUN, 1_000, 1, 10_000),
    sources: [
      {
        name: 'room-manager', address: config.roomManager, abi: managerAbi,
        chainDerivedKinds: ROOM_MANAGER_EVENT_KINDS,
        calldataKinds: ROOM_MANAGER_CALL_KINDS,
        observation: true,
      },
      {
        name: 'room-pool', address: config.roomPool, abi: poolAbi,
        chainDerivedKinds: ROOM_POOL_EVENT_KINDS,
        calldataKinds: ROOM_POOL_CALL_KINDS,
      },
    ],
  })
  const intervalMs = boundedInteger(process.env.HOSTED_WORKER_INTERVAL_MS, 3_000, 250, 60_000)
  const port = boundedInteger(process.env.WORKER_PORT, 3001, 1, 65_535)
  const host = process.env.WORKER_HOST?.trim() || config.bindHost
  let running = false
  let stopped = false
  let lastSuccessAt: string | null = null
  let lastError: string | null = null
  let completedRuns = 0
  let processedBlocks = 0
  let reconciledRooms = 0
  let nextTimer: NodeJS.Timeout | null = null

  const capabilities = {
    service: 'zkdeal-hosted-worker',
    role,
    schemaVersion: 1,
    projectionSchema: HOSTED_INDEXER_PROJECTION_SCHEMA,
    observationSchema: HOSTED_OBSERVATION_SCHEMA,
    sources: [
      { name: 'room-manager', address: config.roomManager },
      { name: 'room-pool', address: config.roomPool },
    ],
    agreement: { minimumIndependentRpcProviders: 2, bootstrapAnchor: 'operator-configured-and-rpc-agreed' },
    fencing: {
      mode: 'delegated-component-lease',
      boundToCoordinatorId: config.coordinatorId,
      workerId,
      promotionInvalidatesDelegation: true,
    },
    blobArchive: {
      prepublishObjectStore: true,
      beaconFallbackEndpoints: config.beaconSidecarUrls.length,
      kzgVerification: 'c-kzg-wasm',
      finalityFailClosed: true,
    },
    endpoints: { health: '/health', readiness: '/ready', metrics: '/metrics', capabilities: '/capabilities' },
    command: ['./node_modules/.bin/tsx', 'src/hosted-worker.ts', role],
  }

  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8')
    if (request.url === '/health') {
      response.end(JSON.stringify({ ok: true, role, running, lastSuccessAt, lastError }))
      return
    }
    if (request.url === '/ready') {
      const fresh = lastSuccessAt !== null && Date.now() - Date.parse(lastSuccessAt) <= Math.max(30_000, intervalMs * 4)
      const ready = fresh && runtime.status().ready && !lastError
      response.statusCode = ready ? 200 : 503
      response.end(JSON.stringify({ ready, role, lastSuccessAt, runtime: runtime.status() }))
      return
    }
    if (request.url === '/capabilities') {
      response.end(JSON.stringify(capabilities))
      return
    }
    if (request.url === '/metrics') {
      response.setHeader('content-type', METRICS_CONTENT_TYPE)
      response.end(renderMetrics(hostedWorkerMetricFamilies({
        running, completedRuns, processedBlocks, reconciledRooms, lastSuccessAt,
      })))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: 'not found' }))
  })

  const tick = async () => {
    if (stopped || running) return
    running = true
    try {
      const result = role === 'indexer' ? await indexer.runOnce() : await indexer.reconcileOnce()
      if ('blocks' in result) processedBlocks += result.blocks
      reconciledRooms += result.reconciledRooms
      completedRuns += 1
      lastSuccessAt = new Date().toISOString()
      lastError = null
    } catch (error) {
      lastError = error instanceof Error ? error.message.slice(0, 500) : 'unknown worker failure'
    } finally {
      running = false
      if (!stopped) {
        nextTimer = setTimeout(() => void tick(), intervalMs)
        nextTimer.unref?.()
      }
    }
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, host, () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  void tick()

  return await new Promise<never>((_resolve, reject) => {
    const stop = (signal: string) => {
      if (stopped) return
      stopped = true
      if (nextTimer) clearTimeout(nextTimer)
      server.close(() => {
        void runtime.close().finally(() => reject(new Error(`hosted worker stopped by ${signal}`)))
      })
    }
    process.once('SIGINT', () => stop('SIGINT'))
    process.once('SIGTERM', () => stop('SIGTERM'))
  })
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  void runHostedWorker().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
