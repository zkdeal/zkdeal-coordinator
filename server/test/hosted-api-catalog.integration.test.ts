import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createApp, type AppContext } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { HostedRuntime } from '../src/hosted-runtime.js'
import { createPostgresPool, type SqlPool } from '../src/postgres-hosted-store.js'
import { encodeAbiParameters, encodeFunctionData, encodeFunctionResult, keccak256, type AbiParameter, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { loadContractAbi } from '../src/hosted-indexer.js'
import { executionPolicyHashV5 } from '../src/execution-policy-v5.js'
import type {
  ManagedL1OperationResult,
  ManagedL1PublishInput,
  ManagedL1Publisher,
} from '../src/managed-l1-publisher.js'
import { HostedOwnerClient } from '../../../app-node/packages/room-node/src/hosted-lifecycle.js'
import { buildBlobBundleFromBlobs } from '../src/blob-archive.js'
import type { ManagedBlobPublishInput,ManagedBlobPublisher } from '../src/managed-blob-publisher.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const objectStoreEndpoint = process.env.TEST_OBJECT_STORE_ENDPOINT
const integration = databaseUrl && objectStoreEndpoint ? describe : describe.skip
const hash = (byte: string) => `0x${byte.repeat(64)}` as `0x${string}`
const address = (byte: string) => `0x${byte.repeat(40)}` as `0x${string}`
const managerAbi = loadContractAbi(resolve(
  import.meta.dirname,'../../../web3-protocol/contracts/out/IRoomManager.sol/IRoomManager.json',
))
const poolAbi=loadContractAbi(resolve(
  import.meta.dirname,'../../../web3-protocol/contracts/out/RoomPoolManager.sol/RoomPoolManager.json',
))
const poolHostingAbi=loadContractAbi(resolve(
  import.meta.dirname,'../../../web3-protocol/contracts/out/RoomPoolHostingFacet.sol/RoomPoolHostingFacet.json',
))
const walletAccount=privateKeyToAccount(`0x${'11'.repeat(32)}`)
const wrongWalletAccount=privateKeyToAccount(`0x${'22'.repeat(32)}`)
const walletAllocationId=hash('7')
const provingPolicy = {
  state_commitment:1,max_blocks_per_batch:8,max_transactions_per_block:1024,
  max_gas_per_block:30_000_000,max_memory_bytes:268_435_456,
  allow_contract_creation:false,allow_self_destruct:false,
  code:[],calls:[],storage:[],imports:[],participant_registry:null,
}
const provingPolicyHash=executionPolicyHashV5(provingPolicy)
const rustProvingPolicyHash='0x19e8cd5b38fc34be9aa28be1460d33c3c1e7083da85c70646f4a6ca95216375a'
const rustLiabilitiesHash='0x90f7330755d3c4e04b3f84c7183918722b36d96a2cb1bf864b80f8d84ebfb1aa'

function jsonAbiValue(parameter: AbiParameter): unknown {
  if (/\[[0-9]*\]$/.test(parameter.type)) return []
  if (parameter.type==='tuple') {
    const components='components' in parameter ? parameter.components : []
    return Object.fromEntries(components.map((component,index) => [
      component.name || String(index),jsonAbiValue(component),
    ]))
  }
  if (/^u?int[0-9]*$/.test(parameter.type)) return '0'
  if (parameter.type==='bool') return false
  if (parameter.type==='address') return address('0')
  if (parameter.type==='bytes') return '0x'
  const fixed=/^bytes([0-9]+)$/.exec(parameter.type)
  if (fixed) return `0x${'00'.repeat(Number(fixed[1]))}`
  if (parameter.type==='string') return ''
  throw new Error(`no JSON fixture for ABI type ${parameter.type}`)
}

function encodeAbiValue(parameter: AbiParameter,value: unknown): unknown {
  const array=/^(.*)\[([0-9]*)\]$/.exec(parameter.type)
  if (array) return (value as unknown[]).map((item) => encodeAbiValue({ ...parameter,type:array[1]! } as AbiParameter,item))
  if (parameter.type==='tuple') {
    const components='components' in parameter ? parameter.components : []
    const object=value as Record<string,unknown>
    return Object.fromEntries(components.map((component,index) => {
      const name=component.name || String(index)
      return [name,encodeAbiValue(component,object[name])]
    }))
  }
  if (/^u?int[0-9]*$/.test(parameter.type)) return BigInt(String(value))
  return value
}

integration('hosted owner API catalog', () => {
  let context: AppContext
  let ownerBaseUrl = ''
  let pool: SqlPool
  let hosted: HostedRuntime
  let adminToken: string
  let tenantToken: string
  let otherTenantToken: string
  let livenessToken: string
  let livenessPrincipalId: string
  let roomOperationsToken: string
  let roomOperationsPrincipalId: string
  let aggregateToken:string
  let aggregatePrincipalId:string
  let poolFinalityToken: string
  let poolBeneficiaryToken: string
  let poolSponsorToken: string
  let roomOperatorToken: string
  let otherRoomOperatorToken: string
  const transactionHash = hash('e')
  const livenessAccount = address('8')
  const livenessPool = address('9')
  const livenessNodeId = hash('a')
  const roomManager = address('5')
  const roomOperationsAccount = address('6')
  const aggregateAccount=address('7')
  const roomPool = address('4')
  const poolFinalityAccount = address('a')
  const poolSponsorAccount = address('d')
  const poolSponsorshipId = 'sponsorship-l1-001'
  const managedOperations = new Map<string, {
    fingerprint: string
    result: ManagedL1OperationResult
  }>()
  const roomBatchOperations = new Map<string, {
    fingerprint:string
    result:ManagedL1OperationResult
  }>()
  const aggregateOperations=new Map<string,{ fingerprint:string;result:ManagedL1OperationResult }>()
  const poolFinalityOperations = new Map<string, {
    fingerprint:string
    result:ManagedL1OperationResult
  }>()
  const poolBeneficiaryOperations = new Map<string, {
    fingerprint:string
    result:ManagedL1OperationResult
  }>()
  const poolSponsorOperations = new Map<string, {
    fingerprint:string
    result:ManagedL1OperationResult
  }>()
  let lastHeartbeatInput: ManagedL1PublishInput | null = null
  let lastRoomBatchInput: ManagedL1PublishInput | null = null
  let lastAggregateInput:ManagedBlobPublishInput|null=null
  let lastPoolFinalityInput: ManagedL1PublishInput | null = null
  let lastPoolBeneficiaryInput: ManagedL1PublishInput | null = null
  let lastPoolSponsorInput: ManagedL1PublishInput | null = null

  beforeAll(async () => {
    const config = loadConfig({
      chainId: 31_337,
      roomManager,
      roomPool,
      databaseUrl: databaseUrl!,
      queueEnabled: true,
      apiKeyPepper: 'hosted-api-catalog-pepper-00000001',
      coordinatorId: 'hosted-api-catalog',
      coordinatorRole: 'active',
      l1RpcUrl: 'http://catalog-rpc-a.invalid',
      l1RpcUrls: ['http://catalog-rpc-a.invalid', 'http://catalog-rpc-b.invalid'],
      l1RpcProviderIds: ['catalog-rpc-a', 'catalog-rpc-b'],
      objectStoreEndpoint: objectStoreEndpoint!,
      objectStoreBucket: process.env.TEST_OBJECT_STORE_BUCKET ?? 'zkdeal-it',
      objectStoreRegion: 'us-east-1',
      objectStoreAccessKeyId: process.env.TEST_OBJECT_STORE_ACCESS_KEY ?? 'zkdealminio',
      objectStoreSecretAccessKey: process.env.TEST_OBJECT_STORE_SECRET_KEY ?? 'zkdeal-minio-test-secret',
      objectStorePrefix: 'hosted-api-catalog-it',
      // Hosted startup must not create or read application state here. /proc
      // is intentionally unwritable even when the test container runs as root.
      dataDir: '/proc/zkdeal-hosted-must-not-write',
    })
    const created = await HostedRuntime.create(config)
    if (!created) throw new Error('hosted runtime was not created')
    hosted = created
    // All hosted mutations intentionally fail closed behind the live L1/indexer
    // gate. Keep this integration suite on one deterministic, independently
    // corroborated head instead of allowing the deliberately-invalid fixture
    // RPC URLs to consume the short production lease while requests time out.
    hosted.l1.agreedBlock = (async (tag: string) => {
      if (tag !== 'latest' && tag !== 'finalized' && tag !== '0xc') {
        throw new Error(`unexpected catalog block tag ${tag}`)
      }
      return {
        chainId: config.chainId,number: '12',hash: hash('2'),parentHash: hash('1'),
        parentBeaconBlockRoot: null,timestamp: '1787317200',
        verifiedSources: ['catalog-rpc-a','catalog-rpc-b'],
      }
    }) as typeof hosted.l1.agreedBlock
    pool = await createPostgresPool(databaseUrl!)
    const fence = hosted.writableFence()
    await hosted.store.upsertTenant(fence, {
      tenantId: 'tenant-a', displayName: 'Tenant A', tier: 'integration',
    })
    await hosted.store.upsertTenant(fence, {
      tenantId: 'tenant-b', displayName: 'Tenant B', tier: 'integration',
    })
    adminToken = (await hosted.store.provisionPrincipal(fence, {
      tenantId: 'tenant-a', kind: 'service', roles: ['hosting-admin'],
    })).token
    tenantToken = (await hosted.store.provisionPrincipal(fence, {
      tenantId: 'tenant-a', kind: 'api-key', roles: ['tenant-admin'],
    })).token
    otherTenantToken = (await hosted.store.provisionPrincipal(fence, {
      tenantId: 'tenant-b', kind: 'api-key', roles: ['tenant-admin'],
    })).token
    roomOperatorToken=(await hosted.store.provisionPrincipal(fence,{
      tenantId:'tenant-a',kind:'node',roles:['room-operator'],
    })).token
    otherRoomOperatorToken=(await hosted.store.provisionPrincipal(fence,{
      tenantId:'tenant-b',kind:'node',roles:['room-operator'],
    })).token
    const liveness = await hosted.store.provisionPrincipal(fence, {
      tenantId: 'tenant-a', kind: 'service', roles: ['l1-liveness'],
    })
    livenessToken = liveness.token
    livenessPrincipalId = liveness.principalId
    await hosted.store.assignL1ServiceBinding(fence, {
      principalId: livenessPrincipalId,bindingKind: 'node-liveness',chainId: config.chainId,
      contractAddress: livenessPool,expectedSender: livenessAccount,nodeId: livenessNodeId,roomId: null,
    })
    const roomOperations=await hosted.store.provisionPrincipal(fence,{
      tenantId:'tenant-a',kind:'service',roles:['l1-room-submit'],
    })
    roomOperationsToken=roomOperations.token
    roomOperationsPrincipalId=roomOperations.principalId
    await hosted.store.assignL1ServiceBinding(fence,{
      principalId:roomOperationsPrincipalId,bindingKind:'room-submit',chainId:config.chainId,
      contractAddress:roomManager,expectedSender:roomOperationsAccount,nodeId:null,roomId:'7',
    })
    const aggregate=await hosted.store.provisionPrincipal(fence,{
      tenantId:'tenant-a',kind:'service',roles:['l1-aggregate-submit'],
    })
    aggregateToken=aggregate.token
    aggregatePrincipalId=aggregate.principalId
    await hosted.store.assignL1ServiceBinding(fence,{
      principalId:aggregatePrincipalId,bindingKind:'room-aggregate',chainId:config.chainId,
      contractAddress:roomManager,expectedSender:aggregateAccount,
    })
    const poolFinality=await hosted.store.provisionPrincipal(fence,{
      tenantId:'tenant-a',kind:'service',roles:['l1-pool-finality-oracle'],
    })
    poolFinalityToken=poolFinality.token
    await hosted.store.assignL1ServiceBinding(fence,{
      principalId:poolFinality.principalId,bindingKind:'pool-finality-oracle',chainId:config.chainId,
      contractAddress:roomPool,expectedSender:poolFinalityAccount,roomId:'7',
    })
    const poolBeneficiary=await hosted.store.provisionPrincipal(fence,{
      tenantId:'tenant-a',kind:'service',roles:['l1-pool-beneficiary'],
    })
    poolBeneficiaryToken=poolBeneficiary.token
    await hosted.store.assignL1ServiceBinding(fence,{
      principalId:poolBeneficiary.principalId,bindingKind:'pool-beneficiary',chainId:config.chainId,
      contractAddress:roomPool,expectedSender:walletAccount.address.toLowerCase() as `0x${string}`,
      allocationId:walletAllocationId,
    })
    const poolSponsor=await hosted.store.provisionPrincipal(fence,{
      tenantId:'tenant-a',kind:'service',roles:['l1-pool-sponsor'],
    })
    poolSponsorToken=poolSponsor.token
    await hosted.store.assignL1ServiceBinding(fence,{
      principalId:poolSponsor.principalId,bindingKind:'pool-sponsor',chainId:config.chainId,
      contractAddress:roomPool,expectedSender:poolSponsorAccount,sponsorshipId:poolSponsorshipId,
    })
    await hosted.store.createSponsorship(fence,{
      sponsorshipId:poolSponsorshipId,sponsorTenantId:'tenant-a',beneficiaryTenantId:'tenant-a',
      allocationId:null,maximumQuantity:'100',unit:'proof-work',expiresAt:null,
      metadata:{ purpose:'managed-l1-sponsor-mutation-catalog' },
    })

    await hosted.store.setCanonicalAnchor(fence, {
      chainId: config.chainId, number: '10', hash: hash('0'),
      verifiedSources: ['catalog-rpc-a', 'catalog-rpc-b'],
    })
    await hosted.store.recordCanonicalBlocks(fence, [
      { chainId: config.chainId, number: '11', hash: hash('1'), parentHash: hash('0'), observedAt: new Date().toISOString() },
      { chainId: config.chainId, number: '12', hash: hash('2'), parentHash: hash('1'), observedAt: new Date().toISOString() },
    ])
    const fact = (index: number, factKind: string) => ({
      factKey: `${transactionHash}:${index}:${factKind}`,
      factKind,
      roomId: '7',
      tenantId: 'tenant-a',
      payload: { transactionHash, roomId: '7', sequence: index },
    })
    await hosted.store.ingestIndexerRecords(fence, {
      chainId: config.chainId,
      blockNumber: '12',
      blockHash: hash('2'),
      source: 'room-manager',
      schemaVersion: 2,
      logs: [{
        logIndex: 0,
        transactionHash,
        address: address('1'),
        eventName: 'BatchAccepted',
        decoded: { roomId: '7', batchIndex: '1' },
      }],
      facts: [
        fact(0, 'deposit'), fact(1, 'import'), fact(2, 'admission'), {
          factKey:`${transactionHash}:3:BatchAccepted`,factKind:'batch',roomId:'7',tenantId:'tenant-a',
          payload:{
            args:{ roomId:'7',batchIndex:'1',postStateRoot:hash('3') },
            provenance:{ eventName:'BatchAccepted',transactionHash,blockNumber:'12',blockHash:hash('2') },
          },
        },
        {
          factKey:`${transactionHash}:4:AllocationUsed`,factKind:'allocation',roomId:'7',tenantId:'tenant-a',
          payload:{
            args:{ allocationId:walletAllocationId,roomId:'7',startBlock:'11',proofDeadlineBlock:'100' },
            provenance:{ eventName:'AllocationUsed',transactionHash,blockNumber:'12',blockHash:hash('2') },
          },
        },
        // Two still-unsequenced forced entries, deliberately ingested out of
        // forcedId order: the proving context must serve them cursor-ordered
        // with the raw signed bytes only the indexed event carries.
        {
          factKey:`${transactionHash}:5:ForcedTransactionQueued`,factKind:'forced-transaction',
          roomId:'7',tenantId:'tenant-a',
          payload:{
            args:{
              roomId:'7',forcedId:'2',transactionHash:hash('9'),deadlineBlock:'41',
              rawSignedTransaction:'0x02c002',
            },
            provenance:{ eventName:'ForcedTransactionQueued',transactionHash,blockNumber:'12',blockHash:hash('2') },
          },
        },
        {
          factKey:`${transactionHash}:6:ForcedTransactionQueued`,factKind:'forced-transaction',
          roomId:'7',tenantId:'tenant-a',
          payload:{
            args:{
              roomId:'7',forcedId:'1',transactionHash:hash('8'),deadlineBlock:'40',
              rawSignedTransaction:'0x02c001',
            },
            provenance:{ eventName:'ForcedTransactionQueued',transactionHash,blockNumber:'12',blockHash:hash('2') },
          },
        },
      ],
    })
    const roomStateFunction=managerAbi.find((item) => item.type==='function' && item.name==='roomState')
    if (!roomStateFunction || roomStateFunction.type!=='function') throw new Error('roomState ABI fixture is unavailable')
    const roomState=jsonAbiValue(roomStateFunction.outputs[0]!) as Record<string,unknown>
    Object.assign(roomState,{
      state:'1',authorizationMode:'1',policyHash:provingPolicyHash,
      minimumImportConfirmations:'64',minimumDepositConfirmations:'64',
      participantCapacity:'128',admissionSigner:address('8'),
      // One unconsumed inbox entry (ids are assigned by pre-increment, so
      // nextInboxId is the LAST assigned id) and two pending forced entries.
      inboxCursor:'0',nextInboxId:'1',forcedCursor:'0',nextForcedId:'2',
    })
    await hosted.store.putRoomObservation(fence, {
      chainId: config.chainId,
      roomId: '7',
      tenantId: 'tenant-a',
      schemaVersion: 2,
      headBlock: '12',
      headHash: hash('2'),
      document: {
        roomId:'7',headBlock:'12',headHash:hash('2'),roomState,
        assets:[address('3')],
        liabilities:[{ asset:address('3'),liability:{ pending:'1',controlled:'2',claimable:'3',paid:'4' } }],
        domainSeparator:hash('d'),deploymentDomain:hash('c'),
        provenance:{ verifiedSources:['catalog-rpc-a','catalog-rpc-b'] },
      },
    })

    await pool.query(
      `INSERT INTO hosted_withdrawals(
         chain_id,room_id,epoch,withdrawal_index,tenant_id,approver_epoch,
         recipient,asset,amount,withdrawal_root,leaf_hash,positional_proof,
         finalized_block,finalized_hash,status
       ) VALUES (31337,7,1,0,'tenant-a',1,$1,$2,10,$3,$4,$5::jsonb,12,$6,'FINALIZED')`,
      [address('2'), address('3'), hash('4'), hash('5'), JSON.stringify([hash('6')]), hash('2')],
    )
    const nodeHeartbeatPublisher = {
      signerAddress: livenessAccount,
      publish: async (input: ManagedL1PublishInput): Promise<ManagedL1OperationResult> => {
        lastHeartbeatInput = input
        const fingerprint = JSON.stringify(input)
        const prior = managedOperations.get(input.idempotencyKey)
        if (prior) {
          if (prior.fingerprint !== fingerprint) {
            throw new Error('L1 operation idempotency key is bound to a different request')
          }
          return prior.result
        }
        const digest = createHash('sha256').update(fingerprint).digest('hex')
        const operationId = `heartbeat-${managedOperations.size + 1}`
        const row = await hosted.store.reserveL1Transaction(hosted.writableFence(), {
          operationId,chainId: config.chainId,sender: livenessAccount,operation: 'node-heartbeat',
          idempotencyKey: input.idempotencyKey,requestHash: digest,
          requestObjectKey: `zkdeal/sha256/${digest.slice(0,2)}/${digest}`,
          destinationAddress: input.to,calldata: input.calldata,inclusionDeadline: '1000',
          remotePendingNonce: '0',
          access: {
            tenantId: input.tenantId,principalId: input.principalId,
            correlationId: input.correlationId,minimumConfirmations: input.minimumConfirmations,
            requireFinalized: input.requireFinalized,bindingKind: 'node-liveness',
          },
        })
        const result: ManagedL1OperationResult = {
          operationId,idempotencyKey: input.idempotencyKey,correlationId: input.correlationId,
          status: 'RESERVED',chainId: config.chainId,from: livenessAccount,to: input.to,
          nonce: row.nonce,transactionHash: null,createdAt: row.createdAt,updatedAt: row.updatedAt,
          binding: input.payload,
        }
        managedOperations.set(input.idempotencyKey,{ fingerprint,result })
        return result
      },
      operation: async (operationId: string): Promise<ManagedL1OperationResult | null> =>
        [...managedOperations.values()].find((entry) => entry.result.operationId === operationId)?.result ?? null,
    } as unknown as ManagedL1Publisher
    const roomBatchPublisher={
      signerAddress:roomOperationsAccount,
      publish:async (input:ManagedL1PublishInput):Promise<ManagedL1OperationResult> => {
        lastRoomBatchInput=input
        const fingerprint=JSON.stringify(input)
        const prior=roomBatchOperations.get(input.idempotencyKey)
        if (prior) {
          if (prior.fingerprint!==fingerprint) throw new Error('L1 operation idempotency key is bound to a different request')
          return prior.result
        }
        const digest=createHash('sha256').update(fingerprint).digest('hex')
        const operationId=`room-batch-${roomBatchOperations.size+1}`
        const row=await hosted.store.reserveL1Transaction(hosted.writableFence(),{
          operationId,chainId:config.chainId,sender:roomOperationsAccount,operation:'room-batch',
          idempotencyKey:input.idempotencyKey,requestHash:digest,
          requestObjectKey:`zkdeal/sha256/${digest.slice(0,2)}/${digest}`,
          destinationAddress:input.to,calldata:input.calldata,inclusionDeadline:'1000',remotePendingNonce:'20',
          access:{ tenantId:input.tenantId,principalId:input.principalId,correlationId:input.correlationId,
            minimumConfirmations:input.minimumConfirmations,requireFinalized:input.requireFinalized,
            bindingKind:'room-submit' },
        })
        const result:ManagedL1OperationResult={
          operationId,idempotencyKey:input.idempotencyKey,correlationId:input.correlationId,
          status:'RESERVED',chainId:config.chainId,from:roomOperationsAccount,to:input.to,
          nonce:row.nonce,transactionHash:null,createdAt:row.createdAt,updatedAt:row.updatedAt,
          binding:input.payload,
        }
        roomBatchOperations.set(input.idempotencyKey,{ fingerprint,result })
        return result
      },
      operation:async (operationId:string):Promise<ManagedL1OperationResult|null> =>
        [...roomBatchOperations.values()].find((entry) => entry.result.operationId===operationId)?.result ?? null,
    } as unknown as ManagedL1Publisher
    const roomAggregatePublisher={
      signerAddress:aggregateAccount,
      publish:async (input:ManagedBlobPublishInput):Promise<ManagedL1OperationResult> => {
        lastAggregateInput=input
        const fingerprint=JSON.stringify(input)
        const prior=aggregateOperations.get(input.idempotencyKey)
        if (prior) {
          if (prior.fingerprint!==fingerprint) throw new Error('L1 operation idempotency key is bound to a different request')
          return prior.result
        }
        const digest=createHash('sha256').update(fingerprint).digest('hex')
        const operationId=`room-aggregate-${aggregateOperations.size+1}`
        const row=await hosted.store.reserveL1Transaction(hosted.writableFence(),{
          operationId,chainId:config.chainId,sender:aggregateAccount,operation:'publish-aggregate',
          idempotencyKey:input.idempotencyKey,requestHash:digest,
          requestObjectKey:`zkdeal/sha256/${digest.slice(0,2)}/${digest}`,
          destinationAddress:input.to,calldata:input.calldata,inclusionDeadline:'1000',remotePendingNonce:'30',
          access:{ tenantId:input.tenantId,principalId:input.principalId,correlationId:input.correlationId,
            minimumConfirmations:input.minimumConfirmations,requireFinalized:input.requireFinalized,
            bindingKind:'room-aggregate' },
        })
        const result:ManagedL1OperationResult={
          operationId,idempotencyKey:input.idempotencyKey,correlationId:input.correlationId,
          status:'RESERVED',chainId:config.chainId,from:aggregateAccount,to:input.to,
          nonce:row.nonce,transactionHash:null,createdAt:row.createdAt,updatedAt:row.updatedAt,
          binding:input.payload,
        }
        aggregateOperations.set(input.idempotencyKey,{ fingerprint,result })
        return result
      },
      operation:async (operationId:string):Promise<ManagedL1OperationResult|null> =>
        [...aggregateOperations.values()].find((entry) => entry.result.operationId===operationId)?.result ?? null,
    } as unknown as ManagedBlobPublisher
    const scopedPublisher=(input:{
      signerAddress:`0x${string}`
      operation:string
      bindingKind:'pool-finality-oracle'|'pool-beneficiary'|'pool-sponsor'
      operations:Map<string,{ fingerprint:string;result:ManagedL1OperationResult }>
      onPublish:(value:ManagedL1PublishInput)=>void
    }) => ({
      signerAddress:input.signerAddress,
      publish:async (value:ManagedL1PublishInput):Promise<ManagedL1OperationResult> => {
        input.onPublish(value)
        const fingerprint=JSON.stringify(value)
        const prior=input.operations.get(value.idempotencyKey)
        if (prior) {
          if (prior.fingerprint!==fingerprint) throw new Error('L1 operation idempotency key is bound to a different request')
          return prior.result
        }
        const digest=createHash('sha256').update(fingerprint).digest('hex')
        const operationId=`${input.operation}-${input.operations.size+1}`
        const row=await hosted.store.reserveL1Transaction(hosted.writableFence(),{
          operationId,chainId:config.chainId,sender:input.signerAddress,operation:input.operation,
          idempotencyKey:value.idempotencyKey,requestHash:digest,
          requestObjectKey:`zkdeal/sha256/${digest.slice(0,2)}/${digest}`,
          destinationAddress:value.to,calldata:value.calldata,inclusionDeadline:'1000',remotePendingNonce:'40',
          access:{ tenantId:value.tenantId,principalId:value.principalId,correlationId:value.correlationId,
            minimumConfirmations:value.minimumConfirmations,requireFinalized:value.requireFinalized,
            bindingKind:input.bindingKind },
        })
        const result:ManagedL1OperationResult={
          operationId,idempotencyKey:value.idempotencyKey,correlationId:value.correlationId,
          status:'RESERVED',chainId:config.chainId,from:input.signerAddress,to:value.to,
          nonce:row.nonce,transactionHash:null,createdAt:row.createdAt,updatedAt:row.updatedAt,binding:value.payload,
        }
        input.operations.set(value.idempotencyKey,{ fingerprint,result })
        return result
      },
      operation:async (operationId:string):Promise<ManagedL1OperationResult|null> =>
        [...input.operations.values()].find((entry) => entry.result.operationId===operationId)?.result ?? null,
    }) as unknown as ManagedL1Publisher
    const poolFinalityPublisher=scopedPublisher({
      signerAddress:poolFinalityAccount,operation:'pool-finalized-checkpoint',
      bindingKind:'pool-finality-oracle',operations:poolFinalityOperations,
      onPublish:(value) => { lastPoolFinalityInput=value },
    })
    const poolBeneficiaryPublisher=scopedPublisher({
      signerAddress:walletAccount.address.toLowerCase() as `0x${string}`,
      operation:'pool-beneficiary-disposal',bindingKind:'pool-beneficiary',
      operations:poolBeneficiaryOperations,onPublish:(value) => { lastPoolBeneficiaryInput=value },
    })
    const poolSponsorPublisher=scopedPublisher({
      signerAddress:poolSponsorAccount,operation:'pool-sponsor-mutation',bindingKind:'pool-sponsor',
      operations:poolSponsorOperations,onPublish:(value) => { lastPoolSponsorInput=value },
    })
    context = await createApp({
      config,hosted,nodeHeartbeatPublisher,roomBatchPublisher,roomAggregatePublisher,
      poolFinalityPublisher,poolBeneficiaryPublisher,poolSponsorPublisher,
      roomBatchCapabilityOverride:true,enableRelay:false,logger:false,
    })
    ownerBaseUrl=await context.app.listen({ host:'127.0.0.1',port:0 })
    expect(context.store).toBeNull()
    expect(context.observer).toBeNull()
  }, 90_000)

  afterAll(async () => {
    await context?.close()
    await pool?.end()
  })

  const auth = (token: string, idempotencyKey?: string) => ({
    authorization: `Bearer ${token}`,
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
  })
  const rpc = async (token: string, method: string, params: Record<string, unknown> = {}, key?: string) => {
    const response = await context.app.inject({
      method: 'POST', url: '/hosting/v1/json-rpc',
      headers: auth(token, key),
      payload: { jsonrpc: '2.0', id: method, method, params },
    })
    expect(response.statusCode).toBe(200)
    return response.json<{ result?: unknown; error?: { code: number; message: string } }>()
  }

  it('boots without DATA_DIR authority and retires every file observer surface', async () => {
    for (const request of [
      { method: 'GET' as const, url: '/rooms/7' },
      { method: 'GET' as const, url: '/rooms/7/state' },
      { method: 'PUT' as const, url: '/observer/v1/rooms/7', payload: {} },
      { method: 'PATCH' as const, url: '/observer/v1/rooms/7/freshness', payload: {} },
    ]) {
      const response = await context.app.inject(request)
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(410)
      expect(response.json()).toMatchObject({
        error: 'file observer routes are retired in hosted mode',
      })
    }
  })

  it('publishes complete schemas and never advertises the retired caller-authored writes', async () => {
    const openapi = (await context.app.inject({ method: 'GET', url: '/hosting/v1/openapi.json' })).json<any>()
    const staticOpenapi = JSON.parse(await readFile(resolve(
      import.meta.dirname,'../capabilities/hosting-v1.openapi.json',
    ),'utf8'))
    expect(staticOpenapi).toEqual(openapi)
    expect(openapi.openapi).toBe('3.1.0')
    expect(openapi.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' })
    expect(openapi.components.schemas.JsonRpcRequest.properties.method.enum).toEqual(expect.arrayContaining([
      'zkdeal_getIndexerStatus', 'zkdeal_getDeposits', 'zkdeal_getWithdrawalProof',
      'zkdeal_adminBackfill', 'zkdeal_adminReconcile', 'zkdeal_adminRetention',
    ]))
    expect(openapi.paths['/hosting/v1/indexer/blocks'].get.responses['200']).toBeTruthy()
    expect(openapi.paths['/hosting/v1/indexer/blocks'].post).toBeUndefined()
    expect(openapi.paths['/hosting/v1/admin/indexer/backfill'].post.parameters)
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Idempotency-Key', required: true })]))
    expect(openapi.paths['/hosting/v1/withdrawals/{roomId}/{epoch}/{withdrawalIndex}/proof'].get.responses['200'])
      .toBeTruthy()
    const requiredOperations = [
      ['/queue/v1/lease', 'post'],
      ['/hosting/v1/auth/wallet/challenges', 'post'],
      ['/hosting/v1/auth/wallet/sessions', 'post'],
      ['/hosting/v1/auth/wallet/session', 'get'],
      ['/hosting/v1/auth/wallet/session', 'delete'],
      ['/hosting/v1/tenants', 'post'],
      ['/hosting/v1/tenants/{tenantId}/principals', 'post'],
      ['/hosting/v1/principals/{principalId}/rotate', 'post'],
      ['/hosting/v1/principals/{principalId}', 'delete'],
      ['/hosting/v1/admin/l1-service-bindings/{principalId}', 'put'],
      ['/hosting/v1/admin/provider-nodes/{principalId}', 'get'],
      ['/hosting/v1/admin/provider-nodes/{principalId}', 'put'],
      ['/hosting/v1/admin/proof-profiles/{proofClass}', 'put'],
      ['/hosting/v1/admin/admissions/recover', 'post'],
      ['/hosting/v1/admin/safety-events/{eventId}/resolve', 'post'],
      ['/hosting/v1/internal/withdrawal-witnesses', 'post'],
      ['/hosting/v1/withdrawal-claims/{claimId}', 'get'],
      ['/hosting/v1/internal/aggregate-billing-manifests', 'post'],
      ['/hosting/v1/internal/post-finality-recoveries', 'post'],
      ['/hosting/v1/internal/post-finality-recoveries/{recoveryId}/finalize', 'post'],
      ['/hosting/v1/admin/billing/prices', 'post'],
      ['/hosting/v1/admin/sla/policies', 'post'],
      ['/hosting/v1/billing/ledger', 'get'],
      ['/hosting/v1/admin/invoices', 'post'],
      ['/hosting/v1/invoices', 'get'],
      ['/hosting/v1/admin/refunds', 'post'],
      ['/hosting/v1/refunds', 'get'],
      ['/hosting/v1/l1-operations/node-heartbeats', 'post'],
      ['/hosting/v1/l1-operations/room-batches', 'post'],
      ['/hosting/v1/l1-operations/room-aggregates', 'post'],
      ['/hosting/v1/l1-operations/pool-sponsor-mutations', 'post'],
      ['/hosting/v1/l1-operations/pool-finalized-checkpoints', 'post'],
      ['/hosting/v1/l1-operations/pool-beneficiary-disposals', 'post'],
      ['/hosting/v1/l1-transactions/{operationId}', 'get'],
      ['/hosting/v1/admin/provider-nodes/{principalId}/drain', 'post'],
      ['/hosting/v1/admin/provider-nodes/{principalId}/retire', 'post'],
      ['/hosting/v1/admin/provider-nodes/{principalId}/lifecycle', 'get'],
    ] as const
    for (const [path, method] of requiredOperations) {
      expect(openapi.paths[path]?.[method], `${method.toUpperCase()} ${path}`).toBeTruthy()
    }

    const retired = await context.app.inject({
      method: 'POST', url: '/hosting/v1/indexer/blocks',
      headers: auth(adminToken), payload: { blocks: [] },
    })
    expect(retired.statusCode).toBe(410)

    const capabilities = (await context.app.inject({ method: 'GET', url: '/hosting/v1/capabilities' })).json<any>()
    expect(capabilities.api.jsonRpcMethods.public).toContain('zkdeal_getFinalityStatus')
    expect(capabilities.api.jsonRpcMethods.public).toContain('zkdeal_getRoomEvents')
    expect(capabilities.api.jsonRpcMethods.public).toContain('zkdeal_getReconciliationStatus')
    expect(capabilities.tenancy.walletAllocationAuth).toMatchObject({
      enabled:true,signatureScheme:'eip191-eoa',erc1271Supported:false,
      challengeEndpoint:'/hosting/v1/auth/wallet/challenges',
      sessionEndpoint:'/hosting/v1/auth/wallet/sessions',
    })
    expect(capabilities.api.jsonRpcMethods.public).toContain('zkdeal_getBillingLedger')
    expect(capabilities.databaseSchema).toBe(28)
    expect(capabilities.managedL1Operations.nodeHeartbeat).toMatchObject({
      endpoint: '/hosting/v1/l1-operations/node-heartbeats',role: 'l1-liveness',
      selector: '0x7cd0e630',
    })
    // The route surface exists; the enabled flag is gated only on the scoped
    // signer configuration, mirroring roomOperationsStatus semantics.
    expect(capabilities.managedL1Operations.roomAggregate).toMatchObject({
      enabled:false,reason:'scoped-aggregate-signer-not-configured',
      endpoint:'/hosting/v1/l1-operations/room-aggregates',selector:'0x5e8b37ac',
      role:'l1-aggregate-submit',transactionType:3,zkdealMaximumBlobs:6,
    })
    expect(capabilities.managedL1Operations.poolSponsorMutation).toMatchObject({
      enabled:false,reason:'scoped-pool-sponsor-signer-not-configured',
      endpoint:'/hosting/v1/l1-operations/pool-sponsor-mutations',senderAuthority:'sponsor',
      role:'l1-pool-sponsor',
      selectors:{
        reserveAndStartForWithDataAvailabilityWithPermit:'0x827ac259',
        renewRoomForWithPermit:'0xf180fe5d',
      },
    })
    expect(capabilities.filesystem).toMatchObject({
      applicationStateAuthority: false,dataDirRequired: false,readOnlyRootSupported: true,
      legacyObserverRoutes: 'retired-410',observationAuthority: 'postgresql-canonical-projection',
    })
    expect(capabilities.billing).toMatchObject({
      aggregateOutcomeFinalityGate: true,
      canonicalSuccessOnlyCharges: true,
      appendOnlyReorgCredits: true,
    })
    expect(capabilities.observability.structuredTrace).toMatchObject({
      schemaVersion:1,secretsForbidden:true,metricLabelsForbidden:true,
      joinKeys:['correlationId','tenantId','roomId','jobId'],
    })
    expect(capabilities.observability.metrics.families).toEqual(expect.arrayContaining([
      { name:'zkdeal_l1_quorum_healthy',labels:[] },
      { name:'zkdeal_indexer_lag_blocks',labels:[] },
      { name:'zkdeal_indexer_retractions_total',labels:['reason'] },
      { name:'zkdeal_admission_wal_recovered_total',labels:['outcome'] },
      { name:'zkdeal_sponsorship_denials_total',labels:['reason'] },
    ]))
    expect(capabilities.api.jsonRpcMethods.public).not.toContain('zkdeal_getFinality')
    expect(capabilities.api.jsonRpcMethods.admin).toEqual(expect.arrayContaining([
      'zkdeal_adminBackfill', 'zkdeal_adminReconcile', 'zkdeal_adminRetention',
      'zkdeal_adminPublishBillingPrice', 'zkdeal_adminPublishSlaPolicy',
      'zkdeal_adminFinalizeInvoice', 'zkdeal_adminRefund',
    ]))
  })

  it('binds heartbeat publication to a narrow principal and canonical operation evidence', async () => {
    const body = {
      schemaVersion: 1,chainId: 31_337,poolAddress: livenessPool,
      expectedLivenessAccount: livenessAccount,nodeId: livenessNodeId,profileHash: hash('b'),
      confirmationPolicy: { minimumConfirmations: 64 },
    }
    const headers = {
      ...auth(livenessToken,'node-heartbeat-catalog-001'),
      'x-correlation-id': 'node-heartbeat:catalog:001',
    }
    const accepted = await context.app.inject({
      method: 'POST',url: '/hosting/v1/l1-operations/node-heartbeats',headers,payload: body,
    })
    expect(accepted.statusCode).toBe(202)
    expect(accepted.headers['x-correlation-id']).toBe('node-heartbeat:catalog:001')
    const operation = accepted.json<ManagedL1OperationResult>()
    expect(operation).toMatchObject({
      idempotencyKey: 'node-heartbeat-catalog-001',correlationId: 'node-heartbeat:catalog:001',
      status: 'RESERVED',chainId: 31_337,from: livenessAccount,to: livenessPool,
      transactionHash: null,
    })
    expect(lastHeartbeatInput?.calldata.slice(0,10)).toBe('0x7cd0e630')
    expect(lastHeartbeatInput?.payload).toEqual(body)

    const replay = await context.app.inject({
      method: 'POST',url: '/hosting/v1/l1-operations/node-heartbeats',headers,payload: body,
    })
    expect(replay.statusCode).toBe(202)
    expect(replay.json()).toEqual(operation)

    const drift = await context.app.inject({
      method: 'POST',url: '/hosting/v1/l1-operations/node-heartbeats',headers,
      payload: { ...body,profileHash: hash('c') },
    })
    expect(drift.statusCode).toBe(409)
    expect(drift.json()).toMatchObject({ error: expect.stringContaining('different request') })

    const missingCorrelation = await context.app.inject({
      method: 'POST',url: '/hosting/v1/l1-operations/node-heartbeats',
      headers: auth(livenessToken,'node-heartbeat-catalog-002'),payload: body,
    })
    expect(missingCorrelation.statusCode).toBe(400)

    for (const changed of [
      { ...body,nodeId: hash('d') },
      { ...body,poolAddress: address('7') },
      { ...body,expectedLivenessAccount: address('6') },
    ]) {
      const denied = await context.app.inject({
        method:'POST',url:'/hosting/v1/l1-operations/node-heartbeats',headers:{
          ...auth(livenessToken,`node-heartbeat-denied-${changed.nodeId.slice(-2)}-${changed.poolAddress.slice(-2)}-${changed.expectedLivenessAccount.slice(-2)}`),
          'x-correlation-id':'node-heartbeat:catalog:denied',
        },payload:changed,
      })
      expect(denied.statusCode).toBe(403)
    }

    const tenantDenied = await context.app.inject({
      method:'POST',url:'/hosting/v1/l1-operations/node-heartbeats',
      headers:{ ...auth(tenantToken,'node-heartbeat-tenant-denied'),'x-correlation-id':'node-heartbeat:tenant:denied' },
      payload:body,
    })
    expect(tenantDenied.statusCode).toBe(401)

    const stored = managedOperations.get('node-heartbeat-catalog-001')!
    stored.result = {
      ...stored.result,status:'FINALIZED',transactionHash: hash('f'),blockNumber:'12',blockHash:hash('2'),
      confirmations:65,receiptSource:{ providerIds:['catalog-rpc-a','catalog-rpc-b'],
        observedAt:'2026-08-21T12:00:00.000Z',canonical:true },finalized:true,
    }
    const status = await context.app.inject({
      method:'GET',url:`/hosting/v1/l1-transactions/${operation.operationId}`,
      headers:auth(livenessToken),
    })
    expect(status.statusCode).toBe(200)
    expect(status.headers['x-correlation-id']).toBe('node-heartbeat:catalog:001')
    expect(status.json()).toEqual(stored.result)
    const crossTenant = await context.app.inject({
      method:'GET',url:`/hosting/v1/l1-transactions/${operation.operationId}`,
      headers:auth(otherTenantToken),
    })
    expect(crossTenant.statusCode).toBe(401)
  })

  it('serves only a canonical hash-bound live proving context',async () => {
    expect(provingPolicyHash).toBe(rustProvingPolicyHash)
    const headers=auth(tenantToken,'proving-policy-catalog-001')
    const registered=await context.app.inject({
      method:'POST',url:'/hosting/v1/rooms/7/proving-policy',headers,
      payload:{ schemaVersion:1,chainId:31_337,policy:provingPolicy },
    })
    expect(registered.statusCode).toBe(201)
    expect(registered.json()).toMatchObject({
      schemaVersion:1,chainId:31_337,roomId:'7',policyHash:provingPolicyHash,created:true,
    })
    const replay=await context.app.inject({
      method:'POST',url:'/hosting/v1/rooms/7/proving-policy',headers,
      payload:{ schemaVersion:1,chainId:31_337,policy:provingPolicy },
    })
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toMatchObject({ policyHash:provingPolicyHash,created:false })

    const drift=await context.app.inject({
      method:'POST',url:'/hosting/v1/rooms/7/proving-policy',headers,
      payload:{
        schemaVersion:1,chainId:31_337,
        policy:{ ...provingPolicy,max_blocks_per_batch:9 },
      },
    })
    expect(drift.statusCode).toBe(409)

    // The unconsumed inbox tail is read hash-bound at the observed head via
    // canonical depositEntry views; the transport is patched with recording,
    // matching the corroborated-call pattern used by the pool suites below.
    const depositEntryFn=managerAbi.find(
      (item) => item.type==='function' && item.name==='depositEntry',
    )
    if (!depositEntryFn || depositEntryFn.type!=='function') {
      throw new Error('depositEntry ABI fixture is unavailable')
    }
    const depositEntry=jsonAbiValue(depositEntryFn.outputs[0]!) as Record<string,unknown>
    Object.assign(depositEntry,{
      depositor:address('6'),beneficiary:address('7'),asset:address('3'),
      amount:'5',queuedAtBlock:'11',consumed:false,refunded:false,
    })
    const depositCalls: Array<{ to:string;data:`0x${string}`;blockTag:Record<string,unknown> }>=[]
    const originalAgreedCall=hosted.l1.agreedCall.bind(hosted.l1)
    hosted.l1.agreedCall=(async (input: typeof depositCalls[number]) => {
      depositCalls.push(input)
      return {
        data:encodeFunctionResult({
          abi:[depositEntryFn],functionName:'depositEntry',
          result:encodeAbiValue(depositEntryFn.outputs[0]!,depositEntry) as never,
        }),
        verifiedSources:['catalog-rpc-a','catalog-rpc-b'],
      }
    }) as typeof hosted.l1.agreedCall
    try {
      const response=await context.app.inject({
        method:'GET',url:'/hosting/v1/rooms/7/proving-context',headers:auth(roomOperatorToken),
      })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        schemaVersion:1,chainId:31_337,l1ChainId:31_337,roomId:'7',
        observedL1Block:12,blockHash:hash('2'),canonical:true,
        receiptSource:{ providerIds:['catalog-rpc-a','catalog-rpc-b'],canonical:true },
        room:{ authorizationMode:'1',policyHash:provingPolicyHash },
        domainSeparator:hash('d'),deploymentDomain:hash('c'),policy:provingPolicy,
        liabilities:[{ asset:address('3'),pending:'1',controlled:'2',claimable:'3',paid:'4' }],
      })
      expect(response.json<any>().liabilitiesHash).toBe(rustLiabilitiesHash)
      // Forced entries come back cursor-ordered even though they were
      // ingested out of order, and carry the event's raw signed bytes.
      expect(response.json<any>().pendingForced).toEqual([
        { forcedId:'1',transactionHash:hash('8'),deadlineBlock:'40',rawSignedTransaction:'0x02c001' },
        { forcedId:'2',transactionHash:hash('9'),deadlineBlock:'41',rawSignedTransaction:'0x02c002' },
      ])
      expect(response.json<any>().pendingDeposits).toEqual([{
        inboxId:'1',depositor:address('6'),beneficiary:address('7'),asset:address('3'),
        amount:'5',queuedAtBlock:'11',consumed:false,refunded:false,
      }])
      expect(depositCalls).toHaveLength(1)
      expect(depositCalls[0]).toMatchObject({
        to:roomManager,blockTag:{ blockHash:hash('2'),requireCanonical:true },
      })
    } finally {
      hosted.l1.agreedCall=originalAgreedCall
    }

    const crossTenant=await context.app.inject({
      method:'GET',url:'/hosting/v1/rooms/7/proving-context',headers:auth(otherRoomOperatorToken),
    })
    expect(crossTenant.statusCode).toBe(404)
  })

  it('publishes finalized checkpoints and beneficiary disposals only from exact canonical authority',async () => {
    const checkpointBody={
      schemaVersion:1,chainId:31_337,roomPool,expectedFinalityOracleAccount:poolFinalityAccount,
      roomId:'7',batchIndex:'1',stateRoot:hash('3'),l1BlockNumber:'12',l1BlockHash:hash('2'),
      confirmationPolicy:{ minimumConfirmations:64,requireFinalized:true },
    }
    const checkpointHeaders={
      ...auth(poolFinalityToken,'pool-finality-catalog-001'),'x-correlation-id':'pool:finality:catalog:001',
    }
    const checkpoint=await context.app.inject({
      method:'POST',url:'/hosting/v1/l1-operations/pool-finalized-checkpoints',
      headers:checkpointHeaders,payload:checkpointBody,
    })
    expect(checkpoint.statusCode).toBe(202)
    const checkpointOperation=checkpoint.json<ManagedL1OperationResult>()
    expect(checkpointOperation).toMatchObject({
      status:'RESERVED',from:poolFinalityAccount,to:roomPool,correlationId:'pool:finality:catalog:001',
      binding:{ roomId:'7',batchIndex:'1',stateRoot:hash('3'),l1BlockHash:hash('2'),
        receiptSources:['catalog-rpc-a','catalog-rpc-b'] },
    })
    expect(lastPoolFinalityInput?.calldata.slice(0,10)).toBe('0xe19bc67e')
    expect((await context.app.inject({
      method:'GET',url:`/hosting/v1/l1-transactions/${checkpointOperation.operationId}`,
      headers:auth(poolFinalityToken),
    })).statusCode).toBe(200)
    const checkpointReplay=await context.app.inject({
      method:'POST',url:'/hosting/v1/l1-operations/pool-finalized-checkpoints',
      headers:checkpointHeaders,payload:checkpointBody,
    })
    expect(checkpointReplay.statusCode).toBe(202)
    expect(checkpointReplay.json()).toEqual(checkpointOperation)
    expect((await context.app.inject({
      method:'POST',url:'/hosting/v1/l1-operations/pool-finalized-checkpoints',
      headers:{ ...auth(poolFinalityToken,'pool-finality-catalog-drift'),'x-correlation-id':'pool:finality:catalog:drift' },
      payload:{ ...checkpointBody,batchIndex:'2' },
    })).statusCode).toBe(409)

    const allocationState=poolAbi.find((item) => item.type==='function' && item.name==='allocationState')
    if (!allocationState || allocationState.type!=='function') throw new Error('allocationState fixture is unavailable')
    const allocation=jsonAbiValue(allocationState.outputs[0]!) as Record<string,unknown>
    Object.assign(allocation,{
      user:walletAccount.address.toLowerCase(),nodeId:hash('8'),status:'2',roomId:'7',
      payer:address('c'),proofDeadlineBlock:'100',
    })
    const encoded=encodeFunctionResult({
      abi:[allocationState],functionName:'allocationState',
      result:encodeAbiValue(allocationState.outputs[0]!,allocation) as never,
    })
    const originalAgreedCall=hosted.l1.agreedCall.bind(hosted.l1)
    hosted.l1.agreedCall=(async () => ({
      data:encoded,verifiedSources:['catalog-rpc-a','catalog-rpc-b'],
    })) as typeof hosted.l1.agreedCall
    try {
      const disposalBody={
        schemaVersion:1,chainId:31_337,roomPool,
        expectedBeneficiaryAccount:walletAccount.address.toLowerCase(),allocationId:walletAllocationId,
        confirmationPolicy:{ minimumConfirmations:64,requireFinalized:true },
      }
      const disposalHeaders={
        ...auth(poolBeneficiaryToken,'pool-disposal-catalog-001'),'x-correlation-id':'pool:disposal:catalog:001',
      }
      const disposal=await context.app.inject({
        method:'POST',url:'/hosting/v1/l1-operations/pool-beneficiary-disposals',
        headers:disposalHeaders,payload:disposalBody,
      })
      expect(disposal.statusCode).toBe(202)
      const disposalOperation=disposal.json<ManagedL1OperationResult>()
      expect(disposalOperation).toMatchObject({
        status:'RESERVED',from:walletAccount.address.toLowerCase(),to:roomPool,
        correlationId:'pool:disposal:catalog:001',
        binding:{ allocationId:walletAllocationId,roomId:'7',payer:address('c'),
          canonicalHeadHash:hash('2'),receiptSources:['catalog-rpc-a','catalog-rpc-b'] },
      })
      expect(lastPoolBeneficiaryInput?.calldata.slice(0,10)).toBe('0xed97f11a')
      expect((await context.app.inject({
        method:'GET',url:`/hosting/v1/l1-transactions/${disposalOperation.operationId}`,
        headers:auth(poolBeneficiaryToken),
      })).statusCode).toBe(200)
      const disposalReplay=await context.app.inject({
        method:'POST',url:'/hosting/v1/l1-operations/pool-beneficiary-disposals',
        headers:disposalHeaders,payload:disposalBody,
      })
      expect(disposalReplay.statusCode).toBe(202)
      expect(disposalReplay.json()).toEqual(disposalOperation)
      expect((await context.app.inject({
        method:'POST',url:'/hosting/v1/l1-operations/pool-beneficiary-disposals',
        headers:{ ...auth(poolBeneficiaryToken,'pool-disposal-cross-allocation'),'x-correlation-id':'pool:disposal:cross' },
        payload:{ ...disposalBody,allocationId:hash('9') },
      })).statusCode).toBe(403)
    } finally {
      hosted.l1.agreedCall=originalAgreedCall
    }
  })

  it('publishes permit-bound sponsor escrow mutations only from exact sponsorship authority',async () => {
    const allocationState=poolAbi.find((item) => item.type==='function' && item.name==='allocationState')
    if (!allocationState || allocationState.type!=='function') throw new Error('allocationState fixture is unavailable')
    const allocation=jsonAbiValue(allocationState.outputs[0]!) as Record<string,unknown>
    Object.assign(allocation,{
      user:walletAccount.address.toLowerCase(),nodeId:hash('8'),status:'2',roomId:'7',
      payer:address('c'),proofDeadlineBlock:'100',
    })
    const encoded=encodeFunctionResult({
      abi:[allocationState],functionName:'allocationState',
      result:encodeAbiValue(allocationState.outputs[0]!,allocation) as never,
    })
    const originalAgreedCall=hosted.l1.agreedCall.bind(hosted.l1)
    hosted.l1.agreedCall=(async () => ({
      data:encoded,verifiedSources:['catalog-rpc-a','catalog-rpc-b'],
    })) as typeof hosted.l1.agreedCall
    try {
      const reservation={
        nodeId:hash('5'),slotId:hash('6'),presetId:hash('7'),
        deadlineBlocksFromStart:'7200',priceEpoch:'1',maxTokenCharge:'1000',
      }
      const permit={ value:'1000',deadline:'1787317200',v:'27',r:hash('1'),s:hash('2') }
      const renewBody={
        schemaVersion:1,chainId:31_337,roomPool,expectedSponsorAccount:poolSponsorAccount,
        sponsorshipId:poolSponsorshipId,beneficiaryTenantId:'tenant-a',
        beneficiary:walletAccount.address.toLowerCase(),
        mutation:{
          kind:'renewRoomForWithPermit',previousAllocationId:walletAllocationId,
          reservation,permit,
        },
        confirmationPolicy:{ minimumConfirmations:64,requireFinalized:true },
      }
      const renewHeaders={
        ...auth(poolSponsorToken,'pool-sponsor-catalog-renew-001'),
        'x-correlation-id':'pool:sponsor:catalog:renew:001',
      }
      const renew=await context.app.inject({
        method:'POST',url:'/hosting/v1/l1-operations/pool-sponsor-mutations',
        headers:renewHeaders,payload:renewBody,
      })
      expect(renew.statusCode,renew.body).toBe(202)
      const renewOperation=renew.json<ManagedL1OperationResult>()
      expect(renewOperation).toMatchObject({
        status:'RESERVED',from:poolSponsorAccount,to:roomPool,
        correlationId:'pool:sponsor:catalog:renew:001',
        binding:{
          sponsorshipId:poolSponsorshipId,beneficiaryTenantId:'tenant-a',
          beneficiary:walletAccount.address.toLowerCase(),
          mutationKind:'renewRoomForWithPermit',selector:'0xf180fe5d',
          previousAllocationId:walletAllocationId,roomId:'7',
          canonicalHeadHash:hash('2'),receiptSources:['catalog-rpc-a','catalog-rpc-b'],
          maxTokenCharge:'1000',permit:{ value:'1000',deadline:'1787317200' },
        },
      })
      expect(lastPoolSponsorInput?.calldata.slice(0,10)).toBe('0xf180fe5d')
      expect((await context.app.inject({
        method:'GET',url:`/hosting/v1/l1-transactions/${renewOperation.operationId}`,
        headers:auth(poolSponsorToken),
      })).statusCode).toBe(200)
      // Another scoped service credential cannot read the sponsor operation.
      expect((await context.app.inject({
        method:'GET',url:`/hosting/v1/l1-transactions/${renewOperation.operationId}`,
        headers:auth(aggregateToken),
      })).statusCode).toBe(403)
      const renewReplay=await context.app.inject({
        method:'POST',url:'/hosting/v1/l1-operations/pool-sponsor-mutations',
        headers:renewHeaders,payload:renewBody,
      })
      expect(renewReplay.statusCode).toBe(202)
      expect(renewReplay.json()).toEqual(renewOperation)
      // The idempotency key is bound to one immutable request.
      expect((await context.app.inject({
        method:'POST',url:'/hosting/v1/l1-operations/pool-sponsor-mutations',
        headers:renewHeaders,
        payload:{ ...renewBody,confirmationPolicy:{ minimumConfirmations:63,requireFinalized:true } },
      })).statusCode).toBe(409)

      const reserveFn=poolHostingAbi.find((item) =>
        item.type==='function' && item.name==='reserveAndStartForWithDataAvailabilityWithPermit')
      if (!reserveFn || reserveFn.type!=='function') throw new Error('sponsor reserve ABI fixture is unavailable')
      const creation=jsonAbiValue(reserveFn.inputs[2]!) as Record<string,unknown>
      const dataAvailability=jsonAbiValue(reserveFn.inputs[3]!) as Record<string,unknown>
      Object.assign(dataAvailability,{ policy:'1' })
      const reserveBody={
        schemaVersion:1,chainId:31_337,roomPool,expectedSponsorAccount:poolSponsorAccount,
        sponsorshipId:poolSponsorshipId,beneficiaryTenantId:'tenant-a',
        beneficiary:walletAccount.address.toLowerCase(),
        mutation:{
          kind:'reserveAndStartForWithDataAvailabilityWithPermit',
          reservation,creation,dataAvailability,permit,
        },
        confirmationPolicy:{ minimumConfirmations:64,requireFinalized:true },
      }
      const reserve=await context.app.inject({
        method:'POST',url:'/hosting/v1/l1-operations/pool-sponsor-mutations',
        headers:{
          ...auth(poolSponsorToken,'pool-sponsor-catalog-reserve-001'),
          'x-correlation-id':'pool:sponsor:catalog:reserve:001',
        },
        payload:reserveBody,
      })
      expect(reserve.statusCode,reserve.body).toBe(202)
      expect(reserve.json<ManagedL1OperationResult>()).toMatchObject({
        status:'RESERVED',from:poolSponsorAccount,to:roomPool,
        binding:{
          mutationKind:'reserveAndStartForWithDataAvailabilityWithPermit',selector:'0x827ac259',
          sponsorshipId:poolSponsorshipId,dataAvailabilityPolicy:'1',
        },
      })
      expect(lastPoolSponsorInput?.calldata.slice(0,10)).toBe('0x827ac259')

      const denied=async (payload:Record<string,unknown>,suffix:string) => context.app.inject({
        method:'POST',url:'/hosting/v1/l1-operations/pool-sponsor-mutations',
        headers:{
          ...auth(poolSponsorToken,`pool-sponsor-catalog-denied-${suffix}`),
          'x-correlation-id':`pool:sponsor:catalog:denied:${suffix}`,
        },
        payload,
      })
      // Wrong scoped role is denied before any binding evaluation.
      expect((await context.app.inject({
        method:'POST',url:'/hosting/v1/l1-operations/pool-sponsor-mutations',
        headers:{
          ...auth(poolFinalityToken,'pool-sponsor-catalog-wrong-role'),
          'x-correlation-id':'pool:sponsor:catalog:wrong-role',
        },
        payload:renewBody,
      })).statusCode).toBe(403)
      // A sponsorship the principal is not immutably bound to is denied.
      expect((await denied({ ...renewBody,sponsorshipId:'sponsorship-other' },'binding')).statusCode).toBe(403)
      // The declared beneficiary tenant must equal the immutable sponsor terms.
      expect((await denied({ ...renewBody,beneficiaryTenantId:'tenant-b' },'tenant')).statusCode).toBe(403)
      // The wrong RoomPool contract is denied.
      expect((await denied({ ...renewBody,roomPool:address('9') },'contract')).statusCode).toBe(403)
      // The permit must cover the immutable maximum token charge.
      expect((await denied({
        ...renewBody,mutation:{ ...renewBody.mutation,permit:{ ...permit,value:'1' } },
      },'permit')).statusCode).toBe(400)
      // Finality is not optional for sponsor escrow mutations.
      expect((await denied({
        ...renewBody,confirmationPolicy:{ minimumConfirmations:64,requireFinalized:false },
      },'finality')).statusCode).toBe(400)
      // An unknown mutation kind is rejected.
      expect((await denied({
        ...renewBody,mutation:{ ...renewBody.mutation,kind:'reserveRoomForWithPermit' },
      },'kind')).statusCode).toBe(400)
      // Renewal requires the canonical beneficiary-tenant allocation fact.
      expect((await denied({
        ...renewBody,mutation:{ ...renewBody.mutation,previousAllocationId:hash('9') },
      },'authority')).statusCode).toBe(409)
      // The renewed allocation must be currently owned by the named beneficiary.
      expect((await denied({ ...renewBody,beneficiary:address('e') },'owner')).statusCode).toBe(409)
    } finally {
      hosted.l1.agreedCall=originalAgreedCall
    }
  })

  it('issues replay-safe EOA wallet sessions only for the canonical tenant allocation',async () => {
    const allocationState=poolAbi.find((item) => item.type==='function' && item.name==='allocationState')
    if (!allocationState || allocationState.type!=='function') throw new Error('allocationState fixture is unavailable')
    const allocation=jsonAbiValue(allocationState.outputs[0]!) as Record<string,unknown>
    Object.assign(allocation,{
      user:walletAccount.address.toLowerCase(),nodeId:hash('8'),status:'2',roomId:'7',
      payer:walletAccount.address.toLowerCase(),proofDeadlineBlock:'100',
    })
    const encoded=encodeFunctionResult({
      abi:[allocationState],functionName:'allocationState',
      result:encodeAbiValue(allocationState.outputs[0]!,allocation) as never,
    })
    const originalAgreedCall=hosted.l1.agreedCall.bind(hosted.l1)
    hosted.l1.agreedCall=(async () => ({
      data:encoded,verifiedSources:['catalog-rpc-a','catalog-rpc-b'],
    })) as typeof hosted.l1.agreedCall
    let sequence=0
    const challenge=async (
      suffix:string,tenantId='tenant-a',walletAddress=walletAccount.address.toLowerCase(),
      domain='wallet.tenant-a.example',uri='https://wallet.tenant-a.example/',
    ) => context.app.inject({
      method:'POST',url:'/hosting/v1/auth/wallet/challenges',
      headers:{ ...auth(tenantToken,`wallet-challenge-${suffix}`),'x-correlation-id':`wallet:challenge:${suffix}` },
      payload:{ tenantId,chainId:31_337,allocationId:walletAllocationId,walletAddress,domain,uri,sessionTtlSeconds:900 },
    })
    const issue=async (challengeBody:any,signature:string,key:string) => context.app.inject({
      method:'POST',url:'/hosting/v1/auth/wallet/sessions',
      headers:{ ...auth(tenantToken,key),'x-correlation-id':`wallet:session:${key}` },
      payload:{ challengeId:challengeBody.challengeId,signature },
    })
    const newSession=async (suffix:string) => {
      const created=await challenge(`${suffix}-${sequence++}`)
      expect(created.statusCode).toBe(201)
      const challengeBody=created.json<any>()
      expect(challengeBody).toMatchObject({
        signatureScheme:'eip191-eoa',erc1271Supported:false,tenantId:'tenant-a',
        chainId:31_337,allocationId:walletAllocationId,walletAddress:walletAccount.address.toLowerCase(),
      })
      const signature=await walletAccount.signMessage({ message:challengeBody.message })
      const issued=await issue(challengeBody,signature,`wallet-session-${suffix}`)
      expect(issued.statusCode).toBe(201)
      return { challengeBody,signature,session:issued.json<any>() }
    }
    try {
      const wrongChain=await context.app.inject({
        method:'POST',url:'/hosting/v1/auth/wallet/challenges',
        headers:{ ...auth(tenantToken,'wallet-challenge-wrong-chain'),'x-correlation-id':'wallet:challenge:wrong-chain' },
        payload:{ tenantId:'tenant-a',chainId:1,allocationId:walletAllocationId,
          walletAddress:walletAccount.address.toLowerCase(),domain:'wallet.tenant-a.example',
          uri:'https://wallet.tenant-a.example/',sessionTtlSeconds:900 },
      })
      expect(wrongChain.statusCode).toBe(400)
      const wrongDomain=await challenge('wrong-domain','tenant-a',walletAccount.address.toLowerCase(),
        'wallet.tenant-a.example','https://other.tenant-a.example/')
      expect(wrongDomain.statusCode).toBe(400)
      expect((await challenge('cross-tenant','tenant-b')).statusCode).toBe(404)

      const unsigned=await challenge('wrong-signature')
      const unsignedBody=unsigned.json<any>()
      const wrongSignature=await wrongWalletAccount.signMessage({ message:unsignedBody.message })
      expect((await issue(unsignedBody,wrongSignature,'wallet-session-wrong-signature')).statusCode).toBe(401)

      const expired=await challenge('expired')
      const expiredBody=expired.json<any>()
      await pool.query(
        `UPDATE hosted_wallet_challenges SET expires_at=clock_timestamp()-interval '1 second'
         WHERE challenge_id=$1`,[expiredBody.challengeId],
      )
      const expiredSignature=await walletAccount.signMessage({ message:expiredBody.message })
      expect((await issue(expiredBody,expiredSignature,'wallet-session-expired')).statusCode).toBe(404)

      const first=await newSession('primary')
      const replay=await issue(first.challengeBody,first.signature,'wallet-session-primary')
      expect(replay.statusCode).toBe(200)
      expect(replay.json<any>().token).toBe(first.session.token)
      expect((await issue(first.challengeBody,first.signature,'wallet-session-replay-denied')).statusCode).toBe(404)
      const current=await context.app.inject({
        method:'GET',url:'/hosting/v1/auth/wallet/session',headers:auth(first.session.token),
      })
      expect(current.statusCode).toBe(200)
      expect(current.json()).toMatchObject({
        tenantId:'tenant-a',walletAddress:walletAccount.address.toLowerCase(),
        scope:{ chainId:31_337,allocationId:walletAllocationId,roomId:'7' },
      })
      const queueJump=await context.app.inject({
        method:'POST',url:'/queue/v1/jobs',headers:auth(first.session.token,'wallet-queue-cross-allocation'),
        payload:{ endpoint:'/v5/rooms/prove',proofClass:'wallet-test',request:{},roomId:'7',
          allocationId:hash('9'),billingMode:'quoted',maximumChargeAmount:'1',maximumChargeCurrency:'USD' },
      })
      expect(queueJump.statusCode).toBe(403)
      const revoked=await context.app.inject({
        method:'DELETE',url:'/hosting/v1/auth/wallet/session',
        headers:auth(first.session.token,'wallet-session-revoke-primary'),
      })
      expect(revoked.statusCode).toBe(204)
      expect((await context.app.inject({
        method:'GET',url:'/hosting/v1/auth/wallet/session',headers:auth(first.session.token),
      })).statusCode).toBe(401)

      const reorged=await newSession('reorg')
      await pool.query(
        `UPDATE hosted_indexer_facts SET canonical=false
         WHERE fact_key=$1`,[`${transactionHash}:4:AllocationUsed`],
      )
      expect((await context.app.inject({
        method:'GET',url:'/hosting/v1/auth/wallet/session',headers:auth(reorged.session.token),
      })).statusCode).toBe(401)
      await pool.query(
        `UPDATE hosted_indexer_facts SET canonical=true
         WHERE fact_key=$1`,[`${transactionHash}:4:AllocationUsed`],
      )

      const rotated=await newSession('disposed')
      await pool.query(
        `INSERT INTO hosted_indexer_facts(
           fact_key,chain_id,block_number,block_hash,fact_kind,room_id,tenant_id,payload,canonical
         ) VALUES ($1,31337,12,$2,'allocation',7,'tenant-a',$3::jsonb,true)`,
        [`${transactionHash}:5:AllocationDisposed`,hash('2'),JSON.stringify({
          args:{ allocationId:walletAllocationId,roomId:'7' },
          provenance:{ eventName:'AllocationDisposed',transactionHash,blockNumber:'12',blockHash:hash('2') },
        })],
      )
      expect((await context.app.inject({
        method:'GET',url:'/hosting/v1/auth/wallet/session',headers:auth(rotated.session.token),
      })).statusCode).toBe(401)
      await pool.query(
        `UPDATE hosted_indexer_facts SET canonical=false WHERE fact_key=$1`,
        [`${transactionHash}:5:AllocationDisposed`],
      )
    } finally {
      hosted.l1.agreedCall=originalAgreedCall
    }
  })

  it('derives submitBatch only from one durable live prepare/prove/verify lineage', async () => {
    const owner=new HostedOwnerClient(
      ownerBaseUrl,roomOperatorToken,roomOperationsToken,'7',31_337,
      roomManager,roomOperationsAccount,64,
    )
    expect(await owner.negotiate()).toBe(1)
    expect(await owner.provingContext()).toMatchObject({
      schemaVersion:1,chainId:31_337,roomId:'7',canonical:true,
      blockHash:hash('2'),domainSeparator:hash('d'),deploymentDomain:hash('c'),
    })
    const submit=managerAbi.find((item) => item.type==='function' && item.name==='submitBatch')
    if (!submit || submit.type!=='function') throw new Error('submitBatch ABI fixture is unavailable')
    const submissionParameter=submit.inputs[1]!
    if (submissionParameter.type!=='tuple' || !('components' in submissionParameter)) {
      throw new Error('submitBatch submission fixture is malformed')
    }
    const journalParameter=submissionParameter.components[0]!
    const provisional=jsonAbiValue(submissionParameter) as Record<string,unknown>
    const contractJournal=provisional.journal as Record<string,unknown>
    Object.assign(contractJournal,{
      protocolVersion:'6',roomId:'7',batchIndex:'1',admissionCursorBefore:'0',
      admissionCursorAfter:'0',l1InclusionDeadline:'1000',
    })
    provisional.seal='0x'
    provisional.canonicalBatchData='0x0102'
    const journalHash=keccak256(encodeAbiParameters(
      [journalParameter],[encodeAbiValue(journalParameter,contractJournal)],
    ))
    const prepareArtifactDigest='4'.repeat(64)
    const guestJournal={ protocol_version:6,room_id:7,batch_index:1,fixture:'catalog' }
    const proofRequest={
      roomWitnessB64:'AQI=',inputDigest:`0x${prepareArtifactDigest}`,jobId:'live-room-proof-identity',
      proofMode:'groth16',production:true,
    }
    const prepareResult={
      schemaVersion:1,preparedFrom:'live-room-engine-state',fixture:false,programId:hash('c'),
      journal:guestJournal,journalHash,prepareArtifactDigest,contentAddress:prepareArtifactDigest,
      proverJobIdentity:'live-room-proof-identity',roomWitnessB64:'AQI=',proofRequest,
      provisionalSubmission:provisional,proofWork:{ blockCount:1,encodedWitnessBytes:2 },
    }
    const proveResult={
      receiptB64:'AwQ=',ethereumSealB64:'AQI=',journal:guestJournal,journalHash,
      journalB64:'BQY=',jobId:'live-room-proof-identity',inputDigest:`0x${prepareArtifactDigest}`,
      backendId:'risc0',programId:hash('c'),proofMode:'groth16',imageId:hash('d'),
    }
    const verifyRequest={ journal:guestJournal,journalHash,receiptB64:'AwQ=' }
    const verifyResult={
      ok:true,journal:guestJournal,journalHash,proofMode:'groth16',ethereumSealB64:'AQI=',
      verifyMs:12,imageId:hash('d'),
    }
    const correlationId='room-batch:catalog:001'
    const artifacts=[
      { name:'prepare',jobId:`pj-${'a'.repeat(20)}`,endpoint:'/hosting/v1/rooms/prepare-batch',request:{ live:true },result:prepareResult },
      { name:'prove',jobId:`pj-${'b'.repeat(20)}`,endpoint:'/v5/rooms/prove',request:proofRequest,result:proveResult },
      { name:'verify',jobId:`pj-${'c'.repeat(20)}`,endpoint:'/v5/rooms/verify',request:verifyRequest,result:verifyResult },
    ] as const
    const bindings:Record<string,{ jobId:string;resultDigest:string }>={}
    for (const [index,artifact] of artifacts.entries()) {
      const proofClass=`catalog-room-batch-${artifact.name}`
      await hosted.store.upsertProofProfile(hosted.writableFence(),{
        proofClass,endpoint:artifact.endpoint,needsGpu:artifact.name==='prove',estimatedWork:'1',
        estimatedProofTimeMs:1_000,settlementMarginMs:1_000,
        evidence:{ fixture:'hosted-api-catalog' },verifiedAt:new Date().toISOString(),
      })
      const requestObject=await hosted.objects.putContent(
        new TextEncoder().encode(JSON.stringify(artifact.request)),'application/json',
      )
      const resultObject=await hosted.objects.putContent(
        new TextEncoder().encode(JSON.stringify(artifact.result)),'application/json',
      )
      await hosted.store.submitProveJob(hosted.writableFence(),{
        jobId:artifact.jobId,retryOfJobId:null,chainId:31_337,tenantId:'tenant-a',roomId:'7',
        allocationId:null,sponsorshipId:null,serviceClass:'batch',correlationId,partition:'shared',
        proofClass,endpoint:artifact.endpoint,idempotencyKey:`catalog-room-batch-job-${index}`,
        requestHash:requestObject.sha256,requestObjectKey:requestObject.key,requestBytes:requestObject.bytes,
        deadlineAt:null,priority:0,billingMode:'telemetry-only',
        maximumChargeAmount:null,maximumChargeCurrency:null,
      })
      await pool.query(
        `UPDATE hosted_prove_jobs SET status='DONE',result_object_key=$2,result_digest=$3,
           finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE job_id=$1`,
        [artifact.jobId,resultObject.key,resultObject.sha256],
      )
      bindings[artifact.name]={ jobId:artifact.jobId,resultDigest:resultObject.sha256 }
    }
    const body={
      schemaVersion:1,chainId:31_337,roomManager,expectedOperationsAccount:roomOperationsAccount,
      roomId:'7',artifacts:{
        prepare:{ ...bindings.prepare!,prepareArtifactDigest },prove:bindings.prove!,verify:bindings.verify!,
      },admissionIds:[],confirmationPolicy:{ minimumConfirmations:64,requireFinalized:true },
    }
    const originalAgreedBlock=hosted.l1.agreedBlock.bind(hosted.l1)
    hosted.l1.agreedBlock=(async (tag:string) => {
      if (tag!=='latest' && tag!=='0xc') throw new Error(`unexpected batch block tag ${tag}`)
      return { chainId:31_337,number:'12',hash:hash('2'),parentHash:hash('1'),
        parentBeaconBlockRoot:null,timestamp:'1787317200',verifiedSources:['catalog-rpc-a','catalog-rpc-b'] }
    }) as typeof hosted.l1.agreedBlock
    try {
      const headers={ ...auth(roomOperationsToken,'room-batch-catalog-001'),'x-correlation-id':correlationId }
      const clientInput={
        correlationId,
        prepare:{ jobId:bindings.prepare!.jobId,attempt:1,retryOfJobId:null,resultDigest:bindings.prepare!.resultDigest },
        prove:{ jobId:bindings.prove!.jobId,attempt:1,retryOfJobId:null,resultDigest:bindings.prove!.resultDigest },
        verify:{ jobId:bindings.verify!.jobId,attempt:1,retryOfJobId:null,resultDigest:bindings.verify!.resultDigest },
        prepareArtifactDigest,admissionIds:[],
      }
      await owner.ackAdmissions([],correlationId)
      const operation=await owner.publishBatch(clientInput)
      expect(operation).toMatchObject({
        status:'RESERVED',chainId:31_337,from:roomOperationsAccount,to:roomManager,
        correlationId,binding:{ roomId:'7',prepareJobId:bindings.prepare!.jobId,
          proveJobId:bindings.prove!.jobId,verifyJobId:bindings.verify!.jobId,journalHash,admissionIds:[] },
      })
      expect(lastRoomBatchInput?.calldata.slice(0,10)).toBe(
        encodeFunctionData({ abi:[submit],functionName:'submitBatch',args:[7n,encodeAbiValue(submissionParameter,{ ...provisional,seal:'0x0102' })] }).slice(0,10),
      )
      expect(lastRoomBatchInput?.payload).toMatchObject({
        prepareResultDigest:bindings.prepare!.resultDigest,proveResultDigest:bindings.prove!.resultDigest,
        verifyResultDigest:bindings.verify!.resultDigest,journalHash,admissionIds:[],
      })
      const stored=roomBatchOperations.get(operation.idempotencyKey)!
      stored.result={
        ...stored.result,status:'FINALIZED',transactionHash:hash('e'),blockNumber:'12',blockHash:hash('2'),
        confirmations:65,receiptSource:{ providerIds:['catalog-rpc-a','catalog-rpc-b'],
          observedAt:'2026-08-21T12:00:00.000Z',canonical:true },finalized:true,
      }
      expect(await owner.operation(operation.operationId,clientInput)).toEqual(stored.result)

      const drift=await context.app.inject({
        method:'POST',url:'/hosting/v1/l1-operations/room-batches',headers,
        payload:{ ...body,artifacts:{ ...body.artifacts,verify:{ ...body.artifacts.verify,resultDigest:'f'.repeat(64) } } },
      })
      expect(drift.statusCode).toBe(409)
    } finally {
      hosted.l1.agreedBlock=originalAgreedBlock
    }
  })

  it('derives submitAggregate and exact sidecars from one ordered durable proof lineage',async () => {
    const submit=managerAbi.find((item) => item.type==='function' && item.name==='submitAggregate')
    const submitBatch=managerAbi.find((item) => item.type==='function' && item.name==='submitBatch')
    if (!submit || submit.type!=='function' || !submitBatch || submitBatch.type!=='function') {
      throw new Error('aggregate ABI fixtures are unavailable')
    }
    const submissionParameter=submitBatch.inputs[1]!
    if (submissionParameter.type!=='tuple' || !('components' in submissionParameter)) {
      throw new Error('aggregate member submission fixture is malformed')
    }
    const journalParameter=submissionParameter.components[0]!
    const provisional=jsonAbiValue(submissionParameter) as Record<string,unknown>
    const contractJournal=provisional.journal as Record<string,unknown>
    Object.assign(contractJournal,{
      protocolVersion:'6',deploymentDomain:hash('c'),roomId:'7',batchIndex:'2',
      admissionCursorBefore:'0',admissionCursorAfter:'0',l1InclusionDeadline:'1000',
    })
    provisional.seal='0x'
    provisional.canonicalBatchData='0x0102'
    const journalHash=keccak256(encodeAbiParameters(
      [journalParameter],[encodeAbiValue(journalParameter,contractJournal)],
    ))
    const blob=`0x${'00'.repeat(131_072)}` as Hex
    const bundle=await buildBlobBundleFromBlobs([blob])
    const blobB64=Buffer.from(blob.slice(2),'hex').toString('base64')
    const roomProgramId=hash('c')
    const prepareArtifactDigest='6'.repeat(64)
    const roomProofRequest={
      roomWitnessB64:'AQI=',inputDigest:`0x${prepareArtifactDigest}`,jobId:'aggregate-room-proof',
      proofMode:'groth16',production:true,
    }
    const guestJournal={ protocol_version:6,room_id:7,batch_index:2,fixture:'aggregate-catalog' }
    const roomPrepareResult={
      schemaVersion:1,preparedFrom:'live-room-engine-state',fixture:false,programId:roomProgramId,
      journal:guestJournal,journalHash,prepareArtifactDigest,contentAddress:prepareArtifactDigest,
      proofRequest:roomProofRequest,provisionalSubmission:provisional,
    }
    const roomProveResult={
      receiptB64:'AwQ=',ethereumSealB64:'AQI=',journal:guestJournal,journalHash,
      jobId:'aggregate-room-proof',inputDigest:`0x${prepareArtifactDigest}`,
      backendId:'risc0',programId:roomProgramId,proofMode:'groth16',
    }
    const roomVerifyRequest={ journal:guestJournal,journalHash,receiptB64:'AwQ=' }
    const roomVerifyResult={
      ok:true,journal:guestJournal,journalHash,proofMode:'groth16',ethereumSealB64:'AQI=',
    }
    const daStatement=hash('8'),daProgramId=hash('9')
    const equivalenceWitness={
      deploymentDomain:hash('c'),roomId:'7',journalHash,canonicalData:'0x01',blobStartIndex:0,
      blobVersionedHashes:bundle.versionedHashes,commitments:bundle.commitments,
      evaluationPoints:[hash('1')],evaluations:[hash('2')],
    }
    const manifest=(seal:Hex) => ({
      canonicalDataHash:hash('d'),canonicalDataLength:'1',blobStartIndex:0,
      blobVersionedHashes:bundle.versionedHashes,commitments:bundle.commitments,
      evaluationPoints:[hash('1')],evaluations:[hash('2')],
      kzgProofs:[`0x${'00'.repeat(48)}`],equivalenceSeal:seal,
      fallbackDeadlineBlock:'0',fallbackSignature:'0x',
    })
    const daPrepareRequest={ equivalenceWitness }
    const daPrepareResult={
      equivalenceWitness,statement:daStatement,dataAvailabilityManifest:manifest('0x'),blobsB64:[blobB64],
    }
    const daProveRequest={ equivalenceWitness,proofMode:'groth16',production:true }
    const daProveResult={
      kind:'data-availability-equivalence',statement:daStatement,programId:daProgramId,
      proofMode:'groth16',receiptB64:'BQY=',ethereumSealHex:'0x1234',equivalenceWitness,
      dataAvailabilityManifest:manifest('0x1234'),blobsB64:[blobB64],
    }
    const daVerifyRequest={ equivalenceWitness,receiptB64:'BQY=' }
    const daVerifyResult={
      ok:true,statement:daStatement,programId:daProgramId,dataAvailabilityManifest:manifest('0x'),
    }
    const aggregateWitness={
      deploymentDomain:hash('c'),members:[{
        roomId:'7',roomProgramId,journalHash,
        equivalenceProgramId:daProgramId,equivalenceStatement:daStatement,
      }],
    }
    const memberReceipts=[{ roomReceiptB64:'AwQ=',equivalenceReceiptB64:'BQY=' }]
    const aggregateProveRequest={ aggregateWitness,memberReceipts,proofMode:'groth16',production:true }
    const aggregateStatement=hash('a'),aggregateProgramId=hash('b')
    const aggregateProveResult={
      kind:'recursive-room-aggregate',statement:aggregateStatement,programId:aggregateProgramId,
      proofMode:'groth16',receiptB64:'Bwg=',ethereumSealHex:'0x5678',aggregateWitness,memberCount:1,
    }
    const aggregateVerifyRequest={ aggregateWitness,receiptB64:'Bwg=' }
    const aggregateVerifyResult={
      ok:true,statement:aggregateStatement,programId:aggregateProgramId,memberCount:1,
    }
    const correlationId='room-aggregate:catalog:001'
    const fixtures=[
      { key:'d',name:'room-prepare',endpoint:'/hosting/v1/rooms/prepare-batch',request:{ live:true },result:roomPrepareResult,roomId:'7' },
      { key:'e',name:'room-prove',endpoint:'/v5/rooms/prove',request:roomProofRequest,result:roomProveResult,roomId:'7' },
      { key:'f',name:'room-verify',endpoint:'/v5/rooms/verify',request:roomVerifyRequest,result:roomVerifyResult,roomId:'7' },
      { key:'1',name:'da-prepare',endpoint:'/v5/data-availability/prepare',request:daPrepareRequest,result:daPrepareResult,roomId:'7' },
      { key:'2',name:'da-prove',endpoint:'/v5/data-availability/prove',request:daProveRequest,result:daProveResult,roomId:'7' },
      { key:'3',name:'da-verify',endpoint:'/v5/data-availability/verify',request:daVerifyRequest,result:daVerifyResult,roomId:'7' },
      { key:'4',name:'aggregate-prove',endpoint:'/v5/aggregates/prove',request:aggregateProveRequest,result:aggregateProveResult,roomId:null },
      { key:'5',name:'aggregate-verify',endpoint:'/v5/aggregates/verify',request:aggregateVerifyRequest,result:aggregateVerifyResult,roomId:null },
    ] as const
    const bindings:Record<string,{ jobId:string;resultDigest:string }>={}
    for (const [index,fixture] of fixtures.entries()) {
      const jobId=`pj-${fixture.key.repeat(20)}`
      // hosted_proof_profiles enforces one class per endpoint; the three room
      // endpoints are already owned by the room-batch catalog test's classes.
      const proofClass=fixture.name.startsWith('room-')
        ? `catalog-room-batch-${fixture.name.slice(5)}`
        : `catalog-room-aggregate-${fixture.name}`
      await hosted.store.upsertProofProfile(hosted.writableFence(),{
        proofClass,endpoint:fixture.endpoint,needsGpu:fixture.endpoint.endsWith('/prove'),
        estimatedWork:'1',estimatedProofTimeMs:1_000,settlementMarginMs:1_000,
        evidence:{ fixture:'hosted-api-catalog' },verifiedAt:new Date().toISOString(),
      })
      const requestObject=await hosted.objects.putContent(
        new TextEncoder().encode(JSON.stringify(fixture.request)),'application/json',
      )
      const resultObject=await hosted.objects.putContent(
        new TextEncoder().encode(JSON.stringify(fixture.result)),'application/json',
      )
      await hosted.store.submitProveJob(hosted.writableFence(),{
        jobId,retryOfJobId:null,chainId:31_337,tenantId:'tenant-a',roomId:fixture.roomId,
        allocationId:null,sponsorshipId:null,serviceClass:'batch',correlationId,partition:'shared',
        proofClass,endpoint:fixture.endpoint,idempotencyKey:`catalog-aggregate-job-${index}`,
        requestHash:requestObject.sha256,requestObjectKey:requestObject.key,requestBytes:requestObject.bytes,
        deadlineAt:null,priority:0,billingMode:'telemetry-only',
        maximumChargeAmount:null,maximumChargeCurrency:null,
      })
      await pool.query(
        `UPDATE hosted_prove_jobs SET status='DONE',result_object_key=$2,result_digest=$3,
           finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE job_id=$1`,
        [jobId,resultObject.key,resultObject.sha256],
      )
      bindings[fixture.name]={ jobId,resultDigest:resultObject.sha256 }
    }
    const body={
      schemaVersion:1,chainId:31_337,roomManager,expectedOperationsAccount:aggregateAccount,
      artifacts:{
        members:[{ roomId:'7',prepare:{ ...bindings['room-prepare']!,prepareArtifactDigest },
          prove:bindings['room-prove']!,verify:bindings['room-verify']! }],
        aggregate:{ prove:bindings['aggregate-prove']!,verify:bindings['aggregate-verify']! },
        dataAvailability:[{ memberIndex:0,roomId:'7',prepare:bindings['da-prepare']!,
          prove:bindings['da-prove']!,verify:bindings['da-verify']! }],
      },
      confirmationPolicy:{ minimumConfirmations:64,requireFinalized:true },
    }
    const headers={ ...auth(aggregateToken,'room-aggregate-catalog-001'),'x-correlation-id':correlationId }
    const accepted=await context.app.inject({
      method:'POST',url:'/hosting/v1/l1-operations/room-aggregates',headers,payload:body,
    })
    expect(accepted.statusCode,accepted.body).toBe(202)
    const operation=accepted.json<ManagedL1OperationResult>()
    expect(operation).toMatchObject({
      status:'RESERVED',from:aggregateAccount,to:roomManager,correlationId,
      binding:{ kind:'ROOM_AGGREGATE',selector:'0x5e8b37ac',transactionType:3,
        aggregateStatement,aggregateProgramId,zkdealBlobCount:1,
        members:[expect.objectContaining({ memberIndex:0,roomId:'7',batchIndex:'2',journalHash })] },
    })
    expect(lastAggregateInput?.calldata.slice(0,10)).toBe('0x5e8b37ac')
    expect(lastAggregateInput?.blobs).toEqual([blob])
    expect(lastAggregateInput?.payload.orderedBlobVersionedHashes).toEqual(bundle.versionedHashes)
    const status=await context.app.inject({
      method:'GET',url:`/hosting/v1/l1-transactions/${operation.operationId}`,headers:auth(aggregateToken),
    })
    expect(status.statusCode).toBe(200)
    expect(status.json()).toEqual(operation)
    const crossPrincipal=await context.app.inject({
      method:'GET',url:`/hosting/v1/l1-transactions/${operation.operationId}`,headers:auth(livenessToken),
    })
    expect(crossPrincipal.statusCode).toBe(403)
    const drift=await context.app.inject({
      method:'POST',url:'/hosting/v1/l1-operations/room-aggregates',headers,
      payload:{ ...body,confirmationPolicy:{ minimumConfirmations:63,requireFinalized:true } },
    })
    expect(drift.statusCode).toBe(409)

    // A deep-lineage conflict maps to the declared 409, never a masked 500:
    // this verify job is complete and digest-bound, but its durable request
    // carries a different receipt than the aggregate prove artifact.
    const mismatchedJobId=`pj-${'6'.repeat(20)}`
    await hosted.store.upsertProofProfile(hosted.writableFence(),{
      proofClass:'catalog-room-aggregate-aggregate-verify',endpoint:'/v5/aggregates/verify',
      needsGpu:false,estimatedWork:'1',estimatedProofTimeMs:1_000,settlementMarginMs:1_000,
      evidence:{ fixture:'hosted-api-catalog' },verifiedAt:new Date().toISOString(),
    })
    const mismatchedRequestObject=await hosted.objects.putContent(
      new TextEncoder().encode(JSON.stringify({ aggregateWitness,receiptB64:'CQo=' })),'application/json',
    )
    const mismatchedResultObject=await hosted.objects.putContent(
      new TextEncoder().encode(JSON.stringify(aggregateVerifyResult)),'application/json',
    )
    await hosted.store.submitProveJob(hosted.writableFence(),{
      jobId:mismatchedJobId,retryOfJobId:null,chainId:31_337,tenantId:'tenant-a',roomId:null,
      allocationId:null,sponsorshipId:null,serviceClass:'batch',correlationId,partition:'shared',
      proofClass:'catalog-room-aggregate-aggregate-verify',endpoint:'/v5/aggregates/verify',
      idempotencyKey:'catalog-aggregate-job-verify-mismatch',
      requestHash:mismatchedRequestObject.sha256,requestObjectKey:mismatchedRequestObject.key,
      requestBytes:mismatchedRequestObject.bytes,deadlineAt:null,priority:0,
      billingMode:'telemetry-only',maximumChargeAmount:null,maximumChargeCurrency:null,
    })
    await pool.query(
      `UPDATE hosted_prove_jobs SET status='DONE',result_object_key=$2,result_digest=$3,
         finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE job_id=$1`,
      [mismatchedJobId,mismatchedResultObject.key,mismatchedResultObject.sha256],
    )
    const lineageConflict=await context.app.inject({
      method:'POST',url:'/hosting/v1/l1-operations/room-aggregates',
      headers:{
        ...auth(aggregateToken,'room-aggregate-lineage-conflict-001'),
        'x-correlation-id':correlationId,
      },
      payload:{ ...body,artifacts:{ ...body.artifacts,aggregate:{
        prove:bindings['aggregate-prove']!,
        verify:{ jobId:mismatchedJobId,resultDigest:mismatchedResultObject.sha256 },
      } } },
    })
    expect(lineageConflict.statusCode,lineageConflict.body).toBe(409)
    expect(lineageConflict.json<{ error:string }>().error).toContain('not one production recursive receipt')

    // Adversarial shape and authority denials fail before any signing.
    const memberFixture=body.artifacts.members[0]!
    // The original correlation is kept so member-lineage loading stays valid;
    // every request still uses a fresh idempotency key.
    const adversarial=async (payload:Record<string,unknown>,suffix:string) => context.app.inject({
      method:'POST',url:'/hosting/v1/l1-operations/room-aggregates',
      headers:{
        ...auth(aggregateToken,`room-aggregate-adversarial-${suffix}`),
        'x-correlation-id':correlationId,
      },
      payload,
    })
    // Duplicate member rooms are rejected.
    expect((await adversarial({
      ...body,artifacts:{ ...body.artifacts,members:[memberFixture,{ ...memberFixture }] },
    },'duplicate-rooms')).statusCode).toBe(400)
    // More than eight member rooms are rejected.
    expect((await adversarial({
      ...body,artifacts:{
        ...body.artifacts,
        members:Array.from({ length:9 },(_,index) => ({ ...memberFixture,roomId:String(index+1) })),
      },
    },'nine-rooms')).statusCode).toBe(400)
    // Malformed artifact references are rejected.
    expect((await adversarial({
      ...body,artifacts:{
        ...body.artifacts,
        members:[{ ...memberFixture,prepare:{ ...memberFixture.prepare,jobId:'pj-XYZ' } }],
      },
    },'malformed-artifact')).statusCode).toBe(400)
    // A member room outside the principal tenant is denied.
    expect((await adversarial({
      ...body,artifacts:{ ...body.artifacts,members:[{ ...memberFixture,roomId:'999' }] },
    },'wrong-tenant')).statusCode).toBe(403)
    // A sender other than the immutably bound aggregate signer is denied.
    expect((await adversarial({
      ...body,expectedOperationsAccount:roomOperationsAccount,
    },'wrong-sender')).statusCode).toBe(403)
    // A DA lineage aimed at a nonexistent member index is rejected.
    expect((await adversarial({
      ...body,artifacts:{
        ...body.artifacts,
        dataAvailability:[{ ...body.artifacts.dataAvailability[0]!,memberIndex:5 }],
      },
    },'wrong-da-member')).statusCode).toBe(400)
    // DA entries can never address more than the eight member positions.
    expect((await adversarial({
      ...body,artifacts:{
        ...body.artifacts,
        dataAvailability:Array.from({ length:9 },(_,index) => ({
          ...body.artifacts.dataAvailability[0]!,memberIndex:index,
        })),
      },
    },'da-overflow')).statusCode).toBe(400)
  },120_000)

  it('serves the authenticated public indexer and custody JSON-RPC catalog with tenant isolation', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['zkdeal_getIndexerStatus', {}],
      ['zkdeal_getCanonicalBlock', { number: '12' }],
      ['zkdeal_getBlocks', { fromBlock: '10' }],
      ['zkdeal_getRoom', { roomId: '7' }],
      ['zkdeal_getRoomEvents', { roomId: '7' }],
      ['zkdeal_getDeposits', { roomId: '7' }],
      ['zkdeal_getImports', { roomId: '7' }],
      ['zkdeal_getAdmissions', { roomId: '7' }],
      ['zkdeal_getBatches', { roomId: '7' }],
      ['zkdeal_getTransaction', { transactionHash }],
      ['zkdeal_getWithdrawals', { roomId: '7' }],
      ['zkdeal_getWithdrawalProof', { roomId: '7', epoch: '1', withdrawalIndex: '0' }],
      ['zkdeal_getFinalityStatus', {}],
      ['zkdeal_getReconciliationStatus', { roomId: '7' }],
      ['zkdeal_getUsage', {}],
      ['zkdeal_getBillingLedger', {}],
      ['zkdeal_getInvoices', {}],
      ['zkdeal_getRefunds', {}],
    ]
    for (const [method, params] of calls) {
      const response = await rpc(tenantToken, method, params)
      expect(response.error, `${method}: ${response.error?.message}`).toBeUndefined()
      expect(response.result).toBeDefined()
    }
    expect((await rpc(otherTenantToken, 'zkdeal_getRoom', { roomId: '7' })).error?.code).toBe(-32004)
    expect((await rpc(otherTenantToken, 'zkdeal_getWithdrawalProof', {
      roomId: '7', epoch: '1', withdrawalIndex: '0',
    })).error?.code).toBe(-32004)
  })

  it('exposes durable entitlement, sponsorship, capacity, claim, and separate admin operations', async () => {
    const entitlement = await context.app.inject({
      method: 'POST', url: '/hosting/v1/entitlements',
      headers: auth(adminToken, 'entitlement-create-001'),
      payload: {
        entitlementId: 'entitlement-001', tenantId: 'tenant-a', unit: 'gpu-second',
        quantity: '3600.5', startsAt: '2026-08-21T00:00:00.000Z', metadata: { tier: 'integration' },
      },
    })
    expect(entitlement.statusCode).toBe(201)
    const sponsorship = await context.app.inject({
      method: 'POST', url: '/hosting/v1/sponsorships',
      headers: auth(tenantToken, 'sponsorship-create-001'),
      payload: {
        sponsorshipId: 'sponsorship-001', beneficiaryTenantId: 'tenant-b',
        maximumQuantity: '100', unit: 'proof', metadata: {},
      },
    })
    expect(sponsorship.statusCode).toBe(201)
    const capacity = await context.app.inject({
      method: 'POST', url: '/hosting/v1/capacity/intents',
      headers: auth(tenantToken, 'capacity-intent-create-001'),
      payload: {
        allocationId: 'allocation-001', roomId: '7', desiredState: 'RENEW', metadata: {},
      },
    })
    expect(capacity.statusCode).toBe(202)

    expect((await rpc(tenantToken, 'zkdeal_getEntitlements')).result).toEqual(
      expect.arrayContaining([expect.objectContaining({ entitlementId: 'entitlement-001' })]),
    )
    expect((await rpc(tenantToken, 'zkdeal_getSponsorships')).result).toEqual(
      expect.arrayContaining([expect.objectContaining({ sponsorshipId: 'sponsorship-001' })]),
    )
    expect((await rpc(tenantToken, 'zkdeal_getCapacity')).result).toEqual(
      expect.arrayContaining([expect.objectContaining({ allocationId: 'allocation-001' })]),
    )

    const claim = await rpc(tenantToken, 'zkdeal_requestWithdrawalClaim', {
      roomId: '7', epoch: '1', withdrawalIndex: '0',
    }, 'withdrawal-claim-001')
    expect(claim.result).toMatchObject({ status: 'PENDING' })
    const replay = await rpc(tenantToken, 'zkdeal_requestWithdrawalClaim', {
      roomId: '7', epoch: '1', withdrawalIndex: '0',
    }, 'withdrawal-claim-001')
    expect(replay.result).toEqual(claim.result)

    expect((await rpc(tenantToken, 'zkdeal_adminBackfill', { fromBlock: '12' }, 'tenant-backfill-denied')).error)
      .toMatchObject({ code: -32003 })
    expect((await rpc(adminToken, 'zkdeal_adminBackfill', { fromBlock: '12' }, 'admin-backfill-001')).result)
      .toMatchObject({ accepted: true, fromBlock: '12' })
    expect((await rpc(adminToken, 'zkdeal_adminReconcile', { roomId: '7' }, 'admin-reconcile-001')).result)
      .toMatchObject({ accepted: true, roomId: '7' })
    expect((await rpc(adminToken, 'zkdeal_adminRetention', {}, 'admin-retention-001')).error).toBeUndefined()
  })

  it('publishes effective billing/SLA terms and immutable invoice exports', async () => {
    const price = await context.app.inject({
      method: 'POST', url: '/hosting/v1/admin/billing/prices',
      headers: auth(adminToken, 'billing-price-api-001'),
      payload: {
        tenantId: 'tenant-a', unit: 'proof-work', currency: 'GBP', unitPrice: '2.5',
        effectiveFrom: '2026-08-01T00:00:00.000Z',
      },
    })
    expect(price.statusCode).toBe(201)
    const sla = await context.app.inject({
      method: 'POST', url: '/hosting/v1/admin/sla/policies',
      headers: auth(adminToken, 'billing-sla-api-001'),
      payload: {
        tenantId: 'tenant-a', serviceClass: 'standard', maximumQueueMs: 5000,
        maximumProofMs: 60000, creditBasisPoints: 1000,
        effectiveFrom: '2026-08-01T00:00:00.000Z',
      },
    })
    expect(sla.statusCode).toBe(201)
    const invoiceRequest = {
      method: 'POST', url: '/hosting/v1/admin/invoices',
      headers: auth(adminToken, 'billing-invoice-api-001'),
      payload: {
        invoiceId: 'invoice-tenant-a-2026-08', tenantId: 'tenant-a',
        periodStart: '2026-08-01T00:00:00.000Z', periodEnd: '2026-09-01T00:00:00.000Z',
        currency: 'GBP',
      },
    } as const
    const invoice = await context.app.inject(invoiceRequest)
    expect(invoice.statusCode).toBe(201)
    expect(invoice.json()).toMatchObject({
      invoiceId: 'invoice-tenant-a-2026-08', tenantId: 'tenant-a',
      currency: 'GBP', netAmount: '0', ledgerHighWater: '0',
    })
    expect((await context.app.inject(invoiceRequest)).statusCode).toBe(200)
    const listed = await context.app.inject({
      method: 'GET', url: '/hosting/v1/invoices', headers: auth(tenantToken),
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json<any>().invoices).toEqual(expect.arrayContaining([
      expect.objectContaining({ invoiceId: 'invoice-tenant-a-2026-08' }),
    ]))
    expect((await rpc(tenantToken, 'zkdeal_getInvoices')).result).toEqual(
      expect.arrayContaining([expect.objectContaining({ invoiceId: 'invoice-tenant-a-2026-08' })]),
    )
  })

  it('derives post-finality recovery branches from independent RPC agreement and replays every owner source', async () => {
    const fence = hosted.writableFence()
    const operationId = 'catalog-post-finality-operation'
    await hosted.store.reserveL1Transaction(fence, {
      operationId,chainId: 31_337,sender: address('9'),operation: 'publish-blob',
      idempotencyKey: 'catalog-post-finality-operation-key',requestHash: 'a'.repeat(64),
      requestObjectKey: `zkdeal/sha256/aa/${'a'.repeat(64)}`,destinationAddress: address('8'),
      calldata: '0x',inclusionDeadline: '1000',remotePendingNonce: '0',
    })
    await hosted.store.attachSignedL1Transaction(fence, operationId, {
      transactionHash: hash('9'),rawTransactionObjectKey: `zkdeal/sha256/bb/${'b'.repeat(64)}`,
      bundleObjectKey: `zkdeal/sha256/cc/${'c'.repeat(64)}`,
    })
    await hosted.store.markL1TransactionBroadcast(fence,operationId)
    await hosted.store.markL1TransactionIncluded(fence,operationId,'11',hash('1'))
    await hosted.store.markL1TransactionFinalized(fence,operationId,'12',hash('2'))
    await hosted.store.advanceCanonicalFloor(fence, {
      chainId: 31_337,number: '12',hash: hash('2'),verifiedSources: ['catalog-rpc-a','catalog-rpc-b'],
    })
    await hosted.store.markL1TransactionRetracted(
      fence,operationId,'independent finalized audit found a conflicting branch',
      ['catalog-rpc-a','catalog-rpc-b'],
    )

    let agree = false
    const recoveryBlocks = new Map([
      ['0xb', { number: '11',hash: hash('3'),parentHash: hash('0') }],
      ['0xc', { number: '12',hash: hash('4'),parentHash: hash('3') }],
    ])
    hosted.l1.agreedBlock = (async (tag: string) => {
      if (!agree) throw new Error('provider split')
      const block = recoveryBlocks.get(tag)
      if (!block) throw new Error(`unexpected block tag ${tag}`)
      return {
        chainId: 31_337,...block,parentBeaconBlockRoot: null,timestamp: '1787317200',
        verifiedSources: ['catalog-rpc-a','catalog-rpc-b'],
      }
    }) as typeof hosted.l1.agreedBlock
    const recoveryId = 'catalog-post-finality-recovery'
    const installRequest = {
      method: 'POST' as const,url: '/hosting/v1/internal/post-finality-recoveries',
      headers: auth(adminToken,recoveryId),
      payload: {
        recoveryId,operationId,expectedPriorFloor: { number: '12',hash: hash('2') },
        reason: 'independent providers agree on a replacement canonical branch',
      },
    }
    expect((await context.app.inject({ ...installRequest,headers: auth(tenantToken,recoveryId) })).statusCode)
      .toBe(401)
    expect((await context.app.inject(installRequest)).statusCode).toBe(503)
    agree = true
    const installed = await context.app.inject(installRequest)
    expect(installed.statusCode).toBe(201)
    expect(installed.json()).toMatchObject({ status: 'BRANCH_INSTALLED',branchStartNumber: '11' })
    expect((await context.app.inject(installRequest)).statusCode).toBe(200)

    for (const source of ['room-manager','room-pool']) {
      await hosted.store.ingestIndexerRecords(fence, {
        chainId: 31_337,blockNumber: '12',blockHash: hash('4'),source,
        schemaVersion: 2,logs: [],facts: [],
      })
    }
    const finalized = await context.app.inject({
      method: 'POST',url: `/hosting/v1/internal/post-finality-recoveries/${recoveryId}/finalize`,
      headers: auth(adminToken,`${recoveryId}:finalize`),payload: {},
    })
    expect(finalized.statusCode).toBe(200)
    expect(finalized.json()).toMatchObject({
      status: 'RESOLVED',replacementFloor: { number: '12',hash: hash('4') },
    })
    expect((await hosted.store.l1Transaction(operationId))?.status).toBe('SUPERSEDED')
  })
})
