'use client'

import Link from 'next/link'
import { ArrowUpRight, Clock, Layers, Users } from 'lucide-react'
import { Badge, StatusDot } from '@/components/ui/primitives'
import { SCENARIO_LABEL, type Room } from '@/lib/types'
import { blockRateLabel, formatUsd, timeAgo } from '@/lib/format'
import { useRooms } from '@/lib/rooms-store'

export function RoomCard({ room }: { room: Room }) {
  const { peersFor } = useRooms()
  const peers = peersFor(room.id)
  const tvl = room.liquidity.reduce((s, l) => s + l.amount, 0)
  const height = room.blocks.length ? room.blocks[room.blocks.length - 1].height : 0
  const isLive = ['live', 'open', 'created', 'challenge'].includes(room.status)

  return (
    <Link
      href={`/room?id=${encodeURIComponent(room.id)}`}
      className="group flex flex-col gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-card/80"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Badge tone={room.scenario === 'dvp' ? 'accent' : 'primary'}>
              {SCENARIO_LABEL[room.scenario]}
            </Badge>
            <Badge tone="muted">deal channel</Badge>
          </div>
          <h3 className="text-sm font-semibold tracking-tight text-foreground text-balance">
            {room.name}
          </h3>
        </div>
        <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
      </div>

      <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
        {room.description}
      </p>

      <div className="grid grid-cols-2 gap-2 rounded-md border border-border bg-background/40 p-2.5 font-mono text-[0.7rem]">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Clock className="size-3 text-primary" />
          <span className="text-foreground">{room.settings.blockTimeMs}ms</span>
          <span>/ block</span>
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Layers className="size-3 text-primary" />
          <span className="text-foreground">{blockRateLabel(room.settings.blockTimeMs)}</span>
        </div>
        <div className="col-span-2 flex items-center gap-1.5 text-muted-foreground">
          <span>sequencer:</span>
          <span className="text-foreground">FIFO · join-order leader</span>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border pt-3 text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Users className="size-3.5" />
          <span className="font-mono text-foreground">{peers.length}</span>
          <span>/ {room.settings.memberTarget}</span>
        </span>
        <span className="font-mono text-muted-foreground">
          escrow <span className="text-foreground">{tvl ? `${tvl.toFixed(3)} ETH` : formatUsd(0)}</span>
        </span>
        <span className="flex items-center gap-1.5">
          {isLive ? (
            <>
              <StatusDot tone="success" pulse />
              <span className="font-mono text-foreground">#{height}</span>
            </>
          ) : (
            <Badge tone={room.status === 'settled' || room.status === 'finalized' ? 'success' : 'muted'}>
              {room.status}
            </Badge>
          )}
        </span>
      </div>

      {!isLive && room.sealedAt && (
        <span className="font-mono text-[0.7rem] text-muted-foreground">
          closed {timeAgo(room.sealedAt)}
        </span>
      )}
    </Link>
  )
}
