/**
 * Browser wiring for the shared RoomClient (@zkdeal/room-client).
 *
 * The platform-neutral client (packages/room-client) composes the p2p
 * RoomChannel + CheckpointCollector, l2-engine startSequencer /
 * electSequencer, prover buildWitnessInput / formatForSolidity, and the L1
 * lifecycle (approveGenesis, submitCheckpoint, finalize, claim, abort,
 * restoreFromCoordinator). This module only provides the browser adapters:
 * webpack-bundled prover worker (with singleThread main-thread fallback),
 * localStorage key store, window.ethereum EIP-1193 provider, and
 * createBrowserNode - then re-exports the shared surface unchanged.
 */

import {
  CoordinatorClient,
  RoomClient,
  type Eip1193Provider,
  type ProveArtifactRefs,
  type KeyStore,
  type RoomClientDeps,
  type SettlementProveResult,
  type SettlementProver,
} from '@zkdeal/room-client'
import { createBrowserNode } from '@zkdeal/p2p'
import type { Groth16Proof, PublicSignals } from '@zkdeal/prover'
import { ZkvmHostManager } from '@zkdeal/zkvm/register-browser'
import { coordinatorBaseUrl } from './coordinator'
import { burnerAccount, loadOrCreateBurnerPrivateKey, loadOrCreateEddsaSeed } from './keys'

export {
  RoomClient,
  type RoomClientDeps,
  type RoomClientOptions,
  type RoomClientState,
  type RoomBlockView,
  type SettlePhase,
  type RoomClientEvent,
  type SettlementProver,
} from '@zkdeal/room-client'
export { burnerAccount }

/** Browser key material: localStorage burner ECDSA + EdDSA seed. */
export class BrowserKeyStore implements KeyStore {
  getBurnerPrivateKey() {
    return loadOrCreateBurnerPrivateKey()
  }
  getEddsaSeed() {
    return loadOrCreateEddsaSeed()
  }
}

function proveInWorker(
  input: Record<string, unknown>,
  wasmUrl: string,
  zkeyUrl: string,
): Promise<SettlementProveResult> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('@zkdeal/prover/worker', import.meta.url), {
        type: 'module',
      })
    } catch (e) {
      reject(e)
      return
    }
    const singleThread = typeof SharedArrayBuffer === 'undefined'
    const id = Math.random().toString(36).slice(2)
    const timer = setTimeout(() => {
      worker.terminate()
      reject(new Error('prover worker timeout'))
    }, 180_000)
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data
      if (!msg || msg.id !== id) return
      if (msg.type === 'result') {
        clearTimeout(timer)
        worker.terminate()
        resolve({
          proof: msg.proof,
          publicSignals: msg.publicSignals,
          elapsedMs: msg.elapsedMs,
          singleThread,
        })
      } else if (msg.type === 'error') {
        clearTimeout(timer)
        worker.terminate()
        reject(new Error(msg.message))
      }
    }
    worker.onerror = (err) => {
      clearTimeout(timer)
      worker.terminate()
      reject(err)
    }
    worker.postMessage({
      type: 'prove',
      id,
      input,
      artifacts: { wasmUrl, zkeyUrl },
      options: { singleThread },
    })
  })
}

/**
 * Browser settlement prover: web-worker prove (webpack bundles the worker URL
 * here, inside web/lib), falling back to a main-thread singleThread prove -
 * mirroring the pre-extraction RoomClient.proveSettlement behavior exactly.
 */
export const browserProver: SettlementProver = {
  async prove(
    input: Record<string, unknown>,
    artifacts: ProveArtifactRefs,
  ): Promise<SettlementProveResult> {
    const wasmUrl = artifacts.wasmUrl!
    const zkeyUrl = artifacts.zkeyUrl!
    try {
      return await proveInWorker(input, wasmUrl, zkeyUrl)
    } catch {
      const { loadArtifacts, prove } = await import('@zkdeal/prover')
      const loaded = await loadArtifacts({ wasmUrl, zkeyUrl })
      const result = (await prove(
        input as unknown as Parameters<typeof prove>[0],
        loaded,
        { singleThread: true },
      )) as { proof: Groth16Proof; publicSignals: PublicSignals }
      return { ...result, singleThread: true }
    }
  },
}

/** Singleton helpers for the portal session. */
let shared: RoomClient | null = null
let sharedZkvm: ZkvmHostManager | null = null

/**
 * Flatten the /config `zkvm.artifacts` section into the backend artifact
 * record (absolute coordinator URLs).
 */
