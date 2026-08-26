import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppContext } from '../src/app.js'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { HostedRuntime } from '../src/hosted-runtime.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const objectStoreEndpoint = process.env.TEST_OBJECT_STORE_ENDPOINT
const integration = databaseUrl && objectStoreEndpoint ? describe : describe.skip

integration('hosted PostgreSQL/ObjectStore prove queue routes', () => {
  let context: AppContext
  let submitToken: string
  let nodeToken: string
  let tenantAdminToken: string

  beforeAll(async () => {
    const config = loadConfig({
      databaseUrl: databaseUrl!,
      apiKeyPepper: 'integration-api-key-pepper-00000001',
      hostingAdminToken: 'integration-hosting-admin-token-0001',
      allowDevStaticAdmin: true,
      coordinatorId: 'queue-route-integration',
      coordinatorRole: 'active',
      queueEnabled: true,
      l1RpcUrl: 'http://rpc-a.invalid',
      l1RpcUrls: ['http://rpc-a.invalid', 'http://rpc-b.invalid'],
      objectStoreEndpoint: objectStoreEndpoint!,
      objectStoreBucket: process.env.TEST_OBJECT_STORE_BUCKET ?? 'zkdeal-it',
      objectStoreRegion: 'us-east-1',
      objectStoreAccessKeyId: process.env.TEST_OBJECT_STORE_ACCESS_KEY ?? 'zkdealminio',
      objectStoreSecretAccessKey: process.env.TEST_OBJECT_STORE_SECRET_KEY ?? 'zkdeal-minio-test-secret',
      objectStorePrefix: 'queue-it',
      dataDir: '/tmp/zkdeal-queue-route-it',
    })
    const hosted = await HostedRuntime.create(config)
    if (!hosted) throw new Error('hosted integration runtime was not created')
    const fence = hosted.writableFence()
    await hosted.store.upsertTenant(fence, {
      tenantId: 'queue-tenant', displayName: 'Queue tenant', tier: 'integration',
    })
    const submitter = await hosted.store.provisionPrincipal(fence, {
      tenantId: 'queue-tenant', kind: 'api-key',
      roles: ['job-submit', 'job-read'],
    })
    const tenantAdmin = await hosted.store.provisionPrincipal(fence, {
      tenantId: 'queue-tenant', kind: 'api-key', roles: ['tenant-admin'],
    })
    const node = await hosted.store.provisionPrincipal(fence, {
      tenantId: 'queue-tenant', kind: 'node', roles: ['prove-node'],
    })
    await hosted.store.upsertProofProfile(fence, {
      proofClass: 'queue-integration', endpoint: '/v5/rooms/prove', needsGpu: true,
      estimatedWork: '2.5', estimatedProofTimeMs: 10_000, settlementMarginMs: 1_000,
      evidence: { source: 'containerized integration benchmark' },
      verifiedAt: new Date().toISOString(),
    })
    await hosted.store.publishBillingPrice(fence, {
      tenantId: 'queue-tenant', unit: 'proof-work', currency: 'GBP', unitPrice: '1',
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
      idempotencyKey: 'queue-integration-price',
    })
    await hosted.store.assignProviderNode(fence, {
      principalId: node.principalId, providerId: 'queue-it-provider', active: true,
      gpu: true, gpuResourceId: 'queue-it-gpu-0', partitions: ['shared'],
      tenantIds: ['queue-tenant'], allocationIds: [], proofClasses: ['queue-integration'],
      maxConcurrentJobs: 1, leaseTtlMs: 30_000,
    })
    submitToken = submitter.token
    nodeToken = node.token
    tenantAdminToken = tenantAdmin.token
    context = await createApp({ config, hosted, enableRelay: false, logger: false })
  })

  it('denies tenant-admin cross-kind and provider/system privilege escalation', async () => {
    for (const payload of [
      { kind: 'node', roles: ['tenant-admin'] },
      { kind: 'api-key', roles: ['prove-node'] },
      { kind: 'service', roles: ['indexer-write'] },
      { kind: 'node', roles: ['prove-node'] },
    ]) {
      const response = await context.app.inject({
        method: 'POST',
        url: '/hosting/v1/tenants/queue-tenant/principals',
        headers: { authorization: `Bearer ${tenantAdminToken}` },
        payload,
      })
      expect([400, 403]).toContain(response.statusCode)
    }
    const roomOperator = await context.app.inject({
      method: 'POST',
      url: '/hosting/v1/tenants/queue-tenant/principals',
      headers: { authorization: `Bearer ${tenantAdminToken}` },
      payload: { kind: 'node', roles: ['room-operator'] },
    })
    expect(roomOperator.statusCode).toBe(201)
  })

  afterAll(async () => {
    await context?.close()
  })

  it('archives request/result bytes and drives a fenced DB lease to DONE', async () => {
    const deadlineAt = new Date(Date.now() + 120_000).toISOString()
    const submit = await context.app.inject({
      method: 'POST',
      url: '/queue/v1/jobs',
      headers: {
        authorization: `Bearer ${submitToken}`,
        'idempotency-key': 'route-job-one',
        'x-correlation-id': 'queue-route:job-one',
      },
      payload: {
        endpoint: '/v5/rooms/prove',
        proofClass: 'queue-integration',
        request: { roomId: '7', witness: ['0x01', '0x02'] },
        roomId: '7',
        deadlineAt,
        correlationId: 'queue-route:job-one',
        billingMode: 'quoted',
        maximumChargeAmount: '10',
        maximumChargeCurrency: 'GBP',
      },
    })
    expect(submit.statusCode).toBe(202)
    const jobId = submit.json<{ jobId: string }>().jobId

    const replay = await context.app.inject({
      method: 'POST', url: '/queue/v1/jobs',
      headers: {
        authorization: `Bearer ${submitToken}`,'idempotency-key':'route-job-one',
        'x-correlation-id':'queue-route:job-one',
      },
      payload: {
        endpoint: '/v5/rooms/prove', proofClass: 'queue-integration',
        request: { witness: ['0x01', '0x02'], roomId: '7' }, roomId: '7',
        deadlineAt,correlationId:'queue-route:job-one',billingMode:'quoted',
        maximumChargeAmount:'10',maximumChargeCurrency:'GBP',
      },
    })
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toMatchObject({ jobId, already: true })

    const changed = await context.app.inject({
      method: 'POST', url: '/queue/v1/jobs',
      headers: {
        authorization: `Bearer ${submitToken}`,'idempotency-key':'route-job-one',
        'x-correlation-id':'queue-route:job-one',
      },
      payload: {
        endpoint: '/v5/rooms/prove', proofClass: 'queue-integration',
        request: { witness: ['0x01', '0x02'], roomId: '7' }, roomId: '7',
        deadlineAt,priority:1,correlationId:'queue-route:job-one',billingMode:'quoted',
        maximumChargeAmount: '10', maximumChargeCurrency: 'GBP',
      },
    })
    expect(changed.statusCode).toBe(409)

    const lease = await context.app.inject({
      method: 'POST', url: '/queue/v1/lease',
      headers: { authorization: `Bearer ${nodeToken}` }, payload: {},
    })
    expect(lease.statusCode).toBe(200)
    expect(lease.json()).toMatchObject({
      jobId,
      correlationId: 'queue-route:job-one',
      tenantId: 'queue-tenant',
      roomId: '7',
      request: { roomId: '7', witness: ['0x01', '0x02'] },
    })

    const complete = await context.app.inject({
      method: 'POST', url: `/queue/v1/jobs/${jobId}/complete`,
      headers: { authorization: `Bearer ${nodeToken}` },
      payload: { result: { receipt: '0xfeed', verified: true } },
    })
    expect(complete.statusCode).toBe(200)
    expect(complete.json()).toMatchObject({ jobId, status: 'DONE', already: false })

    const result = await context.app.inject({
      method: 'GET', url: `/queue/v1/jobs/${jobId}/result`,
      headers: { authorization: `Bearer ${submitToken}` },
    })
    expect(result.statusCode).toBe(200)
    expect(result.json()).toEqual({ receipt: '0xfeed', verified: true })
  })
})
