import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import {
  PostgresHostedStore,createPostgresPool,type SqlPool,
} from '../src/postgres-hosted-store.js'

const databaseUrl=process.env.TEST_DATABASE_URL
const integration=databaseUrl ? describe : describe.skip
const chainId=992_026
const blockHash=`0x${'aa'.repeat(32)}` as `0x${string}`
const parentHash=`0x${'99'.repeat(32)}` as `0x${string}`
const address=(byte:string) => `0x${byte.repeat(40)}` as `0x${string}`
const bytes32=(byte:string) => `0x${byte.repeat(64)}` as `0x${string}`

integration('PostgreSQL semantic reconciliation drift gates',() => {
  let pool:SqlPool
  let store:PostgresHostedStore
  let fence:NonNullable<Awaited<ReturnType<PostgresHostedStore['acquireLease']>>>
  let sequence=1

  beforeAll(async () => {
    pool=await createPostgresPool(databaseUrl!)
    store=new PostgresHostedStore(pool,'semantic-reconciliation-pepper-0001',[])
    await store.bootstrap()
    const acquired=await store.acquireLease('coordinator-writer','semantic-reconciler',60_000)
    if (!acquired) throw new Error('semantic test writer lease is unavailable')
    fence=acquired
    await store.upsertTenant(fence,{ tenantId:'semantic-tenant',displayName:'Semantic Tenant',tier:'test' })
    await pool.query(
      `INSERT INTO canonical_l1_blocks(chain_id,block_number,block_hash,parent_hash,canonical,observed_at)
       VALUES ($1,10,$2,$3,true,clock_timestamp()) ON CONFLICT DO NOTHING`,
      [chainId,blockHash,parentHash],
    )
  })

  afterAll(async () => { await store.close() })

  const tx=() => `0x${(sequence++).toString(16).padStart(64,'0')}` as `0x${string}`
  const insertFact=async (
    roomId:string,eventName:string,args:Record<string,unknown>,
    options:{ blockNumber?:string;blockHash?:`0x${string}`;transactionHash?:`0x${string}`;source?:string }={},
  ) => {
    const transactionHash=options.transactionHash ?? tx()
    const number=options.blockNumber ?? '10'
    const hash=options.blockHash ?? blockHash
    const result=await pool.query<{ fact_id:string }>(
      `INSERT INTO hosted_indexer_facts(
         fact_key,chain_id,block_number,block_hash,fact_kind,room_id,tenant_id,payload,canonical
       ) VALUES ($1,$2,$3,$4,$5,$6,'semantic-tenant',$7::jsonb,true)
       RETURNING fact_id::text`,[
        `semantic:${sequence}:${eventName}`,chainId,number,hash,eventName.toLowerCase(),roomId,
        JSON.stringify({ args:{ roomId,...args },provenance:{
          source:options.source ?? 'room-manager',chainId,blockNumber:number,blockHash:hash,
          transactionHash,logIndex:sequence,address:address('1'),eventName,
          verifiedSources:['semantic-rpc-a','semantic-rpc-b'],
        } }),
      ],
    )
    return { factId:result.rows[0]!.fact_id,transactionHash }
  }

  const gate=async (roomId:string,expected:string,repair:() => Promise<void>) => {
    const failed=await store.roomSemanticProjection(chainId,roomId,'10')
    expect(failed.errors).toContain(expected)
    await store.putRoomObservation(fence,{
      chainId,roomId,tenantId:'semantic-tenant',schemaVersion:2,headBlock:'10',headHash:blockHash,
      document:{ roomId },reconciliationErrors:failed.errors,
    })
    expect(await store.roomObservation(chainId,roomId,'semantic-tenant')).toMatchObject({ reconciled:false })
    await repair()
    const repaired=await store.roomSemanticProjection(chainId,roomId,'10')
    expect(repaired.errors,`room ${roomId} should be semantically repaired`).toEqual([])
    await store.putRoomObservation(fence,{
      chainId,roomId,tenantId:'semantic-tenant',schemaVersion:2,headBlock:'10',headHash:blockHash,
      document:{ roomId },reconciliationErrors:[],
    })
    expect(await store.roomObservation(chainId,roomId,'semantic-tenant')).toMatchObject({ reconciled:true })
  }

  it('blocks and repairs independent admission, forced, import/custody, withdrawal, aggregate, blob, challenge, and sponsorship drift',async () => {
    const drift=await insertFact('101','DepositQueued',{
      inboxId:'1',beneficiary:address('2'),asset:address('3'),amount:'1',
    })
    await pool.query(
      `UPDATE hosted_indexer_facts SET payload=jsonb_set(payload,'{provenance,blockHash}',to_jsonb($2::text))
       WHERE fact_id=$1`,[drift.factId,bytes32('b')],
    )
    await gate('101',`fact ${drift.factId} has field-level provenance drift`,async () => {
      await pool.query(
        `UPDATE hosted_indexer_facts SET payload=jsonb_set(payload,'{provenance,blockHash}',to_jsonb($2::text))
         WHERE fact_id=$1`,[drift.factId,blockHash],
      )
    })

    await insertFact('102','DepositRefunded',{ inboxId:'2',depositor:address('4') })
    await gate('102','DepositRefunded inboxId 2 has no canonical DepositQueued fact',async () => {
      await insertFact('102','DepositQueued',{ inboxId:'2',beneficiary:address('2'),asset:address('3'),amount:'2' })
    })

    const forcedTx=tx()
    await insertFact('103','ForcedOutcomeRecorded',{ forcedId:'3',transactionHash:forcedTx,status:'0' })
    await gate('103','ForcedOutcomeRecorded forcedId 3 does not match its canonical queue fact',async () => {
      await insertFact('103','ForcedTransactionQueued',{
        forcedId:'3',transactionHash:forcedTx,deadlineBlock:'20',rawSignedTransaction:'0x01',
      })
    })

    await insertFact('104','WithdrawalClaimed',{
      outboxEpoch:'1',index:'0',recipient:address('5'),asset:address('3'),amount:'1',
    })
    await gate('104','WithdrawalClaimed epoch 1 has no canonical root fact',async () => {
      await insertFact('104','WithdrawalRootPublished',{ outboxEpoch:'1',withdrawalRoot:bytes32('c') })
    })

    const aggregateTx=tx()
    await insertFact('105','AggregateMemberOutcome',{
      aggregateHash:bytes32('d'),memberIndex:'0',batchIndex:'1',applied:false,failureSelector:'0x12345678',
    },{ transactionHash:aggregateTx })
    const conflictingBatch=await insertFact('105','BatchAccepted',{
      batchIndex:'1',postStateRoot:bytes32('e'),postApproverRoot:bytes32('f'),outboxEpoch:'1',closed:false,
    },{ transactionHash:aggregateTx })
    await gate('105','failed AggregateMemberOutcome conflicts with a same-transaction BatchAccepted fact',async () => {
      await pool.query('UPDATE hosted_indexer_facts SET canonical=false WHERE fact_id=$1',[conflictingBatch.factId])
    })

    const blobTx=tx()
    await insertFact('106','DataAvailabilityAccepted',{
      batchIndex:'1',configuredPolicy:'1',usedBlob:true,usedAuthorizedFallback:false,statementHash:bytes32('1'),
    },{ transactionHash:blobTx })
    await gate('106','blob-backed data-availability fact is not durably archived and verified',async () => {
      await pool.query(
        `INSERT INTO hosted_blob_requirements(
           chain_id,transaction_hash,block_number,block_hash,room_id,batch_index,blob_start_index,
           versioned_hashes,commitments,status,canonical,verified_at
         ) VALUES ($1,$2,10,$3,106,1,0,$4::text[],$5::text[],'VERIFIED',true,clock_timestamp())`,
        [chainId,blobTx,blockHash,[bytes32('2')],[`0x${'33'.repeat(48)}`]],
      )
    })

    const admissionTx=tx()
    await insertFact('107','AdmissionRecorded',{
      admissionId:'1',transactionHash:admissionTx,status:'0',
    },{ transactionHash:admissionTx })
    await gate('107','AdmissionRecorded fact is missing an exact ACKED admission WAL row',async () => {
      await pool.query(
        `INSERT INTO admission_wal(
           room_id,admission_id,tenant_id,transaction_hash,raw_signed_transaction,sender,request,receipt,status
         ) VALUES (107,1,'semantic-tenant',$1,'0x01',$2,'{}'::jsonb,'{}'::jsonb,'ACKED')`,
        [admissionTx,address('6')],
      )
    })

    const challenge=await insertFact('108','OmissionChallengeOpened',{
      admissionId:'1',transactionHash:tx(),challenger:address('7'),penalty:'0',
    })
    await gate('108','challenge/bond custody event contains a malformed zero or negative amount',async () => {
      await pool.query(
        `UPDATE hosted_indexer_facts SET payload=jsonb_set(payload,'{args,penalty}',to_jsonb('1'::text))
         WHERE fact_id=$1`,[challenge.factId],
      )
    })

    await insertFact('109','L1StateInputPublished',{
      importId:'1',l1ChainId:'1',blockNumber:'9',blockHash:bytes32('4'),stateRoot:bytes32('5'),
    })
    const conflictingImport=await insertFact('109','L1StateInputPublished',{
      importId:'1',l1ChainId:'1',blockNumber:'9',blockHash:bytes32('4'),stateRoot:bytes32('6'),
    })
    await gate('109','L1StateInputPublished identity 1 has conflicting canonical payloads',async () => {
      await pool.query('UPDATE hosted_indexer_facts SET canonical=false WHERE fact_id=$1',[conflictingImport.factId])
    })

    await pool.query(
      `INSERT INTO hosted_sponsorships(
         sponsorship_id,sponsor_tenant_id,beneficiary_tenant_id,maximum_quantity,
         consumed_quantity,reserved_quantity,unit,metadata
       ) VALUES ('semantic-sponsor','semantic-tenant','semantic-tenant',100,0,9,'proof-work','{}'::jsonb)`,
    )
    await pool.query(
      `INSERT INTO hosted_prove_jobs(
         job_id,tenant_id,room_id,sponsorship_id,service_class,partition,proof_class,endpoint,
         needs_gpu,idempotency_key,request_hash,request_object_key,request_bytes,estimated_work,
         estimated_proof_time_ms,settlement_margin_ms,tenant_weight,max_attempts,status
       ) VALUES (
         'semantic-sponsored-job','semantic-tenant',110,'semantic-sponsor','standard','shared',
         'semantic','/v5/rooms/prove',false,'semantic-sponsor-job-key',$1,$2,1,10,1000,0,1,3,'QUEUED'
       )`,['a'.repeat(64),`requests/${'a'.repeat(64)}`],
    )
    await pool.query(
      `INSERT INTO hosted_sponsorship_reservations(
         job_id,sponsorship_id,tenant_id,unit,quantity,status
       ) VALUES (
         'semantic-sponsored-job','semantic-sponsor','semantic-tenant','proof-work',10,'RESERVED'
       )`,
    )
    await gate('110','sponsorship counters or reservation tenant/unit/allocation binding drifted',async () => {
      await pool.query(
        `UPDATE hosted_sponsorships SET reserved_quantity=10 WHERE sponsorship_id='semantic-sponsor'`,
      )
    })
  })

  it('blocks and repairs node profile, quarantine/status, drain, and retire transition drift',async () => {
    const nodeA=bytes32('4'),profile=bytes32('5')
    await insertFact('0','CapacityProfileConfirmed',{ nodeId:nodeA,profileHash:profile,profileNonce:'1' },{ source:'room-pool' })
    expect((await store.systemSemanticProjection(chainId,'10')).errors)
      .toContain('CapacityProfileConfirmed lacks an exact canonical requested profile/nonce')
    await insertFact('0','CapacityProfileRequested',{ nodeId:nodeA,profileHash:profile,profileNonce:'1' },{
      source:'room-pool',blockNumber:'9',blockHash:bytes32('8'),
    })
    expect((await store.systemSemanticProjection(chainId,'10')).errors)
      .not.toContain('CapacityProfileConfirmed lacks an exact canonical requested profile/nonce')

    const nodeB=bytes32('6')
    await insertFact('0','NodeRetired',{ nodeId:nodeB,retiredAtBlock:'10' },{ source:'room-pool' })
    expect((await store.systemSemanticProjection(chainId,'10')).errors)
      .toContain('NodeRetired has no prior canonical NodeDrainStarted transition')
    await insertFact('0','NodeDrainStarted',{
      nodeId:nodeB,activeAllocations:'0',cancelledProfileHash:bytes32('0'),profileNonce:'2',
    },{ source:'room-pool',blockNumber:'9',blockHash:bytes32('8') })
    expect((await store.systemSemanticProjection(chainId,'10')).errors)
      .not.toContain('NodeRetired has no prior canonical NodeDrainStarted transition')

    const badStatus=await insertFact('0','NodeStatusChanged',{
      nodeId:bytes32('7'),status:'9',observedBlock:'11',
    },{ source:'room-pool' })
    expect((await store.systemSemanticProjection(chainId,'10')).errors)
      .toContain('NodeStatusChanged contains an invalid status/observedBlock')
    await pool.query('UPDATE hosted_indexer_facts SET canonical=false WHERE fact_id=$1',[badStatus.factId])
    expect((await store.systemSemanticProjection(chainId,'10')).errors)
      .not.toContain('NodeStatusChanged contains an invalid status/observedBlock')
  })
})
