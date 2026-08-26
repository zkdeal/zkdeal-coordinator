import { describe, expect, it, vi } from 'vitest'
import {
  CapacityController,
  CapacityProviderError,
  HttpCapacityProvider,
  type CapacityProvider,
} from '../src/capacity-controller.js'
import type { HostedRuntime } from '../src/hosted-runtime.js'
import type { CapacityDemandSignal, CapacityExecutionLease, CoordinatorFence } from '../src/hosted-types.js'

const fence: CoordinatorFence = {
  leaseName: 'coordinator-writer', holderId: 'active-a', token: 7n,
  expiresAt: '2099-01-01T00:00:00.000Z',
}

const lease: CapacityExecutionLease = {
  allocationId: 'allocation-a', tenantId: 'tenant-a', roomId: '7',
  desiredState: 'ACTIVE', providerNodeId: null, deadlineAt: '2099-01-01T00:00:00.000Z',
  idempotencyKey: 'capacity-idempotency-a', metadata: { region: 'eu-west' },
  executionStatus: 'LEASED', appliedState: 'RESERVED', providerOperationId: null,
  attempts: 1, maxAttempts: 12, leaseOwner: 'capacity-a', leaseToken: '3',
  leaseExpiresAt: '2099-01-01T00:00:00.000Z',
}

const signal: CapacityDemandSignal = {
  signalId: '11', windowStartedAt: '2026-08-21T10:00:00.000Z',
  queuedJobs: 7, queuedBytes: '4096', estimatedProofTimeMs: '900000',
  urgentJobs: 2, reservedJobs: 1, activeGpuResources: 1, desiredGpuResources: 3,
  staleProofProfiles: 1, earliestLatestStartAt: '2026-08-21T10:01:00.000Z',
  scaleDownSafe: false, leaseOwner: 'capacity-a', leaseToken: '4',
  leaseExpiresAt: '2099-01-01T00:00:00.000Z',
}

describe('capacity controller provider boundary', () => {
  it('uses immutable idempotency and bounded credential overlap without redirecting', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = []
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} })
      const token = new Headers(init?.headers).get('authorization')
      if (token === 'Bearer current-capacity-token') {
        return new Response(JSON.stringify({ error: 'rotating' }), { status: 401 })
      }
      return new Response(JSON.stringify({
        state: 'APPLIED', operationId: 'provider-operation-7', providerNodeId: 'gpu-eu-7',
        evidence: { providerRequestId: 'request-7' },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const provider = new HttpCapacityProvider(
      'https://capacity.example/provider/', 'current-capacity-token',
      'previous-capacity-token', fetcher,
    )
    await expect(provider.apply(lease)).resolves.toMatchObject({
      state: 'APPLIED', providerOperationId: 'provider-operation-7', providerNodeId: 'gpu-eu-7',
    })
    expect(requests).toHaveLength(2)
    expect(new Headers(requests[1]!.init.headers).get('idempotency-key')).toBe(lease.idempotencyKey)
    expect(new Headers(requests[1]!.init.headers).get('authorization')).toBe('Bearer previous-capacity-token')
    expect(requests[1]!.init.redirect).toBe('error')
    expect(JSON.parse(String(requests[1]!.init.body))).toMatchObject({
      allocationId: lease.allocationId, tenantId: lease.tenantId,
      desiredState: 'ACTIVE', previousProviderOperationId: null,
    })
  })

  it('forwards a fixed fail-closed scale-down signal and rejects malformed provider state', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (body.signalId) {
        expect(body).toMatchObject({
          signalId: '11', urgentJobs: 2, desiredGpuResources: 3,
          staleProofProfiles: 1, scaleDownSafe: false,
        })
        return new Response(JSON.stringify({ accepted: true, providerRevision: 'r1' }), { status: 200 })
      }
      return new Response(JSON.stringify({ state: 'REJECTED', operationId: 'bad' }), { status: 200 })
    }) as typeof fetch
    const provider = new HttpCapacityProvider(
      'https://capacity.example', 'capacity-provider-token', null, fetcher,
    )
    await expect(provider.publishDemand(signal)).resolves.toMatchObject({ accepted: true })
    await expect(provider.apply(lease)).rejects.toMatchObject({
      name: 'CapacityProviderError', permanent: true,
    } satisfies Partial<CapacityProviderError>)
  })

  it('acknowledges provider work only after durable store completion', async () => {
    const calls: string[] = []
    const store = {
      leaseCapacityDemandSignal: vi.fn(async () => signal),
      completeCapacityDemandSignal: vi.fn(async () => { calls.push('signal-committed') }),
      failCapacityDemandSignal: vi.fn(),
      leaseCapacityExecutions: vi.fn(async () => [lease]),
      completeCapacityExecution: vi.fn(async () => { calls.push('operation-committed') }),
      failCapacityExecution: vi.fn(),
      reconcileNodeLifecycleFacts: vi.fn(async () => ({ applied: 0,recoveryRequired: 0 })),
      leaseNodeLifecycleExecutions: vi.fn(async () => []),
      completeNodeLifecycleExecution: vi.fn(),
      failNodeLifecycleExecution: vi.fn(),
    }
    const runtime = {
      store,
      writableFence: () => fence,
    } as unknown as HostedRuntime
    const provider: CapacityProvider = {
      assertReady: vi.fn(async () => {}),
      publishDemand: vi.fn(async () => { calls.push('signal-provider'); return { accepted: true } }),
      apply: vi.fn(async () => {
        calls.push('operation-provider')
        return {
          state: 'APPLIED' as const, providerOperationId: 'provider-op', providerNodeId: 'gpu-7',
          retryAfterMs: null, evidence: { accepted: true },
        }
      }),
      applyNodeLifecycle: vi.fn(),
    }
    const controller = new CapacityController(runtime, provider, 'capacity-a')
    await expect(controller.processOnce()).resolves.toMatchObject({ signalsSent: 1, applied: 1 })
    expect(calls).toEqual([
      'signal-provider', 'signal-committed', 'operation-provider', 'operation-committed',
    ])
  })
})
