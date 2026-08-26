/**
 * Registry → Room mapping for the rooms store.
 *
 * `registryToRoom` turns one coordinator registry entry into the UI's Room
 * record; `mergeLive` folds the attached client's live state over it. Split
 * out of `lib/rooms-store.tsx` unchanged so the store file carries the React
 * context and the L1 actions. Pure functions - no React, no client.
 */

import type { RoomRegistryEntry } from '@zkdeal/protocol'
import type { RoomClientState } from './room-client'
import type { ContractDef, LiquidityPosition, Peer, Room } from './types'

function mapStatus(entry: RoomRegistryEntry): Room['status'] {
  const s = (entry.status ?? '').toLowerCase()
  if (s === 'open' || s === 'live' || s === 'funded') return s === 'funded' ? 'created' : 'live'
  if (s === 'settled' || s === 'finalized') return 'settled'
  if (s === 'aborted') return 'aborted'
  if (s === 'challenge') return 'challenge'
  if (s === 'sealed') return 'sealed'
  return 'created'
}

function scenarioFromEntry(entry: RoomRegistryEntry): Room['scenario'] {
  const id = (entry.scenarioId ?? '').toLowerCase()
  if (id === 'dvp' || id === '2') return 'dvp'
  if (id === 'erc4626' || id === '1') return 'erc4626'
  return 'generic'
}

/** Registry values are untyped JSON; only accept a plausible positive integer. */
function optionalPositiveInt(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isInteger(n) && n >= 0 ? n : undefined
}

export function registryToRoom(entry: RoomRegistryEntry): Room {
  const depositWei = entry.depositWei ?? '0'
  let depositEth = '0'
  try {
    depositEth = (Number(BigInt(depositWei)) / 1e18).toString()
  } catch {
    depositEth = '0.1'
  }
  const status = mapStatus(entry)
  const memberCount = entry.members?.length ?? 0
  // Escrow is per-member deposit × joined members. Computed in BigInt: the
  // previous code reported ONE deposit as the room total.
  let totalEscrowWei = '0'
  try {
    totalEscrowWei = (BigInt(depositWei) * BigInt(memberCount)).toString()
  } catch {
    totalEscrowWei = '0'
  }
  return {
    id: entry.roomId,
    name: `Deal channel #${entry.roomId}`,
    description:
      entry.scenarioId
        ? `Scenario ${entry.scenarioId} · permissioned deal channel with unanimous verification.`
        : 'Permissioned deal channel with proof-verified L1 settlement.',
    scenario: scenarioFromEntry(entry),
    status,
    createdAt: entry.updatedAtMs ?? Date.now(),
    sealedAt: status === 'settled' || status === 'aborted' ? entry.updatedAtMs : undefined,
    // The registry does not publish the L1 creator. The first member is the
    // FIFO sequencer by join order, which is not the same fact - never label
    // it "creator" from this source.
    operator: entry.members?.[0]?.l1Address ?? null,
    settings: {
      blockTimeMs: entry.blockTimeMs ?? 500,
      memberTarget: entry.memberCap ?? 4,
      depositEth,
      deadlineSec: entry.deadlineSec ? Number(entry.deadlineSec) : undefined,
      // Published by the coordinator from the RoomCreated event; `undefined`
      // renders as "unknown" rather than a fabricated default of 2.
      challengeWindowBlocks: optionalPositiveInt(entry.challengeWindowBlocks),
      proofSystem: 'Groth16',
      daLayer: 'Calldata',
      // Only the attached client knows the settlement chain (mergeLive fills
      // it in); the registry does not carry it.
      settlementChainId: undefined,
      sequencerPolicy: 'fifo-join-order',
    },
    peers: (entry.members ?? []).map((m, i) => ({
      id: m.l1Address,
      address: m.l1Address,
      role: i === 0 ? 'sequencer' : 'member',
      latencyMs: 0,
      joinedAt: Date.now(),
    })),
    blocks: [],
    liquidity:
      totalEscrowWei !== '0'
        ? [
            {
              token: 'Ether',
              symbol: 'ETH',
              amount: Number(BigInt(totalEscrowWei)) / 1e18,
              provider: 'escrow',
            },
          ]
        : [],
    contracts: [],
    batchesSubmitted: entry.lastSeq && entry.lastSeq !== '0' ? 1 : 0,
    depositWei,
    totalEscrowWei,
    peersOnline: entry.peersOnline,
  }
}

