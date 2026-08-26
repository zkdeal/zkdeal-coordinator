'use client'

/**
 * Exactly what the last move publishes.
 *
 * In a VALIDITY_ONLY room every raw signed transaction is republished verbatim
 * as L1 calldata, so this hex string is the complete set of what an observer
 * learns from the move. Showing it in full - not a summary of it - is the only
 * way the confidentiality claim can be checked rather than believed, and the
 * "audited by the vault" line is the runtime assertion behind it: the worker
 * that holds the deck confirmed these bytes contain none of it.
 */
import { BadgeCheck, Braces, Timer } from 'lucide-react'
import { Badge } from '@/components/ui/primitives'
import type { CardLastMove } from './use-card-duel'

const DECK_INIT_ORDER = ['domain', 'duelId', 'player', 'deckRoot', 'emptyHandRoot']
const HAND_ACTION_ORDER = [
  'domain',
  'duelId',
  'player',
  'action',
  'actionCursor',
  'deckRoot',
  'oldHandRoot',
  'newHandRoot',
  'oldDeckCursor',
  'newDeckCursor',
  'oldHandCount',
  'newHandCount',
  'oldBoardCount',
  'newBoardCount',
  'publicCard',
]

export function PayloadInspector({ move }: { move: CardLastMove | null }) {
  if (!move) {
    return (
      <section className="rounded-2xl border border-border bg-card/80 p-5 shadow-2xl shadow-black/20">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Braces className="size-5" />
          <span className="font-mono text-xs tracking-[0.18em] uppercase">Published payload</span>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          Make a move and the complete transaction body appears here, byte for byte.
        </p>
      </section>
    )
  }

  const order = move.publicInputs?.length === DECK_INIT_ORDER.length ? DECK_INIT_ORDER : HAND_ACTION_ORDER

  return (
    <section className="rounded-2xl border border-border bg-card/80 p-5 shadow-2xl shadow-black/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-primary">
            <Braces className="size-5" />
            <span className="font-mono text-xs tracking-[0.18em] uppercase">Published payload</span>
          </div>
          <h3 className="mt-2 break-all font-mono text-base">{move.calldata.signature}</h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {move.audited ? (
            <Badge tone="success" className="gap-1">
              <BadgeCheck className="size-3" /> vault audited
            </Badge>
          ) : null}
          {move.provingMs !== null ? (
            <Badge tone="primary" className="gap-1">
              <Timer className="size-3" /> {Math.round(move.provingMs)} ms in-browser proof
            </Badge>
          ) : null}
          <Badge tone="muted">{move.calldata.bytes} bytes</Badge>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="min-w-0">
          <h4 className="text-[0.7rem] tracking-wide text-muted-foreground uppercase">Arguments</h4>
          <dl className="mt-2 flex flex-col gap-1">
            <div className="flex justify-between gap-3 font-mono text-[0.68rem]">
              <dt className="text-muted-foreground">selector</dt>
              <dd>{move.calldata.selector}</dd>
            </div>
            {move.calldata.published.map((field) => (
              <div key={field.name} className="flex justify-between gap-3 font-mono text-[0.68rem]">
                <dt className="text-muted-foreground">{field.name}</dt>
                <dd className="max-w-[60%] truncate" title={field.value}>
                  {field.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="min-w-0">
          <h4 className="text-[0.7rem] tracking-wide text-muted-foreground uppercase">
            {move.publicInputs ? 'Ordered circuit public inputs' : 'No inner proof on this move'}
          </h4>
          {move.publicInputs ? (
            <ol className="mt-2 flex flex-col gap-0.5">
              {move.publicInputs.map((value, index) => (
                <li key={index} className="flex justify-between gap-3 font-mono text-[0.65rem]">
                  <span className="text-muted-foreground">
                    {index}. {order[index]}
                  </span>
                  <span className="max-w-[55%] truncate" title={value}>
                    {value}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-2 text-[0.68rem] leading-relaxed text-muted-foreground">
              Every value this move touches is already public duel state, so there is nothing to
              hide and nothing to prove.
            </p>
          )}
        </div>
      </div>

      <div className="mt-4">
        <h4 className="text-[0.7rem] tracking-wide text-muted-foreground uppercase">
          Complete transaction body
        </h4>
        <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-border bg-background/60 p-3 font-mono text-[0.62rem] leading-relaxed break-all whitespace-pre-wrap">
          {move.calldata.calldata}
        </pre>
        <p className="mt-2 text-[0.68rem] leading-relaxed text-muted-foreground">
          Search it for a card you hold. The deck order, the per-card salts, the hand array, the
          Merkle siblings that open a deck leaf and the slot a card came from are all absent, and
          the vault worker refused to release these bytes until it had confirmed that.
        </p>
      </div>
    </section>
  )
}
