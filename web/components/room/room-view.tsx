'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRooms } from '@/lib/rooms-store'
import { useWallet } from '@/lib/wallet'
import { Button } from '@/components/ui/button'
import { Badge, Panel, StatTile } from '@/components/ui/primitives'
import { PortalHeader } from '@/components/portal-header'
import { SettingsPanel } from './settings-panel'
import { SettlePanel } from './settle-panel'
import { ManifestReview } from './manifest-review'
import { BlockFeed } from './block-feed'
import { LiquidityPanel } from './liquidity-panel'
import { PeersPanel } from './peers-panel'
import { ContractExplorer } from './contract-explorer'
import { ScenarioErc4626 } from './scenario-erc4626'
import { ScenarioDvp } from './scenario-dvp'
import { shortHex, timeAgo } from '@/lib/format'
import { errorMessage } from '@/lib/l1-errors'

type Tab = 'overview' | 'contracts' | 'scenario' | 'liquidity' | 'peers'

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'muted' | 'info'> = {
  live: 'ok',
  open: 'ok',
  created: 'info',
  challenge: 'warn',
  sealed: 'warn',
  settled: 'muted',
  finalized: 'muted',
  aborted: 'warn',
}

export function RoomView({ roomId }: { roomId: string }) {
  const {
    getRoom,
    peersFor,
    joinRoom,
    leaveRoom,
    joinedRoomId,
    clientState,
    client,
    sealRoom,
  } = useRooms()
  const { address } = useWallet()
  const [tab, setTab] = useState<Tab>('overview')
  const [busy, setBusy] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  const room = getRoom(roomId)

  /**
   * `joinRoom` rethrows everything except `AlreadyMember` - wrong deposit,
   * room full, passed deadline, rejected signature, RPC failure. Dropping
   * those left the spinner stopping with no other change, which reads as a
   * slow join and invites a retry (and a second deposit).
   */
  async function join(id: string) {
    setBusy(true)
    setJoinError(null)
    try {
      await joinRoom(id)
    } catch (e) {
      setJoinError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const joined = joinedRoomId === roomId
  const isLive = room ? ['live', 'open', 'created', 'challenge'].includes(room.status) : false

  if (!roomId) {
    return (
      <div className="min-h-dvh bg-background">
        <PortalHeader />
        <main className="mx-auto max-w-3xl px-4 py-24 text-center">
          <h1 className="text-2xl font-semibold text-foreground">Missing channel id</h1>
          <p className="mt-2 text-muted-foreground">Open a channel via /room?id=&lt;roomId&gt;.</p>
          <Link href="/" className="mt-6 inline-block">
            <Button variant="secondary">Back to portal</Button>
          </Link>
        </main>
      </div>
    )
  }

  if (!room) {
    return (
      <div className="min-h-dvh bg-background">
        <PortalHeader />
        <main className="mx-auto max-w-3xl px-4 py-24 text-center">
          <h1 className="text-2xl font-semibold text-foreground">Channel not found</h1>
          <p className="mt-2 text-muted-foreground">
            This deal channel is not in the coordinator registry yet, or the coordinator is offline.
            Its L1 deposit is unknown here, so joining is refused rather than escrowing a guessed
            amount into a channel whose terms you have not seen.
          </p>
          {address && (
            <Button className="mt-4" disabled={busy} onClick={() => void join(roomId)}>
              Try attach anyway
            </Button>
          )}
          {joinError && (
            <p className="mt-3 text-sm text-warning" role="alert">
              {joinError}
            </p>
          )}
          <Link href="/" className="mt-6 inline-block">
            <Button variant="secondary">Back to portal</Button>
          </Link>
        </main>
      </div>
    )
  }

  const peers = peersFor(room.id)
  const escrowEth = room.totalEscrowWei
    ? (Number(BigInt(room.totalEscrowWei)) / 1e18).toFixed(4)
    : '-'
  const lastBlock = room.blocks[room.blocks.length - 1]

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'contracts', label: `Contracts (${room.contracts.length})` },
    {
      id: 'scenario',
      label:
        room.scenario === 'dvp'
          ? 'DvP'
          : room.scenario === 'erc4626'
            ? 'ERC-4626 Vault'
            : 'Activity',
    },
    { id: 'liquidity', label: 'Escrow' },
    { id: 'peers', label: `Peers (${peers.length})` },
  ]

  return (
    <div className="min-h-dvh bg-background">
      <PortalHeader />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
          <Link href="/" className="hover:text-foreground">
            Portal
          </Link>
          <span>/</span>
          <span className="font-mono">{room.id}</span>
        </div>
        <div className="flex flex-col gap-4 border-b border-border pb-5 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-balance text-2xl font-semibold tracking-tight text-foreground">
                {room.name}
              </h1>
              <Badge tone={STATUS_TONE[room.status] ?? 'muted'}>{room.status}</Badge>
              {isLive && joined && (
                <span className="flex items-center gap-1.5 text-xs text-success">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
                  </span>
                  {clientState.isSequencer ? 'sequencing (FIFO)' : 'verifying'}
                </span>
              )}
            </div>
            <p className="mt-1 max-w-2xl text-pretty text-sm text-muted-foreground">
              {room.description}
            </p>
            {room.nameIsLocalAlias && (
              <p className="mt-1 text-[0.7rem] text-muted-foreground">
                Name and description are a local label stored in this browser only - other members
                see channel <span className="font-mono">{room.id}</span>.
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>
                {/* The registry publishes members, not the L1 creator; the
                    first member is the FIFO leader by join order. */}
                {'first member '}
                <span className="font-mono text-foreground">
                  {room.operator ? shortHex(room.operator) : 'unknown'}
                </span>
              </span>
              <span>
                {'proof '}
                <span className="font-mono text-foreground">Groth16</span>
              </span>
              <span>
                {'block time '}
                <span className="font-mono text-foreground">
                  {room.settings.blockTimeMs}ms (fixed)
                </span>
              </span>
              <span>
                {'sequencer '}
                <span className="font-mono text-foreground">FIFO · join-order leader</span>
              </span>
              <span>{`created ${timeAgo(room.createdAt)}`}</span>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {isLive && (
              <>
                {joined && clientState.isSequencer && (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => client.pauseSequencer()}
                    >
                      Pause sequencer
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => client.resumeSequencer()}
                    >
                      Resume
                    </Button>
                  </>
                )}
                {joined ? (
                  <Button variant="secondary" size="sm" onClick={() => void leaveRoom(room.id)}>
                    Leave
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={!address || busy}
                    onClick={() => void join(room.id)}
                  >
                    {address ? 'Join channel' : 'Connect to join'}
                  </Button>
                )}
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={!joined}
                  onClick={() => {
                    if (
                      confirm(
                        'Seal deal, collect N-of-N sigs, prove, and submitCheckpoint? Settlement is multi-slot.',
                      )
                    ) {
                      void sealRoom(room.id)
                    }
                  }}
                >
                  Seal &amp; settle
                </Button>
              </>
            )}
            {joinError && (
              <p className="w-full text-sm text-warning md:text-right" role="alert">
                {joinError}
              </p>
            )}
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
          <StatTile label="L1 escrow" value={`${escrowEth} ETH`} tone="ok" />
          <StatTile label="Block height" value={lastBlock ? `#${lastBlock.height}` : '-'} />
          <StatTile label="Checkpoints → L1" value={room.batchesSubmitted} tone="info" />
          <StatTile label="Peers" value={peers.length} />
          <StatTile label="Contracts" value={room.contracts.length} />
          <StatTile
            label="Ack seq"
            value={joined ? clientState.lastAckedSeq : '-'}
          />
        </div>

        <div className="mt-6 flex gap-1 overflow-x-auto border-b border-border">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
                tab === t.id
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="py-5">
          {tab === 'overview' && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <BlockFeed room={room} />
              </div>
              <div className="flex flex-col gap-4">
                <ManifestReview roomId={room.id} />
                <SettlePanel room={room} />
                <SettingsPanel room={room} />
              </div>
            </div>
          )}
          {tab === 'contracts' && <ContractExplorer room={room} />}
          {tab === 'scenario' && (
            <>
              {room.scenario === 'erc4626' && <ScenarioErc4626 room={room} />}
              {room.scenario === 'dvp' && <ScenarioDvp room={room} />}
              {room.scenario === 'generic' && (
                <Panel title="Channel activity" subtitle="Generic deal channel">
                  <p className="text-sm text-muted-foreground">
                    Use the Contracts tab to call deployed L2 ABIs via signL2Tx.
                  </p>
                </Panel>
              )}
            </>
          )}
          {tab === 'liquidity' && <LiquidityPanel room={room} />}
          {tab === 'peers' && (
            <PeersPanel roomId={room.id} maxPeers={room.settings.memberTarget} />
          )}
        </div>
      </main>
    </div>
  )
}
