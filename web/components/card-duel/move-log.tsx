'use client'

/**
 * Every move this duel has produced, and where each one stands with the room.
 *
 * The labels are the point of this component. `built here` means the move
 * passed the local rules and the vault audit and has been handed to NOBODY -
 * which is the normal state on a stand with no card room, and is labelled as
 * such rather than dressed up as acceptance. `submitted` means the room holds
 * it as an action; it is still not on L1, and the id shown next to it is a room
 * ACTION id, never a transaction hash. Only `on L1` means a checkpoint proved
 * it, and it names which checkpoint did - AND carries that checkpoint's real
 * transaction hash as a link into the explorer the coordinator advertises, so a
 * viewer can verify the claim without taking this page's word for it.
 */
import {
  ArrowUpRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  LoaderCircle,
  ShieldCheck,
} from 'lucide-react'
import { L1TransactionLink } from '@/components/l1-transaction-link'
import { Badge, type Tone } from '@/components/ui/primitives'
import type { CardSessionEntry, CardSessionState } from '@/lib/card/session'
import type { CardCheckpointRecord } from '@/lib/card/settlement'

const TONE: Record<CardSessionEntry['status'], Tone> = {
  rehearsed: 'muted',
  submitting: 'primary',
  submitted: 'accent',
  checkpointed: 'success',
  failed: 'destructive',
}

const LABEL: Record<CardSessionEntry['status'], string> = {
  rehearsed: 'built here',
  submitting: 'submitting',
  submitted: 'submitted · not on L1',
  checkpointed: 'on L1',
  failed: 'refused',
}

function StatusIcon({ status }: { status: CardSessionEntry['status'] }) {
  if (status === 'checkpointed') return <ShieldCheck className="size-3.5 text-success" />
  if (status === 'submitted') return <CircleCheck className="size-3.5 text-accent" />
  if (status === 'failed') return <CircleX className="size-3.5 text-destructive" />
  if (status === 'submitting') return <LoaderCircle className="size-3.5 animate-spin text-primary" />
  return <CircleDashed className="size-3.5 text-muted-foreground" />
}

export function MoveLog({
  session,
  checkpoints,
  canSubmit,
  busy,
  onSubmit,
}: {
  session: CardSessionState
  /** Every batch this duel has settled, so a settled move can name its hash. */
  checkpoints: readonly CardCheckpointRecord[]
  canSubmit: boolean
  busy: boolean
  onSubmit: (sequence: number) => void
}) {
  const byIndex = new Map(checkpoints.map((record) => [record.index, record]))
  return (
    <section className="rounded-2xl border border-border bg-card/80 p-5 shadow-2xl shadow-black/20">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold">Move log</h3>
        <span className="font-mono text-[0.7rem] text-muted-foreground">
          {session.entries.length} moves ·{' '}
          {session.entries.reduce((total, entry) => total + entry.calldata.bytes, 0)} bytes published
        </span>
      </div>

      {session.entries.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Nothing has been built yet. Registration comes first: a duel move against a missing
          participant leaf reverts before it reaches the game rules.
        </p>
      ) : (
        <ol className="mt-3 flex flex-col gap-1.5">
          {session.entries
            .slice()
            .reverse()
            .map((entry) => {
              const record =
                entry.checkpointIndex !== null ? (byIndex.get(entry.checkpointIndex) ?? null) : null
              return (
              <li
                key={entry.sequence}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background/40 px-3 py-2"
              >
                <StatusIcon status={entry.status} />
                <span className="font-mono text-xs">
                  {entry.sequence}. seat {entry.seat} · {entry.move}
                </span>
                <Badge tone={TONE[entry.status]}>{LABEL[entry.status]}</Badge>
                {entry.checkpointIndex !== null ? (
                  <Badge tone="success">checkpoint {entry.checkpointIndex}</Badge>
                ) : null}
                {entry.provingMs !== null ? (
                  <Badge tone="primary">{Math.round(entry.provingMs)} ms proof</Badge>
                ) : null}
                <span className="font-mono text-[0.65rem] text-muted-foreground">
                  {entry.calldata.bytes} B
                </span>
                {entry.actionId !== null ? (
                  <span
                    className="font-mono text-[0.62rem] text-muted-foreground"
                    title="Room action id - not a transaction hash. Nothing reaches L1 until a checkpoint proves the batch it lands in."
                  >
                    action {entry.actionId}
                    {entry.block !== null ? ` · L2 block ${entry.block}` : ''}
                  </span>
                ) : null}
                {/* The claim "on L1" is only worth making if it can be
                    checked, so a settled move carries the merged room
                    transaction that settled it. */}
                {record ? (
                  <L1TransactionLink receipt={record.receipt} label="settled in" />
                ) : null}
                {entry.error ? (
                  <span className="w-full text-[0.68rem] text-destructive">{entry.error}</span>
                ) : null}
                {entry.status === 'rehearsed' || entry.status === 'failed' ? (
                  <button
                    type="button"
                    className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[0.68rem] text-muted-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={!canSubmit || busy}
                    onClick={() => onSubmit(entry.sequence)}
                  >
                    Submit to room <ArrowUpRight className="size-3" />
                  </button>
                ) : null}
              </li>
              )
            })}
        </ol>
      )}
    </section>
  )
}
