import type { HostedRuntime } from './hosted-runtime.js'
import type {
  CapacityDemandSignal,
  CapacityExecutionLease,
  NodeLifecycleExecutionLease,
} from './hosted-types.js'
import type { CapacityProviderResult, NodeLifecycleProviderResult } from './postgres-hosted-store.js'
import { emitHostedTrace } from './structured-log.js'

export class CapacityProviderError extends Error {
  constructor(
    message: string,
    readonly permanent = false,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message)
    this.name = 'CapacityProviderError'
  }
}

export interface CapacityProvider {
  assertReady(): Promise<void>
  apply(lease: CapacityExecutionLease): Promise<CapacityProviderResult>
  applyNodeLifecycle(lease: NodeLifecycleExecutionLease): Promise<NodeLifecycleProviderResult>
  publishDemand(signal: CapacityDemandSignal): Promise<Record<string, unknown>>
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CapacityProviderError(`${label} must be a JSON object`, true)
  }
  return value as Record<string, unknown>
}

function boundedRetryAfter(value: unknown): number | null {
  if (value === undefined || value === null) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 60 * 60_000) {
    throw new CapacityProviderError('provider retryAfterMs must be from one second through one hour', true)
  }
  return parsed
}

/**
 * Scoped provider adapter. Every mutation carries the immutable operation key
 * understood by cloud/fleet and on-chain-controller adapters; redirects are
 * refused so the bearer cannot be forwarded to another origin.
 */
export class HttpCapacityProvider implements CapacityProvider {
  private readonly baseUrl: string

