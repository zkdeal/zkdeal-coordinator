import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RelayNodeResult } from '@zkdeal/p2p/relay'
import { PROTOCOL_VERSION } from '@zkdeal/protocol'
import type { FastifyInstance } from 'fastify'
import type { ServerConfig } from './config.js'
import type { FaucetService } from './faucet.js'
import { buildCardCircuitsConfigSection } from './card-artifacts.js'

export const FRAMING =
  'unanimous client replay/signing with experimental asynchronous zkVM receipts; the pinned guest now requires derived settlement and header-RLP genesis capabilities, while full settlement validity remains pre-release pending transport/contract integration and the GPU-to-L1 gate'

/**
 * Journal version the pinned guest must declare. Mirrors `JOURNAL_VERSION` in
 * `zkvm/lock-schema.mjs`, which is the authority for the lock's shape; this
 * service only refuses to publish digests from a lock that predates it.
 */
const REQUIRED_JOURNAL_VERSION = 6

/**
 * zkVM /config section, derived from zkvm/artifacts.lock.json + files
 * actually present under zkvmArtifactsRoot. Absent lock (or no digests) →
 * null → the section is omitted and the web UI keeps zkVM backends
 * unselectable (web/lib/manifest-presets.ts zkvmProgramDigestFromConfig).
 */
function buildZkvmConfigSection(cfg: ServerConfig): Record<string, unknown> | null {
  if (!existsSync(cfg.zkvmLockPath)) return null
  let lock: {
    journalVersion?: number
    risc0?: { imageId?: string }
  }
  try {
    lock = JSON.parse(readFileSync(cfg.zkvmLockPath, 'utf8'))
  } catch {
    return null
  }
  // Never expose stale executors/receipts through the default config.
  if (lock.journalVersion !== REQUIRED_JOURNAL_VERSION) return null
  const root = cfg.zkvmArtifactsRoot
  const has = (rel: string) => existsSync(join(root, rel))
  const url = (rel: string) => `/artifacts/zkvm/${rel.replace(/\\/g, '/')}`

  const programDigests: Record<string, string> = {}
  const artifacts: Record<string, unknown> = {}

  const r0Id = lock.risc0?.imageId
  if (r0Id && /^(0x)?[0-9a-fA-F]{64}$/.test(r0Id)) {
    programDigests.risc0 = r0Id.startsWith('0x') ? r0Id.toLowerCase() : `0x${r0Id.toLowerCase()}`
  }
  if (has('risc0/verifier/r0_wasm_verifier.js') && has('risc0/verifier/r0_wasm_verifier_bg.wasm')) {
    artifacts.risc0Verifier = {
      js: url('risc0/verifier/r0_wasm_verifier.js'),
      wasm: url('risc0/verifier/r0_wasm_verifier_bg.wasm'),
    }
  }
  if (Object.keys(programDigests).length === 0) return null
  return { journalVersion: REQUIRED_JOURNAL_VERSION, programDigests, artifacts }
}

export interface DiscoveryRouteDeps {
  config: ServerConfig
  relay: RelayNodeResult | null
  faucet: FaucetService
  admissionEnabled: boolean
}

/** `/health` and `/config` discovery surface. */
export function registerDiscoveryRoutes(app: FastifyInstance, deps: DiscoveryRouteDeps): void {
  const { config: cfg, relay, faucet } = deps

  app.get('/health', async () => ({
    ok: true,
    service: '@zkdeal/server',
    protocolVersion: PROTOCOL_VERSION,
    coordinator: {
      id: cfg.coordinatorId,
      role: cfg.coordinatorRole,
    },
    framing: FRAMING,
  }))

  app.get('/config', async () => {
    const peerId = relay?.node.peerId.toString() ?? null
    const multiaddrs = relay?.multiaddrs ?? []
    const zkvm = buildZkvmConfigSection(cfg)
    const cardCircuits = buildCardCircuitsConfigSection(cfg)
    return {
      chainId: cfg.chainId,
      rpcUrl: '/rpc',
      roomManager: cfg.roomManager,
      roomPool: cfg.roomPool,
      accessToken: cfg.accessToken,
      ...(cfg.managedRoomProfile ? { managedRoomProfile: cfg.managedRoomProfile } : {}),
      admissionEnabled: deps.admissionEnabled,
      // Deployment domain clients must bind into every SignedEnvelope.
      protocolVersion: PROTOCOL_VERSION,
      relay: {
        port: cfg.relayPort,
        peerId,
        multiaddrs,
      },
      l1BlockTimeSec: cfg.l1BlockTimeSec,
      faucetEnabled: faucet.enabled,
      proofStatus: {
        proofBackedBatches: 'pre-release',
        currentProofStatement: 'guest-derived-settlement-v1',
        fullSettlementValidity: false,
        blockers: ['gpu-l1-gate'],
      },
      ...(zkvm !== null ? { zkvm } : {}),
      ...(cardCircuits !== null ? { cardCircuits } : {}),
      framing: FRAMING,
    }
  })
}
