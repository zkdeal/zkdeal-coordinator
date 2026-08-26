import { join } from 'node:path'
import cors from '@fastify/cors'
import { createRelayNode, type RelayNodeResult } from '@zkdeal/p2p/relay'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerArtifactRoutes, registerStaticWeb } from './app-assets.js'
import { registerDiscoveryRoutes } from './app-config-routes.js'
import { registerRpcProxyRoute } from './app-rpc-route.js'
import { RateLimiter } from './quota.js'
import { isLoopbackHost, type ServerConfig } from './config.js'
import { FaucetService } from './faucet.js'
import { JsonFileStore } from './store.js'
import { registerObserverRoutes, ObserverStore } from './observer.js'
import { registerObserverWriteRoutes } from './observer-write.js'
import { registerAdmissionRoutes, type AdmissionService } from './admission.js'
import { registerDemoRoutes, type DemoController } from './demo-control.js'
import { registerMetricsRoute } from './metrics.js'
import { createSseBatchCounters, type SseBatchCounters } from './sse-batcher.js'
import { registerProveQueueRoutes } from './prove-queue/queue-routes.js'
import { registerPostgresProveQueueRoutes } from './prove-queue/postgres-queue-routes.js'
import { ProveQueueStore } from './prove-queue/queue-store.js'
import type { HostedRuntime } from './hosted-runtime.js'
import { registerHostingRoutes } from './hosting-routes.js'
import type { BlobPublisher } from './blob-publisher.js'
import type { WithdrawalProofService } from './withdrawal-service.js'
import type { ManagedL1Publisher } from './managed-l1-publisher.js'
import type { ManagedBlobPublisher } from './managed-blob-publisher.js'
import { registerCorrelationHooks } from './correlation.js'

export interface CreateAppOptions {
  config: ServerConfig
  store?: JsonFileStore
  /** Default true. Unit tests set false (offline). */
  enableRelay?: boolean
  /** Fastify logger; default true. */
  logger?: boolean | object
  /** Read-only room observation archive. */
  observer?: ObserverStore | null
  /** Optional environment-backed validity-only admission service. */
  admission?: AdmissionService | null
  /** Optional persistent local-demo controller. Never enabled on public networks. */
  demo?: DemoController | null
  /** PostgreSQL authority and active/standby fencing for hosted operation. */
  hosted?: HostedRuntime | null
  /** Optional fenced EIP-4844 publisher; hosted mode only. */
  publisher?: BlobPublisher | null
  /** Scoped durable publishers for allowlisted hosted operations. */
  nodeHeartbeatPublisher?: ManagedL1Publisher | null
  roomBatchPublisher?: ManagedL1Publisher | null
  roomAggregatePublisher?: ManagedBlobPublisher | null
  poolSponsorPublisher?: ManagedL1Publisher | null
  poolFinalityPublisher?: ManagedL1Publisher | null
  poolBeneficiaryPublisher?: ManagedL1Publisher | null
  /** Test-only current-zkVM room-batch capability acceptance switch. */
  roomBatchCapabilityOverride?: boolean
  /** Finalized-root-bound withdrawal witness/proof materializer. */
  withdrawals?: WithdrawalProofService | null
}

export interface AppContext {
  app: FastifyInstance
  config: ServerConfig
  /** Standalone-only convenience archive. Hosted mode has no file authority. */
  store: JsonFileStore | null
  relay: RelayNodeResult | null
  faucet: FaucetService
  /** Standalone-only observer. Hosted reads use the PostgreSQL projection. */
  observer: ObserverStore | null
  hosted: HostedRuntime | null
  close: () => Promise<void>
}

/** Origins allowed when CORS_ORIGINS is unset: same-origin + loopback dev UIs. */
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i

