'use client'

/**
 * The legal moves, and the two choices that cannot be inferred.
 *
 * The button list IS the phase machine: `cardAvailableSteps` derives it from
 * `CardDuelLibV5.Phase` plus the turn, so a move the contract would revert is
 * never offered. `play` needs a hand slot (which hidden card) and a board slot
 * (where it becomes public); `attack` needs an attacker slot and a target. Both
 * are picked here rather than by clicking the boards, so the choice is visible
 * next to the move that consumes it.
 */
import { useState } from 'react'
import { Lock, Play, Unlock } from 'lucide-react'
import { CARD_RULES, cardById } from '@zkdeal/card'
import { Badge, Select } from '@/components/ui/primitives'
import type { CardSessionState } from '@/lib/card/session'
import type { CardStep } from '@/lib/card/steps'
import type { CardStepChoiceInput } from '@/lib/card/moves'
import type { CardVaultView } from '@/lib/card/vault-messages'

const FACE = CARD_RULES.faceTarget

export function MoveControls({
  steps,
  session,
  views,
  busy,
  disabled,
  onRun,
}: {
  steps: readonly CardStep[]
  session: CardSessionState
  views: readonly [CardVaultView | null, CardVaultView | null]
  busy: string | null
  disabled: boolean
  onRun: (step: CardStep, choice?: CardStepChoiceInput) => void
}) {
  const [handSlot, setHandSlot] = useState(0)
  const [boardSlot, setBoardSlot] = useState(0)
  const [attackerSlot, setAttackerSlot] = useState(0)
  // FACE is 255 in a literal-typed constant, so the state must be widened or
  // every board slot becomes an assignment error.
  const [targetSlot, setTargetSlot] = useState<number>(FACE)

  const turn = session.duel.turn
  const attacker = session.duel.seats[turn]
  const defender = session.duel.seats[turn === 0 ? 1 : 0]
  const hand = views[turn]?.handCards ?? []

  const freeBoardSlots = Array.from({ length: CARD_RULES.boardLimit }, (_unused, slot) => slot).filter(
    (slot) => (attacker.boardMask & (1 << slot)) === 0,
  )
  const readyAttackers = Array.from({ length: CARD_RULES.boardLimit }, (_unused, slot) => slot).filter(
    (slot) => (attacker.boardMask & (1 << slot)) !== 0 && (attacker.attackedMask & (1 << slot)) === 0,
  )
  const targets = Array.from({ length: CARD_RULES.boardLimit }, (_unused, slot) => slot).filter(
    (slot) => (defender.boardMask & (1 << slot)) !== 0,
  )
  const occupiedHandSlots = hand
    .map((cardId, slot) => ({ cardId, slot }))
    .filter((entry) => entry.cardId !== 0)

  const choiceFor = (step: CardStep): CardStepChoiceInput | undefined => {
    if (step.choice === 'hand-slot-and-board-slot') return { handSlot, boardSlot }
    if (step.choice === 'attack') return { attackerSlot, targetSlot }
    return undefined
  }

  return (
    <section className="rounded-2xl border border-border bg-card/80 p-5 shadow-2xl shadow-black/20">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold">Legal moves</h3>
        <span className="font-mono text-[0.7rem] text-muted-foreground">
          phase {session.duel.phase} · turn {session.duel.turnNumber}
        </span>
      </div>

      {steps.some((step) => step.choice === 'hand-slot-and-board-slot') ? (
        <div className="mt-3 grid gap-2 rounded-lg border border-accent/30 bg-accent/5 p-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-[0.7rem] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Lock className="size-3 text-accent" /> hidden hand slot to play
            </span>
            <Select value={handSlot} onChange={(event) => setHandSlot(Number(event.target.value))}>
              {occupiedHandSlots.length === 0 ? <option value={0}>no card in hand</option> : null}
              {occupiedHandSlots.map((entry) => (
                <option key={entry.slot} value={entry.slot}>
                  slot {entry.slot} · {cardById(entry.cardId).name}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-[0.7rem] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Unlock className="size-3 text-primary" /> public board slot
            </span>
            <Select value={boardSlot} onChange={(event) => setBoardSlot(Number(event.target.value))}>
              {freeBoardSlots.map((slot) => (
                <option key={slot} value={slot}>
                  slot {slot}
                </option>
              ))}
            </Select>
          </label>
        </div>
      ) : null}

      {steps.some((step) => step.choice === 'attack') ? (
        <div className="mt-3 grid gap-2 rounded-lg border border-border bg-background/40 p-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-[0.7rem] text-muted-foreground">
            attacker board slot
            <Select
              value={attackerSlot}
              onChange={(event) => setAttackerSlot(Number(event.target.value))}
            >
              {readyAttackers.map((slot) => (
                <option key={slot} value={slot}>
                  slot {slot} · {cardById(attacker.boardCards[slot] ?? 1).name}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-[0.7rem] text-muted-foreground">
            target
            <Select value={targetSlot} onChange={(event) => setTargetSlot(Number(event.target.value))}>
              {targets.map((slot) => (
                <option key={slot} value={slot}>
                  slot {slot} · {cardById(defender.boardCards[slot] ?? 1).name}
                </option>
              ))}
              <option value={FACE}>face (only while the board is clear)</option>
            </Select>
          </label>
        </div>
      ) : null}

      <div className="mt-3 flex flex-col gap-1.5">
        {steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No move is legal in this state. Reset the duel to start another one.
          </p>
        ) : null}
        {steps.map((step) => (
          <button
            key={`${step.move}-${step.seat}`}
            type="button"
            disabled={disabled || busy !== null}
            onClick={() => onRun(step, choiceFor(step))}
            className="flex items-start gap-3 rounded-lg border border-border bg-background/40 px-3 py-2 text-left transition-colors hover:border-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Play className="mt-0.5 size-3.5 text-primary" />
            <span className="flex flex-1 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {step.label}
                <Badge tone="muted">seat {step.seat}</Badge>
                {step.provesLocally ? <Badge tone="accent">in-browser proof</Badge> : null}
              </span>
              <span className="text-[0.68rem] leading-relaxed text-muted-foreground">
                {step.detail}
              </span>
            </span>
          </button>
        ))}
      </div>

      {busy ? (
        <p className="mt-3 font-mono text-[0.7rem] text-primary">{busy}…</p>
      ) : null}
    </section>
  )
}
