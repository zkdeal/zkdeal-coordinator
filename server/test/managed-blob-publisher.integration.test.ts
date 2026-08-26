import { createServer,type Server } from 'node:http'
import { resolve } from 'node:path'
import {
  encodeFunctionData,keccak256,parseTransaction,serializeTransaction,
  type AbiParameter,type Hex,type TransactionSerializableEIP4844,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { initializeBlobKzg } from '../src/blob-archive.js'
import { loadConfig } from '../src/config.js'
import { loadContractAbi } from '../src/hosted-indexer.js'
import { HostedRuntime } from '../src/hosted-runtime.js'
import type {
  BlobTransactionToSign,L1TransactionSigner,SignedBlobTransactionBody,
} from '../src/l1-transaction-signer.js'
import { ManagedBlobPublisher,type ManagedBlobPublishInput } from '../src/managed-blob-publisher.js'

const databaseUrl=process.env.TEST_DATABASE_URL
const objectStoreEndpoint=process.env.TEST_OBJECT_STORE_ENDPOINT
const integration=databaseUrl && objectStoreEndpoint ? describe : describe.skip
const hash=(byte:string) => `0x${byte.repeat(64)}` as `0x${string}`
const address=(byte:string) => `0x${byte.repeat(40)}` as `0x${string}`
const managerAbi=loadContractAbi(resolve(
  import.meta.dirname,
  '../../../web3-protocol/contracts/out/IRoomManager.sol/IRoomManager.json',
))

function dummyAbiValue(parameter:AbiParameter):unknown {
  if (parameter.type.endsWith('[]')) return []
  if (parameter.type==='tuple') return tupleAbiValue(parameter)
  if (parameter.type==='address') return `0x${'00'.repeat(20)}`
  if (parameter.type==='bool') return false
  if (parameter.type==='string') return ''
  if (parameter.type==='bytes') return '0x'
  const fixedBytes=/^bytes([0-9]+)$/.exec(parameter.type)
  if (fixedBytes) return `0x${'00'.repeat(Number(fixedBytes[1]))}`
  if (/^(?:u?int)[0-9]*$/.test(parameter.type)) return 0n
  throw new Error(`no aggregate fixture for ABI type ${parameter.type}`)
}

function tupleAbiValue(parameter:AbiParameter):Record<string,unknown> {
  const components='components' in parameter ? parameter.components : []
  return Object.fromEntries(components.map((component,index) => [
    component.name || String(index),dummyAbiValue(component),
  ]))
}

function aggregateCalldata(members:Array<{ roomId:string;batchIndex:string }>):`0x${string}` {
  const fn=managerAbi.find((item) => item.type==='function' && item.name==='submitAggregate')
  if (!fn || fn.type!=='function') throw new Error('submitAggregate ABI is absent')
  const aggregateParameter=fn.inputs[0]!
  const aggregate=tupleAbiValue(aggregateParameter)
  const memberParameter=('components' in aggregateParameter ? aggregateParameter.components : [])
    .find((component) => component.name==='members')!
  aggregate.members=members.map((binding) => {
    const member=tupleAbiValue({ ...memberParameter,type:'tuple' } as AbiParameter)
    member.roomId=BigInt(binding.roomId)
    const submission=member.submission as Record<string,unknown>
    const journal=submission.journal as Record<string,unknown>
    journal.roomId=BigInt(binding.roomId)
    journal.batchIndex=BigInt(binding.batchIndex)
    member.submission=submission
    return member
  })
  aggregate.aggregateSeal='0x01'
  return encodeFunctionData({ abi:[fn],functionName:'submitAggregate',args:[aggregate] })
}

async function listen(server:Server):Promise<string> {
  await new Promise<void>((resolve) => server.listen(0,'127.0.0.1',resolve))
  const bound=server.address()
  if (!bound || typeof bound==='string') throw new Error('managed aggregate test server did not bind')
  return `http://127.0.0.1:${bound.port}`
}

function networkHash(raw:Hex):`0x${string}` {
  const parsed=parseTransaction(raw)
  if (parsed.type!=='eip4844') throw new Error('test expected an EIP-4844 transaction')
  return keccak256(serializeTransaction({
    ...parsed,sidecars:undefined,blobs:undefined,kzg:undefined,
  } as TransactionSerializableEIP4844)).toLowerCase() as `0x${string}`
}

class DeterministicAggregateSigner implements L1TransactionSigner {
  private readonly account=privateKeyToAccount(`0x${'43'.repeat(32)}`)
  readonly address=this.account.address.toLowerCase() as `0x${string}`
  calls=0
  failNext=false
  async assertReady():Promise<void> {}
  async signEip4844(input:BlobTransactionToSign):Promise<SignedBlobTransactionBody> {
    this.calls+=1
    if (this.failNext) { this.failNext=false;throw new Error('injected aggregate signer outage') }
    const signedBody=await this.account.signTransaction({
      type:'eip4844',...input,nonce:Number(input.nonce),accessList:[],
    } as never)
    return { signedBody,transactionHash:keccak256(signedBody).toLowerCase() as `0x${string}` }
  }
}

integration('ManagedBlobPublisher aggregate crash/reorg recovery',() => {
  const servers:Server[]=[]
  const signer=new DeterministicAggregateSigner()
  const broadcasts:Hex[]=[]
  let runtime:HostedRuntime|null=null
  let publisher:ManagedBlobPublisher
  let principalId:string
  let receipt:Record<string,unknown>|null=null
  let latestNumber=110n
  let finalizedNumber=99n
  let includedHash=hash('6')
  let disagreeReceipt=false

  const blob=`0x${'00'.repeat(131_072)}` as Hex
  const memberJobId=`pj-${'ab'.repeat(10)}`
  const memberResultDigest='d'.repeat(64)
  const memberResultObjectKey=`zkdeal/sha256/dd/${memberResultDigest}`
  const calldata=aggregateCalldata([{ roomId:'7',batchIndex:'1' }])
  const input:ManagedBlobPublishInput={
    idempotencyKey:'managed-aggregate-crash-001',correlationId:'aggregate:crash:001',
    tenantId:'tenant-aggregate',principalId:'pending',to:address('b'),calldata,
    blobs:[blob],minimumConfirmations:12,requireFinalized:true,
    billing:{ aggregateHash:hash('a'),members:[{
      memberIndex:0,jobId:memberJobId,roomId:'7',batchIndex:'1',
      resultObjectKey:memberResultObjectKey,resultDigest:memberResultDigest,
    }] },
    payload:{ schemaVersion:1,kind:'ROOM_AGGREGATE',chainId:31_337,
      roomManager:address('b'),expectedOperationsAccount:signer.address,selector:'0x5e8b37ac',
      calldataHash:keccak256(calldata),transactionType:3,members:[{ memberIndex:0,roomId:'7',batchIndex:'1' }] },
  }

  beforeAll(async () => {
    await initializeBlobKzg()
    const rpc=(source:'a'|'b') => createServer((incoming,response) => {
      const chunks:Buffer[]=[]
      incoming.on('data',(chunk) => chunks.push(Buffer.from(chunk)))
      incoming.on('end',() => {
        const body=JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id:unknown;method:string;params:unknown[] }
        let result:unknown
        if (body.method==='eth_chainId') result='0x7a69'
        else if (body.method==='eth_getTransactionCount') result='0x5'
        else if (body.method==='eth_maxPriorityFeePerGas') result='0x2'
        else if (body.method==='eth_sendRawTransaction') {
          const raw=String(body.params[0]) as Hex
          broadcasts.push(raw);result=networkHash(raw)
        } else if (body.method==='eth_getTransactionReceipt') {
          result=disagreeReceipt && source==='b' && receipt
            ? { ...receipt,blockHash:hash('7') } : receipt
        } else if (body.method==='eth_getBlockByNumber') {
          const tag=String(body.params[0])
          const number=tag==='finalized' ? finalizedNumber : tag==='latest' ? latestNumber : BigInt(tag)
          const blockHash=number===100n ? includedHash : hash(number%2n===0n ? '8':'9')
          result={ number:`0x${number.toString(16)}`,hash:blockHash,parentHash:hash('5'),
            timestamp:`0x${(1_700_000_000n+number).toString(16)}`,
            parentBeaconBlockRoot:hash('4'),baseFeePerGas:'0x9' }
        } else result=null
        response.setHeader('content-type','application/json')
        response.end(JSON.stringify({ jsonrpc:'2.0',id:body.id,result }))
      })
    })
    const a=rpc('a'),b=rpc('b');servers.push(a,b)
    const rpcUrls=[await listen(a),await listen(b)]
    const config=loadConfig({
      chainId:31_337,databaseUrl:databaseUrl!,apiKeyPepper:'managed-aggregate-publisher-pepper-0001',
      coordinatorId:'managed-aggregate-region-a',coordinatorRole:'active',
      l1RpcUrl:rpcUrls[0]!,l1RpcUrls:rpcUrls,l1RpcProviderIds:['aggregate-rpc-a','aggregate-rpc-b'],
      aggregateSignerUrl:'http://127.0.0.1:1',aggregateSignerAddress:signer.address,
      aggregateSignerAuthToken:'aggregate-signer-token-00000001',
      objectStoreEndpoint:objectStoreEndpoint!,objectStoreBucket:process.env.TEST_OBJECT_STORE_BUCKET ?? 'zkdeal-it',
      objectStoreRegion:'us-east-1',objectStoreAccessKeyId:process.env.TEST_OBJECT_STORE_ACCESS_KEY ?? 'zkdealminio',
      objectStoreSecretAccessKey:process.env.TEST_OBJECT_STORE_SECRET_KEY ?? 'zkdeal-minio-test-secret',
      objectStorePrefix:'managed-aggregate-publisher-it',dataDir:'/tmp/zkdeal-managed-aggregate-it',
    })
    runtime=await HostedRuntime.create(config)
    if (!runtime) throw new Error('managed aggregate runtime did not start')
    await runtime.store.upsertTenant(runtime.writableFence(),{
      tenantId:'tenant-aggregate',displayName:'Aggregate Tenant',tier:'integration',
    })
    const principal=await runtime.store.provisionPrincipal(runtime.writableFence(),{
      tenantId:'tenant-aggregate',kind:'service',roles:['l1-aggregate-submit'],
    })
    principalId=principal.principalId
    input.principalId=principalId
    await runtime.store.assignL1ServiceBinding(runtime.writableFence(),{
      principalId,bindingKind:'room-aggregate',chainId:31_337,
      contractAddress:address('b'),expectedSender:signer.address,
    })
    // The billing manifest gate binds each member to a completed quoted proof
    // job, so the fixture drives one job through the real queue lifecycle.
    if (!await runtime.store.getProveJob(memberJobId)) {
      await runtime.store.publishBillingPrice(runtime.writableFence(),{
        tenantId:'tenant-aggregate',unit:'proof-work',currency:'GBP',unitPrice:'1',
        effectiveFrom:'2020-01-01T00:00:00.000Z',idempotencyKey:'managed-aggregate-price-001',
      })
      await runtime.store.upsertProofProfile(runtime.writableFence(),{
        proofClass:'managed-aggregate-member-proof',endpoint:'/v5/rooms/prove',needsGpu:false,
        estimatedWork:'1',estimatedProofTimeMs:1_000,settlementMarginMs:1_000,
        evidence:{ fixture:'managed-blob-publisher-it' },verifiedAt:new Date().toISOString(),
      })
      const node=await runtime.store.provisionPrincipal(runtime.writableFence(),{
        tenantId:'tenant-aggregate',kind:'node',roles:['prove-node'],
      })
      await runtime.store.assignProviderNode(runtime.writableFence(),{
        principalId:node.principalId,providerId:'managed-aggregate-provider',active:true,
        gpu:false,gpuResourceId:null,partitions:['shared'],tenantIds:['tenant-aggregate'],
        allocationIds:[],proofClasses:['managed-aggregate-member-proof'],
        maxConcurrentJobs:1,leaseTtlMs:60_000,
      })
      await runtime.store.submitProveJob(runtime.writableFence(),{
        jobId:memberJobId,retryOfJobId:null,chainId:31_337,tenantId:'tenant-aggregate',roomId:'7',
        allocationId:null,sponsorshipId:null,serviceClass:'batch',correlationId:'aggregate:crash:001',
        partition:'shared',proofClass:'managed-aggregate-member-proof',endpoint:'/v5/rooms/prove',
        idempotencyKey:'managed-aggregate-crash-job-001',requestHash:'c'.repeat(64),
        requestObjectKey:`zkdeal/sha256/cc/${'c'.repeat(64)}`,requestBytes:100,
        deadlineAt:null,priority:0,billingMode:'quoted',
        maximumChargeAmount:'100',maximumChargeCurrency:'GBP',
      })
      const leased=await runtime.store.leaseProveJob(runtime.writableFence(),node.principalId)
      if (leased?.jobId!==memberJobId) throw new Error('managed aggregate fixture job did not lease')
      await runtime.store.completeProveJob(
        runtime.writableFence(),memberJobId,node.principalId,memberResultObjectKey,memberResultDigest,
      )
    }
    publisher=new ManagedBlobPublisher({
      runtime,chainId:31_337,signer,operation:'publish-aggregate',bindingKind:'room-aggregate',
      gasLimit:12_000_000n,maxFeePerBlobGas:3_000_000_000n,
    })
  },120_000)

  afterAll(async () => {
    await runtime?.close()
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  })

  it('prearchives sidecars, reuses exact bytes, and rejects ambiguous receipt evidence',async () => {
    const store=runtime!.store
    const originalReserve=store.reserveL1Transaction.bind(store)
    let reserveCrash=true
    store.reserveL1Transaction=(async (...args:Parameters<typeof originalReserve>) => {
      if (reserveCrash) { reserveCrash=false;throw new Error('injected crash before aggregate nonce reserve') }
      return originalReserve(...args)
    }) as typeof store.reserveL1Transaction
    await expect(publisher.publish(input)).rejects.toThrow('before aggregate nonce reserve')
    expect(await store.pendingL1Transactions(50,'publish-aggregate')).toHaveLength(0)
    store.reserveL1Transaction=originalReserve

    signer.failNext=true
    await expect(publisher.publish(input)).rejects.toThrow('aggregate signer outage')
    let row=(await store.pendingL1Transactions(50,'publish-aggregate'))[0]!
    expect(row).toMatchObject({ nonce:'5',status:'PREPARED',transactionHash:null })

    const originalAttach=store.attachSignedL1Transaction.bind(store)
    let attachCrash=true
    store.attachSignedL1Transaction=(async (...args:Parameters<typeof originalAttach>) => {
      const attached=await originalAttach(...args)
      if (attachCrash) { attachCrash=false;throw new Error('injected crash after aggregate signed attach') }
      return attached
    }) as typeof store.attachSignedL1Transaction
    await expect(publisher.publish(input)).rejects.toThrow('aggregate signed attach')
    const callsAfterSigned=signer.calls
    row=(await store.pendingL1Transactions(50,'publish-aggregate'))[0]!
    expect(row.status).toBe('SIGNED')
    expect(await runtime!.objects.get(row.rawTransactionObjectKey!)).not.toBeNull()
    store.attachSignedL1Transaction=originalAttach

    // The store refuses any broadcast marker before the immutable billing
    // manifest exists for this exact signed aggregate operation.
    await expect(store.markL1TransactionBroadcast(runtime!.writableFence(),row.operationId))
      .rejects.toThrow('cannot broadcast before its immutable billing manifest')
    const originalRegister=store.registerAggregateBillingManifest.bind(store)
    let registerCrash=true
    store.registerAggregateBillingManifest=(async (...args:Parameters<typeof originalRegister>) => {
      if (registerCrash) { registerCrash=false;throw new Error('injected crash before aggregate billing manifest') }
      return originalRegister(...args)
    }) as typeof store.registerAggregateBillingManifest
    await expect(publisher.publish(input)).rejects.toThrow('before aggregate billing manifest')
    expect(broadcasts).toHaveLength(0)
    row=(await store.pendingL1Transactions(50,'publish-aggregate'))[0]!
    expect(row.status).toBe('SIGNED')
    store.registerAggregateBillingManifest=originalRegister

    const originalArchive=store.recordBlobArchive.bind(store)
    let archiveCrash=true
    store.recordBlobArchive=(async (...args:Parameters<typeof originalArchive>) => {
      await originalArchive(...args)
      if (archiveCrash) { archiveCrash=false;throw new Error('injected crash after aggregate prepublish archive') }
    }) as typeof store.recordBlobArchive
    await expect(publisher.publish(input)).rejects.toThrow('aggregate prepublish archive')
    expect(signer.calls).toBe(callsAfterSigned)
    store.recordBlobArchive=originalArchive
    const manifest=await runtime!.store['pool'].query(
      `SELECT member_count FROM hosted_aggregate_billing_manifests WHERE operation_id=$1`,
      [row.operationId],
    )
    expect(manifest.rowCount).toBe(1)

    const originalBroadcast=store.markL1TransactionBroadcast.bind(store)
    let markerCrash=true
    store.markL1TransactionBroadcast=(async (...args:Parameters<typeof originalBroadcast>) => {
      if (markerCrash) { markerCrash=false;throw new Error('injected crash before aggregate broadcast marker') }
      return originalBroadcast(...args)
    }) as typeof store.markL1TransactionBroadcast
    await expect(publisher.publish(input)).rejects.toThrow('aggregate broadcast marker')
    store.markL1TransactionBroadcast=originalBroadcast
    const recovered=await publisher.publish(input)
    expect(recovered).toMatchObject({ nonce:'5',status:'BROADCAST',binding:input.payload })
    expect(signer.calls).toBe(callsAfterSigned)
    expect(new Set(broadcasts)).toHaveLength(1)
    // hosted_blob_archives rows are immutable and carry no status column:
    // archive rows exist only after full KZG/signed-body verification, with
    // archiveSource/verifiedSources as the verification evidence. Per-room
    // VERIFIED status lives on hosted_blob_requirements and is enforced at
    // settlement by blobArchiveReadyThrough, not on this record.
    const archived=await store.blobArchive(31_337,recovered.transactionHash!)
    expect(archived).toMatchObject({ archiveSource:'hosted-prepublish',verifiedSources:['hosted-publisher'] })
    expect(await runtime!.objects.get(archived!.bundleObjectKey)).not.toBeNull()
    const broadcastWrapper=parseTransaction(broadcasts[0]!)
    expect(broadcastWrapper.type==='eip4844' ? broadcastWrapper.blobVersionedHashes : [])
      .toEqual(archived!.versionedHashes)

    await expect(publisher.publish({ ...input,principalId:'svc_00000000000000000000' }))
      .rejects.toThrow('another scoped principal')

    row=(await store.l1Transaction(recovered.operationId))!
    receipt={ transactionHash:row.transactionHash,blockHash:includedHash,blockNumber:'0x64',
      transactionIndex:'0x0',status:'0x1',type:'0x3',gasUsed:'0x100',effectiveGasPrice:'0x2',
      blobGasUsed:'0x20000',blobGasPrice:'0x3' }
    await runtime!.store['pool'].query(
      `UPDATE hosted_l1_transactions SET next_attempt_at=clock_timestamp() WHERE operation_id=$1`,[row.operationId],
    )
    disagreeReceipt=true
    const ambiguous=await publisher.processOnce()
    expect(ambiguous.errors).toBe(1)
    expect((await store.l1Transaction(row.operationId))?.status).toBe('BROADCAST')
    disagreeReceipt=false
    await runtime!.store['pool'].query(
      `UPDATE hosted_l1_transactions SET next_attempt_at=clock_timestamp() WHERE operation_id=$1`,[row.operationId],
    )
    await publisher.processOnce()
    expect((await store.l1Transaction(row.operationId))?.status).toBe('INCLUDED')

    receipt=null
    await runtime!.store['pool'].query(
      `UPDATE hosted_l1_transactions SET next_attempt_at=clock_timestamp() WHERE operation_id=$1`,[row.operationId],
    )
    await publisher.processOnce()
    expect((await store.l1Transaction(row.operationId))?.status).toBe('BROADCAST')

    receipt={ transactionHash:row.transactionHash,blockHash:includedHash,blockNumber:'0x64',
      transactionIndex:'0x0',status:'0x1',type:'0x3',gasUsed:'0x100',effectiveGasPrice:'0x2',
      blobGasUsed:'0x20000',blobGasPrice:'0x3' }
    finalizedNumber=105n
    await runtime!.store['pool'].query(
      `UPDATE hosted_l1_transactions SET next_attempt_at=clock_timestamp() WHERE operation_id=$1`,[row.operationId],
    )
    await publisher.processOnce();await publisher.processOnce()
    expect((await store.l1Transaction(row.operationId))?.status).toBe('FINALIZED')
    const final=await publisher.operation(row.operationId)
    expect(final).toMatchObject({ finalized:true,blockNumber:'100',blockHash:includedHash,
      receiptSource:{ canonical:true,providerIds:expect.arrayContaining(['aggregate-rpc-a','aggregate-rpc-b']) } })

    includedHash=hash('7')
    const audit=await publisher.processOnce()
    expect(audit.recoveryRequired).toBeGreaterThanOrEqual(1)
    expect((await store.l1Transaction(row.operationId))?.status).toBe('RECOVERY_REQUIRED')
  },120_000)
})
