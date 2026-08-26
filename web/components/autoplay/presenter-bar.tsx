'use client'

/**
 * The presenter's control, and the sentence the room reads.
 *
 * One button starts and stops the run; everything else on screen is the
 * console's own state. The narration is deliberately oversized - this is meant
 * to be legible from the back of a room - and it announces the step BEFORE it
 * runs, so the audience reads what is about to happen rather than reconstructing
 * what already did.
 *
 * Shared by the hidden-card duel and the two application demos so that
 * "press one button and watch" looks and behaves the same everywhere on this
 * site. What differs between them - the chips beside the narration, the noun in
 * the counter, any extra room setting - is passed in; nothing about the run
 * itself is.
 */
import {
  CircleCheck,
  Hourglass,
  MonitorPlay,
  Repeat,
  RotateCcw,
  Square,
  Timer,
  TriangleAlert,
} from 'lucide-react'
import { Select } from '@/components/ui/primitives'
import {
  AUTOPLAY_DELAYS,
  autoplayCompleted,
  type AutoplayRunState,
} from '@/lib/autoplay/run'

export function PresenterBar({
  state,
  running,
  canStart,
  onStart,
  onStop,
  onRestart,
  onDelayMs,
  onLoop,
  unit,
  chips,
  unavailable,
  settings,
  eyebrow = 'Presenter mode',
  startLabel = 'Auto-play demo',
  idleNarration = 'Starting…',
  compact = false,
}: {
  state: AutoplayRunState<unknown, unknown>
  running: boolean
  canStart: boolean
  onStart: () => void
  onStop: () => void
  onRestart: () => void
  onDelayMs: (value: number) => void
  onLoop: (value: boolean) => void
  /** The noun in the counter: "move" for the duel, "step" for a room run. */
  unit: string
  /** Rendered above the narration while a step is in flight. */
  chips?: React.ReactNode
  /** Why the run cannot start, when it cannot. */
  unavailable?: React.ReactNode
  /** Room settings a presenter chooses before starting, e.g. a deadline. */
  settings?: React.ReactNode
  eyebrow?: string
  startLabel?: string
  idleNarration?: string
  compact?: boolean
}) {
  const ended = state.status === 'ended' ? state.end : null
  const good = autoplayCompleted(ended)

  return (
    <section className="rounded-2xl border border-primary/30 bg-card/80 p-5 shadow-2xl shadow-black/20">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-primary">
          <MonitorPlay className="size-5" />
          <span className="font-mono text-xs tracking-[0.18em] uppercase">{eyebrow}</span>
        </div>
        <span className="font-mono text-[0.7rem] text-muted-foreground">
          {unit} {state.movesMade}/{state.maxMoves}
          {state.runs > 0 ? ` · run ${state.runs}` : null}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!canStart && !running}
          onClick={() => (running ? onStop() : onStart())}
          className={`inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            running
              ? 'bg-destructive text-background hover:bg-destructive/90'
              : 'bg-primary text-primary-foreground hover:bg-primary/90'
          }`}
        >
          {running ? <Square className="size-4" /> : <MonitorPlay className="size-4" />}
          {running ? 'Stop auto-play' : startLabel}
        </button>

        <label className="flex items-center gap-1.5 text-[0.7rem] text-muted-foreground">
          <Timer className="size-3.5" />
          step delay
          <Select
            className="h-8 w-24"
            value={state.delayMs}
            onChange={(event) => onDelayMs(Number(event.target.value))}
          >
            {AUTOPLAY_DELAYS.map((value) => (
              <option key={value} value={value}>
                {(value / 1000).toFixed(1)} s
              </option>
            ))}
          </Select>
        </label>

        <label className="flex items-center gap-1.5 text-[0.7rem] text-muted-foreground">
          <input
            type="checkbox"
            checked={state.loop}
            onChange={(event) => onLoop(event.target.checked)}
            className="size-3.5 accent-[var(--primary)]"
          />
          <Repeat className="size-3.5" />
          loop for an unattended stand
        </label>

        {settings}

        {!canStart && !running && unavailable ? (
          <span className="text-[0.7rem] text-warning">{unavailable}</span>
        ) : null}
      </div>

      {/*
        A held run is deliberately louder than the narration it sits above: a
        proof on a shared GPU is the single longest pause in any of these demos,
        and an unexplained pause reads as a hang.
      */}
      {running && state.hold && !compact ? (
        <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-accent/40 bg-accent/10 p-4 text-accent">
          <Hourglass className="mt-0.5 size-4 shrink-0 animate-pulse" />
          <div>
            <span className="font-mono text-[0.7rem] tracking-[0.18em] uppercase">
              autoplay waiting
            </span>
            <p className="mt-1 text-sm leading-relaxed">{state.hold}</p>
            <p className="mt-1 text-[0.7rem] text-muted-foreground">
              The run keeps its budget and resumes by itself; nothing was dropped.
            </p>
          </div>
        </div>
      ) : null}

      {running || state.narration ? (
        <div
          className={`duel-motion mt-2 rounded-xl border p-2 transition-colors ${
            state.acting ? 'border-primary/50 bg-primary/5' : 'border-border bg-background/40'
          }`}
        >
          <div className="flex flex-wrap items-center gap-2">
            {state.acting ? (
              chips
            ) : running ? (
              <span className="font-mono text-[0.7rem] tracking-wide text-muted-foreground uppercase">
                next up
              </span>
            ) : null}
          </div>
          <p className="mt-1 line-clamp-2 text-base leading-snug font-medium text-balance">
            {state.narration ?? idleNarration}
          </p>
        </div>
      ) : null}

      {ended && !compact ? (
        <div
          className={`mt-4 rounded-xl border p-4 ${
            good ? 'border-success/40 bg-success/10' : 'border-warning/40 bg-warning/10'
          }`}
        >
          <div className={`flex items-center gap-2 ${good ? 'text-success' : 'text-warning'}`}>
            {good ? <CircleCheck className="size-5" /> : <TriangleAlert className="size-5" />}
            <span className="text-base font-semibold">{ended.headline}</span>
          </div>
          <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            {ended.detail}
          </p>
          <button
            type="button"
            disabled={!canStart}
            onClick={onRestart}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCcw className="size-3.5" /> Restart the demo
          </button>
        </div>
      ) : null}
    </section>
  )
}
