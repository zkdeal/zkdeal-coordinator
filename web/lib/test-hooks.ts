/**
 * Minimal window.__zkdeal hooks for Playwright e2e.
 *
 * SHIPPING CONSTRAINT: this module exposes a live privileged RoomClient on
 * `window` and must never reach a production bundle. It is reachable only
 * through the flag-gated dynamic import in lib/rooms-store.tsx
 * (NEXT_PUBLIC_ENABLE_TEST_HOOKS === '1'), which the bundler inlines and
 * dead-code-eliminates otherwise. web/scripts/assert-bundle.mjs enforces that
 * invariant against the emitted output.
 *
 * There is deliberately NO private-key read-back path here. An automated peer
 * seeds its own burner key into localStorage before load, so the driver already
 * knows the key; exporting a getter would only add an exfiltration API to the
 * origin.
 */
import type { RoomDeploymentManifest } from '@zkdeal/protocol'
import type { RoomClient, RoomClientState } from './room-client'
import { isAlreadyMemberError } from './l1-errors'
import { acknowledgeManifest, isManifestAcknowledged } from './manifest-ack'
import { SCENARIO_IDS, type ScenarioKey } from './room-manager-abi'

export interface ZkdealTestApi {
  client: RoomClient
  getState: () => RoomClientState
  getAddress: () => string | null
  getLastProof: () => ReturnType<RoomClient['getLastProof']>
  connect: () => Promise<void>
  faucet: () => Promise<void>
  createRoom: (opts?: {
    scenario?: ScenarioKey
    memberTarget?: number
    depositEth?: string
    deadlineSec?: number
    challengeWindowBlocks?: number
    /** Room deployment manifest - published to POST /rooms/:id/manifest. */
    deployment?: RoomDeploymentManifest
  }) => Promise<string>
  joinRoom: (roomId: string, depositEth?: string) => Promise<void>
  attachRoom: (roomId: string) => Promise<void>
  approveGenesis: () => Promise<string>
  openRoom: () => Promise<void>
  vaultDeposit: (assetsEth: string) => Promise<void>
  vaultAccrue: (assetsEth: string) => Promise<void>
  vaultWithdraw: (assetsEth: string) => Promise<void>
  sealAndSettle: () => Promise<void>
  finalize: () => Promise<void>
  claim: () => Promise<void>
  abort: () => Promise<void>
  restoreSnapshot: () => Promise<string>
  waitFor: (
    predicate: (s: RoomClientState) => boolean,
    timeoutMs?: number,
  ) => Promise<RoomClientState>
  waitPhase: (phase: string, timeoutMs?: number) => Promise<RoomClientState>
  waitBlocks: (min: number, timeoutMs?: number) => Promise<RoomClientState>
  syncSnapshot: () => Promise<string>
  /** Manifest review state for the attached room (Playwright assertions). */
  getManifestState: () => {
    roomManifest: RoomDeploymentManifest | null
    manifestDigest: string | null
    manifestReviewRequired: boolean
    acknowledged: boolean
  }
  /** Check the review checkbox programmatically (UI gate for Approve). */
  acknowledgeManifest: () => void
  sealBlockNow: () => Promise<void>
  exportCheckpoint: () => Promise<unknown>
  signExportedCheckpoint: (exported: unknown) => Promise<unknown>
  acceptPeerAck: (ack: unknown) => Promise<void>
  debugTip: () => {
    blocks: number
    engineHeaders: number
    isSequencer: boolean
    hasSequencer: boolean
    error: string | null
    settleMessage: string
  }
}

declare global {
  interface Window {
    __zkdeal?: ZkdealTestApi
    __zkdealLastProof?: unknown
  }
}

function parseEth(s: string): bigint {
  const [whole, frac = ''] = s.split('.')
  const fracPad = (frac + '000000000000000000').slice(0, 18)
  return BigInt(whole || '0') * 10n ** 18n + BigInt(fracPad || '0')
}

