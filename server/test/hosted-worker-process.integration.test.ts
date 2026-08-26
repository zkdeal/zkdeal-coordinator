import { createServer, type Server } from 'node:http'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const databaseUrl = process.env.TEST_DATABASE_URL
const objectStoreEndpoint = process.env.TEST_OBJECT_STORE_ENDPOINT
const integration = databaseUrl && objectStoreEndpoint ? describe : describe.skip

type ManagedChild = {
  process: ChildProcessWithoutNullStreams
  output: string
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<void>
  waitForExit(timeoutMs?: number): Promise<number | null>
}

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

function managedChild(
  role: 'coordinator' | 'indexer' | 'reconciler',
  coordinatorId: string,
  rpcUrls: string[],
  workerId?: string,
): ManagedChild {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'test/helpers/hosted-runtime-child.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_HOSTED_PROCESS_ROLE: role,
        DATABASE_URL: databaseUrl!,
        API_KEY_PEPPER: 'process-fencing-api-key-pepper-0001',
        COORDINATOR_ID: coordinatorId,
        COORDINATOR_ROLE: 'active',
        HOSTED_WORKER_ID: workerId ?? `${coordinatorId}-${role}-0`,
        L1_RPC_URL: rpcUrls[0]!,
        L1_RPC_URLS: rpcUrls.join(','),
        L1_RPC_PROVIDER_IDS: 'rpc-a,rpc-b',
        OBJECT_STORE_ENDPOINT: objectStoreEndpoint!,
        OBJECT_STORE_BUCKET: process.env.TEST_OBJECT_STORE_BUCKET ?? 'zkdeal-it',
        OBJECT_STORE_REGION: 'us-east-1',
        OBJECT_STORE_ACCESS_KEY_ID: process.env.TEST_OBJECT_STORE_ACCESS_KEY ?? 'zkdealminio',
        OBJECT_STORE_SECRET_ACCESS_KEY: process.env.TEST_OBJECT_STORE_SECRET_KEY ?? 'zkdeal-minio-test-secret',
        OBJECT_STORE_PREFIX: 'worker-process-fencing-it',
        DATA_DIR: `/tmp/zkdeal-worker-process-${coordinatorId}-${role}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const managed: ManagedChild = {
    process: child,
    output: '',
    waitFor(pattern, timeoutMs = 15_000) {
      if (pattern.test(managed.output)) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => {
          cleanup()
          reject(new Error(`child output did not match ${pattern}: ${managed.output}`))
        }, timeoutMs)
        const check = () => {
          if (!pattern.test(managed.output)) return
          cleanup()
          resolve()
        }
        const exited = (code: number | null) => {
          cleanup()
          reject(new Error(`child exited ${code} before ${pattern}: ${managed.output}`))
        }
        const cleanup = () => {
          clearTimeout(deadline)
          child.stdout.off('data', check)
          child.stderr.off('data', check)
          child.off('exit', exited)
        }
        child.stdout.on('data', check)
        child.stderr.on('data', check)
        child.once('exit', exited)
      })
    },
    waitForExit(timeoutMs = 15_000) {
      if (child.exitCode !== null) return Promise.resolve(child.exitCode)
      return new Promise<number | null>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(`child did not exit: ${managed.output}`)), timeoutMs)
        child.once('exit', (code) => {
          clearTimeout(deadline)
          resolve(code)
        })
      })
    },
  }
  const append = (chunk: Buffer) => { managed.output += chunk.toString('utf8') }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  return managed
}

integration('hosted real-process writer fencing', () => {
  const rpcServers: Server[] = []
  const children: ManagedChild[] = []
  let rpcUrls: string[] = []

  beforeAll(async () => {
    const first = await rpcServer()
    const second = await rpcServer()
    rpcServers.push(first.server, second.server)
    rpcUrls = [first.url, second.url]
  })

  afterAll(async () => {
    for (const child of children) {
      if (child.process.exitCode === null) child.process.kill('SIGTERM')
    }
    await Promise.allSettled(children.map((child) => child.waitForExit(5_000)))
    await Promise.all(rpcServers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  })

  it('runs three processes, promotes, and rejects every stale writer', async () => {
    const activeA = managedChild('coordinator', 'region-a-process', rpcUrls)
    children.push(activeA)
    await activeA.waitFor(/READY coordinator/)
    const indexerA = managedChild('indexer', 'region-a-process', rpcUrls)
    const reconcilerA = managedChild('reconciler', 'region-a-process', rpcUrls)
    children.push(indexerA, reconcilerA)
    await Promise.all([indexerA.waitFor(/READY indexer/), reconcilerA.waitFor(/READY reconciler/)])
    expect([activeA, indexerA, reconcilerA].every((child) => child.process.exitCode === null)).toBe(true)

    activeA.process.kill('SIGTERM')
    expect(await activeA.waitForExit()).toBe(0)
    const activeB = managedChild('coordinator', 'region-b-process', rpcUrls)
    children.push(activeB)
    await activeB.waitFor(/READY coordinator/)
    await Promise.all([indexerA.waitFor(/FENCED indexer/), reconcilerA.waitFor(/FENCED reconciler/)])
    expect(await indexerA.waitForExit()).toBe(42)
    expect(await reconcilerA.waitForExit()).toBe(42)

    const staleStandby = managedChild(
      'indexer', 'region-a-process', rpcUrls, 'region-a-stale-standby-indexer',
    )
    children.push(staleStandby)
    expect(await staleStandby.waitForExit()).not.toBe(0)
    expect(staleStandby.output).toContain('active coordinator did not grant')

    const indexerB = managedChild('indexer', 'region-b-process', rpcUrls, 'region-b-indexer-0')
    const reconcilerB = managedChild('reconciler', 'region-b-process', rpcUrls, 'region-b-reconciler-0')
    children.push(indexerB, reconcilerB)
    await Promise.all([indexerB.waitFor(/READY indexer/), reconcilerB.waitFor(/READY reconciler/)])
    expect([activeB, indexerB, reconcilerB].every((child) => child.process.exitCode === null)).toBe(true)
  }, 60_000)
})
