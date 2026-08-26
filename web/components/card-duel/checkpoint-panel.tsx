'use client'

/**
 * What is actually on chain, and what is only in this tab.
 *
 * This panel exists because the three states a duel move can be in look the
 * same on a board and are not remotely the same claim:
 *
 *   built here      the bytes exist and were audited; nobody else has seen them
 *   submitted       the room accepted the action; still nothing on L1
 *   checkpointed    a batch containing it was proven and accepted on L1
 *
 * So the counters are three, not one, and the merged room transaction hash is
 * rendered in full with its explorer link - the presenter should be able to
 * point at the screen and read the hash out. Every checkpoint is listed, oldest
 * first, so a long game shows its progression instead of only its last receipt.
 *
 * The hash the coordinator publishes is abbreviated by `publicDemoView`; the
 * full one is recovered from the explorer URL by `cardCheckpointReceipt`, and
 * when it cannot be recovered this says so rather than presenting the
 * abbreviation as the hash.
 */
import { CircleCheck, LoaderCircle, ShieldCheck, TriangleAlert } from 'lucide-react'
import { L1TransactionLink } from '@/components/l1-transaction-link'
import { Badge, StatTile } from '@/components/ui/primitives'
import type { CardCheckpointRecord } from '@/lib/card/settlement'
import type { CardSettlementControls } from './use-card-settlement'

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

function CheckpointRow({ record }: { record: CardCheckpointRecord }) {
  const { receipt } = record
  return (
    <li className="rounded-xl border border-success/30 bg-success/5 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <CircleCheck className="size-4 text-success" />
        <span className="text-sm font-semibold">Checkpoint {record.index}</span>
        <Badge tone="success">L1 block {record.l1Block}</Badge>
        <Badge tone="primary">{seconds(record.proofMs)} room proof</Badge>
        <span className="font-mono text-[0.65rem] text-muted-foreground">
          moves {record.sequences.length > 0 ? record.sequences.join(', ') : '-'}
        </span>
      </div>

      <div className="mt-2.5">
        <span className="font-mono text-[0.65rem] tracking-[0.16em] text-muted-foreground uppercase">
          merged room transaction
        </span>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 rounded-md border border-border bg-background/70 px-2.5 py-1.5 font-mono text-[0.72rem] break-all">
            {receipt.transaction}
          </code>
          <L1TransactionLink receipt={receipt} label="open in the explorer" full />
        </div>
        {receipt.note ? <p className="mt-1 text-[0.68rem] text-warning">{receipt.note}</p> : null}
      </div>

      <p className="mt-2 font-mono text-[0.62rem] break-all text-muted-foreground">
        post-state root {record.postStateRoot}
      </p>
    </li>
  )
}

export function CheckpointPanel({ settlement }: { settlement: CardSettlementControls }) {
  const { counts, checkpoints, activity, stage, blockedBy, notice, due, hint, room } = settlement
  const proving = activity === 'checkpointing'

  return (
    <section className="rounded-2xl border border-border bg-card/80 p-5 shadow-2xl shadow-black/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-success">
          <ShieldCheck className="size-5" />
          <span className="font-mono text-xs tracking-[0.18em] uppercase">L1 settlement</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[0.7rem] text-muted-foreground">
            <input
              type="checkbox"
              checked={settlement.auto}
              onChange={(event) => settlement.setAuto(event.target.checked)}
              className="size-3.5 accent-[var(--primary)]"
            />
            settle progressively
          </label>
          <button
            type="button"
            disabled={room === null || proving || counts.submitted === 0}
            onClick={() => void settlement.checkpointNow()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
          >
            {proving ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="size-3.5" />
            )}
            Checkpoint now
          </button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Built here"
          value={counts.local}
          hint="audited in this tab; the room has never seen these"
        />
        <StatTile
          label="Submitted"
          value={counts.submitted}
          hint="accepted as room actions - not yet on L1"
          tone="primary"
        />
        <StatTile
          label="Proven on L1"
          value={counts.checkpointed}
          hint="covered by an accepted checkpoint"
          tone="success"
        />
        <StatTile
          label="Checkpoints"
          value={checkpoints.length}
          hint={`trigger: ${settlement.policy.movesPerCheckpoint} submitted moves`}
          tone="accent"
        />
      </div>

      <p
        className={`mt-3 rounded-lg border px-3 py-2 text-xs leading-relaxed ${
          due.due && due.blocked === null
            ? 'border-accent/40 bg-accent/10 text-accent'
            : 'border-border bg-background/40 text-muted-foreground'
        }`}
      >
        {hint}
      </p>

      {proving ? (
        <p className="mt-2 flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent">
          <LoaderCircle className="size-3.5 animate-spin" />
          Proving the batch on the room&apos;s GPU
          {stage ? ` · coordinator phase ${stage}` : ''}. The duel stays playable; moves made now
          settle in the next checkpoint.
        </p>
      ) : null}

      {blockedBy ? (
        <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs leading-relaxed text-destructive">
          <div className="flex items-center gap-2 font-semibold">
            <TriangleAlert className="size-4" /> Automatic settlement stopped
          </div>
          <p className="mt-1">{blockedBy}</p>
          <p className="mt-1 text-muted-foreground">
            Nothing was silently dropped: the moves above keep the exact state they were in, and
            new moves stay local until settlement is resumed.
          </p>
          <button
            type="button"
            onClick={settlement.clearBlock}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[0.68rem] text-foreground hover:bg-secondary"
          >
            Resume settlement
          </button>
        </div>
      ) : null}

      {notice ? (
        <p className="mt-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          {notice}
        </p>
      ) : null}

      {checkpoints.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          No batch has settled yet, so nothing in this duel is on L1. A checkpoint appears here with
          its merged room transaction hash the moment one is accepted.
        </p>
      ) : (
        <ol className="mt-4 flex flex-col gap-2.5">
          {checkpoints.map((record) => (
            <CheckpointRow key={`${record.roomId}:${record.index}`} record={record} />
          ))}
        </ol>
      )}
    </section>
  )
}
