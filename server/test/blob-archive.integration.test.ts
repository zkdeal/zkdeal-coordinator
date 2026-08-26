import { createServer, type Server } from 'node:http'
import { keccak256, serializeTransaction, type Hex } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildBlobBundle,
  BlobArchiveCoordinator,
  initializeBlobKzg,
  type IndexedBlobRequirement,
} from '../src/blob-archive.js'
import { loadConfig, type ServerConfig } from '../src/config.js'
import { HostedRuntime } from '../src/hosted-runtime.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const objectStoreEndpoint = process.env.TEST_OBJECT_STORE_ENDPOINT
const integration = databaseUrl && objectStoreEndpoint ? describe : describe.skip
const hash = (byte: string) => `0x${byte.repeat(64)}` as `0x${string}`
const address = (byte: string) => `0x${byte.repeat(40)}` as `0x${string}`

function signedBlobTransaction(bundle: Awaited<ReturnType<typeof buildBlobBundle>>): {
  hash: `0x${string}`
  raw: Hex
} {
  const signature = {
    r: `0x${'11'.repeat(32)}` as Hex,
    s: `0x${'22'.repeat(32)}` as Hex,
    yParity: 0,
  } as const
  const transaction = {
    type: 'eip4844' as const,
    chainId: 31_337,
    nonce: 1,
    gas: 100_000n,
    maxPriorityFeePerGas: 1n,
    maxFeePerGas: 2n,
    maxFeePerBlobGas: 1n,
    to: address('b'),
    value: 0n,
    data: '0x' as Hex,
    accessList: [],
    blobVersionedHashes: bundle.versionedHashes,
    sidecars: bundle.blobs.map((blob, index) => ({
      blob,
      commitment: bundle.commitments[index]!,
      proof: bundle.proofs[index]!,
    })),
  }
  const raw = serializeTransaction(transaction, signature)
  const body = serializeTransaction({ ...transaction, sidecars: undefined }, signature)
  return { raw, hash: keccak256(body) }
}

type Transaction = Record<string, unknown>

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const bound = server.address()
  if (!bound || typeof bound === 'string') throw new Error('test HTTP server did not bind')
  return `http://127.0.0.1:${bound.port}`
}