  constructor(
    baseUrl: string,
    private readonly authToken: string,
    private readonly previousAuthToken: string | null = null,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly timeoutMs = 10_000,
  ) {
    const parsed = new URL(baseUrl)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('capacity provider URL must use HTTP(S)')
    }
    if (authToken.length < 16 || (previousAuthToken !== null && previousAuthToken.length < 16)) {
      throw new Error('capacity provider credentials must contain at least 16 characters')
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
      throw new Error('capacity provider timeout must be from one through sixty seconds')
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, '')
    this.baseUrl = parsed.toString().replace(/\/$/, '')
  }

  private async request(
    path: string,
    init: { method: 'GET' | 'POST'; idempotencyKey?: string; body?: unknown },
  ): Promise<Record<string, unknown>> {
    const tokens = [this.authToken, this.previousAuthToken].filter((value): value is string => Boolean(value))
    let lastStatus = 0
    for (let index = 0; index < tokens.length; index += 1) {
      let response: Response
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: init.method,
          redirect: 'error',
          headers: {
            authorization: `Bearer ${tokens[index]}`,
            accept: 'application/json',
            ...(init.idempotencyKey ? { 'idempotency-key': init.idempotencyKey } : {}),
            ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
      } catch (error) {
        throw new CapacityProviderError(`capacity provider transport failed: ${(error as Error).message}`)
      }
      lastStatus = response.status
      if ((response.status === 401 || response.status === 403) && index + 1 < tokens.length) continue
      const text = await response.text()
      let parsed: unknown = {}
      try {
        parsed = text === '' ? {} : JSON.parse(text)
      } catch {
        throw new CapacityProviderError(`capacity provider returned non-JSON HTTP ${response.status}`, response.status < 500)
      }
      if (!response.ok) {
        const body = object(parsed, 'capacity provider error')
        const message = typeof body.error === 'string' ? body.error : `HTTP ${response.status}`
        const retryAfter = boundedRetryAfter(body.retryAfterMs)
        const permanent = response.status >= 400 && response.status < 500
          && ![408, 409, 425, 429].includes(response.status)
        throw new CapacityProviderError(`capacity provider rejected request: ${message.slice(0, 300)}`, permanent, retryAfter)
      }
      return object(parsed, 'capacity provider response')
    }
    throw new CapacityProviderError(`capacity provider authentication failed with HTTP ${lastStatus}`, true)
  }

  async assertReady(): Promise<void> {
    const response = await this.request('/health', { method: 'GET' })
    if (response.ok !== true) throw new CapacityProviderError('capacity provider health response is not ready')
  }

  async apply(lease: CapacityExecutionLease): Promise<CapacityProviderResult> {
    const response = await this.request('/v1/capacity/operations', {
      method: 'POST',
      idempotencyKey: lease.idempotencyKey,
      body: {
        schemaVersion: 1,
        allocationId: lease.allocationId,
        tenantId: lease.tenantId,
        roomId: lease.roomId,
        desiredState: lease.desiredState,
        providerNodeId: lease.providerNodeId,
        deadlineAt: lease.deadlineAt,
        metadata: lease.metadata,
        previousProviderOperationId: lease.providerOperationId,
      },
    })
    if (response.state !== 'APPLIED' && response.state !== 'PENDING') {
      throw new CapacityProviderError('capacity provider state must be APPLIED or PENDING', true)
    }
    if (typeof response.operationId !== 'string' || response.operationId.length < 1 || response.operationId.length > 200) {
      throw new CapacityProviderError('capacity provider operationId is invalid', true)
    }
    if (
      response.providerNodeId !== undefined && response.providerNodeId !== null
      && (typeof response.providerNodeId !== 'string' || response.providerNodeId.length > 128)
    ) throw new CapacityProviderError('capacity provider node id is invalid', true)
    const retryAfterMs = boundedRetryAfter(response.retryAfterMs)
    if (response.state === 'PENDING' && retryAfterMs === null) {
      throw new CapacityProviderError('pending capacity provider result omitted retryAfterMs', true)
    }
    return {
      state: response.state,
      providerOperationId: response.operationId,
      providerNodeId: (response.providerNodeId as string | null | undefined) ?? null,
      retryAfterMs,
      evidence: object(response.evidence ?? {}, 'capacity provider evidence'),
    }
  }

  async applyNodeLifecycle(lease: NodeLifecycleExecutionLease): Promise<NodeLifecycleProviderResult> {
    const response = await this.request(`/v1/nodes/${lease.onchainNodeId}/lifecycle`, {
      method: 'POST',idempotencyKey: lease.idempotencyKey,
      body: {
        schemaVersion: 1,operationId: lease.operationId,principalId: lease.principalId,
        nodeId: lease.onchainNodeId,desiredState: lease.desiredState,
        previousProviderOperationId: lease.providerOperationId,
      },
    })
    if (response.state !== 'APPLIED' && response.state !== 'PENDING') {
      throw new CapacityProviderError('node lifecycle provider state must be APPLIED or PENDING', true)
    }
    if (typeof response.operationId !== 'string' || response.operationId.length < 1 || response.operationId.length > 200) {
      throw new CapacityProviderError('node lifecycle provider operationId is invalid', true)
    }
    const retryAfterMs = boundedRetryAfter(response.retryAfterMs)
    if (response.state === 'PENDING' && retryAfterMs === null) {
      throw new CapacityProviderError('pending node lifecycle result omitted retryAfterMs', true)
    }
    return {
      state: response.state,providerOperationId: response.operationId,
      retryAfterMs,evidence: object(response.evidence ?? {},'node lifecycle provider evidence'),
    }
  }

  async publishDemand(signal: CapacityDemandSignal): Promise<Record<string, unknown>> {
    const response = await this.request('/v1/capacity/demand', {
      method: 'POST',
      idempotencyKey: `capacity-signal:${signal.signalId}`,
      body: {
        schemaVersion: 1,
        signalId: signal.signalId,
        windowStartedAt: signal.windowStartedAt,
        queuedJobs: signal.queuedJobs,
        queuedBytes: signal.queuedBytes,
        estimatedProofTimeMs: signal.estimatedProofTimeMs,
        urgentJobs: signal.urgentJobs,
        reservedJobs: signal.reservedJobs,
        activeGpuResources: signal.activeGpuResources,
        desiredGpuResources: signal.desiredGpuResources,
        staleProofProfiles: signal.staleProofProfiles,
        earliestLatestStartAt: signal.earliestLatestStartAt,
        scaleDownSafe: signal.scaleDownSafe,
      },
    })
    if (response.accepted !== true) throw new CapacityProviderError('capacity provider did not accept demand signal', true)
    return response
  }
}

export interface CapacityControllerRun {
  signalsSent: number
  applied: number
  pending: number
  retrying: number
  terminal: number
  deadlineRisk: number
  nodeLifecycleApplied: number
  nodeLifecyclePending: number
  nodeLifecycleRetrying: number
  nodeLifecycleTerminal: number
  nodeLifecycleVerified: number
  nodeLifecycleRecoveryRequired: number
}

export class CapacityController {
  constructor(
    private readonly runtime: HostedRuntime,
    private readonly provider: CapacityProvider,
    private readonly workerId: string,
    private readonly leaseTtlMs = 30_000,
    private readonly batchSize = 20,
    private readonly chainId = 1,
  ) {}

  async assertReady(): Promise<void> {
    this.runtime.writableFence()
    await this.provider.assertReady()
  }

  private retryMs(attempt: number, requested: number | null): number {
    if (requested !== null) return requested
    return Math.min(60 * 60_000, 1_000 * (2 ** Math.min(10, Math.max(0, attempt - 1))))
  }

