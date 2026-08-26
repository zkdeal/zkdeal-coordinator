import { resolve } from 'node:path'
import type { AbiParameter } from 'viem'
import { encodeFunctionData } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  aggregateBillingRequestHash,
  HostedFenceError,
  PostgresHostedStore,
  createPostgresPool,
  type SqlPool,
} from '../src/postgres-hosted-store.js'
import { loadContractAbi } from '../src/hosted-indexer.js'
import type { AggregateBillingMember } from '../src/hosted-types.js'
import { buildWithdrawalEpoch } from '../src/withdrawal-proofs.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const hash = (byte: string) => `0x${byte.repeat(64)}` as `0x${string}`
const managerAbi = loadContractAbi(resolve(
  import.meta.dirname,
  '../../../web3-protocol/contracts/out/IRoomManager.sol/IRoomManager.json',
))

function dummyAbiValue(parameter: AbiParameter): unknown {
  if (parameter.type.endsWith('[]')) return []
  if (parameter.type === 'tuple') return tupleAbiValue(parameter)
  if (parameter.type === 'address') return `0x${'00'.repeat(20)}`
  if (parameter.type === 'bool') return false
  if (parameter.type === 'string') return ''
  if (parameter.type === 'bytes') return '0x'
  const fixedBytes = /^bytes([0-9]+)$/.exec(parameter.type)
  if (fixedBytes) return `0x${'00'.repeat(Number(fixedBytes[1]))}`
  if (/^(?:u?int)[0-9]*$/.test(parameter.type)) return 0n
  throw new Error(`no aggregate fixture for ABI type ${parameter.type}`)
}

function tupleAbiValue(parameter: AbiParameter): Record<string, unknown> {
  const components = 'components' in parameter ? parameter.components : []
  return Object.fromEntries(components.map((component, index) => [
    component.name || String(index), dummyAbiValue(component),
  ]))
}

function aggregateCalldata(members: Array<{ roomId: string; batchIndex: string }>): `0x${string}` {
  const fn = managerAbi.find((item) => item.type === 'function' && item.name === 'submitAggregate')
  if (!fn || fn.type !== 'function') throw new Error('submitAggregate ABI is absent')
  const aggregateParameter = fn.inputs[0]!
  const aggregate = tupleAbiValue(aggregateParameter)
  const memberParameter = ('components' in aggregateParameter ? aggregateParameter.components : [])
    .find((component) => component.name === 'members')!
  aggregate.members = members.map((binding) => {
    const member = tupleAbiValue({ ...memberParameter, type: 'tuple' } as AbiParameter)
    member.roomId = BigInt(binding.roomId)
    const submission = member.submission as Record<string, unknown>
    const journal = submission.journal as Record<string, unknown>
    journal.roomId = BigInt(binding.roomId)
    journal.batchIndex = BigInt(binding.batchIndex)
    member.submission = submission
    return member
  })
  aggregate.aggregateSeal = '0x01'
  return encodeFunctionData({ abi: [fn], functionName: 'submitAggregate', args: [aggregate] })
}

