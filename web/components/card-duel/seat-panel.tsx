'use client'

/**
 * One duelist: what the chain knows, and what only this browser knows.
 *
 * The split down the middle of this panel is the whole demonstration. The left
 * column is `CardDuelLibV5.Seat` - slot-addressed board, counters and two
 * Poseidon roots - every field of which is on-chain and published in calldata.
 * The right column is the hand, which exists nowhere but in this tab's vault
 * worker: the coordinator, the outer prover and L1 see only the root above it.
 */
import { Eye, EyeOff, Heart, KeyRound, Swords } from 'lucide-react'
import { CARD_RULES, cardById, cardStats, type CardSeatIndex } from '@zkdeal/card'
import { Badge } from '@/components/ui/primitives'
import type { CardAutoplayFocus } from '@/lib/card/autoplay'
import type { CardSessionState } from '@/lib/card/session'
import type { CardVaultView } from '@/lib/card/vault-messages'

const short = (value: string | null): string =>
  value === null ? '-' : value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value

function BoardSlot({ cardId, health, attacked }: { cardId: number; health: number; attacked: boolean }) {
  if (cardId === 0) {
    return (
      <div className="duel-motion flex h-20 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-background/30 text-[0.65rem] text-muted-foreground transition-colors">
        empty
      </div>
    )
  }
  const card = cardById(cardId)
  return (
    <div className="duel-card-in duel-motion flex h-20 flex-col justify-between rounded-lg border border-border bg-background/50 px-2 py-1.5 text-left transition-colors">

      <span className="text-[0.7rem] leading-tight font-medium">{card.name}</span>
      <span className="flex items-center justify-between font-mono text-[0.65rem] text-muted-foreground">
        <span className="flex items-center gap-0.5">
          <Swords className="size-3" />
          {card.attack}
        </span>
        <span className="flex items-center gap-0.5">
          <Heart className="size-3" />
          {health}
        </span>
      </span>
      {attacked ? <span className="text-[0.6rem] text-warning">attacked</span> : null}
    </div>
  )
}

