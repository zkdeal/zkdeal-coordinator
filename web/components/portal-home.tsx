'use client'

import { useState } from 'react'
import { Archive, Boxes, Layers, Radio, Wallet } from 'lucide-react'
import { PortalHeader } from '@/components/portal-header'
import { RoomCard } from '@/components/room-card'
import { CreateRoomDialog } from '@/components/create-room-dialog'
import { Stat } from '@/components/ui/primitives'
import { useRooms } from '@/lib/rooms-store'

export function PortalHome() {
  const { activeRooms, pastRooms, onlineCount, coordinatorOk, coordinatorError } = useRooms()
  const [tab, setTab] = useState<'active' | 'past'>('active')

  // ETH totals only. There is no price source in this app; the previous
  // "Escrowed ETH" tile summed a hard-coded usd: 0 and formatted it as
  // currency, so rooms holding real deposits displayed $0.00.
  const escrowEth = activeRooms.reduce(
    (s, r) => s + (r.totalEscrowWei ? Number(BigInt(r.totalEscrowWei)) / 1e18 : 0),
    0,
  )
  const totalBlocks = [...activeRooms, ...pastRooms].reduce(
    (s, r) => s + (r.blocks.at(-1)?.height ?? 0),
    0,
  )

  return (
    <div className="min-h-screen grid-bg">
      <PortalHeader />

      <main className="mx-auto max-w-6xl px-4 py-8">
        <section className="flex flex-col gap-4">
          <div className="flex items-center gap-2 font-mono text-xs text-primary">
            <Radio className="size-3.5" />
            <span>execution rooms · unanimous verification · proof-verified L1 settlement</span>
          </div>
          <h1 className="max-w-2xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Spin up permissioned execution rooms with your peers.
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground text-pretty">
            zkdeal is a deal-scoped execution channel: members re-execute every block, co-sign
            progressive checkpoints, and settle a Groth16 certificate to L1 with on-chain calldata
            DA. Execution targets ~8s of room blocks; proving and claim are post-deal.
          </p>
        </section>

        {coordinatorOk === false && (
          <div className="mt-4 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            Coordinator unreachable{coordinatorError ? `: ${coordinatorError}` : ''}. Set{' '}
            <span className="font-mono">NEXT_PUBLIC_COORDINATOR_URL</span> or serve this app from
            the coordinator origin.
          </div>
        )}

        <section className="mt-8 grid grid-cols-2 gap-3 rounded-xl border border-border bg-card/60 p-4 sm:grid-cols-4">
          <Stat label="Active channels" value={activeRooms.length} sub={`${pastRooms.length} archived`} />
          <Stat
            label="Escrowed ETH"
            value={`${escrowEth.toLocaleString('en-US', { maximumFractionDigits: 4 })} ETH`}
            sub="L1 deposits, active channels"
          />
          <Stat label="L2 blocks" value={totalBlocks.toLocaleString()} sub="all channels" />
          <Stat label="Peers online" value={onlineCount} sub="in your session" />
        </section>

        <section className="mt-8">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-1">
              <button
                onClick={() => setTab('active')}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  tab === 'active'
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Layers className="size-3.5" />
                Active
                <span className="font-mono text-muted-foreground">{activeRooms.length}</span>
              </button>
              <button
                onClick={() => setTab('past')}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  tab === 'past'
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Archive className="size-3.5" />
                Past channels
                <span className="font-mono text-muted-foreground">{pastRooms.length}</span>
              </button>
            </div>
            <CreateRoomDialog />
          </div>

          <div className="mt-4">
            {tab === 'active' ? (
              activeRooms.length ? (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {activeRooms.map((room) => (
                    <RoomCard key={room.id} room={room} />
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={<Boxes className="size-6" />}
                  title="No live execution rooms"
                  body="Create a channel on L1 (RoomManager.createRoom) to start a deal with peers."
                />
              )
            ) : pastRooms.length ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {pastRooms.map((room) => (
                  <RoomCard key={room.id} room={room} />
                ))}
              </div>
            ) : (
              <EmptyState
                icon={<Archive className="size-6" />}
                title="No archived channels"
                body="Finalized and aborted channels appear here after claim."
              />
            )}
          </div>
        </section>

        <footer className="mt-12 flex items-center gap-2 border-t border-border pt-6 font-mono text-[0.7rem] text-muted-foreground">
          <Wallet className="size-3" />
          Burner wallet by default (faucet when enabled). Optional MetaMask for L1. Coordinator is
          untrusted bootstrap only.
        </footer>
      </main>
    </div>
  )
}

function EmptyState({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode
  title: string
  body: string
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card/40 px-6 py-16 text-center">
      <span className="grid size-12 place-items-center rounded-lg border border-border bg-card text-muted-foreground">
        {icon}
      </span>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="max-w-sm text-xs text-muted-foreground">{body}</p>
    </div>
  )
}
