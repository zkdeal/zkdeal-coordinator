'use client'

import { Cpu, User } from 'lucide-react'
import { Badge, Card, CardContent, CardHeader, CardTitle, StatusDot } from '@/components/ui/primitives'
import { shortAddr } from '@/lib/keys'
import { useRooms } from '@/lib/rooms-store'
import type { Peer } from '@/lib/types'

const roleMeta: Record<
  Peer['role'],
  { icon: React.ReactNode; tone: 'accent' | 'primary' | 'muted' }
> = {
  sequencer: { icon: <Cpu className="size-3" />, tone: 'accent' },
  member: { icon: <User className="size-3" />, tone: 'muted' },
  observer: { icon: <User className="size-3" />, tone: 'muted' },
}

export function PeersPanel({ roomId, maxPeers }: { roomId: string; maxPeers: number }) {
  const { peersFor, clientState } = useRooms()
  const peers = peersFor(roomId)

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Room peers</CardTitle>
        <Badge tone="muted">
          {peers.length}/{maxPeers}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5">
        {peers.map((p) => {
          const meta = roleMeta[p.role] ?? roleMeta.member
          const isSeq =
            clientState.sequencer &&
            p.address.toLowerCase() === clientState.sequencer.toLowerCase()
          return (
            <div
              key={p.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-background/40 px-2.5 py-1.5"
            >
              <div className="flex items-center gap-2">
                <StatusDot tone="success" pulse />
                <span className="font-mono text-xs text-foreground">{shortAddr(p.address)}</span>
                {p.self && <Badge tone="primary">you</Badge>}
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={isSeq ? 'accent' : meta.tone}>
                  {meta.icon}
                  {isSeq ? 'sequencer' : p.role}
                </Badge>
              </div>
            </div>
          )
        })}
        <p className="mt-1 font-mono text-[0.7rem] text-muted-foreground">
          Roster from libp2p presence. Sequencer = first alive by join order (FIFO at sequencer -
          no MEV claim). Gossip may be plaintext to the relay.
        </p>
      </CardContent>
    </Card>
  )
}