export function SeatPanel({
  seat,
  session,
  view,
  owner,
  demoKeyNote,
  isTurn,
  acting = false,
  focus = null,
}: {
  seat: CardSeatIndex
  session: CardSessionState
  view: CardVaultView | null
  owner: string
  /**
   * Which well-known demo key signs for this seat. Shown, not hidden: the
   * address below is a public test key that every zkdeal stand funds, and a
   * presenter must never be able to imply it is the viewer's own wallet.
   */
  demoKeyNote: string
  isTurn: boolean
  /** This seat is the one autoplay is currently moving for. */
  acting?: boolean
  /** The region autoplay just announced it is about to change, if this seat's. */
  focus?: CardAutoplayFocus['region'] | null
}) {
  const state = session.duel.seats[seat]
  const slots = Array.from({ length: CARD_RULES.boardLimit }, (_unused, slot) => slot)
  // Re-keyed on the focus so an announcement replays the highlight rather than
  // leaving a class that has already finished its one run.
  const focusKey = `${session.entries.length}:${focus ?? 'none'}`

  return (
    <section
      className={`duel-motion rounded-2xl border p-5 shadow-2xl shadow-black/20 transition-colors ${
        isTurn ? 'border-primary/50 bg-card' : 'border-border bg-card/80'
      } ${acting ? 'duel-acting' : ''}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold">Seat {seat}</h3>
            {isTurn ? <Badge tone="primary">on the move</Badge> : null}
            {state.seated ? null : <Badge tone="muted">not seated</Badge>}
          </div>
          <p className="mt-0.5 font-mono text-[0.7rem] text-muted-foreground">
            owner {short(owner)} · participant #{state.participantIndex}
          </p>
          <p className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[0.65rem] leading-snug text-warning">
            <KeyRound className="size-3 shrink-0" />
            <span>
              {demoKeyNote} - a public test key, not your wallet. It both signs this seat&rsquo;s
              transactions and is the <code className="font-mono">player</code> its proofs commit
              to.
            </span>
          </p>
        </div>
        <div
          key={focus === 'health' ? `${focusKey}:health` : 'health'}
          className={`flex items-center gap-1.5 rounded-md px-1.5 font-mono text-lg ${
            focus === 'health' ? 'duel-focus border border-primary' : ''
          }`}
        >
          <Heart className="size-4 text-destructive" />
          {state.health}
        </div>
      </header>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1.25fr_1fr]">
        <div>
          <div className="flex items-center gap-1.5 text-[0.7rem] tracking-wide text-muted-foreground uppercase">
            <Eye className="size-3" />
            Public board · in calldata
          </div>
          <div
            key={focus === 'board' ? `${focusKey}:board` : 'board'}
            className={`mt-2 grid grid-cols-5 gap-1.5 rounded-lg ${
              focus === 'board' ? 'duel-focus border border-primary p-1' : ''
            }`}
          >
            {slots.map((slot) => (
              <BoardSlot
                // Re-keyed on the occupant so a card entering or leaving the
                // slot remounts and replays the enter animation.
                key={`${slot}:${state.boardCards[slot] ?? 0}`}
                cardId={state.boardCards[slot] ?? 0}
                health={state.boardHealth[slot] ?? 0}
                attacked={(state.attackedMask & (1 << slot)) !== 0}
              />
            ))}
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[0.68rem] text-muted-foreground">
            <div className="flex justify-between gap-2">
              <dt>deck cursor</dt>
              <dd className="text-foreground">
                {state.deckCursor}/{CARD_RULES.catalogSize}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>hand count</dt>
              <dd className="text-foreground">{state.handCount}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>board count</dt>
              <dd className="text-foreground">{state.boardCount}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>action cursor</dt>
              <dd className="text-foreground">{state.actionCursor}</dd>
            </div>
            <div className="col-span-2 flex justify-between gap-2">
              <dt>deck root</dt>
              <dd className="text-foreground">{short(state.deckRoot)}</dd>
            </div>
            <div className="col-span-2 flex justify-between gap-2">
              <dt>hand root</dt>
              <dd className="text-foreground">{short(state.handRoot)}</dd>
            </div>
          </dl>
        </div>

        <div
          key={focus === 'hand' || focus === 'roots' ? `${focusKey}:hand` : 'hand'}
          className={`rounded-xl border border-accent/30 bg-accent/5 p-3 ${
            focus === 'hand' || focus === 'roots' ? 'duel-focus' : ''
          }`}
        >
          <div className="flex items-center gap-1.5 text-[0.7rem] tracking-wide text-accent uppercase">
            <EyeOff className="size-3" />
            Hidden hand · this tab only
          </div>
          {view ? (
            <>
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                {view.handCards.map((cardId, slot) => (
                  <div
                    key={`${slot}:${cardId}`}
                    className={`duel-motion rounded-md border px-2 py-1 text-left text-[0.68rem] transition-colors ${
                      cardId === 0
                        ? 'border-dashed border-border text-muted-foreground'
                        : 'duel-card-in border-border bg-background/40'
                    }`}
                  >
                    <span className="block font-mono text-[0.6rem] text-muted-foreground">
                      slot {slot}
                    </span>
                    {cardId === 0 ? (
                      'empty'
                    ) : (
                      <>
                        <span className="block font-medium">{cardById(cardId).name}</span>
                        <span className="font-mono text-muted-foreground">
                          {cardStats(cardId).attack}/{cardStats(cardId).health}
                        </span>
                      </>
                    )}
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[0.65rem] leading-relaxed text-muted-foreground">
                The shuffled deck order behind {view.deckCursor} drawn cards, and the salt of every
                card above, stay in the worker. Nothing here has an encoding in any move.
              </p>
            </>
          ) : (
            <p className="mt-2 text-[0.68rem] text-muted-foreground">
              No vault is open for this seat yet.
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
