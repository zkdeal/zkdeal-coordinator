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
  buildBlobBundleFromBlobs,
  decodeBlobBundle,
  encodeBlobBundle,
  verifyBlobBundle,
  verifySignedBlobTransaction,
  type BlobBundle,
} from './blob-archive.js'
import type { HostedRuntime } from './hosted-runtime.js'
import type { L1TransactionSigner } from './l1-transaction-signer.js'
import {
  aggregateBillingRequestBytes,
  aggregateBillingRequestHash,
  type AggregateBillingRequestBindingMember,
  type HostedL1BindingKind,
  type HostedL1OperationAccess,
  type HostedL1Transaction,
} from './postgres-hosted-store.js'
import type {
  ManagedL1OperationResult,
  ManagedL1OperationStatus,
  ManagedL1PublishInput,
} from './managed-l1-publisher.js'
import { emitHostedTrace } from './structured-log.js'

export interface ManagedBlobBillingInput {
  /** Exact on-chain aggregate statement hash emitted by AggregateMemberOutcome. */
  aggregateHash: `0x${string}`
  /** Ordered members bound to their exact durable proof-result digests. */
  members: AggregateBillingRequestBindingMember[]
}

export interface ManagedBlobPublishInput extends ManagedL1PublishInput {
  /** Exact 128 KiB blobs already committed by the proved DA manifests. */
  blobs: Hex[]
  /**
   * Success-only billing binding. Its canonical bytes become the durable row
   * request object, and its immutable manifest is registered at the SIGNED
   * boundary so the store's broadcast gate can never be reached without it.
   */
  billing: ManagedBlobBillingInput
}

export interface ManagedBlobPublisherOptions {
  runtime: HostedRuntime
  chainId: number
  signer: L1TransactionSigner
  operation: string
  bindingKind: HostedL1BindingKind
  gasLimit: bigint
  maxFeePerBlobGas: bigint
  inclusionWindowBlocks?: bigint
  beaconEndpoints?: readonly string[]
  request?: typeof globalThis.fetch
}

interface StoredManagedBlobRequest {
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
  maxFeePerBlobGas: string
  inclusionDeadline: string
  bundleObjectKey: string
  bundleSha256: string
  blobSha256s: string[]
  blobVersionedHashes: Hex[]
  commitments: Hex[]
  confirmationPolicy: { minimumConfirmations:number;requireFinalized:boolean }
  billing: ManagedBlobBillingInput
  payload: Record<string,unknown>
}