integration('PostgresHostedStore integration', () => {
  let pool: SqlPool
  let store: PostgresHostedStore
  let writer: Awaited<ReturnType<PostgresHostedStore['acquireLease']>>

  beforeAll(async () => {
    pool = await createPostgresPool(databaseUrl!)
    store = new PostgresHostedStore(pool, 'integration-test-pepper-value-0001', managerAbi)
    await store.bootstrap()
    writer = await store.acquireLease('coordinator-writer', 'writer-a', 60_000)
    if (!writer) throw new Error('test writer did not acquire its lease')
  })

  afterAll(async () => {
    await store.close()
  })

  it('migrates and verifies the composite room key, not only a version row', async () => {
    const key = await pool.query<{ columns: string[] }>(
      `SELECT array_agg(attribute.attname::text ORDER BY key.ordinality) AS columns
       FROM pg_constraint AS constraint_row
       CROSS JOIN LATERAL unnest(constraint_row.conkey)
         WITH ORDINALITY AS key(attnum, ordinality)
       JOIN pg_attribute AS attribute
         ON attribute.attrelid = constraint_row.conrelid
        AND attribute.attnum = key.attnum
       WHERE constraint_row.conrelid = 'hosted_room_observations'::regclass
         AND constraint_row.contype = 'p'`,
    )
    expect(key.rows[0]?.columns).toEqual(['chain_id', 'room_id'])

    // Recreate the v1 key/version shape and prove bootstrap performs the data
    // migration rather than trusting the metadata row.
    await pool.query('ALTER TABLE hosted_room_observations DROP CONSTRAINT hosted_room_observations_pkey')
    await pool.query('ALTER TABLE hosted_room_observations ADD PRIMARY KEY(room_id)')
    await pool.query('DELETE FROM hosted_schema_meta')
    await pool.query('INSERT INTO hosted_schema_meta(version) VALUES (1)')
    await store.bootstrap()
    const migrated = await pool.query<{ columns: string[] }>(
      `SELECT array_agg(attribute.attname::text ORDER BY key.ordinality) AS columns
       FROM pg_constraint AS constraint_row
       CROSS JOIN LATERAL unnest(constraint_row.conkey)
         WITH ORDINALITY AS key(attnum, ordinality)
       JOIN pg_attribute AS attribute
         ON attribute.attrelid = constraint_row.conrelid
        AND attribute.attnum = key.attnum
       WHERE constraint_row.conrelid = 'hosted_room_observations'::regclass
         AND constraint_row.contype = 'p'`,
    )
    expect(migrated.rows[0]?.columns).toEqual(['chain_id', 'room_id'])
  })

  it('persists a fenced primary WAL target and rejects a non-standby self-attestation', async () => {
    const checkpoint = await store.recordPrimaryReplicationCheckpoint(writer!)
    expect(checkpoint.targetLsn).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/i)
    expect(Date.parse(checkpoint.recordedAt)).not.toBeNaN()

    await store.releaseLease(writer!)
    await expect(store.acquireLeaseForPromotion(
      'coordinator-writer', 'writer-replica', 60_000, 5 * 60_000,
    )).rejects.toMatchObject({ code: 'replay-position-missing' })
    // The failed promotion rolls back the lease transfer; the original active
    // can be restarted explicitly without accepting caller-authored evidence.
    writer = await store.acquireLease('coordinator-writer', 'writer-a', 60_000)
    if (!writer) throw new Error('test writer did not reacquire its lease')
  })

  it('fences a delayed former active after promotion with a monotonic token', async () => {
    const refused = await store.acquireLease('coordinator-writer', 'writer-b', 60_000)
    expect(refused).toBeNull()
    await store.releaseLease(writer!)
    const promoted = await store.acquireLease('coordinator-writer', 'writer-b', 60_000)
    expect(promoted?.token).toBe(writer!.token + 1n)
    await expect(store.upsertTenant(writer!, {
      tenantId: 'fenced-tenant', displayName: 'must fail', tier: 'standard',
    })).rejects.toBeInstanceOf(HostedFenceError)
    writer = promoted
  })

  it('runs coordinator, indexer, and reconciler under one epoch and fences standby workers on promotion', async () => {
    const indexer = await store.acquireWorkerLease('indexer', 'indexer-worker-a', 'writer-b', 60_000)
    const reconciler = await store.acquireWorkerLease('reconciler', 'reconciler-worker-a', 'writer-b', 60_000)
    const publisher = await store.acquireWorkerLease('publisher', 'publisher-worker-a', 'writer-b', 60_000)
    const capacity = await store.acquireWorkerLease('capacity', 'capacity-worker-epoch-a', 'writer-b', 60_000)
    expect(indexer?.delegation).toMatchObject({ component: 'indexer', workerId: 'indexer-worker-a' })
    expect(reconciler?.delegation).toMatchObject({ component: 'reconciler', workerId: 'reconciler-worker-a' })
    expect(publisher?.delegation).toMatchObject({ component: 'publisher', workerId: 'publisher-worker-a' })
    expect(capacity?.delegation).toMatchObject({ component: 'capacity', workerId: 'capacity-worker-epoch-a' })
    await store.upsertTenant(indexer!, {
      tenantId: 'worker-indexed', displayName: 'Indexer mutation', tier: 'internal',
    })
    await store.upsertTenant(reconciler!, {
      tenantId: 'worker-reconciled', displayName: 'Reconciler mutation', tier: 'internal',
    })
    expect(await store.acquireWorkerLease('indexer', 'indexer-worker-racer', 'writer-b', 60_000)).toBeNull()

    await store.releaseLease(writer!)
    const promoted = await store.acquireLease('coordinator-writer', 'writer-c', 60_000)
    expect(promoted?.token).toBe(writer!.token + 1n)
    await expect(store.upsertTenant(indexer!, {
      tenantId: 'old-indexer-write', displayName: 'must fail', tier: 'internal',
    })).rejects.toBeInstanceOf(HostedFenceError)
    await expect(store.upsertTenant(reconciler!, {
      tenantId: 'old-reconciler-write', displayName: 'must fail', tier: 'internal',
    })).rejects.toBeInstanceOf(HostedFenceError)
    await expect(store.upsertTenant(publisher!, {
      tenantId: 'old-publisher-write', displayName: 'must fail', tier: 'internal',
    })).rejects.toBeInstanceOf(HostedFenceError)
    await expect(store.upsertTenant(capacity!, {
      tenantId: 'old-capacity-write', displayName: 'must fail', tier: 'internal',
    })).rejects.toBeInstanceOf(HostedFenceError)
    expect(await store.acquireWorkerLease('indexer', 'standby-indexer', 'writer-b', 60_000)).toBeNull()

    const promotedIndexer = await store.acquireWorkerLease(
      'indexer', 'indexer-worker-b', 'writer-c', 60_000,
    )
    expect(promotedIndexer?.delegation?.token).toBeGreaterThan(indexer!.delegation!.token)
    await store.upsertTenant(promotedIndexer!, {
      tenantId: 'promoted-indexer-write', displayName: 'New epoch', tier: 'internal',
    })
    writer = promoted
  })

  it('allocates L1 nonces transactionally and binds retry state to immutable requests', async () => {
    const sender = `0x${'71'.repeat(20)}` as `0x${string}`
    const base = {
      chainId: 31337,
      sender,
      operation: 'publish-blob',
      requestHash: '7'.repeat(64),
      requestObjectKey: `zkdeal/sha256/77/${'7'.repeat(64)}`,
      calldata: '0x1234' as `0x${string}`,
      inclusionDeadline: '1000',
      remotePendingNonce: '7',
    }
    const allocated = await Promise.all([
      store.reserveL1Transaction(writer!, {
        ...base, operationId: 'l1-op-a', idempotencyKey: 'l1-idempotency-a',
      }),
      store.reserveL1Transaction(writer!, {
        ...base, operationId: 'l1-op-b', idempotencyKey: 'l1-idempotency-b',
      }),
    ])
    expect(allocated.map((row) => row.nonce).sort()).toEqual(['7', '8'])
    const first = allocated.find((row) => row.operationId === 'l1-op-a')!
    expect((await store.reserveL1Transaction(writer!, {
      ...base, operationId: 'ignored-on-exact-replay', idempotencyKey: 'l1-idempotency-a',
    })).operationId).toBe('l1-op-a')
    await expect(store.reserveL1Transaction(writer!, {
      ...base, operationId: 'drift', idempotencyKey: 'l1-idempotency-a', calldata: '0x99',
    })).rejects.toThrow('another immutable request')

    const signed = await store.attachSignedL1Transaction(writer!, first.operationId, {
      transactionHash: hash('7'),
      rawTransactionObjectKey: `zkdeal/sha256/aa/${'a'.repeat(64)}`,
      bundleObjectKey: `zkdeal/sha256/bb/${'b'.repeat(64)}`,
    })
    expect(signed.status).toBe('SIGNED')
    expect((await store.attachSignedL1Transaction(writer!, first.operationId, {
      transactionHash: hash('7'),
      rawTransactionObjectKey: `zkdeal/sha256/aa/${'a'.repeat(64)}`,
      bundleObjectKey: `zkdeal/sha256/bb/${'b'.repeat(64)}`,
    })).status).toBe('SIGNED')
    await expect(store.attachSignedL1Transaction(writer!, first.operationId, {
      transactionHash: hash('8'),
      rawTransactionObjectKey: `zkdeal/sha256/aa/${'a'.repeat(64)}`,
      bundleObjectKey: `zkdeal/sha256/bb/${'b'.repeat(64)}`,
    })).rejects.toThrow('different signed bytes')
    const retry = await store.recordL1TransactionAttemptError(
      writer!, first.operationId, 'RPC quorum unavailable', 60_000, true,
    )
    expect(retry).toMatchObject({ attempts: 1, deadlineRisk: true, lastError: 'RPC quorum unavailable' })
    expect((await store.pendingL1Transactions()).map((row) => row.operationId)).not.toContain(first.operationId)

    const columns = await pool.query<{ columns: string[] }>(
      `SELECT array_agg(column_name::text ORDER BY column_name) AS columns
       FROM information_schema.columns
       WHERE table_schema=current_schema() AND table_name='hosted_l1_transactions'
         AND column_name IN ('last_attempt_at','next_attempt_at','deadline_risk')`,
    )
    expect(columns.rows[0]?.columns).toEqual(['deadline_risk', 'last_attempt_at', 'next_attempt_at'])

    const auditSender = `0x${'72'.repeat(20)}` as `0x${string}`
    for (const [index, operationId] of ['l1-audit-a', 'l1-audit-b', 'l1-audit-c'].entries()) {
      await pool.query(
        `INSERT INTO hosted_l1_transactions(
           operation_id,chain_id,sender,nonce,operation,idempotency_key,request_hash,
           request_object_key,calldata,inclusion_deadline,transaction_hash,status,
           block_number,block_hash,finalized_block,finalized_hash
         ) VALUES ($1,31337,$2,$3,'publish-blob',$4,$5,$6,'0x','1000',$7,'FINALIZED',
                   $8,$9,$10,$11)`,
        [
          operationId, auditSender, index, `audit-idempotency-${index}`, `${index + 1}`.repeat(64),
          `zkdeal/sha256/${index}${index}/${`${index + 1}`.repeat(64)}`, hash(`${index + 1}`),
          100 + index, hash(`${index + 4}`), 200 + index, hash(`${index + 7}`),
        ],
      )
    }
    const auditFirst = await store.nextFinalizedL1AuditBatch(writer!, 31337, auditSender, 2)
    const auditSecond = await store.nextFinalizedL1AuditBatch(writer!, 31337, auditSender, 2)
    expect(new Set([...auditFirst, ...auditSecond].map((row) => row.operationId)))
      .toEqual(new Set(['l1-audit-a', 'l1-audit-b', 'l1-audit-c']))
    const surprised = await store.markL1TransactionRetracted(
      writer!, 'l1-audit-a', 'post-finality audit mismatch', ['rpc-a', 'rpc-b'],
    )
    expect(surprised).toMatchObject({
      status: 'RECOVERY_REQUIRED', blockNumber: '100', blockHash: hash('4'),
      finalizedBlock: '200', finalizedHash: hash('7'),
    })
  })

  it('binds narrow L1 service principals, operation access, and rotation overlap atomically', async () => {
    await store.upsertTenant(writer!, {
      tenantId: 'tenant-l1-service',displayName: 'L1 Service Tenant',tier: 'internal',
    })
    const original=await store.provisionPrincipal(writer!,{
      tenantId:'tenant-l1-service',kind:'service',roles:['l1-liveness'],
    })
    const bindingInput={
      principalId:original.principalId,bindingKind:'node-liveness' as const,chainId:31337,
      contractAddress:`0x${'81'.repeat(20)}` as `0x${string}`,
      expectedSender:`0x${'82'.repeat(20)}` as `0x${string}`,
      nodeId:hash('8'),roomId:null,
    }
    expect((await store.assignL1ServiceBinding(writer!,bindingInput)).created).toBe(true)
    expect(await store.assignL1ServiceBinding(writer!,bindingInput)).toMatchObject({
      created:false,binding:{ principalId:original.principalId,bindingKind:'node-liveness',
        chainId:31337,contractAddress:bindingInput.contractAddress,
        expectedSender:bindingInput.expectedSender,nodeId:bindingInput.nodeId,roomId:null,active:true },
    })
    await expect(store.assignL1ServiceBinding(writer!,{
      ...bindingInput,nodeId:hash('9'),
    })).rejects.toThrow('different immutable authority')

    const operationInput={
      operationId:'managed-heartbeat-store-001',chainId:31337,sender:bindingInput.expectedSender,
      operation:'node-heartbeat',idempotencyKey:'managed-heartbeat-store-key-001',
      requestHash:'8'.repeat(64),requestObjectKey:`zkdeal/sha256/88/${'8'.repeat(64)}`,
      destinationAddress:bindingInput.contractAddress,calldata:'0x7cd0e630' as `0x${string}`,
      inclusionDeadline:'1000',remotePendingNonce:'11',
      access:{ tenantId:'tenant-l1-service',principalId:original.principalId,
        correlationId:'managed-heartbeat:store:001',minimumConfirmations:64,
        requireFinalized:true,bindingKind:'node-liveness' as const },
    }
    const reserved=await store.reserveL1Transaction(writer!,operationInput)
    expect(reserved.nonce).toBe('11')
    expect(await store.l1OperationAccess(reserved.operationId)).toMatchObject(operationInput.access)
    expect((await store.reserveL1Transaction(writer!,{
      ...operationInput,operationId:'ignored-exact-managed-replay',
    })).operationId).toBe(reserved.operationId)
    await expect(store.reserveL1Transaction(writer!,{
      ...operationInput,operationId:'managed-access-drift',
      access:{ ...operationInput.access,correlationId:'managed-heartbeat:store:drift' },
    })).rejects.toThrow('another access scope')

    const replacement=await store.rotatePrincipal(writer!,original.principalId,86_400_000)
    expect(await store.authenticate(original.token,'service')).not.toBeNull()
    expect((await store.authenticate(replacement.token,'service'))?.principalId).toBe(replacement.principalId)
    expect(await store.l1ServiceBinding(replacement.principalId)).toMatchObject({
      ...bindingInput,principalId:replacement.principalId,
    })
  })

  it('isolates every managed authority nonce and serializes cross-operation idempotency globally',async () => {
    await store.upsertTenant(writer!,{
      tenantId:'tenant-l1-authorities',displayName:'L1 Authority Tenant',tier:'internal',
    })
    const definitions=[
      { key:'aggregate',role:'l1-aggregate-submit' as const,bindingKind:'room-aggregate' as const,
        contractAddress:`0x${'91'.repeat(20)}` as `0x${string}`,
        expectedSender:`0x${'a1'.repeat(20)}` as `0x${string}` },
      { key:'sponsor',role:'l1-pool-sponsor' as const,bindingKind:'pool-sponsor' as const,
        contractAddress:`0x${'92'.repeat(20)}` as `0x${string}`,
        expectedSender:`0x${'a2'.repeat(20)}` as `0x${string}`,sponsorshipId:'sponsor-scope-001' },
      { key:'finality',role:'l1-pool-finality-oracle' as const,bindingKind:'pool-finality-oracle' as const,
        contractAddress:`0x${'93'.repeat(20)}` as `0x${string}`,
        expectedSender:`0x${'a3'.repeat(20)}` as `0x${string}`,roomId:'77' },
      { key:'disposal',role:'l1-pool-beneficiary' as const,bindingKind:'pool-beneficiary' as const,
        contractAddress:`0x${'94'.repeat(20)}` as `0x${string}`,
        expectedSender:`0x${'a4'.repeat(20)}` as `0x${string}`,allocationId:hash('a') },
    ]
    const identities=new Map<string,{ principalId:string;sender:`0x${string}`;bindingKind:(typeof definitions)[number]['bindingKind'] }>()
    for (const definition of definitions) {
      const principal=await store.provisionPrincipal(writer!,{
        tenantId:'tenant-l1-authorities',kind:'service',roles:[definition.role],
      })
      const assigned=await store.assignL1ServiceBinding(writer!,{
        principalId:principal.principalId,bindingKind:definition.bindingKind,chainId:31337,
        contractAddress:definition.contractAddress,expectedSender:definition.expectedSender,
        nodeId:null,roomId:'roomId' in definition ? definition.roomId : null,
        sponsorshipId:'sponsorshipId' in definition ? definition.sponsorshipId : null,
        allocationId:'allocationId' in definition ? definition.allocationId : null,
      })
      expect(assigned).toMatchObject({ created:true,binding:{
        bindingKind:definition.bindingKind,expectedSender:definition.expectedSender,
        roomId:'roomId' in definition ? definition.roomId : null,
        sponsorshipId:'sponsorshipId' in definition ? definition.sponsorshipId : null,
        allocationId:'allocationId' in definition ? definition.allocationId : null,
      } })
      identities.set(definition.key,{
        principalId:principal.principalId,sender:definition.expectedSender,bindingKind:definition.bindingKind,
      })
    }
    const sponsorIdentity=identities.get('sponsor')!
    await expect(store.assignL1ServiceBinding(writer!,{
      principalId:sponsorIdentity.principalId,bindingKind:'pool-sponsor',chainId:31337,
      contractAddress:definitions[1]!.contractAddress,expectedSender:sponsorIdentity.sender,
      sponsorshipId:'different-sponsor-scope',
    })).rejects.toThrow('different immutable authority')
    const sponsorReplacement=await store.rotatePrincipal(writer!,sponsorIdentity.principalId,86_400_000)
    expect(await store.l1ServiceBinding(sponsorReplacement.principalId)).toMatchObject({
      bindingKind:'pool-sponsor',sponsorshipId:'sponsor-scope-001',expectedSender:sponsorIdentity.sender,
    })

    const reserve=(input:{
      key:string;operation:string;sender:`0x${string}`;principalId?:string
      bindingKind?:'room-aggregate'|'pool-sponsor'|'pool-finality-oracle'|'pool-beneficiary'
      requestByte:string;operationId:string;remotePendingNonce?:string
    }) => store.reserveL1Transaction(writer!,{
      operationId:input.operationId,chainId:31337,sender:input.sender,operation:input.operation,
      idempotencyKey:input.key,requestHash:input.requestByte.repeat(64),
      requestObjectKey:`zkdeal/sha256/${input.requestByte}${input.requestByte}/${input.requestByte.repeat(64)}`,
      destinationAddress:`0x${'99'.repeat(20)}`,calldata:`0x${input.requestByte.repeat(4)}` as `0x${string}`,
      inclusionDeadline:'1000',remotePendingNonce:input.remotePendingNonce ?? '9',
      ...(input.principalId && input.bindingKind ? { access:{
        tenantId:'tenant-l1-authorities',principalId:input.principalId,
        correlationId:`authority:${input.operationId}`,minimumConfirmations:64,
        requireFinalized:true,bindingKind:input.bindingKind,
      } } : {}),
    })
    const aggregateInput={
      key:'authority-global-idempotency-001',operation:'room-aggregate',
      sender:`0x${'b1'.repeat(20)}` as `0x${string}`,
      requestByte:'1',operationId:'authority-aggregate-001',
    }
    const [first,collision]=await Promise.allSettled([
      reserve(aggregateInput),
      reserve({
        key:aggregateInput.key,operation:'pool-sponsor-mutation',
        sender:`0x${'b2'.repeat(20)}` as `0x${string}`,requestByte:'2',
        operationId:'authority-sponsor-collision-001',
      }),
    ])
    expect([first,collision].filter((result) => result.status==='fulfilled')).toHaveLength(1)
    const rejected=[first,collision].find((result) => result.status==='rejected') as PromiseRejectedResult
    expect(String(rejected.reason)).toContain('idempotency key is bound to another immutable request')

    const initialNonces=new Map<string,string>()
    for (const [index,key] of ['sponsor','finality','disposal'].entries()) {
      const identity=identities.get(key)!
      const row=await reserve({
        key:`authority-${key}-001`,operation:`authority-${key}`,sender:identity.sender,
        principalId:identity.principalId,bindingKind:identity.bindingKind,
        requestByte:String(index+3),operationId:`authority-${key}-001`,
      })
      initialNonces.set(key,row.nonce)
    }
    const withdrawalSender=`0x${'a5'.repeat(20)}` as `0x${string}`
    const withdrawal=await reserve({
      key:'authority-withdrawal-001',operation:'withdrawal-claim',sender:withdrawalSender,
      requestByte:'6',operationId:'authority-withdrawal-001',
    })
    expect([...initialNonces.values(),withdrawal.nonce]).toEqual(['9','9','9','9'])

    const concurrent=await Promise.all([
      reserve({
        key:'authority-sponsor-002',operation:'pool-sponsor-mutation',sender:sponsorIdentity.sender,
        principalId:sponsorIdentity.principalId,bindingKind:'pool-sponsor',requestByte:'7',
        operationId:'authority-sponsor-002',remotePendingNonce:'0',
      }),
      reserve({
        key:'authority-sponsor-003',operation:'pool-sponsor-mutation',sender:sponsorIdentity.sender,
        principalId:sponsorIdentity.principalId,bindingKind:'pool-sponsor',requestByte:'8',
        operationId:'authority-sponsor-003',remotePendingNonce:'0',
      }),
    ])
    expect(concurrent.map((row) => row.nonce).sort()).toEqual(['10','11'])
  })

  it('rotates hashed principals with old/new overlap and immediate revocation', async () => {
    await store.upsertTenant(writer!, {
      tenantId: 'tenant-a', displayName: 'Tenant A', tier: 'standard',
    })
    const original = await store.provisionPrincipal(writer!, {
      tenantId: 'tenant-a', kind: 'api-key', roles: ['tenant-admin'],
    })
    expect((await store.authenticate(original.token))?.tenantId).toBe('tenant-a')
    const replacement = await store.rotatePrincipal(writer!, original.principalId, 86_400_000)
    expect(await store.authenticate(original.token)).not.toBeNull()
    expect((await store.authenticate(replacement.token))?.principalId).toBe(replacement.principalId)
    await pool.query(
      "UPDATE hosted_principals SET overlap_until = clock_timestamp() - interval '1 second' WHERE principal_id = $1",
      [original.principalId],
    )
    expect(await store.authenticate(original.token)).toBeNull()
    expect(await store.revokePrincipal(writer!, replacement.principalId)).toBe(true)
    expect(await store.authenticate(replacement.token)).toBeNull()
  })

  it('enforces the principal-kind role matrix at the canonical store boundary', async () => {
    await expect(store.provisionPrincipal(writer!, {
      tenantId: 'tenant-a', kind: 'node', roles: ['tenant-admin'],
    })).rejects.toThrow('principal kind node')
    await expect(store.provisionPrincipal(writer!, {
      tenantId: 'tenant-a', kind: 'api-key', roles: ['prove-node'],
    })).rejects.toThrow('principal kind api-key')
    await expect(store.provisionPrincipal(writer!, {
      tenantId: 'tenant-a', kind: 'api-key', roles: ['deadline-set'],
    })).rejects.toThrow('principal kind api-key')
    await expect(store.provisionPrincipal(writer!, {
      tenantId: 'tenant-a', kind: 'service', roles: ['tenant-admin'],
    })).rejects.toThrow('principal kind service')
    await expect(store.provisionPrincipal(writer!, {
      tenantId: 'tenant-a', kind: 'api-key', roles: ['l1-liveness'],
    })).rejects.toThrow('principal kind api-key')
    await expect(store.provisionPrincipal(writer!, {
      tenantId: 'tenant-a', kind: 'node', roles: ['l1-room-submit'],
    })).rejects.toThrow('principal kind node')

    const indexer = await store.provisionPrincipal(writer!, {
      tenantId: 'tenant-a', kind: 'service', roles: ['indexer-write'],
    })
    expect((await store.authenticate(indexer.token, 'service'))?.roles).toEqual(['indexer-write'])
    expect(await store.authenticate(indexer.token, 'node')).toBeNull()
  })

  it('binds every immutable admission WAL byte and never equivocates a receipt', async () => {
    await store.upsertTenant(writer!, {
      tenantId: 'tenant-b', displayName: 'Tenant B', tier: 'standard',
    })
    const input = {
      roomId: '7',
      admissionId: '1',
      tenantId: 'tenant-a',
      transactionHash: hash('1'),
      rawSignedTransaction: '0x010203' as `0x${string}`,
      sender: `0x${'12'.repeat(20)}` as `0x${string}`,
      request: {
        depositInboxId: '4',
        depositContentHash: hash('2'),
        deadlineBlock: '200',
        maximumBatchIndex: '9',
        bondEpoch: '3',
        admissionFee: '11',
        signerAddress: `0x${'34'.repeat(20)}` as `0x${string}`,
      },
    }
    const reserved = await store.reserveAdmission(writer!, input)
    expect(reserved.status).toBe('RESERVED')
    expect((await store.reserveAdmission(writer!, input)).admissionId).toBe('1')
    await expect(store.reserveAdmission(writer!, { ...input, rawSignedTransaction: '0x99' }))
      .rejects.toThrow('different immutable WAL bytes')
    await expect(store.reserveAdmission(writer!, { ...input, tenantId: 'tenant-b' }))
      .rejects.toThrow('different immutable WAL bytes')
    const successor = {
      ...input,
      admissionId: '2',
      transactionHash: hash('5'),
      rawSignedTransaction: '0x050607' as `0x${string}`,
    }
    await expect(store.reserveAdmission(writer!, successor)).rejects.toThrow('earlier admission reservation')
    expect(await store.leaseAdmissions(writer!, '7', 'node-a', 10, 1_000, 'tenant-a')).toEqual([])

    const receipt = { roomId: '7', admissionId: '1', signature: hash('3') }
    expect((await store.commitAdmission(writer!, '7', '1', receipt)).status).toBe('COMMITTED')
    expect(await store.admissionPendingDeposit('7', '4')).toBe(true)
    await expect(store.reserveAdmission(writer!, successor))
      .rejects.toThrow('deposit inbox id is already bound')
    const distinctDepositSuccessor = {
      ...successor,
      request: { ...successor.request, depositInboxId: '5' },
    }
    expect((await store.reserveAdmission(writer!, distinctDepositSuccessor)).status).toBe('RESERVED')
    expect((await store.commitAdmission(writer!, '7', '1', receipt)).receipt).toEqual(receipt)
    await expect(store.commitAdmission(writer!, '7', '1', { ...receipt, signature: hash('4') }))
      .rejects.toThrow('different bytes')

    const firstLease = await store.leaseAdmissions(writer!, '7', 'node-a', 10, 1_000, 'tenant-a')
    expect(firstLease.map((row) => row.admissionId)).toEqual(['1'])
    expect(await store.ackAdmissions(writer!, '7', 'node-b', ['1'], 'tenant-a')).toBe(0)
    await pool.query(
      "UPDATE admission_wal SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE room_id = 7",
    )
    expect((await store.leaseAdmissions(writer!, '7', 'node-b', 10, 1_000, 'tenant-a'))[0]?.admissionId)
      .toBe('1')
    expect(await store.ackAdmissions(writer!, '7', 'node-b', ['1'], 'tenant-a')).toBe(1)
  })

  it('serves admission policy only from a reconciled canonical PostgreSQL observation', async () => {
    const chainId = 60_606
    const roomId = '700'
    const signer = `0x${'56'.repeat(20)}` as `0x${string}`
    await store.setCanonicalAnchor(writer!, {
      chainId, number: '40', hash: hash('4'), verifiedSources: ['rpc-a', 'rpc-b'],
    })
    await store.recordCanonicalBlocks(writer!, [{
      chainId, number: '41', hash: hash('5'), parentHash: hash('4'), observedAt: new Date().toISOString(),
    }])
    const roomState = {
      state: '1', authorizationMode: '1', admissionSigner: signer,
      serviceBond: '1000', minimumServiceBond: '100', omissionPenalty: '10',
      bondEpoch: '3', maximumAdmissionWindow: '128', minimumDepositConfirmations: '12',
      batchIndex: '9', admissionCursor: '17',
    }
    await store.putRoomObservation(writer!, {
      chainId,roomId,tenantId: null,schemaVersion: 2,headBlock: '41',headHash: hash('5'),
      document: { roomId,roomState },
    })
    expect(await store.admissionRoomPolicy(chainId,roomId)).toMatchObject({
      roomId,status: 'OPEN',authorizationMode: 'VALIDITY_ONLY',admissionSigner: signer,
      latestObservedL1Block: '41',latestBatchIndex: '9',admissionCursor: '17',
      deposits: [],admissions: [],batches: [],
    })

    // A same-height fork invalidates the old observation; admission cannot
    // continue from a divergent replica-local copy.
    await store.recordCanonicalBlocks(writer!, [{
      chainId,number: '41',hash: hash('6'),parentHash: hash('4'),observedAt: new Date().toISOString(),
    }])
    expect(await store.admissionRoomPolicy(chainId,roomId)).toBeNull()

    await store.putRoomObservation(writer!, {
      chainId,roomId,tenantId: null,schemaVersion: 2,headBlock: '41',headHash: hash('6'),
      document: { roomId,roomState },reconciliationErrors: ['bond mismatch'],
    })
    await expect(store.admissionRoomPolicy(chainId,roomId)).rejects.toThrow('not schema-current and reconciled')
  })

  it('requires an agreed anchor, advances the floor only, and retracts every fork projection', async () => {
    await expect(store.recordCanonicalBlock(writer!, {
      chainId: 2, number: '500', hash: hash('5'), parentHash: hash('4'), observedAt: new Date().toISOString(),
    })).rejects.toThrow('canonical parent')

    await store.setCanonicalAnchor(writer!, {
      chainId: 1, number: '100', hash: hash('a'), verifiedSources: ['rpc-a', 'rpc-b'],
    })
    await expect(store.setCanonicalAnchor(writer!, {
      chainId: 1, number: '100', hash: hash('b'), verifiedSources: ['rpc-a', 'rpc-b'],
    })).rejects.toThrow('immutable')
    await store.recordCanonicalBlocks(writer!, [
      { chainId: 1, number: '101', hash: hash('b'), parentHash: hash('a'), observedAt: new Date().toISOString() },
      { chainId: 1, number: '102', hash: hash('c'), parentHash: hash('b'), observedAt: new Date().toISOString() },
    ])
    await store.advanceCanonicalFloor(writer!, {
      chainId: 1, number: '101', hash: hash('b'), verifiedSources: ['rpc-a', 'rpc-b'],
    })
    await expect(store.advanceCanonicalFloor(writer!, {
      chainId: 1, number: '100', hash: hash('a'), verifiedSources: ['rpc-a', 'rpc-b'],
    })).rejects.toThrow('advance-only')
    await expect(store.advanceCanonicalFloor(writer!, {
      chainId: 1, number: '101', hash: hash('d'), verifiedSources: ['rpc-a', 'rpc-b'],
    })).rejects.toThrow('not an indexed canonical block')

    await store.putRoomObservation(writer!, {
      chainId: 1,
      roomId: '7',
      tenantId: 'tenant-a',
      schemaVersion: 2,
      headBlock: '102',
      headHash: hash('c'),
      document: { roomId: '7' },
    })
    const indexed = {
      chainId: 1,
      blockNumber: '102',
      blockHash: hash('c'),
      source: 'room-manager',
      schemaVersion: 1,
      logs: [{
        logIndex: 0, transactionHash: hash('e'), address: `0x${'34'.repeat(20)}` as `0x${string}`,
        eventName: 'BatchAccepted', decoded: { roomId: '7', batchIndex: '2' },
      }],
      facts: [{
        factKey: `${hash('e')}:0:BatchAccepted`, factKind: 'batch', roomId: '7',
        tenantId: 'tenant-a', payload: { batchIndex: '2' },
      }],
      blobRequirements: [{
        chainId: 1,
        transactionHash: hash('e'),
        blockNumber: '102',
        blockHash: hash('c'),
        roomId: '7',
        batchIndex: '2',
        blobStartIndex: 0,
        versionedHashes: [hash('8')],
        commitments: [`0x${'44'.repeat(48)}` as `0x${string}`],
      }],
    }
    expect(await store.ingestIndexerRecords(writer!, indexed)).toEqual({ logs: 1, facts: 1 })
    expect(await store.ingestIndexerRecords(writer!, indexed)).toEqual({ logs: 0, facts: 0 })
    await expect(store.ingestIndexerRecords(writer!, {
      ...indexed, facts: [{ ...indexed.facts[0]!, payload: { batchIndex: '999' } }],
    })).rejects.toThrow('conflicts')
    expect(await store.listIndexerFacts({ chainId: 1, tenantId: 'tenant-a', factKinds: ['batch'] }))
      .toEqual([expect.objectContaining({ factKind: 'batch', roomId: '7' })])

    const requirement = indexed.blobRequirements[0]!
    expect(await store.blobArchiveReadyThrough(1, '102')).toBe(false)
    await expect(store.advanceCanonicalFloor(writer!, {
      chainId: 1, number: '102', hash: hash('c'), verifiedSources: ['rpc-a', 'rpc-b'],
    })).rejects.toThrow('unarchived blob sidecar')
    await store.completeBlobRequirement(writer!, requirement, 'beacon sidecar unavailable')
    expect((await store.pendingBlobRequirements()).map((row) => row.transactionHash))
      .toContain(hash('e'))
    await store.recordBlobArchive(writer!, {
      chainId: 1,
      transactionHash: hash('e'),
      versionedHashes: [hash('8')],
      commitments: [`0x${'44'.repeat(48)}`],
      proofs: [`0x${'55'.repeat(48)}`],
      bundleObjectKey: `it/sha256/aa/${'aa'.repeat(32)}`,
      bundleSha256: 'aa'.repeat(32),
      signedTransactionObjectKey: `it/sha256/bb/${'bb'.repeat(32)}`,
      archiveSource: 'hosted-prepublish',
      verifiedSources: ['hosted-publisher'],
    })
    await store.completeBlobRequirement(writer!, requirement, null)
    expect(await store.blobArchiveReadyThrough(1, '102')).toBe(true)
    await expect(store.recordBlobArchive(writer!, {
      chainId: 1,
      transactionHash: hash('e'),
      versionedHashes: [hash('9')],
      commitments: [`0x${'44'.repeat(48)}`],
      proofs: [`0x${'55'.repeat(48)}`],
      bundleObjectKey: `it/sha256/aa/${'aa'.repeat(32)}`,
      bundleSha256: 'aa'.repeat(32),
      signedTransactionObjectKey: `it/sha256/bb/${'bb'.repeat(32)}`,
      archiveSource: 'hosted-prepublish',
      verifiedSources: ['hosted-publisher'],
    })).rejects.toThrow('different immutable bytes')
    await pool.query(
      `INSERT INTO hosted_withdrawals(
         chain_id, room_id, epoch, withdrawal_index, tenant_id, approver_epoch,
         recipient, asset, amount, withdrawal_root, leaf_hash, positional_proof,
         finalized_block, finalized_hash, status
       ) VALUES (1,7,1,0,'tenant-a',1,$1,$2,10,$3,$4,'[]'::jsonb,102,$5,'FINALIZED')`,
      [`0x${'56'.repeat(20)}`, `0x${'78'.repeat(20)}`, hash('6'), hash('7'), hash('c')],
    )
    const rollback = await store.recordCanonicalBlocks(writer!, [
      { chainId: 1, number: '102', hash: hash('d'), parentHash: hash('b'), observedAt: new Date().toISOString() },
    ])
    expect(rollback.rolledBackFrom).toBe('102')
    expect((await pool.query("SELECT count(*)::text AS count FROM hosted_room_observations WHERE chain_id=1")).rows[0])
      .toMatchObject({ count: '0' })
    expect((await pool.query<{ canonical: boolean }>('SELECT canonical FROM hosted_indexer_logs')).rows[0]?.canonical).toBe(false)
    expect((await pool.query<{ status: string }>('SELECT status FROM hosted_withdrawals')).rows[0]?.status).toBe('RETRACTED')
    expect((await pool.query<{ status: string; canonical: boolean }>(
      'SELECT status,canonical FROM hosted_blob_requirements',
    )).rows[0]).toEqual({ status: 'RETRACTED', canonical: false })
    await expect(store.advanceCanonicalFloor(writer!, {
      chainId: 1, number: '102', hash: hash('d'), verifiedSources: ['rpc-a', 'rpc-b'],
    })).resolves.toMatchObject({ number: '102', hash: hash('d') })
    const retraction = await pool.query<{ payload: { previousState: unknown; reason: unknown } }>(
      "SELECT payload FROM hosted_outbox WHERE topic = 'statusRetracted' ORDER BY event_id DESC LIMIT 1",
    )
    expect(retraction.rows[0]?.payload).toEqual(expect.objectContaining({
      previousState: expect.any(Object), reason: expect.any(Object),
    }))
  })

  it('stores fractional usage idempotently and makes ledger rows immutable', async () => {
    const usage = {
      tenantId: 'tenant-a', allocationId: 'allocation-a', jobId: 'job-a', roomId: '7',
      unit: 'gpu-second', quantity: '0.125000000000000001',
      observedAt: new Date().toISOString(), idempotencyKey: 'usage-a', metadata: {},
    }
    const first = await store.recordUsage(writer!, usage)
    expect(await store.recordUsage(writer!, usage)).toBe(first)
    // Numeric spellings are normalized, but every other immutable attribution
    // field is part of the idempotency binding.
    expect(await store.recordUsage(writer!, { ...usage, quantity: '0.1250000000000000010' })).toBe(first)
    for (const drift of [
      { allocationId: 'allocation-b' },
      { jobId: 'job-b' },
      { roomId: '8' },
      { metadata: { correction: true } },
      { observedAt: new Date(Date.parse(usage.observedAt) + 1_000).toISOString() },
      { tenantId: 'tenant-b' },
    ]) {
      await expect(store.recordUsage(writer!, { ...usage, ...drift }))
        .rejects.toThrow('different entry')
    }
    await expect(pool.query('UPDATE hosted_usage_ledger SET quantity = 2 WHERE usage_id = $1', [first]))
      .rejects.toThrow('immutable')
  })

  it('routes SSE outbox events by explicit audience without cross-tenant leakage', async () => {
    await store.upsertProofProfile(writer!, {
      proofClass: 'privacy-internal-profile', endpoint: '/v5/internal/privacy-profile',
      needsGpu: false, estimatedWork: '1', estimatedProofTimeMs: 1_000,
      settlementMarginMs: 0, evidence: { providerPrincipalId: 'provider-secret' },
      verifiedAt: new Date().toISOString(),
    })
    const tenantA = await store.readOutbox('0', 'tenant-a', 1_000)
    const tenantB = await store.readOutbox('0', 'tenant-b', 1_000)
    const administrator = await store.readOutbox('0', 'tenant-a', 1_000, true)

    expect(tenantA.every((event) =>
      event.audience === 'public-chain' || event.tenantId === 'tenant-a')).toBe(true)
    expect(tenantB.every((event) =>
      event.audience === 'public-chain' || event.tenantId === 'tenant-b')).toBe(true)
    expect(tenantA.some((event) => event.topic === 'proof-profile.updated')).toBe(false)
    expect(tenantB.some((event) => event.topic === 'proof-profile.updated')).toBe(false)
    expect(administrator).toEqual(expect.arrayContaining([
      expect.objectContaining({ topic: 'proof-profile.updated', audience: 'admin-internal' }),
    ]))
    expect(tenantA).toEqual(expect.arrayContaining([
      expect.objectContaining({ topic: 'indexer.rollback', audience: 'public-chain' }),
    ]))
    expect(tenantB).toEqual(expect.arrayContaining([
      expect.objectContaining({ topic: 'indexer.rollback', audience: 'public-chain' }),
    ]))
    const publicFact = tenantA.find((event) => event.topic.startsWith('indexer.') && event.topic !== 'indexer.rollback')
    if (publicFact) {
      expect(publicFact.payload).not.toHaveProperty('tenantId')
      expect(publicFact.payload).not.toHaveProperty('providerPrincipalId')
    }
  })

  it('binds withdrawal witnesses to finalized facts and confirms external races only after finality', async () => {
    const chainId = 31338
    const roomId = '55'
    const anchorHash = hash('1')
    const rootBlockHash = hash('2')
    const claimBlockHash = hash('3')
    await store.setCanonicalAnchor(writer!, {
      chainId, number: '10', hash: anchorHash, verifiedSources: ['rpc-a', 'rpc-b'],
    })
    await store.recordCanonicalBlocks(writer!, [{
      chainId, number: '11', hash: rootBlockHash, parentHash: anchorHash,
      observedAt: new Date().toISOString(),
    }])
    const epoch = buildWithdrawalEpoch({
      schemaVersion: 1, deploymentDomain: hash('9'), roomId, outboxEpoch: '1', capacity: 1,
      withdrawals: [{
        index: '0', approverEpoch: '2', recipient: `0x${'12'.repeat(20)}`,
        asset: `0x${'00'.repeat(20)}`, amount: '77',
      }],
    })
    const rootTx = hash('4')
    await store.ingestIndexerRecords(writer!, {
      chainId, blockNumber: '11', blockHash: rootBlockHash, source: 'room-manager', schemaVersion: 2,
      logs: [],
      facts: [{
        factKey: `${rootTx}:0:WithdrawalRootPublished`, factKind: 'withdrawal', roomId,
        tenantId: 'tenant-a', payload: {
          args: { roomId, outboxEpoch: '1', withdrawalRoot: epoch.root },
          provenance: { eventName: 'WithdrawalRootPublished', transactionHash: rootTx },
        },
      }],
    })
    await store.advanceCanonicalFloor(writer!, {
      chainId, number: '11', hash: rootBlockHash, verifiedSources: ['rpc-a', 'rpc-b'],
    })
    expect(await store.indexFinalizedWithdrawalEpoch(writer!, {
      chainId, roomId, epoch: '1', deploymentDomain: epoch.witness.deploymentDomain,
      capacity: epoch.witness.capacity, withdrawalRoot: epoch.root,
      sourceObjectKey: `it/sha256/aa/${'aa'.repeat(32)}`,
      records: epoch.records,
    })).toMatchObject({ created: true, tenantId: 'tenant-a', finalizedBlock: '11' })
    const requested = await store.requestWithdrawalClaim(writer!, {
      chainId, tenantId: 'tenant-a', roomId, epoch: '1', withdrawalIndex: '0',
      idempotencyKey: 'withdrawal-external-race-a',
    }) as { claimId: string }
    const leased = await store.leaseWithdrawalClaims(writer!, chainId, 'withdrawal-worker-it', 1)
    expect(leased[0]?.claimId).toBe(requested.claimId)
    expect(await store.confirmExternallyClaimedWithdrawal(
      writer!, requested.claimId, 'withdrawal-worker-it',
    )).toBe(false)

    await store.recordCanonicalBlocks(writer!, [{
      chainId, number: '12', hash: claimBlockHash, parentHash: rootBlockHash,
      observedAt: new Date().toISOString(),
    }])
    const claimTx = hash('5')
    await store.ingestIndexerRecords(writer!, {
      chainId, blockNumber: '12', blockHash: claimBlockHash, source: 'room-manager', schemaVersion: 2,
      logs: [],
      facts: [{
        factKey: `${claimTx}:0:WithdrawalClaimed`, factKind: 'withdrawal', roomId,
        tenantId: 'tenant-a', payload: {
          args: { roomId, outboxEpoch: '1', index: '0' },
          provenance: { eventName: 'WithdrawalClaimed', transactionHash: claimTx },
        },
      }],
    })
    // Canonical-at-head is insufficient; only advancing the independently
    // agreed floor makes the external permissionless claim authoritative.
    expect(await store.confirmExternallyClaimedWithdrawal(
      writer!, requested.claimId, 'withdrawal-worker-it',
    )).toBe(false)
    await store.advanceCanonicalFloor(writer!, {
      chainId, number: '12', hash: claimBlockHash, verifiedSources: ['rpc-a', 'rpc-b'],
    })
    expect(await store.confirmExternallyClaimedWithdrawal(
      writer!, requested.claimId, 'withdrawal-worker-it',
    )).toBe(true)
    expect(await store.withdrawalClaim(requested.claimId, 'tenant-a')).toMatchObject({
      status: 'CONFIRMED', transactionHash: claimTx, operationId: null,
      errorCode: 'CANONICAL_EXTERNAL_CLAIM',
    })
  })

  it('binds capacity operation keys immutably and requires linked transitions', async () => {
    const initial = {
      allocationId: 'allocation-capacity-a', tenantId: 'tenant-a', roomId: '7',
      desiredState: 'RESERVED' as const, providerNodeId: null,
      deadlineAt: '2026-08-22T12:00:00.000Z', idempotencyKey: 'capacity-operation-a',
      metadata: { region: 'eu-west', requested: 2 },
    }
    await store.reconcileCapacity(writer!, initial)
    await store.reconcileCapacity(writer!, initial)

    for (const drift of [
      { allocationId: 'allocation-capacity-b' },
      { tenantId: 'tenant-b' },
      { roomId: '8' },
      { desiredState: 'ACTIVE' as const },
      { providerNodeId: 'provider-b' },
      { deadlineAt: '2026-08-22T12:00:01.000Z' },
      { metadata: { region: 'eu-west', requested: 3 } },
    ]) {
      await expect(store.reconcileCapacity(writer!, { ...initial, ...drift }))
        .rejects.toThrow('different immutable operation')
    }

    const transition = {
      ...initial,
      desiredState: 'ACTIVE' as const,
      providerNodeId: 'provider-a',
      idempotencyKey: 'capacity-operation-b',
    }
    await expect(store.reconcileCapacity(writer!, transition))
      .rejects.toThrow('must name the prior idempotency key')
    await store.reconcileCapacity(writer!, {
      ...transition,
      previousIdempotencyKey: initial.idempotencyKey,
    })
    await store.reconcileCapacity(writer!, {
      ...transition,
      previousIdempotencyKey: initial.idempotencyKey,
    })
    const operations = await pool.query<{
      idempotency_key: string
      prior_key: string | null
    }>(
      `SELECT operation.idempotency_key, prior.idempotency_key AS prior_key
       FROM hosted_capacity_operations AS operation
       LEFT JOIN hosted_capacity_operations AS prior
         ON prior.operation_id = operation.prior_operation_id
       WHERE operation.allocation_id = $1 ORDER BY operation.operation_id`,
      [initial.allocationId],
    )
    expect(operations.rows).toEqual([
      { idempotency_key: initial.idempotencyKey, prior_key: null },
      { idempotency_key: transition.idempotencyKey, prior_key: initial.idempotencyKey },
    ])
    await expect(pool.query(
      `UPDATE hosted_capacity_operations SET metadata='{}'::jsonb
       WHERE idempotency_key=$1`,
      [initial.idempotencyKey],
    )).rejects.toThrow('immutable')
  })

  it('executes capacity intents under crash-safe leases and freezes fail-closed demand signals', async () => {
    await store.upsertTenant(writer!, {
      tenantId: 'tenant-capacity-executor', displayName: 'Capacity executor', tier: 'reserved',
    })
    await store.upsertProofProfile(writer!, {
      proofClass: 'capacity-stale-profile', endpoint: '/v5/rooms/prove-capacity',
      needsGpu: true, estimatedWork: '2', estimatedProofTimeMs: 600_000,
      settlementMarginMs: 30_000, evidence: { benchmark: 'stale-on-purpose' },
      verifiedAt: '2026-08-01T00:00:00.000Z',
    })
    const intent = {
      allocationId: 'allocation-capacity-executor', tenantId: 'tenant-capacity-executor',
      roomId: '71', desiredState: 'RESERVED' as const, providerNodeId: null,
      deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      idempotencyKey: 'capacity-executor-operation-a', metadata: { region: 'eu-west', gpuClass: '4090' },
    }
    await store.reconcileCapacity(writer!, intent)
    await store.submitProveJob(writer!, {
      jobId: 'pj-cafecafeca', chainId: 31337, tenantId: 'tenant-capacity-executor',
      roomId: intent.roomId, allocationId: intent.allocationId,
      sponsorshipId: null, serviceClass: 'latency',
      correlationId: 'capacity-signal-test', partition: 'reserved',
      proofClass: 'capacity-stale-profile', endpoint: '/v5/rooms/prove-capacity',
      idempotencyKey: 'capacity-signal-job', requestHash: 'ab'.repeat(32),
      requestObjectKey: `zkdeal/sha256/ab/${'ab'.repeat(32)}`, requestBytes: 4096,
      deadlineAt: new Date(Date.now() + 2 * 60_000).toISOString(), priority: 0,
      billingMode: 'telemetry-only',
    })
    const capacityFence = await store.acquireWorkerLease(
      'capacity', 'capacity-worker-a', writer!.holderId, 60_000,
    )
    expect(capacityFence?.delegation).toMatchObject({ component: 'capacity', workerId: 'capacity-worker-a' })

    const firstBatch = await store.leaseCapacityExecutions(capacityFence!, 'capacity-worker-a', 200, 30_000)
    const first = firstBatch.find((item) => item.allocationId === intent.allocationId)
    expect(first).toMatchObject({ attempts: 1, executionStatus: 'LEASED' })
    expect((await store.leaseCapacityExecutions(capacityFence!, 'capacity-worker-a', 200, 30_000))
      .some((item) => item.allocationId === intent.allocationId)).toBe(false)

    // Crash after provider acceptance: DB expiry permits a retry with the same
    // immutable operation key but a new row token. The stale process cannot
    // acknowledge the externally visible effect.
    await pool.query(
      `UPDATE hosted_capacity_intents SET lease_expires_at=clock_timestamp()-interval '1 second'
       WHERE allocation_id=$1`,
      [intent.allocationId],
    )
    const recoveredBatch = await store.leaseCapacityExecutions(capacityFence!, 'capacity-worker-a', 200, 30_000)
    const recovered = recoveredBatch.find((item) => item.allocationId === intent.allocationId)
    expect(BigInt(recovered!.leaseToken)).toBeGreaterThan(BigInt(first!.leaseToken))
    expect(recovered!.idempotencyKey).toBe(first!.idempotencyKey)
    await expect(store.completeCapacityExecution(capacityFence!, first!, {
      state: 'APPLIED', providerOperationId: 'provider-stale', providerNodeId: 'gpu-stale',
      retryAfterMs: null, evidence: {},
    })).rejects.toBeInstanceOf(HostedFenceError)
    await store.completeCapacityExecution(capacityFence!, recovered!, {
      state: 'APPLIED', providerOperationId: 'provider-operation-capacity-a',
      providerNodeId: 'gpu-eu-west-1', retryAfterMs: null,
      evidence: { requestId: 'provider-request-a' },
    })
    expect(await store.listCapacityIntents('tenant-capacity-executor')).toEqual([
      expect.objectContaining({
        allocationId: intent.allocationId, executionStatus: 'APPLIED',
        appliedState: 'RESERVED', providerNodeId: 'gpu-eu-west-1', attempts: 2,
      }),
    ])

    const demand = await store.leaseCapacityDemandSignal(capacityFence!, 'capacity-worker-a', {
      windowMs: 60_000, horizonMs: 5 * 60_000, leaseTtlMs: 30_000,
    })
    expect(demand).toMatchObject({
      queuedJobs: expect.any(Number), staleProofProfiles: 1,
      scaleDownSafe: false,
    })
    expect(demand!.queuedJobs).toBeGreaterThanOrEqual(1)
    expect(demand!.reservedJobs).toBeGreaterThanOrEqual(1)
    expect(demand!.desiredGpuResources).toBeGreaterThanOrEqual(1)
    expect(await store.leaseCapacityDemandSignal(capacityFence!, 'capacity-worker-a')).toBeNull()
    await store.completeCapacityDemandSignal(capacityFence!, demand!, {
      accepted: true, providerRevision: 'revision-1',
    })
    expect(await store.leaseCapacityDemandSignal(capacityFence!, 'capacity-worker-a')).toBeNull()
  })

  it('fences assignments at drain, crash-recovers provider execution, and retires only after finalized drain evidence', async () => {
    const chainId = 31350
    const nodeId = `0x${'31'.repeat(32)}` as `0x${string}`
    const drainTransactionHash = hash('6')
    const retireTransactionHash = hash('7')
    await store.upsertTenant(writer!, {
      tenantId: 'tenant-node-lifecycle', displayName: 'Node lifecycle', tier: 'provider',
    })
    const node = await store.provisionPrincipal(writer!, {
      tenantId: 'tenant-node-lifecycle', kind: 'node', roles: ['prove-node'],
    })
    await store.assignProviderNode(writer!, {
      principalId: node.principalId, providerId: 'provider-node-lifecycle', active: true,
      gpu: true, gpuResourceId: 'gpu-node-lifecycle', partitions: ['shared'],
      tenantIds: ['tenant-node-lifecycle'], allocationIds: [], proofClasses: [],
      maxConcurrentJobs: 1, leaseTtlMs: 60_000,
    })

    const drainInput = {
      principalId: node.principalId, onchainNodeId: nodeId, desiredState: 'DRAINING' as const,
      idempotencyKey: 'node-lifecycle-drain-0001', previousIdempotencyKey: null,
      maxAttempts: 12, actorPrincipalId: null,
    }
    const drain = await store.requestNodeLifecycle(writer!, drainInput)
    expect(drain).toMatchObject({ created: true, operation: { desiredState: 'DRAINING', status: 'PENDING' } })
    expect(await store.requestNodeLifecycle(writer!, drainInput)).toMatchObject({
      created: false, operation: { operationId: drain.operation.operationId },
    })
    await expect(store.requestNodeLifecycle(writer!, {
      ...drainInput, onchainNodeId: `0x${'32'.repeat(32)}`,
    })).rejects.toThrow('different immutable terms')
    expect(await store.providerNode(node.principalId)).toMatchObject({ active: false })
    await expect(store.requestNodeLifecycle(writer!, {
      ...drainInput, desiredState: 'RETIRED', idempotencyKey: 'node-lifecycle-retire-early',
      previousIdempotencyKey: drainInput.idempotencyKey,
    })).rejects.toThrow('finalized canonical drain fact')

    const firstLease = (await store.leaseNodeLifecycleExecutions(
      writer!, 'capacity-lifecycle-worker', 10, 30_000,
    )).find((operation) => operation.operationId === drain.operation.operationId)!
    await expect(store.completeNodeLifecycleExecution(writer!, firstLease, {
      state: 'APPLIED', providerOperationId: 'provider-drain-op', retryAfterMs: null,
      evidence: {
        nodeId, desiredState: 'DRAINING', selector: '0x13ca0607',
        transactionHash: drainTransactionHash,
      },
    })).rejects.toThrow('not bound to the exact on-chain operation')
    await pool.query(
      `UPDATE hosted_node_lifecycle_operations
       SET lease_expires_at=clock_timestamp()-interval '1 second'
       WHERE operation_id=$1`,
      [drain.operation.operationId],
    )
    const recoveredLease = (await store.leaseNodeLifecycleExecutions(
      writer!, 'capacity-lifecycle-worker', 10, 30_000,
    )).find((operation) => operation.operationId === drain.operation.operationId)!
    expect(BigInt(recoveredLease.leaseToken)).toBeGreaterThan(BigInt(firstLease.leaseToken))
    await expect(store.completeNodeLifecycleExecution(writer!, firstLease, {
      state: 'APPLIED', providerOperationId: 'provider-drain-op', retryAfterMs: null,
      evidence: {
        nodeId, desiredState: 'DRAINING', selector: '0xd7ceb78e',
        transactionHash: drainTransactionHash,
      },
    })).rejects.toBeInstanceOf(HostedFenceError)
    expect(await store.completeNodeLifecycleExecution(writer!, recoveredLease, {
      state: 'APPLIED', providerOperationId: 'provider-drain-op', retryAfterMs: null,
      evidence: {
        nodeId, desiredState: 'DRAINING', selector: '0xd7ceb78e',
        transactionHash: drainTransactionHash,
      },
    })).toMatchObject({ status: 'VERIFYING' })

    await store.setCanonicalAnchor(writer!, {
      chainId, number: '50', hash: hash('4'), verifiedSources: ['lifecycle-rpc-a', 'lifecycle-rpc-b'],
    })
    await store.recordCanonicalBlocks(writer!, [{
      chainId, number: '51', hash: hash('5'), parentHash: hash('4'),
      observedAt: new Date().toISOString(),
    }])
    await store.ingestIndexerRecords(writer!, {
      chainId, blockNumber: '51', blockHash: hash('5'), source: 'room-pool', schemaVersion: 2,
      logs: [], facts: [{
        factKey: 'node-lifecycle:drain', factKind: 'node-lifecycle', roomId: null, tenantId: null,
        payload: {
          args: { nodeId },
          provenance: { eventName: 'NodeDrainStarted', transactionHash: drainTransactionHash },
        },
      }],
    })
    await store.advanceCanonicalFloor(writer!, {
      chainId, number: '51', hash: hash('5'), verifiedSources: ['lifecycle-rpc-a', 'lifecycle-rpc-b'],
    })
    expect(await store.reconcileNodeLifecycleFacts(writer!, chainId)).toEqual({
      applied: 1, recoveryRequired: 0,
    })
    expect((await store.listNodeLifecycleOperations(node.principalId))[0]).toMatchObject({
      status: 'APPLIED', canonicalFactBlockHash: hash('5'),
    })

    const retirement = await store.requestNodeLifecycle(writer!, {
      principalId: node.principalId, onchainNodeId: nodeId, desiredState: 'RETIRED',
      idempotencyKey: 'node-lifecycle-retire-0001',
      previousIdempotencyKey: drainInput.idempotencyKey, maxAttempts: 12, actorPrincipalId: null,
    })
    const retireLease = (await store.leaseNodeLifecycleExecutions(
      writer!, 'capacity-lifecycle-worker', 10, 30_000,
    )).find((operation) => operation.operationId === retirement.operation.operationId)!
    expect(await store.completeNodeLifecycleExecution(writer!, retireLease, {
      state: 'APPLIED', providerOperationId: 'provider-retire-op', retryAfterMs: null,
      evidence: {
        nodeId, desiredState: 'RETIRED', selector: '0x13ca0607',
        transactionHash: retireTransactionHash,
      },
    })).toMatchObject({ status: 'VERIFYING' })
    await store.recordCanonicalBlocks(writer!, [{
      chainId, number: '52', hash: hash('8'), parentHash: hash('5'),
      observedAt: new Date().toISOString(),
    }])
    await store.ingestIndexerRecords(writer!, {
      chainId, blockNumber: '52', blockHash: hash('8'), source: 'room-pool', schemaVersion: 2,
      logs: [], facts: [{
        factKey: 'node-lifecycle:retire', factKind: 'node-lifecycle', roomId: null, tenantId: null,
        payload: {
          args: { nodeId },
          provenance: { eventName: 'NodeRetired', transactionHash: retireTransactionHash },
        },
      }],
    })
    await store.advanceCanonicalFloor(writer!, {
      chainId, number: '52', hash: hash('8'), verifiedSources: ['lifecycle-rpc-a', 'lifecycle-rpc-b'],
    })
    expect(await store.reconcileNodeLifecycleFacts(writer!, chainId)).toEqual({
      applied: 1, recoveryRequired: 0,
    })
    expect((await store.listNodeLifecycleOperations(node.principalId)).at(-1)).toMatchObject({
      desiredState: 'RETIRED', status: 'APPLIED', canonicalFactBlockHash: hash('8'),
    })
    await expect(store.requestNodeLifecycle(writer!, {
      ...drainInput, idempotencyKey: 'node-lifecycle-drain-after-retirement',
    })).rejects.toThrow('irreversible')
  })

  it('enforces a single atomic request window across concurrent replicas', async () => {
    const principal = await store.provisionPrincipal(writer!, {
      tenantId: 'tenant-a', kind: 'api-key', roles: ['job-read'],
    })
    const attempts = await Promise.all(
      Array.from({ length: 25 }, () => store.consumePrincipalRate(principal.principalId, 10)),
    )
    expect(attempts.filter(Boolean)).toHaveLength(10)
    expect(await store.consumePrincipalRate(principal.principalId, 10)).toBe(false)
  })

  it('selects each tenant deadline head before cross-tenant work weighting', async () => {
    await store.upsertTenant(writer!, {
      tenantId: 'tenant-edf', displayName: 'Tenant EDF', tier: 'standard',
    })
    await store.upsertProofProfile(writer!, {
      proofClass: 'risc0-heavy-edf', endpoint: '/v5/rooms/prove-heavy',
      needsGpu: false, estimatedWork: '100', estimatedProofTimeMs: 120_000,
      settlementMarginMs: 30_000, evidence: { benchmarkId: 'edf-heavy', samples: 32 },
      verifiedAt: new Date().toISOString(),
    })
    await store.upsertProofProfile(writer!, {
      proofClass: 'risc0-fast-edf', endpoint: '/v5/rooms/prove-fast',
      needsGpu: false, estimatedWork: '0.1', estimatedProofTimeMs: 1_000,
      settlementMarginMs: 1_000, evidence: { benchmarkId: 'edf-fast', samples: 32 },
      verifiedAt: new Date().toISOString(),
    })
    const node = await store.provisionPrincipal(writer!, {
      tenantId: 'tenant-edf', kind: 'node', roles: ['prove-node'],
    })
    await store.assignProviderNode(writer!, {
      principalId: node.principalId, providerId: 'provider-edf', active: true,
      gpu: false, gpuResourceId: null, partitions: ['shared'], tenantIds: ['tenant-edf'],
      allocationIds: [], proofClasses: ['risc0-heavy-edf', 'risc0-fast-edf'],
      maxConcurrentJobs: 2, leaseTtlMs: 60_000,
    })
    const common = {
      chainId: 31337, tenantId: 'tenant-edf', roomId: '88', allocationId: null, sponsorshipId: null,
      serviceClass: 'standard' as const, correlationId: 'edf-order',
      partition: 'shared' as const, requestBytes: 100, billingMode: 'telemetry-only' as const,
    }
    await store.submitProveJob(writer!, {
      ...common, jobId: 'pj-edf00000001', idempotencyKey: 'edf-earlier-heavy',
      proofClass: 'risc0-heavy-edf', endpoint: '/v5/rooms/prove-heavy',
      requestHash: 'e'.repeat(64), requestObjectKey: `zkdeal/sha256/ee/${'e'.repeat(64)}`,
      deadlineAt: new Date(Date.now() + 60 * 60_000).toISOString(), priority: -100,
    })
    await store.submitProveJob(writer!, {
      ...common, jobId: 'pj-edf00000002', idempotencyKey: 'edf-later-fast',
      proofClass: 'risc0-fast-edf', endpoint: '/v5/rooms/prove-fast',
      requestHash: 'f'.repeat(64), requestObjectKey: `zkdeal/sha256/ff/${'f'.repeat(64)}`,
      deadlineAt: new Date(Date.now() + 120 * 60_000).toISOString(), priority: 100,
    })

    expect((await store.leaseProveJob(writer!, node.principalId))?.jobId).toBe('pj-edf00000001')
    expect((await store.leaseProveJob(writer!, node.principalId))?.jobId).toBe('pj-edf00000002')
  })

  it('admits global urgency only from a canonical allocation deadline and rechecks it after reorg', async () => {
    const chainId = 31339
    const allocationId = `0x${'ab'.repeat(32)}`
    await store.upsertTenant(writer!, {
      tenantId: 'tenant-canonical-deadline', displayName: 'Canonical Deadline', tier: 'standard',
    })
    await store.upsertTenant(writer!, {
      tenantId: 'tenant-untrusted-deadline', displayName: 'Untrusted Deadline', tier: 'standard',
    })
    await store.setCanonicalAnchor(writer!, {
      chainId, number: '100', hash: hash('1'), verifiedSources: ['deadline-rpc-a', 'deadline-rpc-b'],
    })
    await store.recordCanonicalBlocks(writer!, [
      { chainId, number: '101', hash: hash('2'), parentHash: hash('1'), observedAt: '2026-08-21T10:00:00.000Z' },
      { chainId, number: '102', hash: hash('3'), parentHash: hash('2'), observedAt: '2026-08-21T10:00:12.000Z' },
    ])
    await store.putRoomObservation(writer!, {
      chainId, roomId: '900', tenantId: 'tenant-canonical-deadline', schemaVersion: 2,
      headBlock: '102', headHash: hash('3'), document: { roomId: '900' },
    })
    await store.ingestIndexerRecords(writer!, {
      chainId, blockNumber: '102', blockHash: hash('3'), source: 'room-pool', schemaVersion: 2,
      logs: [],
      facts: [{
        factKey: 'room-pool:deadline-allocation-used', factKind: 'allocation', roomId: '900',
        tenantId: 'tenant-canonical-deadline',
        payload: {
          args: { allocationId, roomId: '900', startBlock: '102', proofDeadlineBlock: '107' },
          provenance: { eventName: 'AllocationUsed', verifiedSources: ['deadline-rpc-a', 'deadline-rpc-b'] },
        },
      }],
    })
    await store.upsertProofProfile(writer!, {
      proofClass: 'risc0-canonical-deadline', endpoint: '/v5/rooms/prove-deadline',
      needsGpu: false, estimatedWork: '5', estimatedProofTimeMs: 60_000,
      settlementMarginMs: 12_000, evidence: { benchmarkId: 'deadline-profile', samples: 64 },
      verifiedAt: new Date().toISOString(),
    })
    const node = await store.provisionPrincipal(writer!, {
      tenantId: 'tenant-canonical-deadline', kind: 'node', roles: ['prove-node'],
    })
    await store.assignProviderNode(writer!, {
      principalId: node.principalId, providerId: 'provider-deadline', active: true,
      gpu: false, gpuResourceId: null, partitions: ['shared'],
      tenantIds: ['tenant-canonical-deadline', 'tenant-untrusted-deadline'],
      allocationIds: [allocationId], proofClasses: ['risc0-canonical-deadline'],
      maxConcurrentJobs: 4, leaseTtlMs: 60_000,
    })
    const submission = {
      chainId, roomId: '900', sponsorshipId: null, serviceClass: 'standard' as const,
      correlationId: 'canonical-deadline', partition: 'shared' as const,
      proofClass: 'risc0-canonical-deadline', endpoint: '/v5/rooms/prove-deadline',
      requestBytes: 100, priority: -100, billingMode: 'telemetry-only' as const,
    }
    const trusted = await store.submitProveJob(writer!, {
      ...submission, tenantId: 'tenant-canonical-deadline', allocationId,
      jobId: 'pj-cadead000001', idempotencyKey: 'canonical-deadline-first',
      requestHash: 'a'.repeat(64), requestObjectKey: `zkdeal/sha256/aa/${'a'.repeat(64)}`,
      // This caller hint is deliberately late; canonical allocation data owns urgency.
      deadlineAt: '2027-08-21T10:00:00.000Z',
    })
    expect(trusted.job).toMatchObject({
      deadlineTrusted: true, deadlineChainId: String(chainId), deadlineBlock: '107',
      latestStartBlock: '101', deadlineFactKey: 'room-pool:deadline-allocation-used',
      deadlineFactBlockHash: hash('3'),
    })
    await store.submitProveJob(writer!, {
      ...submission, tenantId: 'tenant-untrusted-deadline', roomId: '901', allocationId: null,
      jobId: 'pj-acdeaf000001', idempotencyKey: 'untrusted-deadline', priority: 100,
      requestHash: 'b'.repeat(64), requestObjectKey: `zkdeal/sha256/bb/${'b'.repeat(64)}`,
      deadlineAt: '2026-08-21T10:00:01.000Z',
    })
    expect((await store.leaseProveJob(writer!, node.principalId))?.jobId).toBe('pj-cadead000001')

    const reorgCandidate = await store.submitProveJob(writer!, {
      ...submission, tenantId: 'tenant-canonical-deadline', allocationId,
      jobId: 'pj-cadead000002', idempotencyKey: 'canonical-deadline-reorged',
      requestHash: 'c'.repeat(64), requestObjectKey: `zkdeal/sha256/cc/${'c'.repeat(64)}`,
      deadlineAt: null,
    })
    expect(reorgCandidate.job.deadlineTrusted).toBe(true)
    await store.recordCanonicalBlocks(writer!, [{
      chainId, number: '102', hash: hash('4'), parentHash: hash('2'),
      observedAt: '2026-08-21T10:00:13.000Z',
    }])
    // The durable job retains its audit provenance, but the scheduler rechecks
    // fact canonicality and cannot keep the retracted deadline in global EDF.
    expect((await store.leaseProveJob(writer!, node.principalId))?.jobId).toBe('pj-acdeaf000001')
  })

  it('leases object-key jobs transactionally from server-owned provider assignments', async () => {
    await store.upsertTenant(writer!, {
      tenantId: 'tenant-a', displayName: 'Tenant A', tier: 'standard',
    })
    await store.upsertTenant(writer!, {
      tenantId: 'tenant-b', displayName: 'Tenant B', tier: 'standard',
    })
    await store.upsertProofProfile(writer!, {
      proofClass: 'risc0-room',
      endpoint: '/v5/rooms/prove',
      needsGpu: true,
      estimatedWork: '12.5',
      estimatedProofTimeMs: 90_000,
      settlementMarginMs: 24_000,
      evidence: { benchmarkId: 'bench-2026-08', samples: 32 },
      verifiedAt: new Date().toISOString(),
    })
    const node = await store.provisionPrincipal(writer!, {
      tenantId: 'tenant-a', kind: 'node', roles: ['prove-node'],
    })
    await expect(store.leaseProveJob(writer!, node.principalId)).rejects.toThrow('assignment')
    await store.assignProviderNode(writer!, {
      principalId: node.principalId,
      providerId: 'provider-a',
      active: true,
      gpu: true,
      gpuResourceId: 'gpu-physical-0',
      partitions: ['shared', 'reserved'],
      tenantIds: ['tenant-a', 'tenant-b'],
      allocationIds: [],
      proofClasses: ['risc0-room'],
      maxConcurrentJobs: 4,
      leaseTtlMs: 60_000,
    })
    const siblingNode = await store.provisionPrincipal(writer!, {
      tenantId: 'tenant-b', kind: 'node', roles: ['prove-node'],
    })
    await store.assignProviderNode(writer!, {
      principalId: siblingNode.principalId,
      providerId: 'provider-b',
      active: true,
      gpu: true,
      gpuResourceId: 'gpu-physical-0',
      partitions: ['shared'],
      tenantIds: ['tenant-a', 'tenant-b'],
      allocationIds: [],
      proofClasses: ['risc0-room'],
      maxConcurrentJobs: 4,
      leaseTtlMs: 60_000,
    })
    const base = {
      chainId: 31337, tenantId: 'tenant-a', roomId: '7', allocationId: null, sponsorshipId: null,
      serviceClass: 'standard' as const, correlationId: 'correlation-a',
      partition: 'shared' as const, proofClass: 'risc0-room', endpoint: '/v5/rooms/prove',
      requestBytes: 123, deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(), priority: 2,
      billingMode: 'telemetry-only' as const,
    }
    const first = await store.submitProveJob(writer!, {
      ...base, jobId: 'pj-1111111111', idempotencyKey: 'queue-a',
      requestHash: '1'.repeat(64), requestObjectKey: 'zkdeal/sha256/11/request-a',
    })
    expect(first.already).toBe(false)
    expect((await store.submitProveJob(writer!, {
      ...base, jobId: 'pj-1111111111', idempotencyKey: 'queue-a',
      requestHash: '1'.repeat(64), requestObjectKey: 'zkdeal/sha256/11/request-a',
    })).already).toBe(true)
    await expect(store.submitProveJob(writer!, {
      ...base, jobId: 'pj-1111111111', idempotencyKey: 'queue-a',
      requestHash: '2'.repeat(64), requestObjectKey: 'zkdeal/sha256/22/request-b',
    })).rejects.toThrow('different request or quote terms')
    await store.submitProveJob(writer!, {
      ...base, jobId: 'pj-2222222222', idempotencyKey: 'queue-b',
      requestHash: '2'.repeat(64), requestObjectKey: 'zkdeal/sha256/22/request-b',
    })

    const leased = await store.leaseProveJob(writer!, node.principalId)
    expect(leased?.status).toBe('LEASED')
    expect(leased?.requestObjectKey).toContain('request-')
    expect(await store.leaseProveJob(writer!, siblingNode.principalId)).toBeNull()
    // A DB partial unique constraint and transactional eligibility gate enforce
    // one active GPU lease even when the assignment allows CPU concurrency.
    expect(await store.leaseProveJob(writer!, node.principalId)).toBeNull()
    expect((await store.heartbeatProveJob(writer!, leased!.jobId, node.principalId)).leaseExpiresAt)
      .not.toBeNull()
    await pool.query(
      `UPDATE hosted_prove_jobs SET leased_at=clock_timestamp()-interval '2 seconds'
       WHERE job_id=$1`, [leased!.jobId],
    )
    expect((await store.failProveJob(
      writer!, leased!.jobId, node.principalId, 'TRANSIENT_TEST_FAILURE', true,
    )).status).toBe('QUEUED')
    expect((await store.leaseProveJob(writer!, node.principalId))?.jobId).toBe(leased!.jobId)
    await pool.query(
      `UPDATE hosted_prove_jobs SET leased_at=clock_timestamp()-interval '3 seconds'
       WHERE job_id=$1`, [leased!.jobId],
    )
    const resultDigest = 'a'.repeat(64)
    const resultKey = `zkdeal/sha256/aa/${resultDigest}`
    const completed = await store.completeProveJob(
      writer!, leased!.jobId, node.principalId, resultKey, resultDigest,
    )
    expect(completed.job.status).toBe('DONE')
    const accumulatedProofTime = await pool.query<{ actual_proof_ms: string }>(
      `SELECT actual_proof_ms::text FROM hosted_prove_jobs WHERE job_id=$1`, [leased!.jobId],
    )
    expect(BigInt(accumulatedProofTime.rows[0]!.actual_proof_ms)).toBeGreaterThanOrEqual(5_000n)
    expect((await store.completeProveJob(
      writer!, leased!.jobId, node.principalId, resultKey, resultDigest,
    )).already).toBe(true)
    await expect(store.completeProveJob(
      writer!, leased!.jobId, node.principalId, `zkdeal/sha256/bb/${'b'.repeat(64)}`, 'b'.repeat(64),
    )).rejects.toThrow('immutable')
    const usage = await store.listUsage('tenant-a', '0', 100)
    expect(usage).toEqual(expect.arrayContaining([
      expect.objectContaining({
        jobId: leased!.jobId,
        unit: 'telemetry.proof-work',
        quantity: '12.500000000000000000',
        metadata: expect.objectContaining({ billingState: 'PROVISIONAL_RESOURCE_TELEMETRY' }),
      }),
      expect.objectContaining({ jobId: leased!.jobId, unit: 'telemetry.gpu-second' }),
    ]))

    await pool.query(
      `INSERT INTO hosted_sponsorships(
         sponsorship_id, sponsor_tenant_id, beneficiary_tenant_id,
         maximum_quantity, unit, metadata
       ) VALUES ('sponsor-a','tenant-b','tenant-a',12.5,'proof-work','{}'::jsonb)`,
    )
    await expect(store.submitProveJob(writer!, {
      ...base, sponsorshipId: 'sponsor-a', jobId: 'pj-3300000000',
      idempotencyKey: 'sponsored-unquoted', requestHash: '0'.repeat(64),
      requestObjectKey: 'zkdeal/sha256/00/request-unquoted',
    })).rejects.toThrow('sponsored work must accept an immutable commercial quote')
    await store.publishBillingPrice(writer!, {
      tenantId: 'tenant-b', unit: 'proof-work', currency: 'GBP', unitPrice: '1',
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(), idempotencyKey: 'queue-sponsor-price',
    })
    const sponsored = await Promise.allSettled([
      store.submitProveJob(writer!, {
        ...base, sponsorshipId: 'sponsor-a', jobId: 'pj-3333333333',
        idempotencyKey: 'sponsored-a', requestHash: '3'.repeat(64),
        requestObjectKey: 'zkdeal/sha256/33/request-c', billingMode: 'quoted',
        maximumChargeAmount: '100', maximumChargeCurrency: 'GBP',
      }),
      store.submitProveJob(writer!, {
        ...base, sponsorshipId: 'sponsor-a', jobId: 'pj-4444444444',
        idempotencyKey: 'sponsored-b', requestHash: '4'.repeat(64),
        requestObjectKey: 'zkdeal/sha256/44/request-d', billingMode: 'quoted',
        maximumChargeAmount: '100', maximumChargeCurrency: 'GBP',
      }),
    ])
    expect(sponsored.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(sponsored.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const reservation = await pool.query<{ reserved_quantity: string; reservations: string }>(
      `SELECT sponsorship.reserved_quantity::text,
              count(reservation.job_id)::text AS reservations
       FROM hosted_sponsorships AS sponsorship
       LEFT JOIN hosted_sponsorship_reservations AS reservation
         ON reservation.sponsorship_id = sponsorship.sponsorship_id
        AND reservation.status = 'RESERVED'
       WHERE sponsorship.sponsorship_id = 'sponsor-a'
       GROUP BY sponsorship.sponsorship_id`,
    )
    expect(reservation.rows[0]).toEqual({ reserved_quantity: '12.500000000000000000', reservations: '1' })
  })

  it('bills only finalized applied aggregate members and appends credits on retraction', async () => {
    const chainId = 44_444
    const aggregateHash = hash('8')
    const retryAggregateHash = hash('9')
    const roomManager = `0x${'45'.repeat(20)}` as `0x${string}`
    const aggregateSender = `0x${'46'.repeat(20)}` as `0x${string}`
    const firstCanonicalEventTime = new Date(Date.now() + 60_000).toISOString()
    const retryCanonicalEventTime = new Date(Date.now() + 120_000).toISOString()
    let aggregateNonce = 0
    const signedAggregateOperation = async (
      label: string,
      transactionHash: `0x${string}`,
      bindingAggregateHash: `0x${string}`,
      members: AggregateBillingMember[],
    ) => {
      const calldata = aggregateCalldata(members)
      const boundMembers = await Promise.all(members.map(async (member) => {
        const job = await store.getProveJob(member.jobId)
        if (!job?.resultObjectKey || !job.resultDigest) throw new Error('fixture proof job is incomplete')
        return { ...member, resultObjectKey: job.resultObjectKey, resultDigest: job.resultDigest }
      }))
      const requestHash = aggregateBillingRequestHash({
        chainId,aggregateHash: bindingAggregateHash,destinationAddress: roomManager,calldata,
        members: boundMembers,
      })
      const row = await store.reserveL1Transaction(writer!, {
        operationId: label,chainId,sender: aggregateSender,operation: 'publish-aggregate',
        idempotencyKey: `${label}-idempotency`,requestHash,
        requestObjectKey: `zkdeal/sha256/${requestHash.slice(0,2)}/${requestHash}`,
        destinationAddress: roomManager,calldata,
        inclusionDeadline: '1000',remotePendingNonce: String(aggregateNonce),
      })
      aggregateNonce += 1
      await store.attachSignedL1Transaction(writer!,row.operationId,{
        transactionHash,
        rawTransactionObjectKey: `zkdeal/sha256/aa/${'a'.repeat(64)}`,
        bundleObjectKey: `zkdeal/sha256/bb/${'b'.repeat(64)}`,
      })
      return row.operationId
    }
    await store.upsertTenant(writer!, {
      tenantId: 'tenant-aggregate-sponsor', displayName: 'Aggregate Sponsor', tier: 'standard',
    })
    await store.upsertTenant(writer!, {
      tenantId: 'tenant-aggregate-member', displayName: 'Aggregate Member', tier: 'standard',
    })
    await store.createSponsorship(writer!, {
      sponsorshipId: 'aggregate-sponsor',
      sponsorTenantId: 'tenant-aggregate-sponsor',
      beneficiaryTenantId: 'tenant-aggregate-member',
      allocationId: null,
      maximumQuantity: '80',
      unit: 'proof-work',
      expiresAt: null,
      metadata: { purpose: 'aggregate-member-finality-test' },
    })
    await store.publishBillingPrice(writer!, {
      tenantId: 'tenant-aggregate-sponsor', unit: 'proof-work', currency: 'GBP',
      unitPrice: '2', effectiveFrom: '2020-01-01T00:00:00.000Z',
      idempotencyKey: 'aggregate-price-2026-08',
    })
    await store.publishSlaPolicy(writer!, {
      tenantId: 'tenant-aggregate-sponsor', serviceClass: 'batch',
      maximumQueueMs: 0, maximumProofMs: 0, creditBasisPoints: 1_000,
      effectiveFrom: '2020-01-01T00:00:00.000Z',
      idempotencyKey: 'aggregate-sla-2026-08',
    })
    await store.upsertProofProfile(writer!, {
      proofClass: 'aggregate-member-proof', endpoint: '/v5/rooms/prove-aggregate-member',
      needsGpu: false, estimatedWork: '10', estimatedProofTimeMs: 1_000,
      settlementMarginMs: 1_000, evidence: { fixture: 'eight-member-outcome' },
      verifiedAt: new Date().toISOString(),
    })
    const node = await store.provisionPrincipal(writer!, {
      tenantId: 'tenant-aggregate-sponsor', kind: 'node', roles: ['prove-node'],
    })
    await store.assignProviderNode(writer!, {
      principalId: node.principalId, providerId: 'aggregate-provider', active: true,
      gpu: false, gpuResourceId: null, partitions: ['shared'],
      tenantIds: ['tenant-aggregate-member'], allocationIds: [],
      proofClasses: ['aggregate-member-proof'], maxConcurrentJobs: 1, leaseTtlMs: 60_000,
    })

    const completeMemberJob = async (
      index: number,
      suffix = '',
      retryOfJobId: string | null = null,
    ) => {
      const hex = `${(index + 1).toString(16)}${suffix ? 'f' : 'e'}`.padEnd(64, String(index + 1))
      const jobId = `pj-a66${String(index).padStart(7, '0')}${suffix}`
      await store.submitProveJob(writer!, {
        jobId, chainId, tenantId: 'tenant-aggregate-member', roomId: String(100 + index),
        retryOfJobId,
        allocationId: null, sponsorshipId: 'aggregate-sponsor', serviceClass: 'batch',
        correlationId: `aggregate-${index}${suffix}`, partition: 'shared',
        proofClass: 'aggregate-member-proof', endpoint: '/v5/rooms/prove-aggregate-member',
        idempotencyKey: `aggregate-job-${index}${suffix}`, requestHash: hex,
        requestObjectKey: `zkdeal/sha256/${hex.slice(0, 2)}/${hex}`,
        requestBytes: 100, deadlineAt: null, priority: 0,
        billingMode: 'quoted',
        maximumChargeAmount: '25',maximumChargeCurrency: 'GBP',
      })
      const leased = await store.leaseProveJob(writer!, node.principalId)
      expect(leased?.jobId).toBe(jobId)
      const resultDigest = `${suffix ? 'f' : 'd'}${String(index).repeat(63)}`.slice(0, 64)
      await store.completeProveJob(
        writer!, jobId, node.principalId,
        `zkdeal/sha256/${resultDigest.slice(0, 2)}/${resultDigest}`, resultDigest,
      )
      return jobId
    }
    const jobs: string[] = []
    for (let index = 0; index < 8; index += 1) jobs.push(await completeMemberJob(index))
    const firstMembers = jobs.map((jobId, memberIndex) => ({
      memberIndex, jobId, roomId: String(100 + memberIndex), batchIndex: '1',
    }))
    const invalidOperationId = 'aggregate-operation-arbitrary-calldata'
    await store.reserveL1Transaction(writer!, {
      operationId: invalidOperationId,chainId,sender: aggregateSender,operation: 'publish-aggregate',
      idempotencyKey: 'aggregate-operation-arbitrary-calldata-key',requestHash: '1'.repeat(64),
      requestObjectKey: `zkdeal/sha256/11/${'1'.repeat(64)}`,destinationAddress: roomManager,
      calldata: '0x1234',inclusionDeadline: '1000',remotePendingNonce: '0',
    })
    await store.attachSignedL1Transaction(writer!,invalidOperationId,{
      transactionHash: hash('5'),rawTransactionObjectKey: `zkdeal/sha256/aa/${'a'.repeat(64)}`,
      bundleObjectKey: `zkdeal/sha256/bb/${'b'.repeat(64)}`,
    })
    await expect(store.registerAggregateBillingManifest(writer!, {
      chainId,aggregateHash,operationId: invalidOperationId,
      idempotencyKey: 'aggregate-manifest-arbitrary-calldata',members: firstMembers,
    })).rejects.toThrow('not decodable')
    const aggregateTransactionHash = hash('6')
    const aggregateOperationId = await signedAggregateOperation(
      'aggregate-operation-eight-members',aggregateTransactionHash,aggregateHash,firstMembers,
    )
    expect((await store.listBillingLedger('tenant-aggregate-sponsor')).length).toBe(0)
    const beforeFinality = await pool.query<{ consumed: string; reserved: string }>(
      `SELECT consumed_quantity::text AS consumed,reserved_quantity::text AS reserved
       FROM hosted_sponsorships WHERE sponsorship_id='aggregate-sponsor'`,
    )
    expect(beforeFinality.rows[0]).toEqual({
      consumed: '0.000000000000000000', reserved: '80.000000000000000000',
    })

    await store.setCanonicalAnchor(writer!, {
      chainId, number: '100', hash: hash('a'), verifiedSources: ['rpc-a', 'rpc-b'],
    })
    await store.recordCanonicalBlocks(writer!, [{
      chainId, number: '101', hash: hash('b'), parentHash: hash('a'),
      observedAt: firstCanonicalEventTime,
    }])
    await store.registerAggregateBillingManifest(writer!, {
      chainId, aggregateHash,operationId: aggregateOperationId,
      idempotencyKey: 'aggregate-manifest-eight-members',
      members: firstMembers,
    })
    await store.markL1TransactionBroadcast(writer!, aggregateOperationId)
    await store.markL1TransactionIncluded(writer!, aggregateOperationId, '101', hash('b'))
    await store.markL1TransactionFinalized(writer!, aggregateOperationId, '101', hash('b'))
    await store.ingestIndexerRecords(writer!, {
      chainId, blockNumber: '101', blockHash: hash('b'), source: 'aggregate-fixture',
      schemaVersion: 2, logs: [],
      facts: jobs.flatMap((_jobId, memberIndex) => {
        const outcome = {
          factKey: `aggregate:${aggregateHash}:${memberIndex}`,
          factKind: 'aggregate', roomId: String(100 + memberIndex),
          tenantId: 'tenant-aggregate-member',
          payload: {
            args: {
              aggregateHash, memberIndex: String(memberIndex), roomId: String(100 + memberIndex),
              batchIndex: '1', applied: memberIndex < 7,
              failureSelector: memberIndex < 7 ? '0x00000000' : '0xdeadbeef',
            },
            provenance: {
              eventName: 'AggregateMemberOutcome', transactionHash: aggregateTransactionHash,
              address: roomManager,
            },
          },
        }
        if (memberIndex === 7) return [outcome]
        return [outcome, {
          factKey: `batch:${aggregateHash}:${memberIndex}`,
          factKind: 'batch', roomId: String(100 + memberIndex),
          tenantId: 'tenant-aggregate-member',
          payload: {
            args: { roomId: String(100 + memberIndex), batchIndex: '1' },
            provenance: {
              eventName: 'BatchAccepted', transactionHash: aggregateTransactionHash,
              address: roomManager,
            },
          },
        }]
      }),
    })
    await store.advanceCanonicalFloor(writer!, {
      chainId, number: '101', hash: hash('b'), verifiedSources: ['rpc-a', 'rpc-b'],
    })
    let ledger = await store.listBillingLedger('tenant-aggregate-sponsor')
    expect(ledger.filter((entry) => entry.entryKind === 'CHARGE')).toHaveLength(7)
    expect(ledger.filter((entry) => entry.entryKind === 'SLA_CREDIT')).toHaveLength(7)
    expect(ledger.some((entry) => entry.memberIndex === 7)).toBe(false)
    expect(await store.listBillingLedger('tenant-aggregate-member')).toHaveLength(0)
    const finalized = await pool.query<{ consumed: string; reserved: string; released: string }>(
      `SELECT sponsorship.consumed_quantity::text AS consumed,
              sponsorship.reserved_quantity::text AS reserved,
              count(reservation.job_id) FILTER (WHERE reservation.status='RELEASED')::text AS released
       FROM hosted_sponsorships AS sponsorship
       JOIN hosted_sponsorship_reservations AS reservation
         ON reservation.sponsorship_id=sponsorship.sponsorship_id
       WHERE sponsorship.sponsorship_id='aggregate-sponsor'
       GROUP BY sponsorship.sponsorship_id`,
    )
    expect(finalized.rows[0]).toEqual({
      consumed: '70.000000000000000000', reserved: '0.000000000000000000', released: '1',
    })

    const firstInvoice = await store.createInvoiceExport(writer!, {
      invoiceId: 'invoice-aggregate-before-retry', tenantId: 'tenant-aggregate-sponsor',
      periodStart: '2020-01-01T00:00:00.000Z', periodEnd: '2030-01-01T00:00:00.000Z',
      currency: 'GBP', idempotencyKey: 'invoice-aggregate-before-retry-key',
    })
    expect(firstInvoice.invoice).toMatchObject({ netAmount: '126.000000000000000000' })

    const retryJob = await completeMemberJob(7, 'f', jobs[7]!)
    const retryMembers = [{ memberIndex: 0, jobId: retryJob, roomId: '107', batchIndex: '2' }]
    const retryAggregateTransactionHash = hash('d')
    const retryAggregateOperationId = await signedAggregateOperation(
      'aggregate-operation-retry-member', retryAggregateTransactionHash,
      retryAggregateHash, retryMembers,
    )
    await store.recordCanonicalBlocks(writer!, [{
      chainId, number: '102', hash: hash('c'), parentHash: hash('b'),
      observedAt: retryCanonicalEventTime,
    }])
    await store.registerAggregateBillingManifest(writer!, {
      chainId, aggregateHash: retryAggregateHash,
      operationId: retryAggregateOperationId,
      idempotencyKey: 'aggregate-manifest-retry-member',
      members: retryMembers,
    })
    await store.markL1TransactionBroadcast(writer!, retryAggregateOperationId)
    await store.markL1TransactionIncluded(writer!, retryAggregateOperationId, '102', hash('c'))
    await store.markL1TransactionFinalized(writer!, retryAggregateOperationId, '102', hash('c'))
    await store.ingestIndexerRecords(writer!, {
      chainId, blockNumber: '102', blockHash: hash('c'), source: 'aggregate-fixture',
      schemaVersion: 2, logs: [], facts: [
        {
          factKey: `aggregate:${retryAggregateHash}:0`, factKind: 'aggregate', roomId: '107',
          tenantId: 'tenant-aggregate-member', payload: {
            args: {
              aggregateHash: retryAggregateHash, memberIndex: '0', roomId: '107', batchIndex: '2',
              applied: true, failureSelector: '0x00000000',
            },
            provenance: {
              eventName: 'AggregateMemberOutcome', transactionHash: retryAggregateTransactionHash,
              address: roomManager,
            },
          },
        },
        {
          factKey: `batch:${retryAggregateHash}:0`, factKind: 'batch', roomId: '107',
          tenantId: 'tenant-aggregate-member', payload: {
            args: { roomId: '107', batchIndex: '2' },
            provenance: {
              eventName: 'BatchAccepted', transactionHash: retryAggregateTransactionHash,
              address: roomManager,
            },
          },
        },
      ],
    })
    await store.advanceCanonicalFloor(writer!, {
      chainId, number: '102', hash: hash('c'), verifiedSources: ['rpc-a', 'rpc-b'],
    })
    ledger = await store.listBillingLedger('tenant-aggregate-sponsor')
    expect(ledger.filter((entry) => entry.entryKind === 'CHARGE')).toHaveLength(8)

    // Use the production post-finality recovery path. It requires two
    // independently agreeing sources and retains the prior finalized evidence.
    expect(await store.markL1TransactionRetracted(
      writer!, aggregateOperationId, 'independent sources no longer find finalized transaction',
      ['rpc-a', 'rpc-b'],
    )).toMatchObject(
      { status: 'RECOVERY_REQUIRED', blockNumber: '101', blockHash: hash('b') },
    )
    ledger = await store.listBillingLedger('tenant-aggregate-sponsor')
    // A surprise at block 101 invalidates the entire descendant branch, not
    // only the triggering operation. The independently finalized retry at 102
    // is therefore corrected in the same fenced transaction.
    expect(ledger.filter((entry) => entry.entryKind === 'REORG_CREDIT')).toHaveLength(8)
    const net = await pool.query<{ quantity: string; amount: string }>(
      `SELECT sum(quantity)::text AS quantity,sum(amount)::text AS amount
       FROM hosted_billing_ledger WHERE tenant_id='tenant-aggregate-sponsor'`,
    )
    expect(net.rows[0]).toEqual({
      quantity: '0.000000000000000000', amount: '0.000000000000000000',
    })
    const restored = await pool.query<{ consumed: string; reserved: string; refunds: string }>(
      `SELECT sponsorship.consumed_quantity::text AS consumed,
              sponsorship.reserved_quantity::text AS reserved,
              (SELECT count(*)::text FROM hosted_refunds
               WHERE sponsorship_id=sponsorship.sponsorship_id) AS refunds
       FROM hosted_sponsorships AS sponsorship
       WHERE sponsorship.sponsorship_id='aggregate-sponsor'`,
    )
    expect(restored.rows[0]).toEqual({
      consumed: '0.000000000000000000', reserved: '80.000000000000000000', refunds: '8',
    })
    const deferredCorrection = await pool.query<{ processed: string; unresolved: string }>(
      `SELECT
         (SELECT count(*)::text FROM hosted_aggregate_outcome_retractions AS retraction
          JOIN hosted_aggregate_outcome_receipts AS receipt ON receipt.receipt_id=retraction.receipt_id
          WHERE receipt.aggregate_hash=$1) AS processed,
         (SELECT count(*)::text FROM hosted_outbox
          WHERE topic='billing.aggregate-member-retraction-deferred'
            AND aggregate_id=$2 AND resolved_at IS NULL) AS unresolved`,
      [aggregateHash,`${chainId}:${aggregateHash}:7`],
    )
    expect(deferredCorrection.rows[0]).toEqual({ processed: '8', unresolved: '0' })
    const transfer = await pool.query<{ status: string; transferred_to_job_id: string }>(
      `SELECT status,transferred_to_job_id FROM hosted_sponsorship_reservations
       WHERE job_id=$1`, [jobs[7]],
    )
    expect(transfer.rows[0]).toEqual({ status: 'TRANSFERRED',transferred_to_job_id: retryJob })
    // Finalized invoice snapshots remain immutable; a new export reflects all
    // append-only corrections without rewriting the original evidence.
    expect((await store.listInvoiceExports('tenant-aggregate-sponsor'))[0]?.netAmount)
      .toBe('126.000000000000000000')
    const correctedInvoice = await store.createInvoiceExport(writer!, {
      invoiceId: 'invoice-aggregate-after-reorg', tenantId: 'tenant-aggregate-sponsor',
      supersedesInvoiceId: firstInvoice.invoice.invoiceId,
      periodStart: '2020-01-01T00:00:00.000Z', periodEnd: '2030-01-01T00:00:00.000Z',
      currency: 'GBP', idempotencyKey: 'invoice-aggregate-after-reorg-key',
    })
    expect(correctedInvoice.invoice.netAmount).toBe('0.000000000000000000')

    await expect(store.advanceCanonicalFloor(writer!, {
      chainId,number: '102',hash: hash('c'),verifiedSources: ['rpc-a','rpc-b'],
    })).rejects.toThrow('frozen by an unresolved post-finality recovery')

    const recoveryBlocks = [
      {
        chainId,number: '101',hash: hash('e'),parentHash: hash('a'),
        observedAt: new Date(Date.now() + 180_000).toISOString(),
      },
      {
        chainId,number: '102',hash: hash('f'),parentHash: hash('e'),
        observedAt: new Date(Date.now() + 181_000).toISOString(),
      },
    ]
    const recoveryInput = {
      recoveryId: 'post-finality-recovery-eight-members',
      operationId: aggregateOperationId,
      chainId,
      expectedPriorFloor: { number: '102',hash: hash('c') },
      blocks: recoveryBlocks,
      requiredIndexerSources: ['aggregate-fixture'],
      verifiedSources: ['rpc-a','rpc-b'],
      reason: 'two independent RPC providers agree on the replacement branch',
    }
    await expect(store.installPostFinalityRecoveryBranch(writer!, {
      ...recoveryInput,recoveryId: 'post-finality-recovery-one-source',verifiedSources: ['rpc-a'],
    })).rejects.toThrow('two independent agreeing sources')
    await expect(store.installPostFinalityRecoveryBranch(writer!, {
      ...recoveryInput,recoveryId: 'post-finality-recovery-forged-parent',
      blocks: [{ ...recoveryBlocks[0]!,parentHash: hash('9') },recoveryBlocks[1]!],
    })).rejects.toThrow('retained canonical ancestor')
    const installedRecovery = await store.installPostFinalityRecoveryBranch(writer!, recoveryInput)
    expect(installedRecovery).toMatchObject({
      status: 'BRANCH_INSTALLED',branchStartNumber: '101',
      priorFloor: { number: '102',hash: hash('c') },
      replacementFloor: null,
    })
    expect((await store.installPostFinalityRecoveryBranch(writer!, recoveryInput)).recoveryId)
      .toBe(recoveryInput.recoveryId)
    await expect(store.finalizePostFinalityRecovery(writer!, {
      recoveryId: recoveryInput.recoveryId,
      replacementFloor: { chainId,number: '102',hash: hash('f'),verifiedSources: ['rpc-c','rpc-d'] },
    })).rejects.toThrow('has not been replayed')
    await store.ingestIndexerRecords(writer!, {
      chainId,blockNumber: '101',blockHash: hash('e'),source: 'aggregate-fixture',
      schemaVersion: 2,logs: [],facts: [],
    })
    await store.ingestIndexerRecords(writer!, {
      chainId,blockNumber: '102',blockHash: hash('f'),source: 'aggregate-fixture',
      schemaVersion: 2,logs: [],facts: [],
    })
    const resolvedRecovery = await store.finalizePostFinalityRecovery(writer!, {
      recoveryId: recoveryInput.recoveryId,
      replacementFloor: { chainId,number: '102',hash: hash('f'),verifiedSources: ['rpc-c','rpc-d'] },
    })
    expect(resolvedRecovery).toMatchObject({
      status: 'RESOLVED',replacementFloor: { number: '102',hash: hash('f') },
      verifiedSources: { install: ['rpc-a','rpc-b'],finalize: ['rpc-c','rpc-d'] },
    })
    expect((await store.l1Transaction(aggregateOperationId))?.status).toBe('SUPERSEDED')
    expect((await store.l1Transaction(retryAggregateOperationId))?.status).toBe('SUPERSEDED')
    expect(await store.canonicalFloor(chainId)).toMatchObject({ number: '102',hash: hash('f') })
    await expect(store.advanceCanonicalFloor(writer!, {
      chainId,number: '102',hash: hash('f'),verifiedSources: ['rpc-c','rpc-d'],
    })).resolves.toMatchObject({ number: '102',hash: hash('f') })
  })

  it('nets manual refunds before reorg and serializes invoice/refund replays', async () => {
    const chainId = 45_454
    const tenantId = 'tenant-unsponsored-billing'
    const manager = `0x${'67'.repeat(20)}` as `0x${string}`
    const sender = `0x${'68'.repeat(20)}` as `0x${string}`
    const transactionHash = hash('f')
    const aggregateHash = hash('0')
    await store.upsertTenant(writer!, { tenantId,displayName: 'Unsponsored billing',tier: 'standard' })
    await store.publishBillingPrice(writer!, {
      tenantId,unit: 'proof-work',currency: 'GBP',unitPrice: '2',
      effectiveFrom: '2020-01-01T00:00:00.000Z',idempotencyKey: 'unsponsored-price-v1',
    })
    await store.upsertProofProfile(writer!, {
      proofClass: 'unsponsored-billing-proof',endpoint: '/v5/rooms/prove-unsponsored',
      needsGpu: false,estimatedWork: '10',estimatedProofTimeMs: 1_000,
      settlementMarginMs: 1_000,evidence: { fixture: 'refund-before-reorg' },
      verifiedAt: new Date().toISOString(),
    })
    const node = await store.provisionPrincipal(writer!, {
      tenantId,kind: 'node',roles: ['prove-node'],
    })
    await store.assignProviderNode(writer!, {
      principalId: node.principalId,providerId: 'unsponsored-provider',active: true,
      gpu: false,gpuResourceId: null,partitions: ['shared'],tenantIds: [tenantId],
      allocationIds: ['allocation-billing-001'],proofClasses: ['unsponsored-billing-proof'],
      maxConcurrentJobs: 1,leaseTtlMs: 60_000,
    })
    const jobId = 'pj-b7700000001'
    const requestDigest = 'b'.repeat(64)
    await store.submitProveJob(writer!, {
      jobId,chainId,tenantId,roomId: '1',allocationId: 'allocation-billing-001',sponsorshipId: null,
      serviceClass: 'standard',correlationId: 'unsponsored-refund',partition: 'shared',
      proofClass: 'unsponsored-billing-proof',endpoint: '/v5/rooms/prove-unsponsored',
      idempotencyKey: 'unsponsored-job-v1',requestHash: requestDigest,
      requestObjectKey: `zkdeal/sha256/bb/${requestDigest}`,requestBytes: 100,
      deadlineAt: null,priority: 0,billingMode: 'quoted',
      maximumChargeAmount: '25',maximumChargeCurrency: 'GBP',
    })
    expect((await store.leaseProveJob(writer!,node.principalId))?.jobId).toBe(jobId)
    const resultDigest = 'c'.repeat(64)
    await store.completeProveJob(
      writer!,jobId,node.principalId,`zkdeal/sha256/cc/${resultDigest}`,resultDigest,
    )
    const operationId = 'aggregate-operation-unsponsored-refund'
    const members = [{ memberIndex: 0,jobId,roomId: '1',batchIndex: '1' }]
    const calldata = aggregateCalldata(members)
    const operationRequestHash = aggregateBillingRequestHash({
      chainId,aggregateHash,destinationAddress: manager,calldata,
      members: [{
        ...members[0]!, resultObjectKey: `zkdeal/sha256/cc/${resultDigest}`, resultDigest,
      }],
    })
    await store.reserveL1Transaction(writer!, {
      operationId,chainId,sender,operation: 'publish-aggregate',
      idempotencyKey: 'aggregate-operation-unsponsored-refund-key',requestHash: operationRequestHash,
      requestObjectKey: `zkdeal/sha256/${operationRequestHash.slice(0,2)}/${operationRequestHash}`,
      destinationAddress: manager,calldata,inclusionDeadline: '1000',remotePendingNonce: '0',
    })
    await store.attachSignedL1Transaction(writer!,operationId, {
      transactionHash,rawTransactionObjectKey: `zkdeal/sha256/ee/${'e'.repeat(64)}`,
      bundleObjectKey: `zkdeal/sha256/ff/${'f'.repeat(64)}`,
    })
    await store.setCanonicalAnchor(writer!, {
      chainId,number: '9',hash: hash('0'),verifiedSources: ['rpc-a','rpc-b'],
    })
    await store.recordCanonicalBlocks(writer!, [
      {
        chainId,number: '10',hash: hash('1'),parentHash: hash('0'),
        observedAt: new Date(Date.now() + 59_000).toISOString(),
      },
      {
        chainId,number: '11',hash: hash('2'),parentHash: hash('1'),
        observedAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ])
    await store.ingestIndexerRecords(writer!, {
      chainId,blockNumber: '10',blockHash: hash('1'),source: 'room-pool',
      schemaVersion: 2,logs: [],facts: [{
        factKey: 'allocation:allocation-billing-001',factKind: 'allocation',roomId: '1',tenantId,
        payload: {
          args: { roomId: '1',allocationId: 'allocation-billing-001' },
          provenance: { eventName: 'AllocationUsed',transactionHash: hash('a'),address: manager },
        },
      }],
    })
    await store.registerAggregateBillingManifest(writer!, {
      chainId,aggregateHash,operationId,idempotencyKey: 'unsponsored-manifest-v1',
      members,
    })
    await store.markL1TransactionBroadcast(writer!,operationId)
    await store.markL1TransactionIncluded(writer!,operationId,'11',hash('2'), {
      gasUsed: '21000',effectiveGasPrice: '2',blobGasUsed: null,blobGasPrice: null,
    })
    await store.markL1TransactionFinalized(writer!,operationId,'11',hash('2'))
    await store.ingestIndexerRecords(writer!, {
      chainId,blockNumber: '11',blockHash: hash('2'),source: 'aggregate-fixture',
      schemaVersion: 2,logs: [],facts: [
        {
          factKey: `aggregate:${aggregateHash}:0`,factKind: 'aggregate',roomId: '1',tenantId,
          payload: {
            args: { aggregateHash,memberIndex: '0',roomId: '1',batchIndex: '1',applied: true,failureSelector: '0x00000000' },
            provenance: { eventName: 'AggregateMemberOutcome',transactionHash,address: manager },
          },
        },
        {
          factKey: `batch:${aggregateHash}:0`,factKind: 'batch',roomId: '1',tenantId,
          payload: {
            args: { roomId: '1',batchIndex: '1' },
            provenance: { eventName: 'BatchAccepted',transactionHash,address: manager },
          },
        },
      ],
    })
    await store.advanceCanonicalFloor(writer!, {
      chainId,number: '11',hash: hash('2'),verifiedSources: ['rpc-a','rpc-b'],
    })
    const charge = (await store.listBillingLedger(tenantId)).find((entry) => entry.entryKind === 'CHARGE')!
    expect(charge.amount).toBe('20.000000000000000000')
    const l1AllocationCharge = (await store.listBillingLedger(tenantId))
      .find((entry) => entry.entryKind === 'L1_ALLOCATION_CHARGE')!
    expect(l1AllocationCharge).toMatchObject({
      allocationId: 'allocation-billing-001',unit: 'l1-transaction-wei',
      quantity: '42000.000000000000000000',currency: 'WEI',
      amount: '42000.000000000000000000',sourceFactId: expect.any(String),
      metadata: expect.objectContaining({
        transactionHash,allocationFactId: expect.any(String),transactionCostWei: '42000',
      }),
    })

    const invoiceInput = {
      invoiceId: 'invoice-unsponsored-before-correction',tenantId,
      periodStart: '2020-01-01T00:00:00.000Z',periodEnd: '2030-01-01T00:00:00.000Z',
      currency: 'GBP',idempotencyKey: 'invoice-unsponsored-before-correction-key',
    }
    const invoices = await Promise.all([
      store.createInvoiceExport(writer!,invoiceInput),store.createInvoiceExport(writer!,invoiceInput),
    ])
    expect(invoices.map((value) => value.created).sort()).toEqual([false,true])
    await expect(store.createInvoiceExport(writer!, {
      ...invoiceInput,invoiceId: 'invoice-unsponsored-overlap',
      idempotencyKey: 'invoice-unsponsored-overlap-key',
    })).rejects.toThrow(/overlaps an already closed period/)

    const refundInput = {
      tenantId,chargeEntryId: charge.entryId,quantity: '2',reason: 'operator service adjustment',
      idempotencyKey: 'unsponsored-refund-key',
    }
    const refunds = await Promise.all([
      store.issueBillingRefund(writer!,refundInput),store.issueBillingRefund(writer!,refundInput),
    ])
    expect(refunds.map((value) => value.created).sort()).toEqual([false,true])
    await expect(store.issueBillingRefund(writer!, { ...refundInput,quantity: '3' }))
      .rejects.toThrow('different immutable terms')
    const refundConflict = await Promise.allSettled([
      store.issueBillingRefund(writer!, {
        ...refundInput,quantity: '1',idempotencyKey: 'unsponsored-refund-conflict-key',
      }),
      store.issueBillingRefund(writer!, {
        ...refundInput,quantity: '3',idempotencyKey: 'unsponsored-refund-conflict-key',
      }),
    ])
    expect(refundConflict.filter((value) => value.status === 'fulfilled')).toHaveLength(1)
    expect(refundConflict.filter((value) => value.status === 'rejected')).toHaveLength(1)
    const conflictRefundQuantity = Number(
      (refundConflict.find((value) => value.status === 'fulfilled') as PromiseFulfilledResult<{
        entry: { quantity: string }
      }>).value.entry.quantity,
    ) * -1

    await store.markL1TransactionRetracted(
      writer!,operationId,'post-finality canonical audit mismatch',['rpc-a','rpc-b'],
    )
    const corrected = await store.listBillingLedger(tenantId)
    expect(corrected.find((entry) => entry.entryKind === 'REFUND')?.quantity)
      .toBe('-2.000000000000000000')
    expect(corrected.find((entry) => entry.entryKind === 'REORG_CREDIT' && entry.unit === 'proof-work')?.quantity)
      .toBe(`${-(8 - conflictRefundQuantity)}.000000000000000000`)
    expect(corrected.find((entry) => entry.entryKind === 'REORG_CREDIT' && entry.unit === 'l1-transaction-wei')?.quantity)
      .toBe('-42000.000000000000000000')
    expect(corrected.reduce((sum, entry) => sum + Number(entry.amount ?? '0'),0)).toBe(0)
    const correctionRace = await Promise.allSettled([
      store.createInvoiceExport(writer!, {
        ...invoiceInput,invoiceId: 'invoice-unsponsored-after-correction-a',
        supersedesInvoiceId: invoiceInput.invoiceId,
        idempotencyKey: 'invoice-unsponsored-after-correction-key',
      }),
      store.createInvoiceExport(writer!, {
        ...invoiceInput,invoiceId: 'invoice-unsponsored-after-correction-b',
        supersedesInvoiceId: invoiceInput.invoiceId,
        idempotencyKey: 'invoice-unsponsored-after-correction-key',
      }),
    ])
    expect(correctionRace.filter((value) => value.status === 'fulfilled')).toHaveLength(1)
    expect(correctionRace.filter((value) => value.status === 'rejected')).toHaveLength(1)
    const correction = correctionRace.find((value) => value.status === 'fulfilled') as
      PromiseFulfilledResult<Awaited<ReturnType<typeof store.createInvoiceExport>>>
    expect(correction.value.invoice).toMatchObject({
      supersedesInvoiceId: invoiceInput.invoiceId,netAmount: '0.000000000000000000',
    })
  })

  it('prioritizes dirty rooms and persists fair reconciliation progress across worker restarts', async () => {
    await pool.query(
      `INSERT INTO hosted_room_reconciliation_queue(chain_id,room_id,dirty,priority)
       SELECT 31337,room_id,true,0 FROM generate_series(1,5) AS room_id
       ON CONFLICT (chain_id,room_id) DO UPDATE SET
         dirty=true,priority=0,last_success_at=NULL,next_retry_at=NULL`,
    )
    const urgent = await store.leaseRoomReconciliations(writer!, 31337, ['5'], 2)
    expect(urgent[0]).toBe('5')
    for (const roomId of urgent) {
      await store.completeRoomReconciliation(writer!, {
        chainId: 31337, roomId, headBlock: '100', headHash: hash('8'),
      })
    }

    const restarted = new PostgresHostedStore(pool, 'integration-test-pepper-value-0001', managerAbi)
    const next = await restarted.leaseRoomReconciliations(writer!, 31337, [], 2)
    for (const roomId of next) {
      await restarted.completeRoomReconciliation(writer!, {
        chainId: 31337, roomId, headBlock: '101', headHash: hash('9'),
      })
    }
    const final = await restarted.leaseRoomReconciliations(writer!, 31337, [], 2)
    expect(new Set([...urgent, ...next, ...final])).toEqual(new Set(['1', '2', '3', '4', '5']))
  })
})