export async function createApp(opts: CreateAppOptions): Promise<AppContext> {
  const cfg = opts.config
  const hosted = opts.hosted ?? null
  const store = hosted ? null : (opts.store ?? new JsonFileStore(cfg.dataDir))
  const enableRelay = opts.enableRelay ?? true
  const app = Fastify({
    logger: opts.logger ?? true,
    // Forwarded headers are authority over rate-limit and audit identities.
    // Fastify therefore ignores them unless the operator names exact proxy
    // addresses/CIDRs; `true` is never used here.
    trustProxy: cfg.trustProxyCidrs.length > 0 ? cfg.trustProxyCidrs : false,
  })
  registerCorrelationHooks(app)
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/legacy/v3' || req.url.startsWith('/legacy/v3/')) {
      return reply.code(410).send({
        error: 'legacy v3 coordinator routes are permanently retired',
      })
    }
    // A standby may serve health/read views, but must not sign, drain, lease,
    // relay a write, or mutate an archive. Database fencing below the route is
    // still the final split-brain guard; this is the fail-fast outer gate.
    if (
      ((hosted && hosted.status().effectiveRole !== 'active')
        || (!hosted && cfg.coordinatorRole === 'standby')) &&
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      req.url !== '/hosting/v1/admin/promote'
    ) {
      return reply.code(503).send({
        error: 'coordinator is standby and cannot accept mutations',
        coordinatorId: cfg.coordinatorId,
      })
    }
  })
  // COOP/COEP on ALL responses (must be on root instance - not an encapsulated plugin).
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cross-Origin-Opener-Policy', 'same-origin')
    reply.header('Cross-Origin-Embedder-Policy', 'require-corp')
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin')
    return payload
  })
  // CORS allowlist (was `origin: true`, i.e. every origin reflected - which
  // made the RPC proxy and every mutating route callable from any web page).
  await app.register(cors, {
    origin: (origin, cb) => {
      // No Origin header: same-origin navigation or a non-browser client.
      if (!origin) return cb(null, true)
      if (cfg.corsOrigins.length > 0) return cb(null, cfg.corsOrigins.includes(origin))
      return cb(null, LOOPBACK_ORIGIN_RE.test(origin))
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS'],
  })

  /* ---------- quotas ---------- */

  // The faucet's real anti-abuse control is FaucetService's atomic
  // per-ADDRESS cooldown - that is what bounds how much valueless devnet ETH
  // any one recipient can pull. The per-IP bucket only stops a flood, so it
  // must still fit legitimate multi-peer use: one e2e run or Kurtosis sweep
  // funds ~20 burner addresses from a single host. A 3-token bucket rejected
  // the third peer of a normal test run.
  const faucetLimiter = new RateLimiter(cfg.faucetIpBurst, cfg.faucetIpPerSec)
  const rpcLimiter = new RateLimiter(200, 25)

  let relay: RelayNodeResult | null = null
  if (enableRelay) {
    const relayHost = cfg.bindHost.includes(':')
      ? isLoopbackHost(cfg.bindHost) ? '127.0.0.1' : '0.0.0.0'
      : cfg.bindHost === 'localhost' ? '127.0.0.1' : cfg.bindHost
    relay = await createRelayNode({
      wsPort: cfg.relayPort,
      host: relayHost,
      maxReservations: cfg.relayMaxReservations,
      maxRooms: cfg.relayMaxRooms,
      roomTtlMs: cfg.relayRoomTtlMs,
    })
  }

  const faucet = new FaucetService(cfg)
  const observer = hosted ? null : (opts.observer ?? new ObserverStore(join(cfg.dataDir, 'room-observer')))

  /* ---------- health / config ---------- */

  registerDiscoveryRoutes(app, {
    config: cfg,
    relay,
    faucet,
    admissionEnabled: opts.admission !== null && opts.admission !== undefined,
  })
  registerHostingRoutes(app, {
    config: cfg,
    runtime: hosted,
    admission: opts.admission ?? null,
    publisher: opts.publisher ?? null,
    nodeHeartbeatPublisher: opts.nodeHeartbeatPublisher ?? null,
    roomBatchPublisher: opts.roomBatchPublisher ?? null,
    roomAggregatePublisher: opts.roomAggregatePublisher ?? null,
    poolSponsorPublisher:opts.poolSponsorPublisher ?? null,
    poolFinalityPublisher:opts.poolFinalityPublisher ?? null,
    poolBeneficiaryPublisher:opts.poolBeneficiaryPublisher ?? null,
    roomBatchCapabilityOverride: opts.roomBatchCapabilityOverride,
    withdrawals: opts.withdrawals ?? null,
  })

  /* ---------- read-only room observation ---------- */

  if (observer) {
    registerObserverRoutes(app, observer)
    // This file-backed compatibility surface is deliberately standalone-only.
    registerObserverWriteRoutes(app, { store: observer, config: cfg })
  } else {
    const retired = async (_request: unknown, reply: { code(status: number): { send(body: object): unknown } }) =>
      reply.code(410).send({
        error: 'file observer routes are retired in hosted mode',
        replacement: '/hosting/v1/indexer/rooms/{roomId}',
      })
    app.all('/observer/v1/*', retired)
    app.all('/rooms/*', retired)
  }
  registerAdmissionRoutes(app, opts.admission ?? null)
  let sseCounters: SseBatchCounters | null = null
  if (opts.demo) {
    sseCounters = createSseBatchCounters()
    registerDemoRoutes(app, opts.demo, { sseCounters })
  }

  /* ---------- metrics (open, like /health; numbers only) ---------- */

  registerMetricsRoute(app, { demo: opts.demo ?? null, sse: sseCounters,hosted })

  /* ---------- shared prove queue (opt-in) ---------- */

  if (cfg.queueEnabled) {
    if (hosted) {
      registerPostgresProveQueueRoutes(app, hosted, opts.config.chainId)
    } else {
      // The file queue is an explicit local/standalone tool only. Hosted mode
      // has no file fallback if PostgreSQL or object storage is unavailable.
      registerProveQueueRoutes(app, {
        store: new ProveQueueStore(join(cfg.dataDir, 'prove-queue')),
        submitToken: cfg.queueSubmitToken ?? '',
        nodeToken: cfg.queueNodeToken ?? '',
      })
    }
  }

  /* ---------- JSON-RPC proxy ---------- */

  registerRpcProxyRoute(app, cfg, rpcLimiter)

  /* ---------- faucet ---------- */

  app.post<{ Body: { address?: string } }>('/faucet', { bodyLimit: 4096 }, async (req, reply) => {
    if (!faucetLimiter.take(req.ip)) {
      return reply.code(429).send({ error: 'rate limited' })
    }
    const address = req.body?.address
    if (!address) return reply.code(400).send({ error: 'address required' })
    const result = await faucet.drip(address as `0x${string}`)
    if (!result.ok) return reply.code(result.status).send({ error: result.error })
    return { ok: true, txHash: result.txHash }
  })

  /* ---------- artifacts + static web (or placeholder) ---------- */

  registerArtifactRoutes(app, cfg)
  await registerStaticWeb(app, cfg)

  const close = async () => {
    if (relay) {
      await relay.node.stop()
    }
    await app.close()
    await hosted?.close()
  }

  return { app, config: cfg, store, relay, faucet, observer, hosted, close }
}
