'use client'

/**
 * Everything the run did, and what each entry is allowed to claim.
 *
 * The labels are the point of this component. `accepted` means the coordinator
 * holds it - an action in a room block, a template queued for proving - and
 * nothing about it is on Ethereum. `on L1` means a real transaction carries it,
 * and a row that says so MUST let a viewer check it: it renders the transaction
 * as a link whose href carries the whole 32-byte hash, pointed at the explorer
 * the coordinator itself advertises.
 *
 * When the full hash cannot be recovered the row says exactly that, in place of
 * the link. An abbreviation nobody can look up would look like evidence and be
 * none, which is worse than showing nothing.
 */
import { CircleCheck, CircleDashed, CircleX, ShieldCheck } from 'lucide-react'
import { L1TransactionLink } from '@/components/l1-transaction-link'
import { Badge, type Tone } from '@/components/ui/primitives'
import type { DemoLogEntry, DemoLogStatus } from '@/lib/applications/log'

const TONE: Record<DemoLogStatus, Tone> = {
  running: 'muted',
  accepted: 'accent',
  landed: 'success',
  refused: 'destructive',
}

const LABEL: Record<DemoLogStatus, string> = {
  running: 'in flight',
  accepted: 'accepted · not on L1',
  landed: 'on L1',
  refused: 'refused',
}

function StatusIcon({ status }: { status: DemoLogStatus }) {
  if (status === 'landed') return <ShieldCheck className="size-3.5 text-success" />
  if (status === 'accepted') return <CircleCheck className="size-3.5 text-accent" />
  if (status === 'refused') return <CircleX className="size-3.5 text-destructive" />
  return <CircleDashed className="size-3.5 text-muted-foreground" />
}

export function ActionLog({ log }: { log: readonly DemoLogEntry[] }) {
  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Action log</h3>
        <span className="font-mono text-[0.68rem] text-muted-foreground">
          {log.filter((entry) => entry.status === 'landed').length} of {log.length} on L1
        </span>
      </div>
      {log.length === 0 ? (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Nothing has run yet. Every entry that appears here is a real call to this stand&apos;s
          coordinator, and every entry that lands state on Ethereum carries its transaction hash as
          a link you can open yourself.
        </p>
      ) : (
        <ol className="mt-2 flex flex-col gap-1.5">
          {log
            .slice()
            .reverse()
            .map((entry) => (
              <li
                key={entry.sequence}
                className="rounded-lg border border-border bg-background/40 px-3 py-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <StatusIcon status={entry.status} />
                  <span className="text-xs font-medium">{entry.title}</span>
                  <Badge tone={TONE[entry.status]}>{LABEL[entry.status]}</Badge>
                  {entry.block !== null ? (
                    <span className="font-mono text-[0.62rem] text-muted-foreground">
                      L2 block {entry.block}
                    </span>
                  ) : null}
                  {entry.proofMs !== null ? (
                    <Badge tone="primary">{(entry.proofMs / 1000).toFixed(1)} s room proof</Badge>
                  ) : null}
                  {entry.actionId !== null ? (
                    <span
                      className="font-mono text-[0.62rem] text-muted-foreground"
                      title="Room action id - not a transaction hash. Nothing reaches L1 until a checkpoint proves the batch it lands in."
                    >
                      action {entry.actionId}
                    </span>
                  ) : null}
                </div>
                {entry.receipt ? (
                  <div className="mt-1.5">
                    <L1TransactionLink receipt={entry.receipt} />
                  </div>
                ) : null}
                {entry.detail ? (
                  <p
                    className={`mt-1 text-[0.7rem] leading-relaxed ${
                      entry.status === 'refused' ? 'text-destructive' : 'text-muted-foreground'
                    }`}
                  >
                    {entry.detail}
                  </p>
                ) : null}
              </li>
            ))}
        </ol>
      )}
    </div>
  )
}
