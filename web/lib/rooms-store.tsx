'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { RoomDeploymentManifest } from '@zkdeal/protocol'
import { keccak256, parseEther } from 'viem'
import { fetchRooms, fetchHealth, type CoordinatorConfig } from './coordinator'
import { isAlreadyMemberError } from './l1-errors'
import { assertAttachedRoom, isAttachedToRoom } from './room-scope'
import { getSharedRoomClient, type RoomClient, type RoomClientState } from './room-client'
import type { ScenarioKey } from './room-manager-abi'
// Registry → Room mapping lives next door; this file owns the context and the
// L1 actions.
import { mergeLive, registryToRoom } from './rooms-registry-map'
import type { LiquidityPosition, Peer, Room, RoomSettings } from './types'

/**
 * Largest member target the UI offers (`components/create-room-dialog.tsx`
 * caps its input at the same value, and `room/settings-panel.tsx` labels it).
 * It is an immutable L1 room parameter, so an out-of-range value is rejected
 * rather than clamped.
 */
export const MAX_MEMBER_TARGET = 4

export interface CreateRoomInput {
  name: string
  description: string
  /** Preset key (scenario byte 0/1/2) or 'custom' (255) for modified manifests. */
  scenario: Room['scenario'] | 'custom'
  /**
   * Room deployment manifest. Always sent (presets included) so the manifest
   * digest anchored into genesis is verified end-to-end; RoomClient.createRoom
   * publishes it to POST /rooms/:id/manifest for joiner review.
   */
  deployment?: RoomDeploymentManifest
  settings: RoomSettings
  operator: string
  /** Join immediately after create with deposit. */
  autoJoin?: boolean
}

interface Store {
  rooms: Room[]
  activeRooms: Room[]
  pastRooms: Room[]
  onlineCount: number
  myPeerId: string
  joinedRoomId: string | null
  coordinatorOk: boolean | null
  coordinatorError: string | null
  config: CoordinatorConfig | null
  client: RoomClient
  clientState: RoomClientState
  getRoom: (id: string) => Room | undefined
  peersFor: (id: string) => Peer[]
  refreshRooms: () => Promise<void>
  createRoom: (input: CreateRoomInput) => Promise<string>
  joinRoom: (id: string) => Promise<void>
  leaveRoom: (id: string) => Promise<void>
  sealRoom: (id: string) => Promise<void>
  finalizeRoom: (id: string) => Promise<void>
  claimRoom: (id: string) => Promise<void>
  abortRoom: (id: string) => Promise<void>
  approveGenesis: (id: string) => Promise<void>
  openRoom: (id: string) => Promise<void>
  restoreSnapshot: (id: string) => Promise<string>
  /**
   * Submit a real L2 transaction to the EXACT room `id`.
   * `signature` is the canonical ABI signature (`transfer(address,uint256)`)
   * and `argsData` the already ABI-encoded argument tuple. Resolves with the
   * transaction hash of the signed raw tx; REJECTS on any failure (never
   * reports success for a call that did not go through).
   */
  submitCall: (id: string, contract: string, signature: string, argsData: Uint8Array) => Promise<string>
  addLiquidity: (id: string, pos: LiquidityPosition) => void
  /** True when the shared client is attached to exactly this room. */
  isAttachedTo: (id: string) => boolean
}

const RoomsContext = createContext<Store | null>(null)