  async processOnce(): Promise<CapacityControllerRun> {
    const totals: CapacityControllerRun = {
      signalsSent: 0, applied: 0, pending: 0, retrying: 0, terminal: 0, deadlineRisk: 0,
      nodeLifecycleApplied: 0,nodeLifecyclePending: 0,nodeLifecycleRetrying: 0,
      nodeLifecycleTerminal: 0,nodeLifecycleVerified: 0,nodeLifecycleRecoveryRequired: 0,
    }
    const signal = await this.runtime.store.leaseCapacityDemandSignal(
      this.runtime.writableFence(), this.workerId, { leaseTtlMs: this.leaseTtlMs },
    )
    if (signal) {
      const trace={
        correlationId:`capacity:${signal.signalId}`,tenantId:null,roomId:null,jobId:null,
        operationId:signal.signalId,component:'capacity' as const,event:'demand.publish',
      }
      emitHostedTrace({ ...trace,outcome:'started' })
      try {
        const response = await this.provider.publishDemand(signal)
        await this.runtime.store.completeCapacityDemandSignal(this.runtime.writableFence(), signal, response)
        totals.signalsSent += 1
        emitHostedTrace({ ...trace,outcome:'succeeded' })
      } catch (error) {
        const providerError = error instanceof CapacityProviderError ? error : null
        await this.runtime.store.failCapacityDemandSignal(
          this.runtime.writableFence(), signal,
          error instanceof Error ? error.message : 'unknown capacity signal failure',
          this.retryMs(1, providerError?.retryAfterMs ?? null),
          providerError?.permanent ?? false,
        )
        emitHostedTrace({ ...trace,outcome:providerError?.permanent ? 'failed' : 'retrying' })
      }
    }

    const leases = await this.runtime.store.leaseCapacityExecutions(
      this.runtime.writableFence(), this.workerId, this.batchSize, this.leaseTtlMs,
    )
    for (const lease of leases) {
      const trace={
        correlationId:`capacity:${lease.idempotencyKey}`,tenantId:lease.tenantId,roomId:lease.roomId,
        jobId:null,operationId:lease.allocationId,component:'capacity' as const,event:'allocation.apply',
      }
      emitHostedTrace({ ...trace,outcome:'started' })
      try {
        const result = await this.provider.apply(lease)
        await this.runtime.store.completeCapacityExecution(this.runtime.writableFence(), lease, result)
        if (result.state === 'APPLIED') totals.applied += 1
        else totals.pending += 1
        emitHostedTrace({ ...trace,outcome:result.state==='APPLIED' ? 'succeeded' : 'retrying' })
      } catch (error) {
        const providerError = error instanceof CapacityProviderError ? error : null
        const failed = await this.runtime.store.failCapacityExecution(
          this.runtime.writableFence(), lease,
          error instanceof Error ? error.message : 'unknown capacity provider failure',
          this.retryMs(lease.attempts, providerError?.retryAfterMs ?? null),
          providerError?.permanent ?? false,
        )
        if (failed.terminal) totals.terminal += 1
        else totals.retrying += 1
        if (failed.deadlineRisk) totals.deadlineRisk += 1
        emitHostedTrace({ ...trace,outcome:failed.terminal ? 'failed' : 'retrying' })
      }
    }
    const canonical = await this.runtime.store.reconcileNodeLifecycleFacts(
      this.runtime.writableFence(),this.chainId,
    )
    totals.nodeLifecycleVerified += canonical.applied
    totals.nodeLifecycleRecoveryRequired += canonical.recoveryRequired
    const lifecycleLeases = await this.runtime.store.leaseNodeLifecycleExecutions(
      this.runtime.writableFence(),this.workerId,this.batchSize,this.leaseTtlMs,
    )
    for (const lease of lifecycleLeases) {
      const trace={
        correlationId:`capacity:${lease.idempotencyKey}`,tenantId:null,roomId:null,jobId:null,
        operationId:lease.operationId,component:'capacity' as const,event:'node-lifecycle.apply',
      }
      emitHostedTrace({ ...trace,outcome:'started' })
      try {
        const result = await this.provider.applyNodeLifecycle(lease)
        await this.runtime.store.completeNodeLifecycleExecution(this.runtime.writableFence(),lease,result)
        if (result.state === 'APPLIED') totals.nodeLifecycleApplied += 1
        else totals.nodeLifecyclePending += 1
        emitHostedTrace({ ...trace,outcome:result.state==='APPLIED' ? 'succeeded' : 'retrying' })
      } catch (error) {
        const providerError = error instanceof CapacityProviderError ? error : null
        const failed = await this.runtime.store.failNodeLifecycleExecution(
          this.runtime.writableFence(),lease,
          error instanceof Error ? error.message : 'unknown node lifecycle provider failure',
          this.retryMs(lease.attempts,providerError?.retryAfterMs ?? null),
          providerError?.permanent ?? false,
        )
        if (failed.status === 'FAILED') totals.nodeLifecycleTerminal += 1
        else totals.nodeLifecycleRetrying += 1
        emitHostedTrace({ ...trace,outcome:failed.status==='FAILED' ? 'failed' : 'retrying' })
      }
    }
    return totals
  }
}
