'use client'

import { Clock, Cpu, Database, Link2, Shield, Users } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/primitives'
import { blockRateLabel } from '@/lib/format'
import { useRooms } from '@/lib/rooms-store'
import type { Room } from '@/lib/types'

function Row({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
  accent?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="text-primary">{icon}</span>
        {label}
      </span>
      <span
        className={`font-mono text-xs tabular-nums ${accent ? 'text-accent' : 'text-foreground'}`}
      >
        {value}
      </span>
    </div>
  )
}

export function SettingsPanel({ room }: { room: Room }) {
  const { config } = useRooms()
  const s = room.settings
  // Only the coordinator /config (or the attached client) knows the L1. The
  // registry does not publish it, so an unknown chain renders as unknown
  // rather than defaulting to "Ethereum Mainnet".
  const chainName = config?.chainId
    ? `L1 chain ${config.chainId}`
    : s.settlementChainId != null
      ? `Chain ${s.settlementChainId}`
      : 'unknown'

  return (
    <Card>
      <CardHeader>
        <CardTitle>Channel parameters</CardTitle>
        <p className="text-xs text-muted-foreground">
          Deal-channel rules - execution ~8s; settlement is multi-slot.
        </p>
      </CardHeader>
      <CardContent className="divide-y divide-border">
        <Row
          icon={<Clock className="size-3.5" />}
          label="Block time"
          value={`${s.blockTimeMs}ms · ${blockRateLabel(s.blockTimeMs)} (fixed)`}
          accent
        />
        <Row
          icon={<Users className="size-3.5" />}
          label="Member target"
          value={`${s.memberTarget} (max 4)`}
        />
        <Row
          icon={<Shield className="size-3.5" />}
          label="Sequencer"
          value="FIFO · join-order leader"
          accent
        />
        <Row icon={<Cpu className="size-3.5" />} label="Proof system" value="Groth16" />
        <Row icon={<Database className="size-3.5" />} label="Data availability" value="L1 calldata" />
        <Row
          icon={<Clock className="size-3.5" />}
          label="Challenge window"
          value={
            s.challengeWindowBlocks != null ? `${s.challengeWindowBlocks} L1 blocks` : 'unknown'
          }
        />
        <Row icon={<Link2 className="size-3.5" />} label="Settles to" value={chainName} />

        <div className="pt-3 text-[0.65rem] leading-snug text-muted-foreground">
          <strong className="text-foreground">Trust boundary:</strong> the coordinator is untrusted
          bootstrap (genesis assist, artifacts, relay, registry, faucet, optional snapshots). Members
          recompute the genesis root before approveGenesis; execution and proving run in the browser.
        </div>
      </CardContent>
    </Card>
  )
}