export function mergeLive(room: Room, cs: RoomClientState): Room {
  if (cs.roomId !== room.id) return room
  const peers: Peer[] = cs.peers.map((p) => ({
    id: p.peerId || p.member,
    address: p.l1Address || p.member,
    role: p.role === 'sequencer' ? 'sequencer' : 'member',
    latencyMs: 0,
    joinedAt: p.lastSeenMs,
    self: p.member === cs.l1Address,
  }))
  const blocks = cs.blocks.map((b) => ({
    height: b.height,
    hash: b.hash,
    txCount: b.txCount,
    gasUsed: 0,
    proposer: b.proposer,
    timestamp: b.timestamp,
    proof: b.proof === 'acked' ? ('acked' as const) : b.proof === 'settled' ? ('settled' as const) : ('pending' as const),
    acks: b.acks,
    ackTarget: b.ackTarget,
  }))
  let status: Room['status'] = room.status
  if (cs.roomState === 2) status = 'live'
  if (cs.settlePhase === 'challenge') status = 'challenge'
  if (cs.roomState === 3) status = 'finalized'
  if (cs.roomState === 4) status = 'aborted'
  if (cs.settlePhase === 'claimed') status = 'settled'

  const contracts: ContractDef[] = cs.contracts.map((c) => ({
    address: c.address,
    name: c.name,
    kind: (c.kind as ContractDef['kind']) || 'Custom',
    standard: c.kind,
    abi: normalizeAbi(c.abi),
  }))

  const depositEth = Number(cs.depositWei) / 1e18
  const liquidity: LiquidityPosition[] =
    cs.totalEscrow > 0n
      ? [
          {
            token: 'Ether (L1 escrow)',
            symbol: 'ETH',
            amount: Number(cs.totalEscrow) / 1e18,
            provider: 'RoomManager',
          },
        ]
      : room.liquidity

  return {
    ...room,
    status,
    peers,
    blocks,
    contracts: contracts.length ? contracts : room.contracts,
    liquidity,
    batchesSubmitted: cs.settlePhase === 'challenge' || cs.roomState === 3 ? 1 : room.batchesSubmitted,
    settings: {
      ...room.settings,
      memberTarget: cs.memberTarget || room.settings.memberTarget,
      depositEth: depositEth ? String(depositEth) : room.settings.depositEth,
      settlementChainId: cs.config?.chainId ?? room.settings.settlementChainId,
    },
    totalEscrowWei: cs.totalEscrow.toString(),
    depositWei: cs.depositWei.toString(),
  }
}

function normalizeAbi(abi: unknown[]): ContractDef['abi'] {
  return abi
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .filter((x) => x.type === 'function' || !x.type)
    .map((x) => ({
      name: String(x.name ?? 'fn'),
      stateMutability: (x.stateMutability as ContractDef['abi'][0]['stateMutability']) ?? 'nonpayable',
      inputs: Array.isArray(x.inputs)
        ? (x.inputs as Array<{ name?: string; type?: string }>).map((i) => ({
            name: i.name ?? '',
            type: i.type ?? 'uint256',
          }))
        : [],
      outputs: Array.isArray(x.outputs)
        ? (x.outputs as Array<{ name?: string; type?: string }>).map((o) => ({
            name: o.name ?? '',
            type: o.type ?? '',
          }))
        : [],
    }))
}