export function RoomsProvider({ children }: { children: React.ReactNode }) {
  const client = useMemo(() => getSharedRoomClient(), [])
  const [rooms, setRooms] = useState<Room[]>([])
  const [joinedRoomId, setJoinedRoomId] = useState<string | null>(null)
  const [coordinatorOk, setCoordinatorOk] = useState<boolean | null>(null)
  const [coordinatorError, setCoordinatorError] = useState<string | null>(null)
  const [config, setConfig] = useState<CoordinatorConfig | null>(null)
  const [clientState, setClientState] = useState<RoomClientState>(client.getState())
  const namesRef = useRef<Record<string, { name: string; description: string }>>({})

  useEffect(
    () =>
      client.subscribe((s) => {
        setClientState(s)
        // The shared client is the authority on attachment. If it disconnects
        // or detaches (Disconnect, destroy, detachRoom), drop the joined
        // marker immediately so no room-scoped control stays enabled against
        // a client that is no longer there.
        if (!s.connected || s.roomId === null) setJoinedRoomId(null)
      }),
    [client],
  )

  useEffect(() => {
    // window.__zkdeal is a live privileged client (raw RoomClient, L1
    // lifecycle, checkpoint signing). It exists ONLY in explicitly flagged
    // e2e builds. __ZKDEAL_TEST_HOOKS__ is a DefinePlugin literal (see
    // next.config.mjs) derived from NEXT_PUBLIC_ENABLE_TEST_HOOKS, so this
    // branch is constant-folded and the dynamic import below - with the whole
    // test-hook module graph - is dropped from the bundle. A plain runtime
    // `if` would still ship the module. The import() MUST sit inside the
    // positive branch: webpack only prunes a whole `if` block, so an early
    // `if (!flag) return` leaves the import reachable and the chunk emitted.
    // The `typeof` guard keeps the bare global safe under a bundler that does
    // not define it (Turbopack has no DefinePlugin equivalent): an undefined
    // constant means hooks off, not a ReferenceError at mount. DefinePlugin
    // still folds the identifier, so webpack drops the branch as before.
    if (typeof __ZKDEAL_TEST_HOOKS__ !== 'undefined' && __ZKDEAL_TEST_HOOKS__) {
      let cancelled = false
      void import('./test-hooks').then((m) => {
        if (!cancelled) m.installZkdealTestHooks(client)
      })
      return () => {
        cancelled = true
      }
    }
    return undefined
  }, [client])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        await client.connect({ preferMetaMask: false })
        if (cancelled) return
        setConfig(client.getState().config)
        const health = await fetchHealth()
        setCoordinatorOk(health.ok)
      } catch (e) {
        if (!cancelled) {
          setCoordinatorOk(false)
          setCoordinatorError((e as Error).message)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client])

  const refreshRooms = useCallback(async () => {
    try {
      const entries = await fetchRooms()
      setCoordinatorOk(true)
      setCoordinatorError(null)
      setRooms((prev) => {
        const mapped = entries.map((e) => {
          const base = registryToRoom(e)
          const meta = namesRef.current[base.id]
          if (meta) {
            // Name/description are NOT part of the canonical room record: they
            // live in this tab's memory only. Flag them so the UI can say so
            // instead of implying other members see the same label.
            base.name = meta.name
            base.description = meta.description
            base.nameIsLocalAlias = true
          }
          const old = prev.find((p) => p.id === base.id)
          return old ? { ...base, blocks: old.blocks, contracts: old.contracts.length ? old.contracts : base.contracts } : base
        })
        return mapped
      })
    } catch (e) {
      setCoordinatorOk(false)
      setCoordinatorError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void refreshRooms()
    const t = setInterval(() => void refreshRooms(), 8_000)
    return () => clearInterval(t)
  }, [refreshRooms])

  // Merge live client state into the joined room
  const roomsLive = useMemo(() => {
    return rooms.map((r) => mergeLive(r, clientState))
  }, [rooms, clientState])

  const getRoom = useCallback(
    (id: string) => roomsLive.find((r) => r.id === id),
    [roomsLive],
  )

  const peersFor = useCallback(
    (id: string) => getRoom(id)?.peers ?? [],
    [getRoom],
  )

  const createRoom = useCallback(
    async (input: CreateRoomInput) => {
      if (!client.getState().connected) {
        await client.connect({ preferMetaMask: false })
      }
      const depositWei = parseEther(input.settings.depositEth || '0.1')
      const deadlineSec = BigInt(
        input.settings.deadlineSec || Math.floor(Date.now() / 1000) + 3600,
      )
      // These become immutable L1 room parameters - never default them, and
      // never silently coerce them: a caller asking for 8 members used to get
      // a room permanently capped at 4 with no error.
      const { challengeWindowBlocks, memberTarget } = input.settings
      if (challengeWindowBlocks == null || challengeWindowBlocks < 1) {
        throw new Error('createRoom: challengeWindowBlocks must be a positive number')
      }
      if (!Number.isInteger(memberTarget) || memberTarget < 1 || memberTarget > MAX_MEMBER_TARGET) {
        throw new Error(
          `createRoom: memberTarget must be an integer between 1 and ${MAX_MEMBER_TARGET}`,
        )
      }
      const roomId = await client.createRoom({
        scenario: input.scenario as ScenarioKey,
        memberTarget,
        depositWei,
        deadlineSec,
        challengeWindowBlocks,
        ...(input.deployment ? { deployment: input.deployment } : {}),
      })
      const id = roomId.toString()
      namesRef.current[id] = { name: input.name, description: input.description }
      if (input.autoJoin !== false) {
        await client.joinRoomL1(roomId, depositWei)
        await client.attachRoom(roomId)
        // Only claim "joined" once the client actually holds this room.
        if (client.getState().roomId !== id) {
          throw new Error(`attach failed: client is on ${client.getState().roomId ?? 'no room'}`)
        }
        setJoinedRoomId(id)
      }
      await refreshRooms()
      return id
    },
    [client, refreshRooms],
  )

  const joinRoom = useCallback(
    async (id: string) => {
      const room = getRoom(id)
      // depositWei is an immutable L1 room parameter. Defaulting it escrowed a
      // hard-coded 0.1 ETH into a room whose deposit, member cap, deadline and
      // challenge window the user had never seen - a crafted /room?id=<other>
      // link was one click from an unintended escrow. A room the registry has
      // not published carries no deposit to honour.
      if (room?.depositWei === undefined) {
        throw new Error(
          `joinRoom: channel ${id} is not in the coordinator registry, so its L1 deposit is unknown - refresh the registry before joining`,
        )
      }
      const depositWei = BigInt(room.depositWei)
      const roomId = BigInt(id)
      if (!client.getState().connected) {
        await client.connect({ preferMetaMask: false })
      }
      // Join on L1 if not already a member. ONLY AlreadyMember() is
      // idempotent - wrong deposit, room full, passed deadline, wrong state,
      // rejected signature and RPC failures must reach the user instead of
      // being laundered into "joined". Never set joinedRoomId on failure.
      try {
        await client.joinRoomL1(roomId, depositWei)
      } catch (e) {
        if (!isAlreadyMemberError(e)) throw e
      }
      await client.attachRoom(roomId)
      // attachRoom sets the client's own roomId; require that before this
      // browser presents itself as joined.
      if (client.getState().roomId !== id) {
        throw new Error(`attach failed: client is on ${client.getState().roomId ?? 'no room'}`)
      }
      setJoinedRoomId(id)
    },
    [client, getRoom],
  )

  const leaveRoom = useCallback(
    async (id: string) => {
      if (joinedRoomId === id) {
        await client.detachRoom()
        setJoinedRoomId(null)
      }
    },
    [client, joinedRoomId],
  )

  /**
   * Fail closed before any room-scoped client call. RoomClient methods act on
   * `this.roomId`, so an action requested for room B while room A is attached
   * would silently mutate A (abort / open / approve are irreversible L1
   * lifecycle changes). Requires BOTH the store's joined marker and the
   * client's own attachment to equal `id`; never silently re-attaches.
   */
  const requireAttachedRoom = useCallback(
    (id: string) => assertAttachedRoom(id, joinedRoomId, client.getState().roomId),
    [client, joinedRoomId],
  )

  const isAttachedTo = useCallback(
    (id: string) => isAttachedToRoom(id, joinedRoomId, clientState.roomId),
    [clientState.roomId, joinedRoomId],
  )

  const sealRoom = useCallback(
    async (id: string) => {
      requireAttachedRoom(id)
      await client.sealAndSettle()
      await refreshRooms()
    },
    [client, refreshRooms, requireAttachedRoom],
  )

  const finalizeRoom = useCallback(
    async (id: string) => {
      requireAttachedRoom(id)
      await client.finalizeRoom()
      await refreshRooms()
    },
    [client, refreshRooms, requireAttachedRoom],
  )

  const claimRoom = useCallback(
    async (id: string) => {
      requireAttachedRoom(id)
      await client.claim()
      await refreshRooms()
    },
    [client, refreshRooms, requireAttachedRoom],
  )

  const abortRoom = useCallback(
    async (id: string) => {
      requireAttachedRoom(id)
      await client.abortRoom()
      await refreshRooms()
    },
    [client, refreshRooms, requireAttachedRoom],
  )

  const approveGenesis = useCallback(
    async (id: string) => {
      requireAttachedRoom(id)
      await client.loadAndApproveGenesis()
    },
    [client, requireAttachedRoom],
  )

  const openRoom = useCallback(
    async (id: string) => {
      requireAttachedRoom(id)
      await client.openRoom()
      await refreshRooms()
    },
    [client, refreshRooms, requireAttachedRoom],
  )

  const restoreSnapshot = useCallback(
    async (id: string) => {
      requireAttachedRoom(id)
      const { warning } = await client.restoreFromCoordinator()
      return warning
    },
    [client, requireAttachedRoom],
  )

  const submitCall = useCallback(
    async (id: string, contract: string, signature: string, argsData: Uint8Array) => {
      requireAttachedRoom(id)
      // callL2 concatenates the caller's byte chunks after the selector, so a
      // single fully ABI-encoded argument tuple is the correct payload. The
      // selector comes from the FULL signature (previously hard-coded to
      // `fn()`, which produced the wrong selector for every function with
      // parameters). Errors propagate: a reverted or unsent call must never
      // be presented as a success.
      const rawTx = (await client.callL2(contract as `0x${string}`, signature, [
        argsData,
      ])) as `0x${string}`
      // The signed raw transaction's keccak IS its L2 transaction hash.
      return keccak256(rawTx)
    },
    [client, requireAttachedRoom],
  )

  const addLiquidity = useCallback((_id: string, _pos: LiquidityPosition) => {
    // Liquidity is L1 escrow - deposits happen via joinRoom, not a side path.
  }, [])

  const activeRooms = useMemo(
    () =>
      roomsLive.filter((r) =>
        ['created', 'open', 'live', 'challenge'].includes(r.status),
      ),
    [roomsLive],
  )
  const pastRooms = useMemo(
    () =>
      roomsLive
        .filter((r) => ['settled', 'sealed', 'finalized', 'aborted'].includes(r.status))
        .sort((a, b) => (b.sealedAt ?? 0) - (a.sealedAt ?? 0)),
    [roomsLive],
  )

  const onlineCount = clientState.peers.length || (coordinatorOk ? 1 : 0)
  const myPeerId = clientState.l1Address ?? 'offline'

  const value: Store = {
    rooms: roomsLive,
    activeRooms,
    pastRooms,
    onlineCount,
    myPeerId,
    joinedRoomId,
    coordinatorOk,
    coordinatorError,
    config,
    client,
    clientState,
    getRoom,
    peersFor,
    refreshRooms,
    createRoom,
    joinRoom,
    leaveRoom,
    sealRoom,
    finalizeRoom,
    claimRoom,
    abortRoom,
    approveGenesis,
    openRoom,
    restoreSnapshot,
    submitCall,
    addLiquidity,
    isAttachedTo,
  }

  return <RoomsContext.Provider value={value}>{children}</RoomsContext.Provider>
}

export function useRooms() {
  const ctx = useContext(RoomsContext)
  if (!ctx) throw new Error('useRooms must be used within RoomsProvider')
  return ctx
}
