import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { hostedMetricFamilies,renderMetrics } from '../src/metrics.js'
import { createPostgresPool,PostgresHostedStore,type SqlPool } from '../src/postgres-hosted-store.js'
import type { HostedRuntimeStatus } from '../src/hosted-runtime.js'

const databaseUrl=process.env.TEST_DATABASE_URL
const integration=databaseUrl ? describe : describe.skip

integration('hosted low-cardinality metrics',() => {
  let pool:SqlPool
  let store:PostgresHostedStore

  beforeAll(async () => {
    pool=await createPostgresPool(databaseUrl!)
    store=new PostgresHostedStore(pool,'hosted-metrics-pepper-0001-at-least-32-bytes',[])
    await store.bootstrap()
    const fence=await store.acquireLease('coordinator-writer','metrics-owner',60_000)
    if (!fence) throw new Error('metrics fixture could not acquire writer lease')
    await store.upsertTenant(fence,{ tenantId:'metrics-tenant',displayName:'Metrics Tenant',tier:'test' })
    await pool.query(
      `INSERT INTO canonical_l1_blocks(chain_id,block_number,block_hash,parent_hash,canonical,observed_at)
       VALUES (31337,10,$1,$2,true,clock_timestamp())`,
      [`0x${'11'.repeat(32)}`,`0x${'22'.repeat(32)}`],
    )
    await pool.query(
      `INSERT INTO admission_wal(
         room_id,admission_id,tenant_id,transaction_hash,raw_signed_transaction,sender,request,status
       ) VALUES (7,1,'metrics-tenant',$1,'0x01',$2,'{}'::jsonb,'RESERVED')`,
      [`0x${'33'.repeat(32)}`,`0x${'44'.repeat(20)}`],
    )
    await pool.query(
      `INSERT INTO hosted_outbox(tenant_id,audience,topic,aggregate_id,payload,retention_class)
       VALUES (NULL,'public-chain','indexer.rollback','31337','{}'::jsonb,'safety')`,
    )
    await store.putRoomObservation(fence,{
      chainId:31337,roomId:'7',tenantId:'metrics-tenant',schemaVersion:2,headBlock:'10',
      headHash:`0x${'11'.repeat(32)}`,document:{ roomState:{ state:'1' } },
      reconciliationErrors:['injected semantic drift'],
    })
  })

  afterAll(async () => { if (store) await store.close() })

  it('queries durable metrics and renders only bounded labels',async () => {
    const snapshot=await store.hostedMetricsSnapshot()
    expect(snapshot).toMatchObject({ canonicalHeadBlock:10,reorgs:1 })
    expect(snapshot.admissionStatuses).toContainEqual({ status:'RESERVED',count:1 })
    expect(snapshot.reconciliationStatuses).toContainEqual({ status:'drifted',count:1 })
    const runtime:HostedRuntimeStatus={
      enabled:true,configuredRole:'active',effectiveRole:'active',coordinatorId:'metrics-owner',
      fenceToken:'1',leaseExpiresAt:new Date(Date.now()+60_000).toISOString(),schemaVersion:26,
      l1QuorumHealthy:true,l1LastAgreedAt:new Date().toISOString(),indexerLagBlocks:'0',
      indexerHeadMatchesL1:true,ready:true,runtimeMode:'coordinator',workerComponent:null,
      workerId:null,promotionReplication:null,
    }
    const output=renderMetrics(hostedMetricFamilies(snapshot,runtime,[
      { source:'rpc-a',healthy:true,lastSuccessAt:null,lastError:null,latencyMs:1 },
      { source:'rpc-b',healthy:true,lastSuccessAt:null,lastError:null,latencyMs:1 },
    ]))
    for (const name of [
      'zkdeal_l1_quorum_healthy','zkdeal_indexer_reconciliation_rooms',
      'zkdeal_admission_wal_records','zkdeal_room_deadline_slack_seconds_bucket',
      'zkdeal_hosted_queue_fairness_virtual_finish_spread','zkdeal_usage_reconciliation_lag_seconds',
      'zkdeal_hosted_object_backlog','zkdeal_sponsorship_quantity',
      'zkdeal_blob_archive_requirements','zkdeal_aggregate_member_outcomes_total',
    ]) expect(output).toContain(name)
    expect(output).toContain('zkdeal_indexer_retractions_total{reason="canonical_reorg"}')
    expect(output).toContain('zkdeal_admission_wal_recovered_total{outcome="succeeded"}')
    expect(output).toContain('zkdeal_sponsorship_denials_total{reason="policy"}')
    expect(output).not.toContain('metrics-tenant')
    expect(output).not.toContain('rpc-a')
  })
})
