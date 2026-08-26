import { join } from 'node:path'
import type { ServerConfig } from './config.js'
import type { CoordinatorFence } from './hosted-types.js'
import {
  createPostgresPool,
  HOSTED_SCHEMA_VERSION,
  HostedFenceError,
  PostgresHostedStore,
  type ReplicationPromotionEvidence,
} from './postgres-hosted-store.js'
import { S3ObjectStore, type ObjectStore } from './object-store.js'
import { SharedL1Transport } from './shared-l1-transport.js'
import { loadContractAbi } from './hosted-indexer.js'

export const HOSTED_LEASE_NAME = 'coordinator-writer'
// Route/schema registration and runtime cold starts can synchronously occupy a
// constrained container for more than fifteen seconds. A lease acquired before
// the listener becomes ready must not self-fence solely because of that bounded
// startup work. Sixty seconds remains well inside the five-minute promotion
// drill while preserving three missed renewals before expiry.
export const HOSTED_LEASE_TTL_MS = 60_000
export const HOSTED_LEASE_RENEW_MS = 20_000

export interface HostedRuntimeStatus {
  enabled: boolean
  configuredRole: ServerConfig['coordinatorRole']
  effectiveRole: 'active' | 'standby' | 'standalone' | 'fenced'
  coordinatorId: string
  fenceToken: string | null
  leaseExpiresAt: string | null
  schemaVersion: number
  l1QuorumHealthy: boolean
  l1LastAgreedAt: string | null
  indexerLagBlocks: string | null
  indexerHeadMatchesL1: boolean
  ready: boolean
  runtimeMode: 'coordinator' | 'worker'
  workerComponent: string | null
  workerId: string | null
  promotionReplication: ReplicationPromotionEvidence | null
}

export interface HostedRuntimeCreateOptions {
  workerComponent?: 'indexer' | 'reconciler' | 'publisher' | 'withdrawal' | 'capacity'
  workerId?: string
  /**
   * Coordinator-only cold-start mode. The database/object/L1 dependencies are
   * constructed, but no writer epoch exists until `activate()` is called after
   * route/schema compilation. Workers always acquire their delegated lease
   * immediately.
   */
  deferWriterLease?: boolean
}

/**
 * Owns the PostgreSQL pool and the writer lease. Losing one renewal clears the
 * in-memory fence immediately; every store mutation also re-checks the token
 * inside its transaction, so a paused former active cannot write after a new
 * replica is promoted.
 */
export class HostedRuntime {
  private fence: CoordinatorFence | null = null
  private timer: NodeJS.Timeout | null = null
  private closed = false
  private effectiveRole: HostedRuntimeStatus['effectiveRole']
  private l1Timer: NodeJS.Timeout | null = null
  private l1LastAgreedAt: string | null = null
  private indexerLagBlocks: string | null = null
  private indexerHeadMatchesL1 = false
  private promotionReplication: ReplicationPromotionEvidence | null = null
  private renewalStarted = false
  private l1MonitorStarted = false

  private constructor(
    readonly store: PostgresHostedStore,
    readonly objects: ObjectStore,
    readonly l1: SharedL1Transport,
    private readonly config: ServerConfig,
    private readonly workerComponent: 'indexer' | 'reconciler' | 'publisher' | 'withdrawal' | 'capacity' | null,
    private readonly workerId: string | null,
  ) {
    this.effectiveRole = config.coordinatorRole
  }

  static async create(
    config: ServerConfig,
    options: HostedRuntimeCreateOptions = {},
  ): Promise<HostedRuntime | null> {
    if (!config.databaseUrl) return null
    const pool = await createPostgresPool(config.databaseUrl)
    const aggregateAbi = loadContractAbi(
      join(config.contractsOut, 'IRoomManager.sol', 'IRoomManager.json'),
    )
    const store = new PostgresHostedStore(pool, config.apiKeyPepper!, aggregateAbi)
    const objects = new S3ObjectStore({
      endpoint: config.objectStoreEndpoint!,
      bucket: config.objectStoreBucket,
      region: config.objectStoreRegion,
      accessKeyId: config.objectStoreAccessKeyId!,
      secretAccessKey: config.objectStoreSecretAccessKey!,
      prefix: config.objectStorePrefix,
    })
    const l1 = new SharedL1Transport(
      config.l1RpcUrls,
      config.chainId,
      globalThis.fetch,
      10_000,
      config.l1RpcProviderIds,
    )
    const workerComponent = options.workerComponent ?? null
    if (workerComponent && options.deferWriterLease) {
      throw new Error('delegated workers cannot defer their writer lease')
    }
    const workerId = workerComponent
      ? options.workerId?.trim() || `${config.coordinatorId}-${workerComponent}`
      : null
    const runtime = new HostedRuntime(store, objects, l1, config, workerComponent, workerId)
    try {
      await objects.putContent(
        new TextEncoder().encode('zkdeal hosted object-store readiness probe'),
        'text/plain; charset=utf-8',
      )
      await store.bootstrap()
      await runtime.refreshL1Health(false).catch(() => {})
      if (workerComponent) {
        const acquired = await runtime.acquire()
        if (!acquired) {
          throw new HostedFenceError('active coordinator did not grant this worker a current-epoch delegation')
        }
      } else if (
        !options.deferWriterLease
        && (config.coordinatorRole === 'active' || config.coordinatorRole === 'standalone')
      ) {
        const acquired = await runtime.acquire()
        if (!acquired && config.coordinatorRole === 'active') {
          throw new HostedFenceError('another coordinator owns the active writer lease')
        }
      } else if (options.deferWriterLease) {
        runtime.effectiveRole = 'fenced'
      }
      runtime.startL1Monitor()
      if (!options.deferWriterLease) runtime.startRenewal()
      return runtime
    } catch (error) {
      await store.close().catch(() => {})
      throw error
    }
  }

