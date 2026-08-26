import { createServer, type Server } from 'node:http'
import {
  keccak256,
  parseTransaction,
  serializeTransaction,
  type Hex,
  type TransactionSerializableEIP4844,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { initializeBlobKzg } from '../src/blob-archive.js'
import { BlobPublisher, type BlobPublishRequest } from '../src/blob-publisher.js'
import { loadConfig } from '../src/config.js'
import { HostedRuntime } from '../src/hosted-runtime.js'
import type {
  BlobTransactionToSign,
  L1TransactionSigner,
  SignedBlobTransactionBody,
} from '../src/l1-transaction-signer.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const objectStoreEndpoint = process.env.TEST_OBJECT_STORE_ENDPOINT
const integration = databaseUrl && objectStoreEndpoint ? describe : describe.skip
const hash = (byte: string) => `0x${byte.repeat(64)}` as `0x${string}`
const address = (byte: string) => `0x${byte.repeat(40)}` as `0x${string}`

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const bound = server.address()
  if (!bound || typeof bound === 'string') throw new Error('publisher test server did not bind')
  return `http://127.0.0.1:${bound.port}`
}

function networkHash(raw: Hex): `0x${string}` {
  const parsed = parseTransaction(raw)
  if (parsed.type !== 'eip4844') throw new Error('test expected a blob transaction')
  return keccak256(serializeTransaction({
    ...parsed, sidecars: undefined, blobs: undefined, kzg: undefined,
  } as TransactionSerializableEIP4844)).toLowerCase() as `0x${string}`
}

class DeterministicSigner implements L1TransactionSigner {
  private readonly account = privateKeyToAccount(`0x${'41'.repeat(32)}`)
  readonly address = this.account.address.toLowerCase() as `0x${string}`
  calls = 0
  failNext = false

  async assertReady(): Promise<void> {}

  async signEip4844(input: BlobTransactionToSign): Promise<SignedBlobTransactionBody> {
    this.calls += 1
    if (this.failNext) {
      this.failNext = false
      throw new Error('injected signer outage')
    }
    const signedBody = await this.account.signTransaction({
      type: 'eip4844', ...input, nonce: Number(input.nonce), accessList: [],
    } as never)
    return { signedBody, transactionHash: keccak256(signedBody).toLowerCase() as `0x${string}` }
  }
}