integration('blob archive PostgreSQL/MinIO integration', () => {
  const servers: Server[] = []
  const transactions = new Map<string, Transaction>()
  let beaconMode: 'valid' | 'missing' | 'corrupt' = 'valid'
  let beaconPayload: Record<string, unknown> = { data: [] }
  let rpcUrls: string[] = []
  let beaconUrl = ''
  let runtime: HostedRuntime | null = null
  let config: ServerConfig

  beforeAll(async () => {
    // Production workers perform the same prewarm before they acquire their
    // delegated fence, avoiding a lease timeout during WASM initialization.
    await initializeBlobKzg()
    const rpc = () => createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          id: unknown
          method: string
          params: unknown[]
        }
        let result: unknown
        if (body.method === 'eth_chainId') result = '0x7a69'
        else if (body.method === 'eth_getBlockByNumber') {
          const tag = body.params[0]
          result = tag === '0x64'
            ? {
                number: '0x64', hash: hash('1'), parentHash: hash('0'), timestamp: '0x64',
                parentBeaconBlockRoot: hash('8'),
              }
            : {
                number: '0x65', hash: hash('2'), parentHash: hash('1'), timestamp: '0x65',
                parentBeaconBlockRoot: hash('9'),
              }
        } else if (body.method === 'eth_getTransactionByHash') {
          result = transactions.get(String(body.params[0]).toLowerCase()) ?? null
        } else result = null
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
      })
    })
    const rpcA = rpc()
    const rpcB = rpc()
    servers.push(rpcA, rpcB)
    rpcUrls = [await listen(rpcA), await listen(rpcB)]

    const beacon = createServer((_request, response) => {
      const payload = beaconMode === 'missing'
        ? { data: [] }
        : beaconMode === 'corrupt'
          ? {
              data: [(beaconPayload.data as Array<Record<string, unknown>>)[0]
                ? {
                    ...(beaconPayload.data as Array<Record<string, unknown>>)[0],
                    blob: `0x${'00'.repeat(131_072)}`,
                  }
                : null].filter(Boolean),
            }
          : beaconPayload
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(payload))
    })
    servers.push(beacon)
    beaconUrl = await listen(beacon)

    config = loadConfig({
      chainId: 31_337,
      databaseUrl: databaseUrl!,
      apiKeyPepper: 'blob-archive-integration-pepper-0001',
      coordinatorId: 'blob-archive-region-a',
      coordinatorRole: 'active',
      l1RpcUrl: rpcUrls[0]!,
      l1RpcUrls: rpcUrls,
      l1RpcProviderIds: ['blob-rpc-a', 'blob-rpc-b'],
      objectStoreEndpoint: objectStoreEndpoint!,
      objectStoreBucket: process.env.TEST_OBJECT_STORE_BUCKET ?? 'zkdeal-it',
      objectStoreRegion: 'us-east-1',
      objectStoreAccessKeyId: process.env.TEST_OBJECT_STORE_ACCESS_KEY ?? 'zkdealminio',
      objectStoreSecretAccessKey: process.env.TEST_OBJECT_STORE_SECRET_KEY ?? 'zkdeal-minio-test-secret',
      objectStorePrefix: 'blob-archive-it',
      beaconSidecarUrls: [beaconUrl],
      dataDir: '/tmp/zkdeal-blob-archive-it',
    })
    runtime = await HostedRuntime.create(config)
    if (!runtime) throw new Error('hosted runtime did not start')
  }, 120_000)

  afterAll(async () => {
    await runtime?.close()
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  })

  it('prearchives hosted blobs, falls back to beacon sidecars, gates finality, and retracts on reorg', async () => {
    const hostedBundle = await buildBlobBundle('0x686f737465642d7072657075626c697368')
    const externalBundle = await buildBlobBundle('0x626561636f6e2d66616c6c6261636b')
    const signedHosted = signedBlobTransaction(hostedBundle)
    beaconPayload = {
      data: [{
        index: '0',
        blob: externalBundle.blobs[0],
        kzg_commitment: externalBundle.commitments[0],
        kzg_proof: externalBundle.proofs[0],
      }],
    }

    const transaction = (transactionHash: `0x${string}`, versionedHashes: readonly `0x${string}`[]) => ({
      hash: transactionHash,
      from: address('a'),
      to: address('b'),
      nonce: '0x1',
      input: '0x',
      value: '0x0',
      type: '0x3',
      chainId: '0x7a69',
      blockHash: hash('1'),
      blockNumber: '0x64',
      transactionIndex: '0x0',
      blobVersionedHashes: versionedHashes,
    })
    const hostedHash = signedHosted.hash
    const beaconHash = hash('b')
    const missingHash = hash('c')
    const corruptHash = hash('d')
    transactions.set(hostedHash, transaction(hostedHash, hostedBundle.versionedHashes))
    transactions.set(beaconHash, transaction(beaconHash, externalBundle.versionedHashes))
    transactions.set(missingHash, transaction(missingHash, externalBundle.versionedHashes))
    transactions.set(corruptHash, transaction(corruptHash, externalBundle.versionedHashes))

    await runtime!.store.setCanonicalAnchor(runtime!.writableFence(), {
      chainId: config.chainId, number: '99', hash: hash('0'), verifiedSources: ['blob-rpc-a', 'blob-rpc-b'],
    })
    await runtime!.store.recordCanonicalBlocks(runtime!.writableFence(), [
      { chainId: config.chainId, number: '100', hash: hash('1'), parentHash: hash('0'), observedAt: new Date().toISOString() },
      { chainId: config.chainId, number: '101', hash: hash('2'), parentHash: hash('1'), observedAt: new Date().toISOString() },
    ])
    const requirement = (
      transactionHash: `0x${string}`,
      roomId: string,
      bundle: typeof hostedBundle,
    ): IndexedBlobRequirement => ({
      chainId: config.chainId,
      transactionHash,
      blockNumber: '100',
      blockHash: hash('1'),
      roomId,
      batchIndex: '1',
      blobStartIndex: 0,
      versionedHashes: bundle.versionedHashes,
      commitments: bundle.commitments,
    })
    const hosted = requirement(hostedHash, '1', hostedBundle)
    const external = requirement(beaconHash, '2', externalBundle)
    const missing = requirement(missingHash, '3', externalBundle)
    const corrupt = requirement(corruptHash, '4', externalBundle)
    await runtime!.store.ingestIndexerRecords(runtime!.writableFence(), {
      chainId: config.chainId,
      blockNumber: '100',
      blockHash: hash('1'),
      source: 'room-manager',
      schemaVersion: 2,
      logs: [],
      facts: [],
      blobRequirements: [hosted, external, missing, corrupt],
    })

    const archive = new BlobArchiveCoordinator(runtime!, [beaconUrl])
    await expect(archive.archivePrepublished({
      chainId: config.chainId,
      transactionHash: hash('f'),
      signedTransaction: signedHosted.raw,
      bundle: hostedBundle,
    })).rejects.toThrow('transaction hash does not match')
    const hostedArchive = await archive.archivePrepublished({
      chainId: config.chainId,
      transactionHash: hostedHash,
      signedTransaction: signedHosted.raw,
      bundle: hostedBundle,
    })
    await archive.ensureArchived(hosted)
    expect(await runtime!.objects.get(hostedArchive.bundleObjectKey)).not.toBeNull()
    expect(await runtime!.objects.get(hostedArchive.signedTransactionObjectKey)).not.toBeNull()
    expect(await runtime!.store.blobArchive(config.chainId, hostedHash))
      .toMatchObject({ archiveSource: 'hosted-prepublish' })

    beaconMode = 'valid'
    await archive.ensureArchived(external)
    expect(await runtime!.store.blobArchive(config.chainId, beaconHash))
      .toMatchObject({ archiveSource: 'beacon-fallback' })

    beaconMode = 'missing'
    await expect(archive.ensureArchived(missing)).rejects.toThrow('missing a transaction blob')
    beaconMode = 'corrupt'
    await expect(archive.ensureArchived(corrupt)).rejects.toThrow('does not match its KZG commitment')
    expect(await runtime!.store.blobArchiveReadyThrough(config.chainId, '100')).toBe(false)
    await expect(runtime!.store.advanceCanonicalFloor(runtime!.writableFence(), {
      chainId: config.chainId, number: '100', hash: hash('1'), verifiedSources: ['blob-rpc-a', 'blob-rpc-b'],
    })).rejects.toThrow('unarchived blob sidecar')

    const rollback = await runtime!.store.recordCanonicalBlocks(runtime!.writableFence(), [
      { chainId: config.chainId, number: '100', hash: hash('3'), parentHash: hash('0'), observedAt: new Date().toISOString() },
      { chainId: config.chainId, number: '101', hash: hash('4'), parentHash: hash('3'), observedAt: new Date().toISOString() },
    ])
    expect(rollback.rolledBackFrom).toBe('100')
    expect(await runtime!.store.pendingBlobRequirements()).toEqual([])
    expect(await runtime!.store.blobArchive(config.chainId, hostedHash)).not.toBeNull()
    expect(await runtime!.store.blobArchive(config.chainId, beaconHash)).not.toBeNull()
    await expect(runtime!.store.advanceCanonicalFloor(runtime!.writableFence(), {
      chainId: config.chainId, number: '100', hash: hash('3'), verifiedSources: ['blob-rpc-a', 'blob-rpc-b'],
    })).resolves.toMatchObject({ number: '100', hash: hash('3') })
  }, 180_000)
})
