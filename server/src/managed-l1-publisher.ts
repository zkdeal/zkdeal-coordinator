import { createHash, randomUUID } from 'node:crypto'
import { bytesToHex, hexToBytes, keccak256, type Hex } from 'viem'
import type { HostedRuntime } from './hosted-runtime.js'
import type {
  HostedL1BindingKind,
  HostedL1OperationAccess,
  HostedL1Transaction,
} from './postgres-hosted-store.js'
import type { L1Eip1559TransactionSigner } from './l1-transaction-signer.js'
import { emitHostedTrace } from './structured-log.js'

export type ManagedL1OperationStatus =
  | 'RESERVED' | 'SIGNED' | 'BROADCAST' | 'INCLUDED' | 'FINALIZED'
  | 'FAILED' | 'RECOVERY_REQUIRED' | 'SUPERSEDED'

export interface ManagedL1OperationResult {
  operationId: string
  idempotencyKey: string
  correlationId: string
  status: ManagedL1OperationStatus
  chainId: number
  from: `0x${string}`
  to: `0x${string}`
  nonce: string
  transactionHash: `0x${string}` | null
  createdAt: string
  updatedAt: string
  blockNumber?: string
  blockHash?: `0x${string}`
  confirmations?: number
  receiptSource?: { providerIds: string[]; observedAt: string; canonical: true }
  finalized?: true
  failureCode?: string
  /** Operation-specific immutable linkage (safe identifiers and hashes only). */
  binding?: Record<string, unknown>
}

export interface ManagedL1PublishInput {
  idempotencyKey: string
  correlationId: string
  tenantId: string
  principalId: string
  to: `0x${string}`
  calldata: Hex
  payload: Record<string, unknown>
  minimumConfirmations: number
  requireFinalized: boolean
}

interface StoredManagedRequest {
  schemaVersion: 1
  operation: string
  bindingKind: HostedL1BindingKind
  chainId: number
  sender: `0x${string}`
  tenantId: string
  principalId: string
  correlationId: string
  to: `0x${string}`
  calldata: Hex
  value: string
  gas: string
  maxPriorityFeePerGas: string
  maxFeePerGas: string
  inclusionDeadline: string
  confirmationPolicy: { minimumConfirmations: number; requireFinalized: boolean }
  payload: Record<string, unknown>
}