integration('BlobPublisher crash recovery with PostgreSQL and MinIO', () => {
  const servers: Server[] = []
  const signer = new DeterministicSigner()
  const broadcasts: Hex[] = []
  let runtime: HostedRuntime | null = null
  let publisher: BlobPublisher
  let receipt: Record<string, unknown> | null = null
  let latestNumber = 110n
  let finalizedNumber = 99n
  let includedHash = hash('6')

  const request: BlobPublishRequest = {
    to: address('b'), calldata: '0x1234', blobData: '0x7065727369737465642d626c6f62',
    value: '0', gas: '250000', maxPriorityFeePerGas: '2', maxFeePerGas: '20',
    maxFeePerBlobGas: '3', inclusionDeadline: '140',
  }

  beforeAll(async () => {
    await initializeBlobKzg()
    const rpc = () => createServer((incoming, response) => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      incoming.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          id: unknown
          method: string
          params: unknown[]
        }
        let result: unknown
        if (body.method === 'eth_chainId') result = '0x7a69'
        else if (body.method === 'eth_getTransactionCount') result = '0x5'
        else if (body.method === 'eth_sendRawTransaction') {
          const raw = String(body.params[0]) as Hex
          broadcasts.push(raw)
          result = networkHash(raw)
        } else if (body.method === 'eth_getTransactionReceipt') result = receipt
        else if (body.method === 'eth_getBlockByNumber') {
          const tag = String(body.params[0])
          const number = tag === 'finalized'
            ? finalizedNumber
            : tag === 'latest'
              ? latestNumber
              : BigInt(tag)
          const blockHash = number === 100n ? includedHash : hash(number % 2n === 0n ? '8' : '9')
          result = {
            number: `0x${number.toString(16)}`,
            hash: blockHash,
            parentHash: hash('5'),
            timestamp: `0x${(1_700_000_000n + number).toString(16)}`,
            parentBeaconBlockRoot: hash('4'),
          }
        } else result = null
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
      })
    })
    const a = rpc()
    const b = rpc()
    servers.push(a, b)
    const rpcUrls = [await listen(a), await listen(b)]
    const config = loadConfig({
      chainId: 31_337,
      databaseUrl: databaseUrl!,
      apiKeyPepper: 'blob-publisher-integration-pepper-0001',
      coordinatorId: 'blob-publisher-region-a', coordinatorRole: 'active',
      l1RpcUrl: rpcUrls[0]!, l1RpcUrls: rpcUrls,
      l1RpcProviderIds: ['publisher-rpc-a', 'publisher-rpc-b'],
      l1SignerUrl: 'http://127.0.0.1:1', l1SignerAddress: signer.address,
      l1SignerAuthToken: 'publisher-signer-token-00000001', blobPublisherEnabled: true,
      objectStoreEndpoint: objectStoreEndpoint!,
      objectStoreBucket: process.env.TEST_OBJECT_STORE_BUCKET ?? 'zkdeal-it',
      objectStoreRegion: 'us-east-1',
      objectStoreAccessKeyId: process.env.TEST_OBJECT_STORE_ACCESS_KEY ?? 'zkdealminio',
      objectStoreSecretAccessKey: process.env.TEST_OBJECT_STORE_SECRET_KEY ?? 'zkdeal-minio-test-secret',
      objectStorePrefix: 'blob-publisher-crash-it',
      dataDir: '/tmp/zkdeal-blob-publisher-it',
    })
    runtime = await HostedRuntime.create(config)
    if (!runtime) throw new Error('publisher hosted runtime did not start')
    publisher = new BlobPublisher(runtime, config.chainId, signer)
  }, 120_000)

  afterAll(async () => {
    await runtime?.close()
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  })

  it('recovers every durable boundary with one nonce and identical signed bytes', async () => {
    const store = runtime!.store

    // Durable request object -> nonce reserve.
    const originalReserve = store.reserveL1Transaction.bind(store)
    let reserveCrash = true
    store.reserveL1Transaction = (async (...args: Parameters<typeof originalReserve>) => {
      if (reserveCrash) {
        reserveCrash = false
        throw new Error('injected crash before nonce reserve')
      }
      return originalReserve(...args)
    }) as typeof store.reserveL1Transaction
    await expect(publisher.publish('publisher-crash-operation-a', request)).rejects.toThrow('before nonce reserve')
    expect((await runtime!.store.pendingL1Transactions()).length).toBe(0)
    store.reserveL1Transaction = originalReserve

    // Reserve -> signer outage. The allocated nonce remains recoverable.
    signer.failNext = true
    await expect(publisher.publish('publisher-crash-operation-a', request)).rejects.toThrow('signer outage')
    let row = (await store.pendingL1Transactions())[0]!
    expect(row).toMatchObject({ nonce: '5', status: 'PREPARED', transactionHash: null })

    // Signed content objects -> journal attach, with the DB commit succeeding
    // just before the process disappears. Restart must not call the signer.
    const originalAttach = store.attachSignedL1Transaction.bind(store)
    let attachCrash = true
    store.attachSignedL1Transaction = (async (...args: Parameters<typeof originalAttach>) => {
      const attached = await originalAttach(...args)
      if (attachCrash) {
        attachCrash = false
        throw new Error('injected crash after signed-row attach')
      }
      return attached
    }) as typeof store.attachSignedL1Transaction
    await expect(publisher.publish('publisher-crash-operation-a', request)).rejects.toThrow('signed-row attach')
    const callsAfterSignedBytes = signer.calls
    row = (await store.pendingL1Transactions())[0]!
    expect(row).toMatchObject({ nonce: '5', status: 'SIGNED' })
    expect(await runtime!.objects.get(row.rawTransactionObjectKey!)).not.toBeNull()
    store.attachSignedL1Transaction = originalAttach

    // Row attach -> prepublish archive record.
    const originalArchive = store.recordBlobArchive.bind(store)
    let archiveCrash = true
    store.recordBlobArchive = (async (...args: Parameters<typeof originalArchive>) => {
      await originalArchive(...args)
      if (archiveCrash) {
        archiveCrash = false
        throw new Error('injected crash after prepublish archive')
      }
    }) as typeof store.recordBlobArchive
    await expect(publisher.publish('publisher-crash-operation-a', request)).rejects.toThrow('prepublish archive')
    expect(signer.calls).toBe(callsAfterSignedBytes)
    store.recordBlobArchive = originalArchive

    // RPC acceptance -> durable broadcast marker. The retry rebroadcasts only
    // the same wrapper and never consumes or signs a replacement nonce.
    const originalBroadcastMarker = store.markL1TransactionBroadcast.bind(store)
    let markerCrash = true
    store.markL1TransactionBroadcast = (async (...args: Parameters<typeof originalBroadcastMarker>) => {
      if (markerCrash) {
        markerCrash = false
        throw new Error('injected crash before broadcast marker')
      }
      return originalBroadcastMarker(...args)
    }) as typeof store.markL1TransactionBroadcast
    await expect(publisher.publish('publisher-crash-operation-a', request)).rejects.toThrow('broadcast marker')
    row = (await store.pendingL1Transactions())[0]!
    expect(row.status).toBe('SIGNED')
    store.markL1TransactionBroadcast = originalBroadcastMarker
    const recovered = await publisher.publish('publisher-crash-operation-a', request)
    expect(recovered).toMatchObject({ nonce: '5', status: 'BROADCAST' })
    expect(signer.calls).toBe(callsAfterSignedBytes)
    expect(new Set(broadcasts)).toHaveLength(1)

    // A distinct operation observes the durable next nonce, not the remote
    // provider's stale pending value and never reuses nonce 5.
    const second = await publisher.publish('publisher-crash-operation-b', {
      ...request, calldata: '0x5678', blobData: '0x7365636f6e642d626c6f62',
    })
    expect(second.nonce).toBe('6')

    // Inclusion -> explicit two-provider absence is a reorg and rebroadcast;
    // provider disagreement would throw and leave INCLUDED untouched.
    row = await store.l1Transaction(recovered.operationId) as NonNullable<typeof row>
    receipt = {
      transactionHash: row.transactionHash, blockHash: includedHash,
      blockNumber: '0x64', transactionIndex: '0x0', status: '0x1', type: '0x3',
    }
    await runtime!.store['pool'].query(
      `UPDATE hosted_l1_transactions SET next_attempt_at=clock_timestamp()
       WHERE operation_id=$1`, [row.operationId],
    )
    await publisher.processOnce()
    expect((await store.l1Transaction(row.operationId))?.status).toBe('INCLUDED')
    receipt = null
    await runtime!.store['pool'].query(
      `UPDATE hosted_l1_transactions SET next_attempt_at=clock_timestamp()
       WHERE operation_id=$1`, [row.operationId],
    )
    await publisher.processOnce()
    expect((await store.l1Transaction(row.operationId))?.status).toBe('BROADCAST')

    // Canonical reinclusion and finality retain evidence; a later corroborated
    // hash change is durably fenced for the manual recovery runbook.
    receipt = {
      transactionHash: row.transactionHash, blockHash: includedHash,
      blockNumber: '0x64', transactionIndex: '0x0', status: '0x1', type: '0x3',
    }
    finalizedNumber = 105n
    await runtime!.store['pool'].query(
      `UPDATE hosted_l1_transactions SET next_attempt_at=clock_timestamp()
       WHERE operation_id=$1`, [row.operationId],
    )
    await publisher.processOnce()
    const finalized = await store.l1Transaction(row.operationId)
    expect(finalized).toMatchObject({
      status: 'FINALIZED', blockNumber: '100', blockHash: includedHash,
      finalizedBlock: '105',
    })
    includedHash = hash('7')
    await publisher.processOnce()
    expect(await store.l1Transaction(row.operationId)).toMatchObject({
      status: 'RECOVERY_REQUIRED', blockNumber: '100', blockHash: hash('6'),
      finalizedBlock: '105',
    })
  }, 120_000)
})