  private async acquire(): Promise<boolean> {
    const fence = this.workerComponent
      ? await this.store.acquireWorkerLease(
          this.workerComponent,
          this.workerId!,
          this.config.coordinatorId,
          HOSTED_LEASE_TTL_MS,
        )
      : await this.store.acquireLease(
          HOSTED_LEASE_NAME,
          this.config.coordinatorId,
          HOSTED_LEASE_TTL_MS,
        )
    this.fence = fence
    this.effectiveRole = fence ? 'active' : 'standby'
    if (fence && !this.workerComponent) {
      await this.store.recordPrimaryReplicationCheckpoint(fence)
    }
    return fence !== null
  }

  private startRenewal(): void {
    if (this.renewalStarted) return
    this.renewalStarted = true
    this.timer = setInterval(() => {
      void this.renew().catch(() => {
        this.fence = null
        this.effectiveRole = 'fenced'
      })
    }, HOSTED_LEASE_RENEW_MS)
    this.timer.unref?.()
  }

  private startL1Monitor(): void {
    if (this.l1MonitorStarted) return
    this.l1MonitorStarted = true
    this.l1Timer = setInterval(() => {
      void this.refreshL1Health(false).catch(() => {
        this.indexerHeadMatchesL1 = false
      })
    }, 15_000)
    this.l1Timer.unref?.()
  }

  /**
   * Acquire the coordinator epoch only after all synchronous cold-start work
   * has completed. A failed acquisition leaves the process fenced; callers
   * must not bind a listener or report readiness.
   */
  async activate(): Promise<void> {
    if (this.closed) throw new HostedFenceError('hosted runtime is closed')
    if (this.workerComponent) {
      if (!this.fence) throw new HostedFenceError('delegated worker lease is absent')
      return
    }
    if (this.config.coordinatorRole === 'standby') {
      this.effectiveRole = 'standby'
      return
    }
    if (this.fence) {
      this.writableFence()
      this.startRenewal()
      return
    }
    const acquired = await this.acquire()
    if (!acquired) {
      this.fence = null
      this.effectiveRole = this.config.coordinatorRole === 'active' ? 'fenced' : 'standby'
      throw new HostedFenceError('another coordinator owns the active writer lease')
    }
    // Re-read the lease boundary immediately before the caller may expose
    // readiness. Every later mutation also validates it transactionally.
    this.writableFence()
    this.startRenewal()
  }

  async refreshL1Health(requireFreshIndexer: boolean): Promise<void> {
    const latest = await this.l1.agreedBlock('latest')
    this.l1LastAgreedAt = new Date().toISOString()
    const indexed = await this.store.canonicalHead(this.config.chainId)
    if (!indexed) {
      this.indexerLagBlocks = null
      this.indexerHeadMatchesL1 = false
      if (requireFreshIndexer) throw new Error('canonical indexer has no head')
      return
    }
    const lag = BigInt(latest.number) - BigInt(indexed.number)
    this.indexerLagBlocks = lag.toString()
    if (lag < 0n || lag > BigInt(Math.min(this.config.maximumArchiveLagBlocks, 8))) {
      this.indexerHeadMatchesL1 = false
      if (requireFreshIndexer) throw new Error('canonical indexer is outside the eight-block freshness gate')
      return
    }
    const corroborated = await this.l1.agreedBlock(`0x${BigInt(indexed.number).toString(16)}`)
    this.indexerHeadMatchesL1 = corroborated.hash.toLowerCase() === indexed.hash.toLowerCase()
    if (
      this.indexerHeadMatchesL1
      && !await this.store.blobArchiveReadyThrough(this.config.chainId, indexed.number)
    ) {
      this.indexerHeadMatchesL1 = false
      if (requireFreshIndexer) throw new Error('canonical indexer has unarchived blob sidecars')
      return
    }
    if (requireFreshIndexer && !this.indexerHeadMatchesL1) {
      throw new Error('canonical indexer head hash does not match the L1 quorum')
    }
  }

