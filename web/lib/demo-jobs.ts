/**
 * Waiting on a background coordinator job.
 *
 * Room deployment and checkpointing are both launched asynchronously and
 * answered with a job id, so the only honest way to report "it landed" is to
 * watch the job to completion and re-read the room afterwards. Every caller on
 * this site does that through here, so "the coordinator's failure explanation
 * is rethrown unchanged" is one rule rather than one per demo.
 *
 * A timeout is reported as STILL RUNNING, not as a loss: the room holds every
 * action it accepted either way, and a later checkpoint proves them.
 *
 * React-free.
 */
import { api } from '@/components/demo-console/api'

export interface DemoJobView {
  id: string
  phase: string
  finishedAt: string | null
  failure?: { explanation: string; recovery?: string }
}

export interface AwaitDemoJobOptions {
  readonly timeoutMs: number
  readonly pollMs?: number
  /** Called once per distinct coordinator phase, e.g. PROVING then L1_PENDING. */
  readonly onPhase?: (phase: string) => void
}

export async function awaitDemoJob(
  jobId: string,
  options: AwaitDemoJobOptions,
): Promise<void> {
  const pollMs = options.pollMs ?? 2_000
  const deadline = Date.now() + options.timeoutMs
  let phase: string | null = null
  for (;;) {
    const job = await api<DemoJobView>(`/demo/v1/jobs/${jobId}`)
    if (job.phase !== phase) {
      phase = job.phase
      options.onPhase?.(job.phase)
    }
    if (job.failure) throw new Error(job.failure.explanation)
    if (job.finishedAt !== null) return
    if (Date.now() > deadline) {
      throw new Error(
        `The coordinator job is still at ${job.phase} after ${Math.round(
          options.timeoutMs / 1000,
        )} s. Nothing was lost - the room still holds every action it accepted.`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

export function demoIdempotencyKey(prefix: string): string {
  const random =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${random}`.slice(0, 128)
}
