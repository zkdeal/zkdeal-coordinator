import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { loadConfig } from '../src/config.js'
import { HostedRuntime } from '../src/hosted-runtime.js'
import {
  createPostgresPool,
  HostedFenceError,
  type SqlPool,
} from '../src/postgres-hosted-store.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const objectStoreEndpoint = process.env.TEST_OBJECT_STORE_ENDPOINT
const integration = databaseUrl && objectStoreEndpoint ? describe : describe.skip

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
              number: '0x1',hash: `0x${'11'.repeat(32)}`,
              parentHash: `0x${'00'.repeat(32)}`,timestamp: '0x1',
            }
          : null
      response.setHeader('content-type','application/json')
      response.end(JSON.stringify({ jsonrpc: '2.0',id: body.id,result }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0,'127.0.0.1',resolve))
  const bound = server.address()
  if (!bound || typeof bound === 'string') throw new Error('RPC fixture did not bind')
  return { server,url: `http://127.0.0.1:${bound.port}` }
}

integration('hosted coordinator cold-start lease boundary', () => {
  let runtime: HostedRuntime
  let pool: SqlPool
  const servers: Server[] = []

  beforeAll(async () => {
    const first = await rpcServer()
    const second = await rpcServer()
    servers.push(first.server,second.server)
    const config = loadConfig({
      databaseUrl: databaseUrl!,apiKeyPepper: 'cold-start-api-key-pepper-00000001',
      coordinatorId: 'cold-start-owner',coordinatorRole: 'active',
      l1RpcUrl: first.url,l1RpcUrls: [first.url,second.url],l1RpcProviderIds: ['rpc-a','rpc-b'],
      objectStoreEndpoint: objectStoreEndpoint!,
      objectStoreBucket: process.env.TEST_OBJECT_STORE_BUCKET ?? 'zkdeal-it',
      objectStoreRegion: 'us-east-1',
      objectStoreAccessKeyId: process.env.TEST_OBJECT_STORE_ACCESS_KEY ?? 'zkdealminio',
      objectStoreSecretAccessKey: process.env.TEST_OBJECT_STORE_SECRET_KEY ?? 'zkdeal-minio-test-secret',
      objectStorePrefix: 'cold-start-it',dataDir: '/proc/zkdeal-cold-start-must-not-write',
    })
    const created = await HostedRuntime.create(config,{ deferWriterLease: true })
    if (!created) throw new Error('hosted runtime was not created')
    runtime = created
    pool = await createPostgresPool(databaseUrl!)
  },60_000)

  afterAll(async () => {
    await runtime?.close()
    await pool?.end()
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  })

  it('owns no epoch during cold work, revalidates before ready, and rejects an expired token', async () => {
    expect(runtime.status()).toMatchObject({ effectiveRole: 'fenced',ready: false,fenceToken: null })
    expect(() => runtime.writableFence()).toThrow(HostedFenceError)
    const before = await pool.query(
      `SELECT 1 FROM coordinator_leases WHERE lease_name='coordinator-writer'`,
    )
    expect(before.rowCount).toBe(0)

    // This boundary is duration-independent: arbitrary cold route/schema work
    // can happen above without a token to expire or an authority to mutate.
    await runtime.activate()
    expect(await runtime.verifyReady()).toMatchObject({ effectiveRole: 'active',ready: true })
    const stale = runtime.writableFence()

    await pool.query(
      `UPDATE coordinator_leases SET expires_at=clock_timestamp()-interval '1 second'
       WHERE lease_name='coordinator-writer' AND holder_id=$1 AND fence_token=$2`,
      [stale.holderId,stale.token.toString()],
    )
    expect(await runtime.verifyReady()).toMatchObject({ effectiveRole: 'fenced',ready: false })
    await expect(runtime.store.upsertTenant(stale,{
      tenantId:'expired-cold-start-writer',displayName:'must fail',tier:'internal',
    })).rejects.toBeInstanceOf(HostedFenceError)
  })
})
