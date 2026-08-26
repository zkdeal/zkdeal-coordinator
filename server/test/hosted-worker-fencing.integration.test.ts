import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { loadConfig, type ServerConfig } from '../src/config.js'
import { HostedFenceError } from '../src/postgres-hosted-store.js'
import { HostedRuntime } from '../src/hosted-runtime.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const objectStoreEndpoint = process.env.TEST_OBJECT_STORE_ENDPOINT
const integration = databaseUrl && objectStoreEndpoint ? describe : describe.skip
let rpcUrls: string[] = []

async function rpcServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: unknown; method: string }
      const result = body.method === 'eth_chainId'
        ? '0x7a69'
        : body.method === 'eth_getBlockByNumber'
          ? {
              number: '0x1', hash: `0x${'11'.repeat(32)}`,
              parentHash: `0x${'00'.repeat(32)}`, timestamp: '0x1',
            }
          : null
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('RPC test server did not bind')
  return { server, url: `http://127.0.0.1:${address.port}` }
}

function config(coordinatorId: string): ServerConfig {
  return loadConfig({
    databaseUrl: databaseUrl!,
    apiKeyPepper: 'worker-fencing-api-key-pepper-0001',
    coordinatorId,
    coordinatorRole: 'active',
    l1RpcUrl: rpcUrls[0]!,
    l1RpcUrls: rpcUrls,
    l1RpcProviderIds: ['rpc-a', 'rpc-b'],
    objectStoreEndpoint: objectStoreEndpoint!,
    objectStoreBucket: process.env.TEST_OBJECT_STORE_BUCKET ?? 'zkdeal-it',
    objectStoreRegion: 'us-east-1',
    objectStoreAccessKeyId: process.env.TEST_OBJECT_STORE_ACCESS_KEY ?? 'zkdealminio',
    objectStoreSecretAccessKey: process.env.TEST_OBJECT_STORE_SECRET_KEY ?? 'zkdeal-minio-test-secret',
    objectStorePrefix: 'worker-fencing-it',
    dataDir: `/tmp/zkdeal-worker-fencing-${coordinatorId}`,
  })
}

integration('hosted multi-process epoch fencing', () => {
  let active: HostedRuntime | null = null
  let indexer: HostedRuntime | null = null
  let reconciler: HostedRuntime | null = null
  let promoted: HostedRuntime | null = null
  let promotedIndexer: HostedRuntime | null = null
  const rpcServers: Server[] = []

  beforeAll(async () => {
    const firstRpc = await rpcServer()
    const secondRpc = await rpcServer()
    rpcServers.push(firstRpc.server, secondRpc.server)
    rpcUrls = [firstRpc.url, secondRpc.url]
    const activeConfig = config('region-a-epoch')
    active = await HostedRuntime.create(activeConfig)
    indexer = await HostedRuntime.create(activeConfig, {
      workerComponent: 'indexer', workerId: 'region-a-indexer-0',
    })
    reconciler = await HostedRuntime.create(activeConfig, {
      workerComponent: 'reconciler', workerId: 'region-a-reconciler-0',
    })
    if (!active || !indexer || !reconciler) throw new Error('three hosted runtimes were not created')
  }, 60_000)

  afterAll(async () => {
    await Promise.allSettled([
      promotedIndexer?.close(), reconciler?.close(), indexer?.close(),
      promoted?.close(), active?.close(),
    ])
    await Promise.all(rpcServers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  })

  it('lets active coordinator, indexer, and reconciler mutate concurrently', async () => {
    expect(active!.status()).toMatchObject({ runtimeMode: 'coordinator', effectiveRole: 'active' })
    expect(indexer!.status()).toMatchObject({
      runtimeMode: 'worker', workerComponent: 'indexer', effectiveRole: 'active',
    })
    expect(reconciler!.status()).toMatchObject({
      runtimeMode: 'worker', workerComponent: 'reconciler', effectiveRole: 'active',
    })
    await Promise.all([
      active!.store.upsertTenant(active!.writableFence(), {
        tenantId: 'three-runtime-control', displayName: 'Control', tier: 'internal',
      }),
      indexer!.store.upsertTenant(indexer!.writableFence(), {
        tenantId: 'three-runtime-indexer', displayName: 'Indexer', tier: 'internal',
      }),
      reconciler!.store.upsertTenant(reconciler!.writableFence(), {
        tenantId: 'three-runtime-reconciler', displayName: 'Reconciler', tier: 'internal',
      }),
    ])
  })

  it('invalidates old-region workers immediately on promotion', async () => {
    const staleIndexerFence = indexer!.writableFence()
    const staleReconcilerFence = reconciler!.writableFence()
    await active!.close()
    active = null
    const promotedConfig = config('region-b-epoch')
    promoted = await HostedRuntime.create(promotedConfig)
    if (!promoted) throw new Error('promoted coordinator was not created')

    await expect(indexer!.store.upsertTenant(staleIndexerFence, {
      tenantId: 'old-indexer-after-promotion', displayName: 'must fail', tier: 'internal',
    })).rejects.toBeInstanceOf(HostedFenceError)
    await expect(reconciler!.store.upsertTenant(staleReconcilerFence, {
      tenantId: 'old-reconciler-after-promotion', displayName: 'must fail', tier: 'internal',
    })).rejects.toBeInstanceOf(HostedFenceError)
    await expect(HostedRuntime.create(config('region-a-epoch'), {
      workerComponent: 'indexer', workerId: 'region-a-standby-indexer',
    })).rejects.toBeInstanceOf(HostedFenceError)

    promotedIndexer = await HostedRuntime.create(promotedConfig, {
      workerComponent: 'indexer', workerId: 'region-b-indexer-0',
    })
    if (!promotedIndexer) throw new Error('promoted indexer was not created')
    await promotedIndexer.store.upsertTenant(promotedIndexer.writableFence(), {
      tenantId: 'new-indexer-after-promotion', displayName: 'new epoch', tier: 'internal',
    })
  }, 60_000)
})
