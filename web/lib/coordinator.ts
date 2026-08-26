/**
 * Coordinator REST client (PROTOCOL.md §11) - browser wrapper around the
 * shared CoordinatorClient (@zkdeal/room-client).
 * Base URL: NEXT_PUBLIC_COORDINATOR_URL or '' (same-origin when served by
 * coordinator). The relay multiaddr rewrite uses window.location.hostname,
 * as before. Every previously exported function keeps its name and shape.
 */

import { CoordinatorClient } from '@zkdeal/room-client'
import type {
  GenesisResponse,
  RoomDeploymentManifest,
  RoomRegistryEntry,
  SnapshotPayload,
} from '@zkdeal/protocol'

export type { CoordinatorConfig, ContractsManifest } from '@zkdeal/room-client'

export function coordinatorBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_COORDINATOR_URL
  if (raw === undefined || raw === null) return ''
  return String(raw).replace(/\/$/, '')
}

let defaultClient: CoordinatorClient | null = null

function client(): CoordinatorClient {
  if (!defaultClient) {
    defaultClient = new CoordinatorClient({
      baseUrl: coordinatorBaseUrl(),
      relayHost:
        typeof window !== 'undefined' && window.location.hostname
          ? window.location.hostname
          : undefined,
    })
  }
  return defaultClient
}

export function coordinatorUrl(path: string): string {
  return client().url(path)
}

export function fetchHealth(): Promise<{ ok: boolean; [key: string]: unknown }> {
  return client().fetchHealth()
}

export function fetchConfig() {
  return client().fetchConfig()
}

export function fetchRooms(): Promise<RoomRegistryEntry[]> {
  return client().fetchRooms()
}

// Resolves null on an explicit 404 only ("no genesis published yet"), matching
// fetchManifest below; every other failure throws out of the shared client.
export function fetchGenesis(roomId: string | bigint): Promise<GenesisResponse | null> {
  return client().fetchGenesis(roomId)
}

export function postGenesis(
  roomId: string | bigint,
  body: {
    scenario: number | string
    members: Array<{ address: string; depositWei: string }>
    manifest?: RoomDeploymentManifest
  },
): Promise<GenesisResponse> {
  return client().postGenesis(roomId, body)
}

export function fetchManifest(
  roomId: string | bigint,
): Promise<{ manifest: RoomDeploymentManifest; manifestDigest: string } | null> {
  return client().fetchManifest(roomId)
}

export function postManifest(
  roomId: string | bigint,
  manifest: RoomDeploymentManifest,
): Promise<{ manifestDigest: string }> {
  return client().postManifest(roomId, manifest)
}

export function fetchSnapshot(roomId: string | bigint): Promise<SnapshotPayload> {
  return client().fetchSnapshot(roomId)
}

export function putSnapshot(roomId: string | bigint, payload: SnapshotPayload): Promise<void> {
  return client().putSnapshot(roomId, payload)
}

export function postRoomBus(roomId: string | bigint, msg: unknown): Promise<void> {
  return client().postRoomBus(roomId, msg)
}

export function pollRoomBus(
  roomId: string | bigint,
  after: number,
): Promise<{ after: number; messages: Array<{ seq: number; msg: unknown }> }> {
  return client().pollRoomBus(roomId, after)
}

export function requestFaucet(address: string): Promise<{ ok: boolean; txHash?: string }> {
  return client().requestFaucet(address)
}

export function fetchContractsManifest() {
  return client().fetchContractsManifest()
}