export function installZkdealTestHooks(client: RoomClient): void {
  if (typeof window === 'undefined') return

  const waitFor = (
    predicate: (s: RoomClientState) => boolean,
    timeoutMs = 120_000,
  ): Promise<RoomClientState> =>
    new Promise((resolve, reject) => {
      if (predicate(client.getState())) {
        resolve(client.getState())
        return
      }
      const t = setTimeout(() => {
        unsub()
        reject(new Error(`waitFor timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      const unsub = client.subscribe((s) => {
        if (predicate(s)) {
          clearTimeout(t)
          unsub()
          resolve(s)
        }
      })
    })

  const api: ZkdealTestApi = {
    client,
    getState: () => client.getState(),
    getAddress: () => client.getState().l1Address,
    getLastProof: () => client.getLastProof(),
    connect: async () => {
      await client.connect({ preferMetaMask: false })
    },
    faucet: () => client.faucet(),
    createRoom: async (opts = {}) => {
      const depositWei = parseEth(opts.depositEth ?? '0.1')
      const deadlineSec = BigInt(
        opts.deadlineSec ?? Math.floor(Date.now() / 1000) + 3600,
      )
      const roomId = await client.createRoom({
        scenario: opts.scenario ?? 'erc4626',
        memberTarget: opts.memberTarget ?? 2,
        depositWei,
        deadlineSec,
        challengeWindowBlocks: opts.challengeWindowBlocks ?? 1,
        ...(opts.deployment ? { deployment: opts.deployment } : {}),
      })
      await client.joinRoomL1(roomId, depositWei)
      await client.attachRoom(roomId)
      return roomId.toString()
    },
    joinRoom: async (roomId, depositEth = '0.1') => {
      if (roomId === undefined || roomId === null || roomId === '') {
        throw new Error('joinRoom: roomId required')
      }
      const id = BigInt(String(roomId))
      const depositWei = parseEth(depositEth)
      try {
        await client.joinRoomL1(id, depositWei)
      } catch (e) {
        // Only AlreadyMember() is idempotent; everything else (wrong deposit,
        // room full, deadline, RPC) must fail the test loudly.
        if (!isAlreadyMemberError(e)) throw e
      }
      await client.attachRoom(id)
    },
    attachRoom: async (roomId) => {
      await client.attachRoom(BigInt(roomId))
    },
    approveGenesis: async () => client.loadAndApproveGenesis(),
    openRoom: () => client.openRoom(),
    vaultDeposit: async (assetsEth) => {
      const vault = client.vaultAddress()
      if (!vault) throw new Error('no vault in genesis')
      await client.vaultDeposit(parseEth(assetsEth), vault)
    },
    vaultAccrue: async (assetsEth) => {
      const vault = client.vaultAddress()
      if (!vault) throw new Error('no vault in genesis')
      await client.vaultAccrueYield(vault, parseEth(assetsEth))
    },
    vaultWithdraw: async (assetsEth) => {
      const vault = client.vaultAddress()
      if (!vault) throw new Error('no vault in genesis')
      await client.vaultWithdraw(parseEth(assetsEth), vault)
    },
    sealAndSettle: () => client.sealAndSettle(),
    finalize: () => client.finalizeRoom(),
    claim: () => client.claim(),
    abort: () => client.abortRoom(),
    restoreSnapshot: async () => {
      const { warning } = await client.restoreFromCoordinator()
      return warning
    },
    waitFor,
    waitPhase: (phase, timeoutMs) => waitFor((s) => s.settlePhase === phase, timeoutMs),
    waitBlocks: (min, timeoutMs) => waitFor((s) => s.blocks.length >= min, timeoutMs),
    /** Pull coordinator snapshot into this peer (catch-up when gossip lags). */
    syncSnapshot: async () => {
      const { warning } = await client.restoreFromCoordinator()
      return warning
    },
    getManifestState: () => {
      const s = client.getState()
      return {
        roomManifest: s.roomManifest ?? null,
        manifestDigest: s.manifestDigest ?? null,
        manifestReviewRequired: !!s.manifestReviewRequired,
        acknowledged: isManifestAcknowledged(s.roomId),
      }
    },
    acknowledgeManifest: () => {
      const id = client.getState().roomId
      if (!id) throw new Error('acknowledgeManifest: no room attached')
      acknowledgeManifest(id)
    },
    sealBlockNow: async () => {
      const ok = await client.ensureSequencer()
      if (!ok) throw new Error('ensureSequencer failed')
      const seq = (client as unknown as { sequencer?: { sealBlockNow: () => Promise<unknown> } | null })
        .sequencer
      if (!seq) throw new Error('no sequencer handle')
      await seq.sealBlockNow()
    },
    exportCheckpoint: () => client.exportCheckpoint(),
    signExportedCheckpoint: (exported) =>
      client.signExportedCheckpoint(exported as Parameters<RoomClient['signExportedCheckpoint']>[0]),
    acceptPeerAck: (ack) => client.acceptPeerAck(ack as Parameters<RoomClient['acceptPeerAck']>[0]),
    debugTip: () => {
      const s = client.getState()
      const seq = (client as unknown as { sequencer?: unknown }).sequencer
      const engine = (client as unknown as { engine?: { getHeaders: () => unknown[] } | null }).engine
      return {
        blocks: s.blocks.length,
        engineHeaders: engine?.getHeaders().length ?? -1,
        isSequencer: s.isSequencer,
        hasSequencer: !!seq,
        error: s.error,
        settleMessage: s.settleMessage,
      }
    },
  }

  window.__zkdeal = api
  // Keep scenario constant visible for debugging
  void SCENARIO_IDS
}