function canonical(value:unknown):string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value==='object') {
    return `{${Object.entries(value as Record<string,unknown>)
      .filter(([,item]) => item!==undefined)
      .sort(([left],[right]) => left.localeCompare(right))
      .map(([key,item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function safeKey(value:string,field:string):string {
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(value)) throw new Error(`${field} must contain 8-200 safe characters`)
  return value
}

function address(value:unknown,field:string):`0x${string}` {
  const next=String(value ?? '').toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(next)) throw new Error(`${field} is malformed`)
  return next as `0x${string}`
}

function data(value:unknown,field:string):Hex {
  const next=String(value ?? '').toLowerCase()
  if (!/^0x(?:[0-9a-f]{2})*$/.test(next)) throw new Error(`${field} is malformed`)
  return next as Hex
}

function hash32(value:unknown,field:string):`0x${string}` {
  const next=String(value ?? '').toLowerCase()
  if (!/^0x[0-9a-f]{64}$/.test(next)) throw new Error(`${field} is malformed`)
  return next as `0x${string}`
}

/** Normalize and bound-check the immutable billing binding before it is durable. */
function billingBinding(value:ManagedBlobBillingInput|undefined):ManagedBlobBillingInput {
  if (!value || !Array.isArray(value.members)) throw new Error('managed blob billing binding is required')
  if (value.members.length<1 || value.members.length>8) {
    throw new Error('billing members must contain 1 through 8 aggregate members')
  }
  const members=[...value.members]
    .sort((left,right) => left.memberIndex-right.memberIndex)
    .map((member,index) => {
      if (member.memberIndex!==index) throw new Error('billing member indices must be unique and contiguous from zero')
      if (!/^pj-[0-9a-f]{10,64}$/.test(member.jobId)) throw new Error('billing member jobId is malformed')
      if (!/^\d+$/.test(member.roomId) || !/^\d+$/.test(member.batchIndex)) {
        throw new Error('billing member room and batch ids must be unsigned decimals')
      }
      if (!/^[0-9a-f]{64}$/.test(member.resultDigest) || typeof member.resultObjectKey!=='string'
        || member.resultObjectKey.length<8) {
        throw new Error('billing member proof-result binding is malformed')
      }
      return {
        memberIndex:member.memberIndex,jobId:member.jobId,roomId:member.roomId,
        batchIndex:member.batchIndex,resultObjectKey:member.resultObjectKey,
        resultDigest:member.resultDigest,
      }
    })
  return { aggregateHash:hash32(value.aggregateHash,'billing aggregateHash'),members }
}

function integer(value:unknown,field:string):string {
  const next=String(value ?? '')
  if (!/^(?:0|[1-9][0-9]*)$/.test(next)) throw new Error(`${field} must be an unsigned canonical integer`)
  return BigInt(next).toString()
}

function status(value:HostedL1Transaction['status']):ManagedL1OperationStatus {
  return value==='PREPARED' ? 'RESERVED' : value
}

function blobDigest(blob:Hex):string {
  return createHash('sha256').update(hexToBytes(blob)).digest('hex')
}

/**
 * Managed type-3 publisher for exact proof-derived blobs. The KZG bundle and
 * request are durable before nonce signing; restart paths only reload the same
 * content-addressed wrapper and never invoke the signer once bytes exist.
 */
export class ManagedBlobPublisher {
  private readonly archive:BlobArchiveCoordinator
  private readonly inclusionWindowBlocks:bigint

  constructor(private readonly options:ManagedBlobPublisherOptions) {
    if (!Number.isSafeInteger(options.chainId) || options.chainId<=0) throw new Error('managed blob chainId is invalid')
    if (!/^[a-z][a-z0-9-]{2,63}$/.test(options.operation)) throw new Error('managed blob operation is invalid')
    if (options.gasLimit<21_000n || options.gasLimit>30_000_000n) throw new Error('managed blob gas limit is unsafe')
    if (options.maxFeePerBlobGas<=0n) throw new Error('managed blob maximum fee must be positive')
    this.inclusionWindowBlocks=options.inclusionWindowBlocks ?? 96n
    if (this.inclusionWindowBlocks<8n || this.inclusionWindowBlocks>4_096n) {
      throw new Error('managed blob inclusion window is outside 8 through 4096 blocks')
    }
    this.archive=new BlobArchiveCoordinator(
      options.runtime,options.beaconEndpoints ?? [],options.request ?? globalThis.fetch,
    )
  }

  get signerAddress():`0x${string}` { return this.options.signer.address }

  async assertReady():Promise<void> {
    await this.options.signer.assertReady()
    this.options.runtime.writableFence()
    await Promise.all([
      this.options.runtime.l1.agreedTransactionCount(this.options.signer.address,'pending'),
      this.options.runtime.l1.agreedEip1559Fees(),
    ])
  }

  private async bundleFor(request:StoredManagedBlobRequest):Promise<BlobBundle> {
    const bytes=await this.options.runtime.objects.get(request.bundleObjectKey)
    if (!bytes || createHash('sha256').update(bytes).digest('hex')!==request.bundleSha256) {
      throw new Error('durable managed blob bundle object changed digest')
    }
    const bundle=await verifyBlobBundle(
      decodeBlobBundle(bytes),request.blobVersionedHashes,request.commitments,
    )
    if (bundle.blobs.map(blobDigest).join(',')!==request.blobSha256s.join(',')) {
      throw new Error('durable managed blob payload changed identity')
    }
    return bundle
  }

  private async requestFor(row:HostedL1Transaction):Promise<StoredManagedBlobRequest> {
    if (!row.transportRequestHash || !row.transportRequestObjectKey) {
      throw new Error('managed blob operation has no durable transport request binding')
    }
    const bytes=await this.options.runtime.objects.get(row.transportRequestObjectKey)
    if (!bytes || createHash('sha256').update(bytes).digest('hex')!==row.transportRequestHash) {
      throw new Error('durable managed blob transport request changed digest')
    }
    const request=JSON.parse(new TextDecoder().decode(bytes)) as StoredManagedBlobRequest
    if (
      request.schemaVersion!==1 || request.operation!==row.operation || request.operation!==this.options.operation
      || request.bindingKind!==this.options.bindingKind || request.chainId!==row.chainId
      || address(request.sender,'stored sender')!==row.sender
      || address(request.to,'stored destination')!==row.destinationAddress
      || data(request.calldata,'stored calldata')!==row.calldata
      || integer(request.inclusionDeadline,'stored inclusion deadline')!==row.inclusionDeadline
    ) throw new Error('durable managed blob request is not bound to its nonce journal')
    const billing=billingBinding(request.billing)
    if (
      aggregateBillingRequestHash({
        chainId:row.chainId,aggregateHash:billing.aggregateHash,
        destinationAddress:request.to,calldata:request.calldata,members:billing.members,
      })!==row.requestHash
      || !row.requestObjectKey.toLowerCase().endsWith(row.requestHash)
    ) throw new Error('durable managed blob billing binding is not bound to its nonce journal')
    await this.bundleFor(request)
    return request
  }

  private baseMatches(
    request:StoredManagedBlobRequest,input:ManagedBlobPublishInput,bundle:BlobBundle,
  ):boolean {
    return request.tenantId===input.tenantId && request.principalId===input.principalId
      && request.correlationId===input.correlationId && request.to===address(input.to,'operation destination')
      && request.calldata===data(input.calldata,'operation calldata')
      && request.confirmationPolicy.minimumConfirmations===input.minimumConfirmations
      && request.confirmationPolicy.requireFinalized===input.requireFinalized
      && request.bundleSha256===createHash('sha256').update(encodeBlobBundle(bundle)).digest('hex')
      && request.blobSha256s.join(',')===bundle.blobs.map(blobDigest).join(',')
      && canonical(request.billing)===canonical(billingBinding(input.billing))
      && canonical(request.payload)===canonical(input.payload)
  }

  private async raw(row:HostedL1Transaction):Promise<Hex> {
    if (!row.rawTransactionObjectKey || !row.transactionHash) throw new Error('managed blob operation has no signed archive')
    const bytes=await this.options.runtime.objects.get(row.rawTransactionObjectKey)
    if (!bytes) throw new Error('durable managed blob signed wrapper is missing')
    return bytesToHex(bytes)
  }

  private async ensureArchive(row:HostedL1Transaction):Promise<void> {
    if (!row.transactionHash || !row.rawTransactionObjectKey || !row.bundleObjectKey) {
      throw new Error('managed blob row is missing exact archive keys')
    }
    const request=await this.requestFor(row)
    const bundle=await this.bundleFor(request)
    const raw=await this.raw(row)
    const identity=await verifySignedBlobTransaction(raw,bundle)
    if (identity.transactionHash.toLowerCase()!==row.transactionHash) {
      throw new Error('managed blob signed wrapper changed transaction hash')
    }
    const archived=await this.archive.archivePrepublished({
      chainId:this.options.chainId,transactionHash:row.transactionHash,signedTransaction:raw,bundle,
    })
    if (archived.signedTransactionObjectKey!==row.rawTransactionObjectKey
      || archived.bundleObjectKey!==row.bundleObjectKey) {
      throw new Error('managed blob nonce journal differs from the prepublish archive')
    }
  }

  private async sign(row:HostedL1Transaction):Promise<HostedL1Transaction> {
    const request=await this.requestFor(row)
    const bundle=await this.bundleFor(request)
    const signed=await this.options.signer.signEip4844({
      chainId:request.chainId,nonce:BigInt(row.nonce),to:request.to,data:request.calldata,
      value:BigInt(request.value),gas:BigInt(request.gas),
      maxPriorityFeePerGas:BigInt(request.maxPriorityFeePerGas),maxFeePerGas:BigInt(request.maxFeePerGas),
      maxFeePerBlobGas:BigInt(request.maxFeePerBlobGas),blobVersionedHashes:bundle.versionedHashes,
    })
    const parsed=parseTransaction(signed.signedBody)
    if (parsed.type!=='eip4844') throw new Error('managed blob signer returned a non-type-3 transaction')
    const wrapper=serializeTransaction({
      ...parsed,sidecars:bundle.blobs.map((blob,index) => ({
        blob,commitment:bundle.commitments[index]!,proof:bundle.proofs[index]!,
      })),
    } as TransactionSerializableEIP4844)
    const verified=await verifySignedBlobTransaction(wrapper,bundle)
    if (verified.transactionHash.toLowerCase()!==signed.transactionHash.toLowerCase()) {
      throw new Error('managed blob network wrapper changed the signed body hash')
    }
    const rawObject=await this.options.runtime.objects.putContent(
      hexToBytes(wrapper),'application/vnd.ethereum.signed-transaction',
    )
    const attached=await this.options.runtime.store.attachSignedL1Transaction(
      this.options.runtime.writableFence(),row.operationId,{
        transactionHash:signed.transactionHash,rawTransactionObjectKey:rawObject.key,
        bundleObjectKey:request.bundleObjectKey,
      },
    )
    await this.ensureArchive(attached)
    return attached
  }

  private async broadcast(row:HostedL1Transaction):Promise<HostedL1Transaction> {
    if (!row.transactionHash) throw new Error('managed blob operation has no transaction hash')
    await this.ensureArchive(row)
    await this.options.runtime.l1.broadcastRawTransaction(await this.raw(row),row.transactionHash)
    return this.options.runtime.store.markL1TransactionBroadcast(
      this.options.runtime.writableFence(),row.operationId,
    )
  }

  /**
   * The billing manifest is registered against the SIGNED, not-yet-broadcast
   * row. Registration is idempotent, so crash/replay paths re-register the
   * same immutable manifest; the store refuses broadcast without it.
   */
  private async registerBillingManifest(row:HostedL1Transaction):Promise<void> {
    const request=await this.requestFor(row)
    await this.options.runtime.store.registerAggregateBillingManifest(
      this.options.runtime.writableFence(),{
        chainId:row.chainId,aggregateHash:request.billing.aggregateHash,
        operationId:row.operationId,idempotencyKey:row.idempotencyKey,
        members:request.billing.members.map((member) => ({
          memberIndex:member.memberIndex,jobId:member.jobId,
          roomId:member.roomId,batchIndex:member.batchIndex,
        })),
      },
    )
  }

  private async resume(row:HostedL1Transaction):Promise<HostedL1Transaction> {
    if (row.status==='PREPARED') row=await this.sign(row)
    if (row.status==='SIGNED') {
      await this.registerBillingManifest(row)
      row=await this.broadcast(row)
    }
    return row
  }

  async publish(input:ManagedBlobPublishInput):Promise<ManagedL1OperationResult> {
    safeKey(input.idempotencyKey,'Idempotency-Key')
    safeKey(input.correlationId,'X-Correlation-Id')
    if (!Number.isSafeInteger(input.minimumConfirmations)
      || input.minimumConfirmations<1 || input.minimumConfirmations>4_096) {
      throw new Error('minimumConfirmations must be from 1 through 4096')
    }
    const bundle=await buildBlobBundleFromBlobs(input.blobs)
    const billing=billingBinding(input.billing)
    const existing=await this.options.runtime.store.l1TransactionByIdempotencyKey(input.idempotencyKey)
    if (existing) {
      if (existing.operation!==this.options.operation) throw new Error('idempotency key belongs to another L1 operation')
      // Scope adoption is checked before request drift so a cross-principal
      // replay is reported as the scoping violation it is, matching the
      // route-level 403 boundary.
      const access=await this.options.runtime.store.l1OperationAccess(existing.operationId)
      if (!access || access.principalId!==input.principalId || access.tenantId!==input.tenantId
        || access.bindingKind!==this.options.bindingKind) {
        throw new Error('managed blob operation belongs to another scoped principal')
      }
      const request=await this.requestFor(existing)
      if (!this.baseMatches(request,input,bundle)) {
        throw new Error('L1 operation idempotency key is bound to a different request')
      }
      return this.result(await this.resume(existing),access)
    }
    const bundleBytes=encodeBlobBundle(bundle)
    const bundleObject=await this.options.runtime.objects.putContent(
      bundleBytes,'application/vnd.zkdeal.blob-bundle+json',
    )
    const [latest,fees]=await Promise.all([
      this.options.runtime.l1.agreedBlock('latest'),this.options.runtime.l1.agreedEip1559Fees(),
    ])
    const inclusionWindow=this.inclusionWindowBlocks>BigInt(input.minimumConfirmations+8)
      ? this.inclusionWindowBlocks : BigInt(input.minimumConfirmations+8)
    const request:StoredManagedBlobRequest={
      schemaVersion:1,operation:this.options.operation,bindingKind:this.options.bindingKind,
      chainId:this.options.chainId,sender:this.options.signer.address,
      tenantId:input.tenantId,principalId:input.principalId,correlationId:input.correlationId,
      to:address(input.to,'operation destination'),calldata:data(input.calldata,'operation calldata'),
      value:'0',gas:this.options.gasLimit.toString(),
      maxPriorityFeePerGas:integer(fees.maxPriorityFeePerGas,'priority fee'),
      maxFeePerGas:integer(fees.maxFeePerGas,'maximum fee'),
      maxFeePerBlobGas:this.options.maxFeePerBlobGas.toString(),
      inclusionDeadline:(BigInt(latest.number)+inclusionWindow).toString(),
      bundleObjectKey:bundleObject.key,bundleSha256:bundleObject.sha256,
      blobSha256s:bundle.blobs.map(blobDigest),blobVersionedHashes:bundle.versionedHashes,
      commitments:bundle.commitments,
      confirmationPolicy:{ minimumConfirmations:input.minimumConfirmations,requireFinalized:input.requireFinalized },
      billing,payload:input.payload,
    }
    // The primary request binding IS the immutable billing binding: schema-28
    // requires request_hash to equal aggregateBillingRequestHash so the
    // manifest gate can verify calldata, members, and proof-result digests.
    const billingHash=aggregateBillingRequestHash({
      chainId:this.options.chainId,aggregateHash:billing.aggregateHash,
      destinationAddress:request.to,calldata:request.calldata,members:billing.members,
    })
    const billingObject=await this.options.runtime.objects.putContent(
      aggregateBillingRequestBytes({
        chainId:this.options.chainId,aggregateHash:billing.aggregateHash,
        destinationAddress:request.to,calldata:request.calldata,members:billing.members,
      }),'application/vnd.zkdeal.aggregate-billing-operation+json',
    )
    if (billingObject.sha256!==billingHash) throw new Error('aggregate billing request object digest mismatch')
    const requestBytes=new TextEncoder().encode(canonical(request))
    const requestHash=createHash('sha256').update(requestBytes).digest('hex')
    const requestObject=await this.options.runtime.objects.putContent(
      requestBytes,'application/vnd.zkdeal.managed-blob-operation+json',
    )
    if (requestObject.sha256!==requestHash) throw new Error('managed blob request object digest mismatch')
    const row=await this.options.runtime.store.reserveL1Transaction(this.options.runtime.writableFence(),{
      operationId:randomUUID(),chainId:this.options.chainId,sender:this.options.signer.address,
      operation:this.options.operation,idempotencyKey:input.idempotencyKey,requestHash:billingHash,
      requestObjectKey:billingObject.key,transportRequestHash:requestHash,
      transportRequestObjectKey:requestObject.key,
      destinationAddress:request.to,calldata:request.calldata,
      inclusionDeadline:request.inclusionDeadline,
      remotePendingNonce:await this.options.runtime.l1.agreedTransactionCount(this.options.signer.address,'pending'),
      access:{ tenantId:input.tenantId,principalId:input.principalId,correlationId:input.correlationId,
        minimumConfirmations:input.minimumConfirmations,requireFinalized:input.requireFinalized,
        bindingKind:this.options.bindingKind },
    })
    const access=await this.options.runtime.store.l1OperationAccess(row.operationId)
    if (!access) throw new Error('managed blob access row was not committed atomically')
    return this.result(await this.resume(row),access)
  }

  private async watch(row:HostedL1Transaction):Promise<HostedL1Transaction> {
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
          blobGasUsed:receipt.blobGasUsed==null ? null : BigInt(String(receipt.blobGasUsed)).toString(),
          blobGasPrice:receipt.blobGasPrice==null ? null : BigInt(String(receipt.blobGasPrice)).toString(),
        } : undefined,{ verifiedSources:agreed.verifiedSources },
      )
    }
    if (row.status==='INCLUDED') {
      const agreed=row.transactionHash
        ? await this.options.runtime.l1.agreedReceiptOptional(row.transactionHash) : null
      const receipt=agreed?.transaction
      if (!receipt || BigInt(String(receipt.blockNumber)).toString()!==row.blockNumber
        || String(receipt.blockHash).toLowerCase()!==row.blockHash) {
        row=await this.options.runtime.store.markL1TransactionRetracted(
          this.options.runtime.writableFence(),row.operationId,'canonical aggregate receipt disappeared before finality',
        )
        return this.broadcast(row)
      }
      const finalized=await this.options.runtime.l1.agreedBlock('finalized')
      if (BigInt(finalized.number)>=BigInt(row.blockNumber!)) {
        const included=await this.options.runtime.l1.agreedBlock(`0x${BigInt(row.blockNumber!).toString(16)}`)
        if (included.hash.toLowerCase()!==row.blockHash) {
          row=await this.options.runtime.store.markL1TransactionRetracted(
            this.options.runtime.writableFence(),row.operationId,'aggregate included block changed before finality',
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

  async processOnce(limit=50):Promise<{ processed:number;errors:number;recoveryRequired:number }> {
    let processed=0;let errors=0;let recoveryRequired=0
    const latest=await this.options.runtime.l1.agreedBlock('latest')
    for (const initial of await this.options.runtime.store.pendingL1Transactions(limit,this.options.operation)) {
      const access=await this.options.runtime.store.l1OperationAccess(initial.operationId).catch(() => null)
      const trace={
        correlationId:access?.correlationId ?? `publisher:${initial.operationId}`,
        tenantId:access?.tenantId ?? null,roomId:null,jobId:null,operationId:initial.operationId,
        component:'publisher' as const,event:'aggregate.watch',
      }
      emitHostedTrace({ ...trace,outcome:'started' })
      try {
        if (initial.attempts>=32) {
          await this.options.runtime.store.markL1TransactionRecoveryRequired(
            this.options.runtime.writableFence(),initial.operationId,'bounded managed aggregate attempts exhausted',
          );recoveryRequired+=1;emitHostedTrace({ ...trace,outcome:'failed' });continue
        }
        const watched=await this.watch(initial);processed+=1
        emitHostedTrace({ ...trace,event:`aggregate.${watched.status.toLowerCase()}`,
          outcome:watched.status==='FAILED' || watched.status==='RECOVERY_REQUIRED' ? 'failed'
            : watched.status==='INCLUDED' || watched.status==='FINALIZED' ? 'succeeded' : 'retrying' })
      } catch (error) {
        errors+=1
        const current=await this.options.runtime.store.l1Transaction(initial.operationId).catch(() => null)
        if (current && ['PREPARED','SIGNED','BROADCAST','INCLUDED'].includes(current.status)) {
          const reason=error instanceof Error ? error.message : 'managed aggregate watcher failure'
          const backoff=Math.min(60_000,1_000*(2**Math.min(current.attempts,6)))
          await this.options.runtime.store.recordL1TransactionAttemptError(
            this.options.runtime.writableFence(),current.operationId,reason,backoff,
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
            'post-finality aggregate block changed; manual recovery is required',canonicalBlock.verifiedSources,
          );recoveryRequired+=1
        }
      } catch {
        // Provider unavailability is not reorg evidence.
      }
    }
    return { processed,errors,recoveryRequired }
  }

  async operation(operationId:string):Promise<ManagedL1OperationResult|null> {
    const [row,access]=await Promise.all([
      this.options.runtime.store.l1Transaction(operationId),
      this.options.runtime.store.l1OperationAccess(operationId),
    ])
    if (!row || !access || row.operation!==this.options.operation) return null
    return this.result(row,access)
  }

  private async result(row:HostedL1Transaction,access:HostedL1OperationAccess):Promise<ManagedL1OperationResult> {
    const request=await this.requestFor(row)
    const result:ManagedL1OperationResult={
      operationId:row.operationId,idempotencyKey:row.idempotencyKey,correlationId:access.correlationId,
      status:status(row.status),chainId:row.chainId,from:row.sender,to:row.destinationAddress!,nonce:row.nonce,
      transactionHash:row.transactionHash,createdAt:row.createdAt,updatedAt:row.updatedAt,binding:request.payload,
    }
    if (['FAILED','RECOVERY_REQUIRED','SUPERSEDED'].includes(row.status)) result.failureCode=row.lastError ?? row.status
    if ((row.status==='INCLUDED' || row.status==='FINALIZED') && row.transactionHash && row.blockNumber && row.blockHash) {
      const [receipt,latest]=await Promise.all([
        this.options.runtime.l1.agreedReceiptOptional(row.transactionHash),this.options.runtime.l1.agreedBlock('latest'),
      ])
      if (!receipt.transaction || BigInt(String(receipt.transaction.blockNumber)).toString()!==row.blockNumber
        || String(receipt.transaction.blockHash).toLowerCase()!==row.blockHash) {
        throw new Error('managed aggregate no longer has canonical receipt evidence')
      }
      const sources=[...new Set([...row.receiptProviderIds,...receipt.verifiedSources])]
      if (sources.length<2 || !row.receiptCanonical) throw new Error('managed aggregate receipt evidence is incomplete')
      result.blockNumber=row.blockNumber;result.blockHash=row.blockHash
      result.confirmations=BigInt(latest.number)>=BigInt(row.blockNumber)
        ? Number(BigInt(latest.number)-BigInt(row.blockNumber)+1n) : 0
      result.receiptSource={ providerIds:sources,observedAt:row.receiptObservedAt ?? row.updatedAt,canonical:true }
      if (row.status==='FINALIZED') result.finalized=true
    }
    return result
  }
}