function flattenZkvmArtifacts(zkvm: unknown, base: string): Record<string, string> {
  const out: Record<string, string> = {}
  const z = (zkvm ?? {}) as {
    artifacts?: {
      stfWasm?: { js?: string; wasm?: string }
      risc0Verifier?: { js?: string; wasm?: string }
      ligetron?: { proverJs?: string; proverWasm?: string; proverData?: string; guestWasm?: string }
    }
  }
  const abs = (p?: string) => (p ? (p.startsWith('http') ? p : `${base}${p}`) : undefined)
  const a = z.artifacts ?? {}
  const put = (key: string, value?: string) => {
    if (value) out[key] = value
  }
  put('stfWasmJs', abs(a.stfWasm?.js))
  put('stfWasmWasm', abs(a.stfWasm?.wasm))
  put('r0VerifierJs', abs(a.risc0Verifier?.js))
  put('r0VerifierWasm', abs(a.risc0Verifier?.wasm))
  put('ligetronProverJs', abs(a.ligetron?.proverJs))
  put('ligetronProverWasm', abs(a.ligetron?.proverWasm))
  put('ligetronProverData', abs(a.ligetron?.proverData))
  put('ligetronGuest', abs(a.ligetron?.guestWasm))
  return out
}

/** zkVM execution-validity manager (multi-room; UI polls getRoomViews). */
export function getSharedZkvmManager(): ZkvmHostManager {
  if (!sharedZkvm) {
    sharedZkvm = new ZkvmHostManager({
      member: '0x0000000000000000000000000000000000000000',
      onEvent: (e) => {
        if (typeof window !== 'undefined' && e.type === 'divergence') {
          console.warn('[zkdeal/zkvm] divergence', e)
        }
      },
    })
  }
  return sharedZkvm
}

/**
 * Authoritative disconnect for the whole session.
 *
 * "Disconnect" previously cleared two React fields while the shared client
 * kept its signer, libp2p node, attached room and sequencer - a burner could
 * carry on signing L2 blocks after the UI said disconnected. This tears the
 * client down (detach room, stop node, dispose prover) and emits
 * `connected: false`, which every subscriber (RoomsProvider) uses to drop its
 * joined-room state, so no room-scoped control stays enabled.
 *
 * It does NOT erase the persisted burner key - that is a separate, explicitly
 * confirmed destructive action (`forgetBurnerIdentity`).
 */
export async function disconnectSharedRoomClient(): Promise<void> {
  if (!shared) return
  await shared.destroy()
}

export function getSharedRoomClient(): RoomClient {
  if (!shared) {
    const relayHost =
      typeof window !== 'undefined' && window.location.hostname
        ? window.location.hostname
        : undefined
    const zkvm = getSharedZkvmManager()
    const deps: RoomClientDeps = {
      coordinator: new CoordinatorClient({ baseUrl: coordinatorBaseUrl(), relayHost }),
      keys: new BrowserKeyStore(),
      createP2PNode: (opts) => createBrowserNode(opts),
      prover: browserProver,
      zkvm,
      // The browser console is the wallet-driven demo plane: direct L1 writes
      // are permitted only against a loopback dev RPC, and the hosted
      // read-only mode rejects injected wallets outright.
      l1WriteMode: 'direct-standalone-loopback-dev',
      // Getter: resolve window.ethereum at connect() time, exactly as before.
      get eip1193(): Eip1193Provider | undefined {
        return typeof window !== 'undefined'
          ? (window.ethereum as Eip1193Provider | undefined)
          : undefined
      },
      onProof: (p) => {
        // Diagnostic mirror for e2e proof assertions. Gated by the same
        // build-time flag as window.__zkdeal so shipped bundles carry no
        // zkdeal globals at all (web/scripts/assert-bundle.mjs).
        if (__ZKDEAL_TEST_HOOKS__ && typeof window !== 'undefined') {
          ;(window as unknown as { __zkdealLastProof?: unknown }).__zkdealLastProof = p
        }
      },
    }
    shared = new RoomClient(deps)
    // Synchronous state mirror → zkVM manager: this subscription fires on the
    // same emit that surfaces roomManifest (attach → ensureRoomManifest →
    // bootEngine → onGenesis), so the room policy is registered BEFORE the
    // engine boots and the genesis reaches the manager. No React timing in
    // the loop.
    shared.subscribe((s) => {
      if (s.l1Address) zkvm.setMember(s.l1Address)
      const zkvmConfig = (s.config as { zkvm?: unknown } | null)?.zkvm
      if (zkvmConfig) zkvm.setArtifacts(flattenZkvmArtifacts(zkvmConfig, coordinatorBaseUrl()))
      if (s.roomId && s.roomManifest?.zkvm) {
        zkvm.setRoomPolicy(s.roomId, s.roomManifest.zkvm)
        shared!.setZkvmRequireReceipts(s.roomManifest.zkvm.settle === 'require-receipts')
      }
    })
  }
  return shared
}
