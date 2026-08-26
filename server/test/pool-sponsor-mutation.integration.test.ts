import { createServer,type Server } from 'node:http'
import { keccak256,type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { HostedRuntime } from '../src/hosted-runtime.js'
import type {
  Eip1559TransactionToSign,L1Eip1559TransactionSigner,SignedEip1559TransactionBody,
} from '../src/l1-transaction-signer.js'
import { ManagedL1Publisher,type ManagedL1PublishInput } from '../src/managed-l1-publisher.js'

const databaseUrl=process.env.TEST_DATABASE_URL
const objectStoreEndpoint=process.env.TEST_OBJECT_STORE_ENDPOINT
const integration=databaseUrl && objectStoreEndpoint ? describe : describe.skip
const hash=(byte:string) => `0x${byte.repeat(64)}` as `0x${string}`
const address=(byte:string) => `0x${byte.repeat(40)}` as `0x${string}`

async function listen(server:Server):Promise<string> {
  await new Promise<void>((resolve) => server.listen(0,'127.0.0.1',resolve))
  const bound=server.address()
  if (!bound || typeof bound==='string') throw new Error('sponsor mutation test server did not bind')
  return `http://127.0.0.1:${bound.port}`
}

class DeterministicSponsorSigner implements L1Eip1559TransactionSigner {
  private readonly account=privateKeyToAccount(`0x${'53'.repeat(32)}`)
  readonly address=this.account.address.toLowerCase() as `0x${string}`
  calls=0
  failNext=false
  async assertReady():Promise<void> {}
  async signEip1559(input:Eip1559TransactionToSign):Promise<SignedEip1559TransactionBody> {
    this.calls+=1
    if (this.failNext) { this.failNext=false;throw new Error('injected sponsor signer outage') }
    const signedBody=await this.account.signTransaction({
      type:'eip1559',...input,nonce:Number(input.nonce),accessList:[],
    } as never)
    return { signedBody,transactionHash:keccak256(signedBody).toLowerCase() as `0x${string}` }
  }
}

integration('ManagedL1Publisher pool-sponsor mutation crash/reorg recovery',() => {
  const servers:Server[]=[]
  const signer=new DeterministicSponsorSigner()
  const broadcasts:Hex[]=[]
  let runtime:HostedRuntime|null=null
  let publisher:ManagedL1Publisher
  let principalId:string
  let receipt:Record<string,unknown>|null=null
  let latestNumber=110n
  let finalizedNumber=99n
  let includedHash=hash('6')
  let disagreeReceipt=false

  // The route layer alone derives sponsor calldata from the pinned RoomPool
  // ABI. This suite exercises the durable signer/nonce/broadcast/finality
  // boundary the sponsor mutation rides on, with the exact operation name and
  // binding kind the coordinator wires for POST
  // /hosting/v1/l1-operations/pool-sponsor-mutations.
  const input:ManagedL1PublishInput={
    idempotencyKey:'pool-sponsor-mutation-crash-001',correlationId:'pool-sponsor:crash:001',
    tenantId:'tenant-sponsor',principalId:'pending',to:address('b'),calldata:'0xf180fe5d',
    minimumConfirmations:12,requireFinalized:true,
    payload:{ schemaVersion:1,chainId:31_337,roomPool:address('b'),
      expectedSponsorAccount:'pending',sponsorshipId:'sponsorship-crash-001',
      beneficiaryTenantId:'tenant-sponsor',beneficiary:address('c'),
      mutationKind:'renewRoomForWithPermit',selector:'0xf180fe5d',
      previousAllocationId:hash('7'),maxTokenCharge:'1000',
      permit:{ value:'1000',deadline:'1787317200' },
      calldataHash:keccak256('0xf180fe5d'),
      confirmationPolicy:{ minimumConfirmations:12,requireFinalized:true } },
  }

  beforeAll(async () => {
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
          broadcasts.push(raw);result=keccak256(raw)
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
      chainId:31_337,databaseUrl:databaseUrl!,apiKeyPepper:'pool-sponsor-mutation-pepper-00001',
      coordinatorId:'pool-sponsor-region-a',coordinatorRole:'active',
      l1RpcUrl:rpcUrls[0]!,l1RpcUrls:rpcUrls,l1RpcProviderIds:['sponsor-rpc-a','sponsor-rpc-b'],
      poolSponsorSignerUrl:'http://127.0.0.1:1',poolSponsorSignerAddress:signer.address,
      poolSponsorSignerAuthToken:'pool-sponsor-signer-token-00000001',
      objectStoreEndpoint:objectStoreEndpoint!,objectStoreBucket:process.env.TEST_OBJECT_STORE_BUCKET ?? 'zkdeal-it',
      objectStoreRegion:'us-east-1',objectStoreAccessKeyId:process.env.TEST_OBJECT_STORE_ACCESS_KEY ?? 'zkdealminio',
      objectStoreSecretAccessKey:process.env.TEST_OBJECT_STORE_SECRET_KEY ?? 'zkdeal-minio-test-secret',
      objectStorePrefix:'pool-sponsor-mutation-it',dataDir:'/tmp/zkdeal-pool-sponsor-mutation-it',
    })
    runtime=await HostedRuntime.create(config)
    if (!runtime) throw new Error('pool sponsor runtime did not start')
    await runtime.store.upsertTenant(runtime.writableFence(),{
      tenantId:'tenant-sponsor',displayName:'Sponsor Tenant',tier:'integration',
    })
    const principal=await runtime.store.provisionPrincipal(runtime.writableFence(),{
      tenantId:'tenant-sponsor',kind:'service',roles:['l1-pool-sponsor'],
    })
    principalId=principal.principalId
    input.principalId=principalId
    input.payload.expectedSponsorAccount=signer.address
    await runtime.store.assignL1ServiceBinding(runtime.writableFence(),{
      principalId,bindingKind:'pool-sponsor',chainId:31_337,
      contractAddress:address('b'),expectedSender:signer.address,
      sponsorshipId:'sponsorship-crash-001',
    })
    publisher=new ManagedL1Publisher({
      runtime,chainId:31_337,signer,operation:'pool-sponsor-mutation',bindingKind:'pool-sponsor',
      gasLimit:5_000_000n,
    })
  },120_000)

  afterAll(async () => {
    await runtime?.close()
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  })

  it('persists before signing, reuses exact bytes, and fails closed on ambiguous or moved receipts',async () => {
    const store=runtime!.store
    const originalReserve=store.reserveL1Transaction.bind(store)
    let reserveCrash=true
    store.reserveL1Transaction=(async (...args:Parameters<typeof originalReserve>) => {
      if (reserveCrash) { reserveCrash=false;throw new Error('injected crash before sponsor nonce reserve') }
      return originalReserve(...args)
    }) as typeof store.reserveL1Transaction
    await expect(publisher.publish(input)).rejects.toThrow('before sponsor nonce reserve')
    expect(await store.pendingL1Transactions(50,'pool-sponsor-mutation')).toHaveLength(0)
    store.reserveL1Transaction=originalReserve

    // Signer outage after the durable reserve: the request object and nonce
    // journal survive; no signed bytes exist yet.
    signer.failNext=true
    await expect(publisher.publish(input)).rejects.toThrow('sponsor signer outage')
    let row=(await store.pendingL1Transactions(50,'pool-sponsor-mutation'))[0]!
    expect(row).toMatchObject({ nonce:'5',status:'PREPARED',transactionHash:null })

    // Crash after the signed archive commit: restart resumes without a second
    // signature and broadcasts the exact archived bytes.
    const originalAttach=store.attachSignedL1Transaction.bind(store)
    let attachCrash=true
    store.attachSignedL1Transaction=(async (...args:Parameters<typeof originalAttach>) => {
      const attached=await originalAttach(...args)
      if (attachCrash) { attachCrash=false;throw new Error('injected crash after sponsor signed attach') }
      return attached
    }) as typeof store.attachSignedL1Transaction
    await expect(publisher.publish(input)).rejects.toThrow('sponsor signed attach')
    const callsAfterSigned=signer.calls
    row=(await store.pendingL1Transactions(50,'pool-sponsor-mutation'))[0]!
    expect(row.status).toBe('SIGNED')
    expect(await runtime!.objects.get(row.rawTransactionObjectKey!)).not.toBeNull()
    store.attachSignedL1Transaction=originalAttach

    const originalBroadcast=store.markL1TransactionBroadcast.bind(store)
    let markerCrash=true
    store.markL1TransactionBroadcast=(async (...args:Parameters<typeof originalBroadcast>) => {
      if (markerCrash) { markerCrash=false;throw new Error('injected crash before sponsor broadcast marker') }
      return originalBroadcast(...args)
    }) as typeof store.markL1TransactionBroadcast
    await expect(publisher.publish(input)).rejects.toThrow('sponsor broadcast marker')
    store.markL1TransactionBroadcast=originalBroadcast
    const recovered=await publisher.publish(input)
    expect(recovered).toMatchObject({ nonce:'5',status:'BROADCAST',binding:input.payload })
    expect(signer.calls).toBe(callsAfterSigned)
    expect(new Set(broadcasts)).toHaveLength(1)

    // Idempotent replay returns the same durable operation without re-signing.
    const replay=await publisher.publish(input)
    expect(replay.operationId).toBe(recovered.operationId)
    expect(signer.calls).toBe(callsAfterSigned)
    // A different immutable request under the same key is refused.
    await expect(publisher.publish({ ...input,minimumConfirmations:13 }))
      .rejects.toThrow('bound to a different request')
    // A principal without the exact immutable binding cannot adopt the
    // operation.
    await expect(publisher.publish({ ...input,principalId:'svc_00000000000000000000' }))
      .rejects.toThrow('access binding is missing')

    row=(await store.l1Transaction(recovered.operationId))!
    receipt={ transactionHash:row.transactionHash,blockHash:includedHash,blockNumber:'0x64',
      transactionIndex:'0x0',status:'0x1',type:'0x2',gasUsed:'0x100',effectiveGasPrice:'0x2' }
    await runtime!.store['pool'].query(
      `UPDATE hosted_l1_transactions SET next_attempt_at=clock_timestamp() WHERE operation_id=$1`,[row.operationId],
    )
    // Ambiguous receipt evidence from the two providers is not inclusion.
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

    // A receipt that disappears before finality retracts and rebroadcasts the
    // identical archived bytes.
    receipt=null
    await runtime!.store['pool'].query(
      `UPDATE hosted_l1_transactions SET next_attempt_at=clock_timestamp() WHERE operation_id=$1`,[row.operationId],
    )
    await publisher.processOnce()
    expect((await store.l1Transaction(row.operationId))?.status).toBe('BROADCAST')
    expect(new Set(broadcasts)).toHaveLength(1)
    expect(signer.calls).toBe(callsAfterSigned)

    receipt={ transactionHash:row.transactionHash,blockHash:includedHash,blockNumber:'0x64',
      transactionIndex:'0x0',status:'0x1',type:'0x2',gasUsed:'0x100',effectiveGasPrice:'0x2' }
    finalizedNumber=105n
    await runtime!.store['pool'].query(
      `UPDATE hosted_l1_transactions SET next_attempt_at=clock_timestamp() WHERE operation_id=$1`,[row.operationId],
    )
    await publisher.processOnce();await publisher.processOnce()
    expect((await store.l1Transaction(row.operationId))?.status).toBe('FINALIZED')
    const final=await publisher.operation(row.operationId)
    expect(final).toMatchObject({ finalized:true,blockNumber:'100',blockHash:includedHash,
      binding:{ sponsorshipId:'sponsorship-crash-001',mutationKind:'renewRoomForWithPermit',selector:'0xf180fe5d' },
      receiptSource:{ canonical:true,providerIds:expect.arrayContaining(['sponsor-rpc-a','sponsor-rpc-b']) } })

    // A post-finality canonical surprise enters RECOVERY_REQUIRED; the sponsor
    // escrow effect is then owner-audited, never silently rewritten.
    includedHash=hash('7')
    const audit=await publisher.processOnce()
    expect(audit.recoveryRequired).toBeGreaterThanOrEqual(1)
    expect((await store.l1Transaction(row.operationId))?.status).toBe('RECOVERY_REQUIRED')
  },120_000)
})