  private async renew(): Promise<void> {
    if (this.closed || !this.fence) return
    const renewed = this.workerComponent
      ? await this.store.acquireWorkerLease(
          this.workerComponent,
          this.workerId!,
          this.config.coordinatorId,
          HOSTED_LEASE_TTL_MS,
        )
      : await this.store.acquireLease(
          HOSTED_LEASE_NAME,
          this.config.coordinatorId,
          HOSTED_LEASE_TTL_MS,
        )
    const delegationMatches = renewed?.delegation?.token === this.fence.delegation?.token
      && renewed?.delegation?.workerId === this.fence.delegation?.workerId
      && renewed?.delegation?.component === this.fence.delegation?.component
    if (
      !renewed
      || renewed.token !== this.fence.token
      || Boolean(renewed.delegation) !== Boolean(this.fence.delegation)
      || (renewed.delegation && !delegationMatches)
    ) {
      this.fence = null
      this.effectiveRole = 'fenced'
      throw new HostedFenceError('coordinator writer lease was lost')
    }
    if (!this.workerComponent) {
      await this.store.recordPrimaryReplicationCheckpoint(renewed)
    }
    this.fence = renewed
  }

  /** Authorized standby promotion after replay, schema, L1, freshness, and archive gates. */
  async promote(): Promise<boolean> {
    if (this.closed) return false
    if (this.workerComponent) throw new Error('delegated workers cannot promote a coordinator epoch')
    if (this.fence && this.effectiveRole === 'active') return true
    await this.refreshL1Health(true)
    const promoted = await this.store.acquireLeaseForPromotion(
      HOSTED_LEASE_NAME,
      this.config.coordinatorId,
      HOSTED_LEASE_TTL_MS,
      this.config.promotionMaximumCheckpointAgeMs,
    )
    if (!promoted) {
      this.fence = null
      this.effectiveRole = 'standby'
      return false
    }
    this.fence = promoted.fence
    this.promotionReplication = promoted.replication
    this.effectiveRole = 'active'
    return true
  }

  async assertCriticalL1Ready(): Promise<void> {
    await this.refreshL1Health(true)
  }

  /**
   * Revalidate the writer epoch using PostgreSQL's clock before advertising
   * readiness. A promoted or expired epoch is cleared immediately; relying on
   * the in-memory expiry alone would leave a short stale-active readiness gap.
   */
  async verifyReady(): Promise<HostedRuntimeStatus> {
    const current = this.status()
    if (!current.ready || this.config.coordinatorRole === 'standby') return current
    try {
      await this.store.assertCurrentFence(this.writableFence())
    } catch (error) {
      if (error instanceof HostedFenceError) {
        this.fence = null
        this.effectiveRole = 'fenced'
        return this.status()
      }
      throw error
    }
    return this.status()
  }

  writableFence(): CoordinatorFence {
    if (!this.fence) throw new HostedFenceError()
    if (Date.parse(this.fence.expiresAt) <= Date.now()) {
      this.fence = null
      this.effectiveRole = 'fenced'
      throw new HostedFenceError('coordinator writer lease expired')
    }
    return this.fence
  }

  status(): HostedRuntimeStatus {
    return {
      enabled: true,
      configuredRole: this.config.coordinatorRole,
      effectiveRole: this.effectiveRole,
      coordinatorId: this.config.coordinatorId,
      fenceToken: this.fence?.token.toString() ?? null,
      leaseExpiresAt: this.fence?.expiresAt ?? null,
      schemaVersion: HOSTED_SCHEMA_VERSION,
      l1QuorumHealthy: this.l1LastAgreedAt !== null
        && Date.now() - Date.parse(this.l1LastAgreedAt) <= 60_000,
      l1LastAgreedAt: this.l1LastAgreedAt,
      indexerLagBlocks: this.indexerLagBlocks,
      indexerHeadMatchesL1: this.indexerHeadMatchesL1,
      ready:
        this.config.coordinatorRole === 'standby'
          ? this.effectiveRole === 'standby'
          : this.effectiveRole === 'active'
            && this.fence !== null
            && this.l1LastAgreedAt !== null
            && Date.now() - Date.parse(this.l1LastAgreedAt) <= 60_000,
      runtimeMode: this.workerComponent ? 'worker' : 'coordinator',
      workerComponent: this.workerComponent,
      workerId: this.workerId,
      promotionReplication: this.promotionReplication,
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    if (this.l1Timer) clearInterval(this.l1Timer)
    this.timer = null
    this.l1Timer = null
    if (this.fence) await this.store.releaseLease(this.fence).catch(() => {})
    this.fence = null
    await this.store.close()
  }
}
