import { createHash, randomUUID } from 'node:crypto'
import {
  bytesToHex,
  hexToBytes,
  parseTransaction,
  serializeTransaction,
  type Hex,
  type TransactionSerializableEIP4844,
} from 'viem'
import {
  BlobArchiveCoordinator,
  buildBlobBundle,
  encodeBlobBundle,
  verifySignedBlobTransaction,
} from './blob-archive.js'
import type { HostedRuntime } from './hosted-runtime.js'
import type { HostedL1Transaction } from './postgres-hosted-store.js'
import type { L1TransactionSigner } from './l1-transaction-signer.js'

export interface BlobPublishRequest {
  to: `0x${string}`
  calldata: Hex
  blobData: Hex
  value: string
  gas: string
  maxPriorityFeePerGas: string
  maxFeePerGas: string
  maxFeePerBlobGas: string
  inclusionDeadline: string
}

export interface BlobPublishResult {
  operationId: string
  transactionHash: `0x${string}` | null
  status: HostedL1Transaction['status']
  nonce: string
}

interface StoredBlobPublishRequest extends BlobPublishRequest {
  schemaVersion: 1
  chainId: number
  sender: `0x${string}`
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function hex(value: unknown, bytes: number | null, field: string): Hex {
  const text = String(value ?? '').toLowerCase()
  const expression = bytes === null ? /^0x(?:[0-9a-f]{2})*$/ : new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`)
  if (!expression.test(text)) throw new Error(`${field} is malformed`)
  return text as Hex
}

function decimal(value: unknown, field: string, allowZero = true): string {
  const text = String(value ?? '')
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) throw new Error(`${field} must be an unsigned canonical decimal`)
  const parsed = BigInt(text)
  if (!allowZero && parsed === 0n) throw new Error(`${field} must be greater than zero`)
  return parsed.toString()
}

function normalizeRequest(
  input: BlobPublishRequest,
  chainId: number,
  sender: `0x${string}`,
): StoredBlobPublishRequest {
  const request: StoredBlobPublishRequest = {
    schemaVersion: 1,
    chainId,
    sender: hex(sender, 20, 'sender') as `0x${string}`,
    to: hex(input.to, 20, 'to') as `0x${string}`,
    calldata: hex(input.calldata, null, 'calldata'),
    blobData: hex(input.blobData, null, 'blobData'),
    value: decimal(input.value, 'value'),
    gas: decimal(input.gas, 'gas', false),
    maxPriorityFeePerGas: decimal(input.maxPriorityFeePerGas, 'maxPriorityFeePerGas'),
    maxFeePerGas: decimal(input.maxFeePerGas, 'maxFeePerGas', false),
    maxFeePerBlobGas: decimal(input.maxFeePerBlobGas, 'maxFeePerBlobGas', false),
    inclusionDeadline: decimal(input.inclusionDeadline, 'inclusionDeadline', false),
  }
  if (BigInt(request.maxPriorityFeePerGas) > BigInt(request.maxFeePerGas)) {
    throw new Error('maxPriorityFeePerGas cannot exceed maxFeePerGas')
  }
  if (request.blobData === '0x') throw new Error('blobData cannot be empty')
  return request
}

function encodeRequest(request: StoredBlobPublishRequest): Uint8Array {
  return new TextEncoder().encode(canonical(request))
}

function decodeRequest(bytes: Uint8Array): StoredBlobPublishRequest {
  const value = JSON.parse(new TextDecoder().decode(bytes)) as BlobPublishRequest & {
    schemaVersion?: unknown
    chainId?: unknown
    sender?: unknown
  }
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.chainId) || Number(value.chainId) <= 0) {
    throw new Error('stored blob publish request has an unsupported schema')
  }
  return normalizeRequest(value, Number(value.chainId), hex(value.sender, 20, 'stored sender') as `0x${string}`)
}

function rowResult(row: HostedL1Transaction): BlobPublishResult {
  return {
    operationId: row.operationId,
    transactionHash: row.transactionHash,
    status: row.status,
    nonce: row.nonce,
  }
}

/** Durable, nonce-safe EIP-4844 publisher owned by a fenced hosted writer. */
export class BlobPublisher {
  private readonly archive: BlobArchiveCoordinator

  constructor(
    private readonly runtime: HostedRuntime,
    private readonly chainId: number,
    private readonly signer: L1TransactionSigner,
    beaconEndpoints: readonly string[] = [],
    request: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.archive = new BlobArchiveCoordinator(runtime, beaconEndpoints, request)
  }

  async assertReady(): Promise<void> {
    await this.signer.assertReady()
    if (this.signer.address.toLowerCase() === '0x0000000000000000000000000000000000000000') {
      throw new Error('L1 publisher signer cannot be the zero address')
    }
    this.runtime.writableFence()
    await this.runtime.l1.agreedTransactionCount(this.signer.address, 'pending')
  }

  async publish(idempotencyKey: string, input: BlobPublishRequest): Promise<BlobPublishResult> {
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
      throw new Error('Idempotency-Key must contain 8-200 safe characters')
    }
    const request = normalizeRequest(input, this.chainId, this.signer.address)
    const latest = await this.runtime.l1.agreedBlock('latest')
    if (BigInt(request.inclusionDeadline) <= BigInt(latest.number)) {
      throw new Error('blob publish inclusionDeadline has already passed')
    }
    const bytes = encodeRequest(request)
    const requestHash = createHash('sha256').update(bytes).digest('hex')
    const object = await this.runtime.objects.putContent(
      bytes, 'application/vnd.zkdeal.blob-publish-request+json',
    )
    if (object.sha256 !== requestHash) throw new Error('blob publish request object digest mismatch')
    const remotePendingNonce = await this.runtime.l1.agreedTransactionCount(this.signer.address, 'pending')
    let row = await this.runtime.store.reserveL1Transaction(this.runtime.writableFence(), {
      operationId: randomUUID(),
      chainId: this.chainId,
      sender: this.signer.address,
      operation: 'publish-blob',
      idempotencyKey,
      requestHash,
      requestObjectKey: object.key,
      destinationAddress: request.to,
      calldata: request.calldata,
      inclusionDeadline: request.inclusionDeadline,
      remotePendingNonce,
    })
    if (row.status === 'PREPARED') row = await this.signPrepared(row)
    if (row.status === 'SIGNED') row = await this.broadcast(row)
    return rowResult(row)
  }

  private async requestFor(row: HostedL1Transaction): Promise<StoredBlobPublishRequest> {
    const bytes = await this.runtime.objects.get(row.requestObjectKey)
    if (!bytes) throw new Error('durable blob publish request object is missing')
    const requestHash = createHash('sha256').update(bytes).digest('hex')
    if (requestHash !== row.requestHash) throw new Error('durable blob publish request hash mismatch')
    const request = decodeRequest(bytes)
    if (
      request.chainId !== row.chainId
      || request.sender !== row.sender
      || request.calldata !== row.calldata
      || request.inclusionDeadline !== row.inclusionDeadline
    ) throw new Error('durable blob publish request is not bound to its nonce journal row')
    return request
  }

  private async signPrepared(row: HostedL1Transaction): Promise<HostedL1Transaction> {
    const request = await this.requestFor(row)
    const bundle = await buildBlobBundle(request.blobData)
    const signed = await this.signer.signEip4844({
      chainId: request.chainId,
      nonce: BigInt(row.nonce),
      to: request.to,
      data: request.calldata,
      value: BigInt(request.value),
      gas: BigInt(request.gas),
      maxPriorityFeePerGas: BigInt(request.maxPriorityFeePerGas),
      maxFeePerGas: BigInt(request.maxFeePerGas),
      maxFeePerBlobGas: BigInt(request.maxFeePerBlobGas),
      blobVersionedHashes: bundle.versionedHashes,
    })
    const parsed = parseTransaction(signed.signedBody)
    if (parsed.type !== 'eip4844') throw new Error('L1 signer returned a non-blob transaction')
    const wrapper = serializeTransaction({
      ...parsed,
      sidecars: bundle.blobs.map((blob, index) => ({
        blob,
        commitment: bundle.commitments[index]!,
        proof: bundle.proofs[index]!,
      })),
    } as TransactionSerializableEIP4844)
    const verified = await verifySignedBlobTransaction(wrapper, bundle)
    if (verified.transactionHash !== signed.transactionHash) {
      throw new Error('signed body hash changed while constructing the EIP-4844 network wrapper')
    }
    // Stage content-addressed exact bytes, then bind them to the nonce journal.
    // If the process dies after this row transition, restart recovery never
    // asks the signer again: broadcast() reconstructs/verifies the archive from
    // these immutable keys before any RPC submission.
    const bundleObject = await this.runtime.objects.putContent(
      encodeBlobBundle(bundle), 'application/vnd.zkdeal.blob-bundle+json',
    )
    const rawObject = await this.runtime.objects.putContent(
      hexToBytes(wrapper), 'application/vnd.ethereum.signed-transaction',
    )
    const attached = await this.runtime.store.attachSignedL1Transaction(this.runtime.writableFence(), row.operationId, {
      transactionHash: signed.transactionHash,
      rawTransactionObjectKey: rawObject.key,
      bundleObjectKey: bundleObject.key,
    })
    await this.ensureArchive(attached)
    return attached
  }

  private async rawTransaction(row: HostedL1Transaction): Promise<Hex> {
    if (!row.rawTransactionObjectKey || !row.transactionHash) throw new Error('signed L1 row has no durable bytes')
    const bytes = await this.runtime.objects.get(row.rawTransactionObjectKey)
    if (!bytes) throw new Error('durable signed L1 transaction object is missing')
    return bytesToHex(bytes)
  }

  private async ensureArchive(row: HostedL1Transaction): Promise<void> {
    if (!row.transactionHash || !row.rawTransactionObjectKey || !row.bundleObjectKey) {
      throw new Error('signed L1 row is missing its content-addressed archive keys')
    }
    const request = await this.requestFor(row)
    const bundle = await buildBlobBundle(request.blobData)
    const raw = await this.rawTransaction(row)
    const identity = await verifySignedBlobTransaction(raw, bundle)
    if (identity.transactionHash !== row.transactionHash) {
      throw new Error('durable signed L1 bytes do not match their nonce journal transaction hash')
    }
    const archived = await this.archive.archivePrepublished({
      chainId: this.chainId,
      transactionHash: row.transactionHash,
      signedTransaction: raw,
      bundle,
    })
    if (
      archived.signedTransactionObjectKey !== row.rawTransactionObjectKey
      || archived.bundleObjectKey !== row.bundleObjectKey
    ) throw new Error('durable L1 row does not match the verified prepublish archive')
  }

  private async broadcast(row: HostedL1Transaction): Promise<HostedL1Transaction> {
    if (!row.transactionHash) throw new Error('signed L1 row has no transaction hash')
    await this.ensureArchive(row)
    const raw = await this.rawTransaction(row)
    await this.runtime.l1.broadcastRawTransaction(raw, row.transactionHash)
    return this.runtime.store.markL1TransactionBroadcast(this.runtime.writableFence(), row.operationId)
  }

  private async receipt(row: HostedL1Transaction): Promise<Record<string, unknown> | null> {
    if (!row.transactionHash) return null
    return (await this.runtime.l1.agreedReceiptOptional(row.transactionHash)).transaction
  }

  async processOnce(limit = 50): Promise<{ processed: number; errors: number; recoveryRequired: number }> {
    let processed = 0
    let errors = 0
    let recoveryRequired = 0
    const latest = await this.runtime.l1.agreedBlock('latest')
    const rows = await this.runtime.store.pendingL1Transactions(limit, 'publish-blob')
    for (const initial of rows) {
      let row = initial
      try {
        if (row.attempts >= 32) {
          await this.runtime.store.markL1TransactionRecoveryRequired(
            this.runtime.writableFence(), row.operationId,
            'bounded automatic publish attempts exhausted; operator recovery is required',
          )
          recoveryRequired += 1
          continue
        }
        if (row.status === 'PREPARED') row = await this.signPrepared(row)
        if (row.status === 'SIGNED') row = await this.broadcast(row)
        if (row.status === 'BROADCAST') {
          const receipt = await this.receipt(row)
          if (!receipt) {
            await this.broadcast(row)
            processed += 1
            continue
          }
          if (String(receipt.status ?? '').toLowerCase() !== '0x1') {
            await this.runtime.store.markL1TransactionFailed(
              this.runtime.writableFence(), row.operationId, 'canonical L1 receipt reverted',
            )
            processed += 1
            continue
          }
          row = await this.runtime.store.markL1TransactionIncluded(
            this.runtime.writableFence(), row.operationId,
            BigInt(String(receipt.blockNumber)).toString(),
            String(receipt.blockHash).toLowerCase() as `0x${string}`,
            receipt.gasUsed != null && receipt.effectiveGasPrice != null
              ? {
                  gasUsed: BigInt(String(receipt.gasUsed)).toString(),
                  effectiveGasPrice: BigInt(String(receipt.effectiveGasPrice)).toString(),
                  blobGasUsed: receipt.blobGasUsed == null ? null : BigInt(String(receipt.blobGasUsed)).toString(),
                  blobGasPrice: receipt.blobGasPrice == null ? null : BigInt(String(receipt.blobGasPrice)).toString(),
                }
              : undefined,
          )
        }
        if (row.status === 'INCLUDED') {
          const receipt = await this.receipt(row)
          if (
            !receipt
            || BigInt(String(receipt.blockNumber)).toString() !== row.blockNumber
            || String(receipt.blockHash).toLowerCase() !== row.blockHash
          ) {
            row = await this.runtime.store.markL1TransactionRetracted(
              this.runtime.writableFence(), row.operationId, 'canonical receipt disappeared or moved before finality',
            )
            await this.broadcast(row)
            processed += 1
            continue
          }
          const finalized = await this.runtime.l1.agreedBlock('finalized')
          if (BigInt(finalized.number) >= BigInt(row.blockNumber!)) {
            const included = await this.runtime.l1.agreedBlock(
              `0x${BigInt(row.blockNumber!).toString(16)}`,
            )
            if (included.hash.toLowerCase() !== row.blockHash) {
              row = await this.runtime.store.markL1TransactionRetracted(
                this.runtime.writableFence(), row.operationId,
                'included block hash changed before the finality transition',
              )
              await this.broadcast(row)
              processed += 1
              continue
            }
            await this.runtime.store.markL1TransactionFinalized(
              this.runtime.writableFence(), row.operationId, finalized.number, finalized.hash,
            )
          }
        }
        processed += 1
      } catch (error) {
        // Durable state remains retryable. A worker never consumes a second
        // nonce or mutates signed bytes merely because an RPC/signer is down.
        errors += 1
        const current = await this.runtime.store.l1Transaction(row.operationId).catch(() => null)
        if (current && ['PREPARED', 'SIGNED', 'BROADCAST', 'INCLUDED'].includes(current.status)) {
          const reason = error instanceof Error ? error.message : 'unknown publisher processing failure'
          if (current.attempts >= 31) {
            await this.runtime.store.markL1TransactionRecoveryRequired(
              this.runtime.writableFence(), current.operationId,
              `bounded automatic publish attempts exhausted: ${reason}`,
            ).then(() => { recoveryRequired += 1 }).catch(() => {})
          } else {
            const backoffMs = Math.min(60_000, 1_000 * (2 ** Math.min(current.attempts, 6)))
            const deadlineRisk = BigInt(current.inclusionDeadline) <= BigInt(latest.number) + 2n
            await this.runtime.store.recordL1TransactionAttemptError(
              this.runtime.writableFence(), current.operationId, reason, backoffMs, deadlineRisk,
            ).catch(() => {})
          }
        }
      }
    }

    // Static post-finality surprise hook: a corroborated canonical block hash
    // change cannot be auto-healed. Fence the fact as RECOVERY_REQUIRED and
    // emit statusRetracted for the operator runbook/alert path.
    for (const row of await this.runtime.store.nextFinalizedL1AuditBatch(
      this.runtime.writableFence(), this.chainId, this.signer.address, limit,
    )) {
      if (!row.blockNumber || !row.blockHash) continue
      try {
        const canonicalBlock = await this.runtime.l1.agreedBlock(
          `0x${BigInt(row.blockNumber).toString(16)}`,
        )
        if (canonicalBlock.hash.toLowerCase() !== row.blockHash) {
          await this.runtime.store.markL1TransactionRetracted(
            this.runtime.writableFence(), row.operationId,
            'post-finality canonical block hash changed; manual recovery is required',
            canonicalBlock.verifiedSources,
          )
          recoveryRequired += 1
        }
      } catch {
        // Provider unavailability alone is not evidence of a finalized reorg.
      }
    }
    return { processed, errors, recoveryRequired }
  }

  async operation(operationId: string): Promise<BlobPublishResult | null> {
    const row = await this.runtime.store.l1Transaction(operationId)
    return row ? rowResult(row) : null
  }
}
