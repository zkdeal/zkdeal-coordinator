'use client'

/**
 * The duel's presenter control.
 *
 * The bar itself - the button, the pacing selector, the loop switch, the hold
 * banner, the oversized narration and the end card - is the shared
 * `components/autoplay/presenter-bar.tsx`, which the two application demos
 * render as well. What is here is only what is about the DUEL: which seat is
 * moving, what the move is called in plain language, and the fact that the
 * proof for it is being produced in this tab rather than on a server.
 */
import { LoaderCircle } from 'lucide-react'
import { PresenterBar } from '@/components/autoplay/presenter-bar'
import { Badge } from '@/components/ui/primitives'
import type { CardAutoplayControls } from './use-card-autoplay'

const MOVE_TITLES: Record<string, string> = {
  registerDuelist: 'registering',
  openDuel: 'opening the duel',
  joinDuel: 'joining the duel',
  abandonDuel: 'abandoning',
  initializeDeck: 'committing a shuffled deck',
  commitSeed: 'committing a seed',
  revealSeed: 'revealing a seed',
  draw: 'drawing a hidden card',
  burn: 'burning the drawn card',
  play: 'playing a card face-up',
  attack: 'attacking',
  endTurn: 'ending the turn',
  concede: 'conceding',
  claimPrize: 'claiming the pot',
}

export function AutoplayBar({ autoplay }: { autoplay: CardAutoplayControls }) {
  const { state, running, canStart } = autoplay
  const acting = state.acting

  return (
    <PresenterBar
      state={state}
      running={running}
      canStart={canStart}
      onStart={autoplay.start}
      onStop={autoplay.stop}
      onRestart={autoplay.restart}
      onDelayMs={autoplay.setDelayMs}
      onLoop={autoplay.setLoop}
      unit="move"
      idleNarration="Starting the duel…"
      unavailable="The prover is not armed yet - fetch and verify the artifacts above."
      chips={
        acting ? (
          <>
            <Badge tone="primary">seat {acting.seat}</Badge>
            <span className="font-mono text-[0.7rem] tracking-wide text-primary uppercase">
              {MOVE_TITLES[acting.move] ?? acting.move}
            </span>
            {acting.proving ? (
              <span className="duel-proving inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-2 py-0.5 font-mono text-[0.7rem] text-accent">
                <LoaderCircle className="size-3 animate-spin" />
                proving in this tab
              </span>
            ) : null}
          </>
        ) : null
      }
    />
  )
}
