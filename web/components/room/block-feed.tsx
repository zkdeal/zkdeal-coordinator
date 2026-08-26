'use client'

import { useEffect, useState } from 'react'
import { Blocks } from 'lucide-react'
import { Badge, Card, CardContent, CardHeader, CardTitle, StatusDot } from '@/components/ui/primitives'
import { timeAgo } from '@/lib/format'
import { shortAddr } from '@/lib/keys'
import { getSharedZkvmManager } from '@/lib/room-client'
import type { DealBlock, Room } from '@/lib/types'

const proofTone = {
  pending: 'warning',
  acked: 'primary',
  settled: 'success',
} as const

/**
 * Per-block zkVM proof pipeline state (from @zkdeal/zkvm ProofJobView).
 *
 * The three peer lists mean DIFFERENT things and must never be merged in the
 * UI: `verifiedBy` is a cryptographic proof check, `integrityCheckedBy` is a
 * digest/journal comparison that proves nothing about execution, and
 * `acknowledgedBy` is only a peer's claim about our receipt. The label
 * "verified" is reserved for the first.
 */
interface ZkView {
  seq: string
  state: string
  backendId: string
  executeMs?: number
  proveMs?: number
  receiptBytes?: number
  verifiedBy: string[]
  integrityCheckedBy?: string[]
  acknowledgedBy?: string[]
  receiptVerifiedLocally?: boolean
  error?: string
}

const zkTone: Record<string, 'muted' | 'warning' | 'primary' | 'success' | 'danger'> = {
  queued: 'muted',
  executing: 'warning',
  'exec-verified': 'primary',
  proving: 'warning',
  receipt: 'primary',
  'receipt-verified': 'success',
  'peer-verified': 'success',
  // Integrity-only is NOT a proof check - never render it in the success tone.
  'integrity-checked': 'warning',
  'peer-conflict': 'danger',
  diverged: 'danger',
  failed: 'danger',
  unsupported: 'muted',
}

function zkLabel(v: ZkView): string {
  switch (v.state) {
    case 'receipt':
      // A receipt exists; nothing has verified it yet. Say so.
      return `zk receipt (unverified)${v.proveMs ? ` ${(v.proveMs / 1000).toFixed(1)}s` : ''}${
        v.receiptBytes ? ` · ${Math.round(v.receiptBytes / 1024)}KB` : ''
      }`
    case 'receipt-verified':
      return 'zk proof verified locally'
    case 'peer-verified':
      return `zk proof verified ×${v.verifiedBy.length}`
    case 'integrity-checked':
      // Digest/journal comparison only - explicitly NOT proof verification.
      return `zk integrity check only ×${v.integrityCheckedBy?.length ?? 0}`
    case 'peer-conflict':
      return 'zk PEER CONFLICT'
    case 'exec-verified':
      return `zk re-exec matches${v.executeMs !== undefined ? ` ${v.executeMs}ms` : ''}`
    case 'proving':
      return 'zk proving…'
    case 'diverged':
      return 'zk DIVERGED'
    case 'failed':
      return 'zk prove failed'
    case 'unsupported':
      return 'zk re-exec matches · no local prover'
    default:
      return `zk ${v.state}`
  }
}

/** Long-form tooltip that spells out exactly what the chip does and does not assert. */
function zkTitle(v: ZkView): string {
  const parts = [`${v.backendId} · state ${v.state}`]
  if (v.verifiedBy.length) parts.push(`cryptographically verified peer receipts: ${v.verifiedBy.length}`)
  if (v.integrityCheckedBy?.length) {
    parts.push(
      `integrity-only comparisons (NOT proof verification): ${v.integrityCheckedBy.length}`,
    )
  }
  if (v.acknowledgedBy?.length) {
    parts.push(`peer claims about our receipt (unverified here): ${v.acknowledgedBy.length}`)
  }
  parts.push(
    v.receiptVerifiedLocally
      ? 'our receipt was verified locally'
      : 'our receipt has NOT been verified locally',
  )
  if (v.error) parts.push(`error: ${v.error}`)
  return parts.join(' | ')
}

function BlockRow({ block, live, zk }: { block: DealBlock; live: boolean; zk?: ZkView }) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-4 py-2 last:border-0">
      <div className="flex w-24 shrink-0 items-center gap-2">
        {live && block.proof === 'pending' ? (
          <StatusDot tone="warning" pulse />
        ) : (
          <StatusDot tone={proofTone[block.proof]} />
        )}
        <span className="font-mono text-xs font-medium text-foreground">#{block.height}</span>
      </div>
      <span className="hidden w-28 shrink-0 truncate font-mono text-[0.7rem] text-muted-foreground sm:inline">
        {block.hash.slice(0, 12)}…
      </span>
      <span className="w-14 shrink-0 font-mono text-xs text-foreground tabular-nums">
        {block.txCount} tx
      </span>
      <span className="hidden flex-1 font-mono text-[0.7rem] text-muted-foreground md:inline">
        {block.acks != null ? `${block.acks}/${block.ackTarget ?? '?'} acks` : ''} ·{' '}
        {shortAddr(block.proposer)} · {timeAgo(block.timestamp)}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {zk && (
          <Badge tone={zkTone[zk.state] ?? 'muted'} title={zkTitle(zk)}>
            {zkLabel(zk)}
          </Badge>
        )}
        <Badge tone={proofTone[block.proof]}>{block.proof}</Badge>
      </span>
    </div>
  )
}

export function BlockFeed({ room }: { room: Room }) {
  const blocks = [...room.blocks].reverse()
  const live = ['live', 'open', 'challenge'].includes(room.status)
  const [zkViews, setZkViews] = useState<Map<string, ZkView>>(new Map())

  // Poll the zkVM manager (1s while mounted). Rooms without a zkVM policy
  // yield no views and no chips render.
  useEffect(() => {
    let cancelled = false
    const manager = getSharedZkvmManager()
    const tick = () => {
      if (cancelled) return
      const views = manager.getRoomViews(room.id) as ZkView[]
      if (views.length > 0) {
        setZkViews(new Map(views.map((v) => [v.seq, v])))
      }
    }
    tick()
    const t = setInterval(tick, 1_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [room.id])

  const zkBackend = zkViews.size > 0 ? [...zkViews.values()][0].backendId : null

  return (
    <Card className="flex min-h-0 flex-col">
      <CardHeader className="flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <Blocks className="size-4 text-primary" />
          <CardTitle>Block feed</CardTitle>
        </div>
        <div className="flex items-center gap-2">
          {zkBackend && <Badge tone="primary">zkVM: {zkBackend}</Badge>}
          {live && (
            <span className="flex items-center gap-1.5 font-mono text-[0.7rem] text-success">
              <StatusDot tone="success" pulse /> live
            </span>
          )}
          <Badge tone="muted">{room.blocks.length} in view</Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="max-h-[22rem] overflow-y-auto">
          {blocks.length ? (
            blocks.map((b) => (
              <BlockRow key={b.height} block={b} live={live} zk={zkViews.get(String(b.height))} />
            ))
          ) : (
            <p className="px-4 py-10 text-center text-xs text-muted-foreground">
              Waiting for the join-order sequencer to produce the first block…
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
