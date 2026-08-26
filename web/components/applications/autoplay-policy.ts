'use client'

/**
 * What the two application demos are allowed to do to a stand that has one of
 * everything.
 *
 * There is a single GPU behind both panels and a single operator key behind
 * every L1 transaction the coordinator sends. A presenter WILL press both
 * buttons; when they first did, both runs reached their deploy in the same
 * moment and the coordinator answered the second with a raw
 * `eth_sendRawTransaction` failure - one key, two transactions, one nonce.
 * Observed on the reference stand, not hypothesized.
 *
 * So the shared claim below is what makes the second run wait and SAY it is
 * waiting, rather than race and be refused in front of a room. It is module
 * state on purpose: both hooks import this module, so both see one counter.
 */
import type { AutoplayEnd } from '@/lib/autoplay/run'
import type { DemoStepKind } from '@/lib/applications/application-run'

export const DEMO_BOUNDED_END: AutoplayEnd = {
  kind: 'bounded',
  headline: 'Demo run complete',
  detail:
    'Autoplay stopped at its step bound rather than running on. Every step it took was a real call to the coordinator on the same control plane the live room studio uses.',
}

export const DEMO_STOPPED_END: AutoplayEnd = {
  kind: 'stopped',
  headline: 'Autoplay stopped',
  detail:
    'The run was stopped by hand. A coordinator step already in flight finishes first, then this demo room is closed to new actions. Everything it accepted and every receipt remain visible.',
}

/** What the chip beside the narration says while a step is in flight. */
export const DEMO_STEP_LABELS: Record<DemoStepKind, string> = {
  system: 'reading the coordinator',
  prepare: 'proving the cold state',
  'await-template': 'waiting for the cold proof',
  open: 'opening the room',
  deploy: 'deploying on L1',
  action: 'submitting a room action',
  checkpoint: 'proving the batch',
}

/**
 * Steps that ASK the stand's single CUDA worker for new work, and therefore
 * wait while it is busy.
 *
 * `await-template` is deliberately NOT one of them even though it is entirely
 * about a proof: it submits nothing, it watches a job that is already running -
 * usually the one this run just started. Gating it on a busy prover would make
 * the run hold on its own cold proof and never resume, which is a deadlock, not
 * back-pressure.
 */
export const DEMO_GPU_STEPS: readonly DemoStepKind[] = ['prepare', 'checkpoint']

/**
 * How long a run will wait for the shared prover before giving up and saying
 * so. Generous - a queue of three room proofs is legitimately a couple of
 * minutes - but finite, because a silent unbounded wait is indistinguishable
 * from a hang on an unattended stand.
 */
export const DEMO_GPU_HOLD_LIMIT_MS = 10 * 60_000

/** Steps that make the coordinator send an L1 transaction from its own key. */
export const DEMO_L1_STEPS: readonly DemoStepKind[] = ['deploy', 'checkpoint']

/**
 * The proving deadlines a presenter can choose between, in seconds.
 *
 * Both applications are two room blocks and one batch, so they need far less
 * allowance than a duel; 120 s is the default anyway, because it is the number
 * a presenter has already seen on the duel and a shared GPU can put a queued
 * proof in front of either of them.
 */
export const DEMO_DEADLINE_SECONDS: readonly number[] = Object.freeze([60, 120, 240, 480])

let l1InFlight = 0

/** How many demos on this page are inside an L1-sending step right now. */
export function demoL1InFlight(): number {
  return l1InFlight
}

/**
 * Take the claim. Callers MUST take it synchronously, before their first
 * `await`, so a second run that fires in the next macrotask sees it.
 */
export function claimDemoL1(): void {
  l1InFlight += 1
}

export function releaseDemoL1(): void {
  l1InFlight = Math.max(0, l1InFlight - 1)
}