export interface ManagedL1PublisherOptions {
  runtime: HostedRuntime
  chainId: number
  signer: L1Eip1559TransactionSigner
  operation: string
  bindingKind: HostedL1BindingKind
  gasLimit: bigint
  inclusionWindowBlocks?: bigint
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([,item]) => item !== undefined)
      .sort(([left],[right]) => left.localeCompare(right))
      .map(([key,item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function safeKey(value: string, field: string): string {
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(value)) throw new Error(`${field} must contain 8-200 safe characters`)
  return value
}

function address(value: unknown, field: string): `0x${string}` {
  const next=String(value ?? '').toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(next)) throw new Error(`${field} is malformed`)
  return next as `0x${string}`
}

function calldata(value: unknown): Hex {
  const next=String(value ?? '').toLowerCase()
  if (!/^0x(?:[0-9a-f]{2})*$/.test(next)) throw new Error('managed L1 calldata is malformed')
  return next as Hex
}

function integer(value: unknown,field: string): string {
  const next=String(value ?? '')
  if (!/^(?:0|[1-9][0-9]*)$/.test(next)) throw new Error(`${field} must be an unsigned canonical integer`)
  return BigInt(next).toString()
}

function status(value: HostedL1Transaction['status']): ManagedL1OperationStatus {
  return value === 'PREPARED' ? 'RESERVED' : value
}

/**
 * Fenced, content-addressed EIP-1559 operation publisher. Operation-specific
 * routes own ABI validation; this layer owns the signer/nonce/crash/finality
 * boundary and never reconstructs a request after a nonce has been reserved.
 */
export class ManagedL1Publisher {
  private readonly inclusionWindowBlocks: bigint

  constructor(private readonly options: ManagedL1PublisherOptions) {
    if (!Number.isSafeInteger(options.chainId) || options.chainId <= 0) throw new Error('managed L1 chainId is invalid')
    if (!/^[a-z][a-z0-9-]{2,63}$/.test(options.operation)) throw new Error('managed L1 operation name is invalid')
    if (options.gasLimit < 21_000n || options.gasLimit > 30_000_000n) throw new Error('managed L1 gas limit is unsafe')
    this.inclusionWindowBlocks=options.inclusionWindowBlocks ?? 64n
    if (this.inclusionWindowBlocks < 8n || this.inclusionWindowBlocks > 4_096n) {
      throw new Error('managed L1 inclusion window is outside 8 through 4096 blocks')
    }
  }

  get signerAddress(): `0x${string}` { return this.options.signer.address }

  async assertReady(): Promise<void> {
    await this.options.signer.assertReady()
    this.options.runtime.writableFence()
    await Promise.all([
      this.options.runtime.l1.agreedTransactionCount(this.options.signer.address,'pending'),
      this.options.runtime.l1.agreedEip1559Fees(),
    ])
  }

  private baseMatches(request: StoredManagedRequest,input: ManagedL1PublishInput): boolean {
    return request.schemaVersion===1 && request.operation===this.options.operation
      && request.bindingKind===this.options.bindingKind && request.chainId===this.options.chainId
      && request.sender===this.options.signer.address && request.tenantId===input.tenantId
      && request.correlationId===input.correlationId
      && request.to===address(input.to,'operation destination')
      && request.calldata===calldata(input.calldata)
      && request.confirmationPolicy.minimumConfirmations===input.minimumConfirmations
      && request.confirmationPolicy.requireFinalized===input.requireFinalized
      && canonical(request.payload)===canonical(input.payload)
  }

  private async requestFor(row: HostedL1Transaction): Promise<StoredManagedRequest> {
    const bytes=await this.options.runtime.objects.get(row.requestObjectKey)
    if (!bytes) throw new Error('durable managed L1 request object is missing')
    if (createHash('sha256').update(bytes).digest('hex')!==row.requestHash) {
      throw new Error('durable managed L1 request digest changed')
    }
    const request=JSON.parse(new TextDecoder().decode(bytes)) as StoredManagedRequest
    if (
      request.schemaVersion!==1 || request.operation!==row.operation || request.chainId!==row.chainId
      || address(request.sender,'stored sender')!==row.sender
      || address(request.to,'stored destination')!==row.destinationAddress
      || calldata(request.calldata)!==row.calldata
      || integer(request.inclusionDeadline,'stored inclusionDeadline')!==row.inclusionDeadline
    ) throw new Error('durable managed L1 request is not bound to its nonce journal')
    return request
  }

  private async raw(row: HostedL1Transaction): Promise<Hex> {
    if (!row.rawTransactionObjectKey || !row.transactionHash) throw new Error('managed L1 operation has no signed archive')
    const bytes=await this.options.runtime.objects.get(row.rawTransactionObjectKey)
    if (!bytes) throw new Error('durable managed L1 signed bytes are missing')
    const raw=bytesToHex(bytes)
    if (keccak256(raw).toLowerCase()!==row.transactionHash) throw new Error('managed L1 signed bytes changed hash')
    return raw
  }

  private async sign(row: HostedL1Transaction): Promise<HostedL1Transaction> {
    const request=await this.requestFor(row)
    const signed=await this.options.signer.signEip1559({
      chainId: request.chainId,nonce: BigInt(row.nonce),to: request.to,data: request.calldata,
      value: BigInt(request.value),gas: BigInt(request.gas),
      maxPriorityFeePerGas: BigInt(request.maxPriorityFeePerGas),maxFeePerGas: BigInt(request.maxFeePerGas),
    })
    const object=await this.options.runtime.objects.putContent(
      hexToBytes(signed.signedBody),'application/vnd.ethereum.signed-transaction',
    )
    return this.options.runtime.store.attachSignedL1Transaction(
      this.options.runtime.writableFence(),row.operationId,
      { transactionHash: signed.transactionHash,rawTransactionObjectKey: object.key,bundleObjectKey: null },
    )
  }

  private async broadcast(row: HostedL1Transaction): Promise<HostedL1Transaction> {
    if (!row.transactionHash) throw new Error('managed L1 operation has no transaction hash')
    await this.options.runtime.l1.broadcastRawTransaction(await this.raw(row),row.transactionHash)
    return this.options.runtime.store.markL1TransactionBroadcast(
      this.options.runtime.writableFence(),row.operationId,
    )
  }

  private async resume(row: HostedL1Transaction): Promise<HostedL1Transaction> {
    if (row.status==='PREPARED') row=await this.sign(row)
    if (row.status==='SIGNED') row=await this.broadcast(row)
    return row
  }

  async publish(input: ManagedL1PublishInput): Promise<ManagedL1OperationResult> {
    safeKey(input.idempotencyKey,'Idempotency-Key')
    safeKey(input.correlationId,'X-Correlation-Id')
    if (!Number.isSafeInteger(input.minimumConfirmations)
      || input.minimumConfirmations<1 || input.minimumConfirmations>4_096) {
      throw new Error('minimumConfirmations must be from 1 through 4096')
    }
    const existing=await this.options.runtime.store.l1TransactionByIdempotencyKey(input.idempotencyKey)
    if (existing) {
      if (existing.operation!==this.options.operation) throw new Error('idempotency key belongs to another L1 operation')
      const request=await this.requestFor(existing)
      if (!this.baseMatches(request,input)) throw new Error('L1 operation idempotency key is bound to a different request')
      const access=await this.options.runtime.store.l1OperationAccess(existing.operationId)
      if (!access) throw new Error('managed L1 operation access binding is missing')
      if (access.principalId!==input.principalId) {
        const [original,current]=await Promise.all([
          this.options.runtime.store.l1ServiceBinding(access.principalId),
          this.options.runtime.store.l1ServiceBinding(input.principalId),
        ])
        if (
          !original || !current || !original.active || !current.active
          || original.bindingKind!==current.bindingKind || original.chainId!==current.chainId
          || original.contractAddress!==current.contractAddress
          || original.expectedSender!==current.expectedSender || original.nodeId!==current.nodeId
          || original.roomId!==current.roomId || original.sponsorshipId!==current.sponsorshipId
          || original.allocationId!==current.allocationId || access.tenantId!==input.tenantId
        ) throw new Error('managed L1 operation access binding is missing')
      }
      return this.result(await this.resume(existing),access)
    }
    const [latest,fees]=await Promise.all([
      this.options.runtime.l1.agreedBlock('latest'),this.options.runtime.l1.agreedEip1559Fees(),
    ])
    const inclusionWindow=this.inclusionWindowBlocks > BigInt(input.minimumConfirmations+8)
      ? this.inclusionWindowBlocks : BigInt(input.minimumConfirmations+8)
    const request: StoredManagedRequest={
      schemaVersion:1,operation:this.options.operation,bindingKind:this.options.bindingKind,
      chainId:this.options.chainId,sender:this.options.signer.address,
      tenantId:input.tenantId,principalId:input.principalId,correlationId:input.correlationId,
      to:address(input.to,'operation destination'),calldata:calldata(input.calldata),value:'0',
      gas:this.options.gasLimit.toString(),maxPriorityFeePerGas:integer(fees.maxPriorityFeePerGas,'priority fee'),
      maxFeePerGas:integer(fees.maxFeePerGas,'maximum fee'),
      inclusionDeadline:(BigInt(latest.number)+inclusionWindow).toString(),
      confirmationPolicy:{ minimumConfirmations:input.minimumConfirmations,requireFinalized:input.requireFinalized },
      payload:input.payload,
    }
    const bytes=new TextEncoder().encode(canonical(request))
    const requestHash=createHash('sha256').update(bytes).digest('hex')
    const object=await this.options.runtime.objects.putContent(
      bytes,'application/vnd.zkdeal.managed-l1-operation+json',
    )
    if (object.sha256!==requestHash) throw new Error('managed L1 request object digest mismatch')
    const row=await this.options.runtime.store.reserveL1Transaction(this.options.runtime.writableFence(),{
      operationId:randomUUID(),chainId:this.options.chainId,sender:this.options.signer.address,
      operation:this.options.operation,idempotencyKey:input.idempotencyKey,requestHash,
      requestObjectKey:object.key,destinationAddress:request.to,calldata:request.calldata,
      inclusionDeadline:request.inclusionDeadline,
      remotePendingNonce:await this.options.runtime.l1.agreedTransactionCount(this.options.signer.address,'pending'),
      access:{ tenantId:input.tenantId,principalId:input.principalId,correlationId:input.correlationId,
        minimumConfirmations:input.minimumConfirmations,requireFinalized:input.requireFinalized,
        bindingKind:this.options.bindingKind },
    })
    const access=await this.options.runtime.store.l1OperationAccess(row.operationId)
    if (!access) throw new Error('managed L1 operation access row was not committed atomically')
    return this.result(await this.resume(row),access)
  }

  private async watch(row: HostedL1Transaction): Promise<HostedL1Transaction> {
    row=await this.resume(row)
    if (row.status==='BROADCAST') {
      const agreed=row.transactionHash
        ? await this.options.runtime.l1.agreedReceiptOptional(row.transactionHash) : null
      if (!agreed?.transaction) return this.broadcast(row)
      const receipt=agreed.transaction
      if (String(receipt.status).toLowerCase()==='0x0') {
        await this.options.runtime.store.markL1TransactionFailed(
          this.options.runtime.writableFence(),row.operationId,`${this.options.operation} reverted`,
        )
        return (await this.options.runtime.store.l1Transaction(row.operationId))!
      }
      row=await this.options.runtime.store.markL1TransactionIncluded(
        this.options.runtime.writableFence(),row.operationId,
        BigInt(String(receipt.blockNumber)).toString(),String(receipt.blockHash).toLowerCase() as `0x${string}`,
        receipt.gasUsed!=null && receipt.effectiveGasPrice!=null ? {
          gasUsed:BigInt(String(receipt.gasUsed)).toString(),
          effectiveGasPrice:BigInt(String(receipt.effectiveGasPrice)).toString(),
        } : undefined,
        { verifiedSources:agreed.verifiedSources },
      )
    }
    if (row.status==='INCLUDED') {
      const agreed=row.transactionHash
        ? await this.options.runtime.l1.agreedReceiptOptional(row.transactionHash) : null
      const receipt=agreed?.transaction
      if (!receipt || BigInt(String(receipt.blockNumber)).toString()!==row.blockNumber
        || String(receipt.blockHash).toLowerCase()!==row.blockHash) {
        row=await this.options.runtime.store.markL1TransactionRetracted(
          this.options.runtime.writableFence(),row.operationId,'canonical receipt disappeared or moved before finality',
        )
        return this.broadcast(row)
      }
      const finalized=await this.options.runtime.l1.agreedBlock('finalized')
      if (BigInt(finalized.number)>=BigInt(row.blockNumber!)) {
        const included=await this.options.runtime.l1.agreedBlock(`0x${BigInt(row.blockNumber!).toString(16)}`)
        if (included.hash.toLowerCase()!==row.blockHash) {
          row=await this.options.runtime.store.markL1TransactionRetracted(
            this.options.runtime.writableFence(),row.operationId,'included block changed before finality',
          )
          return this.broadcast(row)
        }
        row=await this.options.runtime.store.markL1TransactionFinalized(
          this.options.runtime.writableFence(),row.operationId,finalized.number,finalized.hash,
        )
      }
    }
    return row
  }

  async processOnce(limit=50): Promise<{ processed:number;errors:number;recoveryRequired:number }> {
    let processed=0;let errors=0;let recoveryRequired=0
    const latest=await this.options.runtime.l1.agreedBlock('latest')
    for (const initial of await this.options.runtime.store.pendingL1Transactions(limit,this.options.operation)) {
      const access=await this.options.runtime.store.l1OperationAccess(initial.operationId).catch(() => null)
      const storedRequest=await this.requestFor(initial).catch(() => null)
      const roomId=storedRequest && /^(?:0|[1-9][0-9]*)$/.test(String(storedRequest.payload.roomId ?? ''))
        ? String(storedRequest.payload.roomId) : null
      const trace={
        correlationId:access?.correlationId ?? `publisher:${initial.operationId}`,
        tenantId:access?.tenantId ?? null,roomId,jobId:null,operationId:initial.operationId,
        component:'publisher' as const,event:'operation.watch',
      }
      emitHostedTrace({ ...trace,outcome:'started' })
      try {
        if (initial.attempts>=32) {
          await this.options.runtime.store.markL1TransactionRecoveryRequired(
            this.options.runtime.writableFence(),initial.operationId,'bounded managed L1 attempts exhausted',
          );recoveryRequired+=1
          emitHostedTrace({ ...trace,outcome:'failed' })
          continue
        }
        const watched=await this.watch(initial);processed+=1
        emitHostedTrace({
          ...trace,event:`operation.${watched.status.toLowerCase()}`,
          outcome:watched.status==='RECOVERY_REQUIRED' || watched.status==='FAILED'
            ? 'failed' : watched.status==='INCLUDED' || watched.status==='FINALIZED' ? 'succeeded' : 'retrying',
        })
      } catch (error) {
        errors+=1
        const current=await this.options.runtime.store.l1Transaction(initial.operationId).catch(() => null)
        if (current && ['PREPARED','SIGNED','BROADCAST','INCLUDED'].includes(current.status)) {
          const reason=error instanceof Error ? error.message : 'managed L1 watcher failure'
          const backoffMs=Math.min(60_000,1_000*(2**Math.min(current.attempts,6)))
          await this.options.runtime.store.recordL1TransactionAttemptError(
            this.options.runtime.writableFence(),current.operationId,reason,backoffMs,
            BigInt(current.inclusionDeadline)<=BigInt(latest.number)+2n,
          ).catch(() => {})
        }
        emitHostedTrace({ ...trace,outcome:'retrying' })
      }
    }
    for (const row of await this.options.runtime.store.nextFinalizedL1AuditBatch(
      this.options.runtime.writableFence(),this.options.chainId,this.options.signer.address,limit,
    )) {
      if (row.operation!==this.options.operation || !row.blockNumber || !row.blockHash) continue
      try {
        const canonicalBlock=await this.options.runtime.l1.agreedBlock(`0x${BigInt(row.blockNumber).toString(16)}`)
        if (canonicalBlock.hash.toLowerCase()!==row.blockHash) {
          await this.options.runtime.store.markL1TransactionRetracted(
            this.options.runtime.writableFence(),row.operationId,
            'post-finality canonical block changed; manual recovery is required',canonicalBlock.verifiedSources,
          );recoveryRequired+=1
          const access=await this.options.runtime.store.l1OperationAccess(row.operationId).catch(() => null)
          emitHostedTrace({
            correlationId:access?.correlationId ?? `publisher:${row.operationId}`,
            tenantId:access?.tenantId ?? null,roomId:null,jobId:null,operationId:row.operationId,
            component:'publisher',event:'operation.post-finality-audit',outcome:'retracted',
          })
        }
      } catch {
        // Provider unavailability is not canonical reorg evidence.
      }
    }
    return { processed,errors,recoveryRequired }
  }

  async operation(operationId:string): Promise<ManagedL1OperationResult | null> {
    const [row,access]=await Promise.all([
      this.options.runtime.store.l1Transaction(operationId),
      this.options.runtime.store.l1OperationAccess(operationId),
    ])
    if (!row || !access || row.operation!==this.options.operation) return null
    return this.result(row,access)
  }

  private async result(row:HostedL1Transaction,access:HostedL1OperationAccess): Promise<ManagedL1OperationResult> {
    const request=await this.requestFor(row)
    const result:ManagedL1OperationResult={
      operationId:row.operationId,idempotencyKey:row.idempotencyKey,correlationId:access.correlationId,
      status:status(row.status),chainId:row.chainId,from:row.sender,
      to:row.destinationAddress!,nonce:row.nonce,transactionHash:row.transactionHash,
      createdAt:row.createdAt,updatedAt:row.updatedAt,
      binding:request.payload,
    }
    if (['FAILED','RECOVERY_REQUIRED','SUPERSEDED'].includes(row.status)) {
      result.failureCode=row.lastError ?? row.status
    }
    if ((row.status==='INCLUDED' || row.status==='FINALIZED') && row.transactionHash && row.blockNumber && row.blockHash) {
      const [receipt,latest]=await Promise.all([
        this.options.runtime.l1.agreedReceiptOptional(row.transactionHash),
        this.options.runtime.l1.agreedBlock('latest'),
      ])
      if (!receipt.transaction
        || BigInt(String(receipt.transaction.blockNumber)).toString()!==row.blockNumber
        || String(receipt.transaction.blockHash).toLowerCase()!==row.blockHash) {
        throw new Error('managed L1 operation no longer has canonical receipt evidence')
      }
      const sources=[...new Set([...row.receiptProviderIds,...receipt.verifiedSources])]
      if (sources.length<2 || !row.receiptCanonical) throw new Error('managed L1 receipt evidence is incomplete')
      const confirmations=BigInt(latest.number)>=BigInt(row.blockNumber)
        ? Number(BigInt(latest.number)-BigInt(row.blockNumber)+1n) : 0
      result.blockNumber=row.blockNumber;result.blockHash=row.blockHash;result.confirmations=confirmations
      result.receiptSource={ providerIds:sources,observedAt:row.receiptObservedAt ?? row.updatedAt,canonical:true }
      if (row.status==='FINALIZED') result.finalized=true
    }
    return result
  }
}
