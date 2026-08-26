'use client'

import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/primitives'
import { errorMessage } from '@/lib/l1-errors'
import { useManifestAck } from '@/lib/manifest-ack'
import { useRooms } from '@/lib/rooms-store'
import type { Room } from '@/lib/types'

const PHASE_LABEL: Record<string, string> = {
  idle: 'Idle',
  'collecting-sigs': 'Collecting N-of-N signatures',
  proving: 'Proving (2-10s)',
  submitting: 'Submitting checkpoint',
  challenge: 'Challenge window',
  finalizing: 'Finalizing',
  claimable: 'Claimable - pull exit',
  claimed: 'Claimed',
  aborted: 'Aborted - claim deposit',
  error: 'Error',
}

export function SettlePanel({ room }: { room: Room }) {
  const {
    clientState,
    sealRoom,
    finalizeRoom,
    claimRoom,
    abortRoom,
    approveGenesis,
    openRoom,
    restoreSnapshot,
    isAttachedTo,
  } = useRooms()

  const { acknowledged } = useManifestAck(room.id)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Every control below drives the shared client, which acts on ITS attached
  // room. Unless that is exactly this room, the buttons would mutate another
  // channel's L1 lifecycle - so they are disabled, not merely warned about.
  const attached = isAttachedTo(room.id)
  const live = attached ? clientState : null
  // Rooms with custom (unaudited) bytecode gate Approve-genesis on the
  // manifest-review acknowledgement (see ManifestReview above this panel).
  const manifestGate = !!live?.manifestReviewRequired && !acknowledged
  const phase = live?.settlePhase ?? 'idle'
  const msg = live?.settleMessage ?? ''
  const challengeEnds = live?.challengeEndsAtBlock
  const l1Block = live?.currentL1Block
  const claimable = live?.claimableWei ?? 0n
  const canFinalize =
    phase === 'challenge' &&
    challengeEnds != null &&
    l1Block != null &&
    l1Block > challengeEnds

  /** Run a room-scoped action, surfacing its real failure instead of dropping it. */
  async function act(run: () => Promise<unknown>, onOk?: (v: unknown) => void) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const v = await run()
      onOk?.(v)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const lock = busy || !attached
  const notAttachedTitle = attached
    ? undefined
    : `Not attached to channel ${room.id}. Join it first - these actions run against the attached room.`

  return (
    <Card>
      <CardHeader>
        <CardTitle>Seal &amp; settle</CardTitle>
        <p className="text-xs text-muted-foreground">
          Deal execution ≈ 8s. Proving + checkpoint + challenge + claim are
          post-deal / multi-slot.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!attached && (
          <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs leading-snug text-warning">
            Not attached to channel <span className="font-mono">{room.id}</span>
            {clientState.roomId ? (
              <>
                {' '}(client is attached to <span className="font-mono">{clientState.roomId}</span>)
              </>
            ) : null}
            . Lifecycle actions are disabled so they cannot target another channel.
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">Phase</span>
          <Badge tone={phase === 'error' ? 'warning' : 'primary'}>
            {PHASE_LABEL[phase] ?? phase}
          </Badge>
        </div>
        {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
        {challengeEnds != null && (
          <p className="font-mono text-[0.7rem] text-muted-foreground">
            challenge ends at L1 block {challengeEnds}
            {l1Block != null ? ` · now ${l1Block}` : ''}
          </p>
        )}
        {live?.exits && live.exits.length > 0 && (
          <div className="rounded-md border border-border bg-background/40 p-2">
            <div className="mb-1 text-[0.7rem] text-muted-foreground">Exit preview</div>
            {live.exits.map((e) => (
              <div key={e.address} className="flex justify-between font-mono text-[0.7rem]">
                <span>{e.address.slice(0, 8)}…</span>
                <span>{(Number(e.amountWei) / 1e18).toFixed(4)} ETH</span>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-2.5">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
            <span className="font-mono text-[0.7rem] break-all text-destructive">{error}</span>
          </div>
        )}
        {notice && (
          <p className="rounded-md border border-border bg-background/40 p-2 font-mono text-[0.7rem] break-all text-muted-foreground">
            {notice}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={lock || manifestGate}
            title={
              notAttachedTitle ??
              (manifestGate ? 'Review and acknowledge the contract manifest first' : undefined)
            }
            onClick={() => void act(() => approveGenesis(room.id))}
          >
            Approve genesis
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={lock}
            title={notAttachedTitle}
            onClick={() => void act(() => openRoom(room.id))}
          >
            Open room
          </Button>
          <Button
            size="sm"
            disabled={lock}
            title={notAttachedTitle}
            onClick={() => void act(() => sealRoom(room.id))}
          >
            Seal &amp; prove
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={lock || !canFinalize}
            title={notAttachedTitle}
            onClick={() => void act(() => finalizeRoom(room.id))}
          >
            Finalize
          </Button>
          <Button
            size="sm"
            disabled={lock || (claimable === 0n && phase !== 'claimable' && phase !== 'aborted')}
            title={notAttachedTitle}
            onClick={() => void act(() => claimRoom(room.id))}
          >
            Claim
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={lock}
            title={notAttachedTitle}
            onClick={() => {
              if (
                confirm(
                  `Abort channel ${room.id}? Only valid if the deadline passed and no checkpoint exists.`,
                )
              ) {
                void act(() => abortRoom(room.id))
              }
            }}
          >
            Abort
          </Button>
        </div>

        <Button
          size="sm"
          variant="outline"
          disabled={lock}
          title={notAttachedTitle}
          onClick={() => void act(() => restoreSnapshot(room.id), (w) => setNotice(String(w)))}
        >
          Restore from coordinator
        </Button>
        <p className="text-[0.65rem] leading-snug text-muted-foreground">
          Snapshot restore recovers state + headers + sigs if present. It does{' '}
          <strong>not</strong> restore private keys.
        </p>
      </CardContent>
    </Card>
  )
}
