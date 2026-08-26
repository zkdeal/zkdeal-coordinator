/**
 * Presentation tables and pure formatters for the Kurtosis story player.
 *
 * Split out of `components/kurtosis-story-player.tsx`: the phase/tone colour
 * tables are indexed by the validated `StoryPhase` / `StoryTone` unions (see
 * lib/kurtosis-stories.ts, which whitelists both on import), and the helpers
 * below are pure functions over an already-parsed bundle. No React.
 */

import type {
  KurtosisStory,
  KurtosisStoryBundle,
  StoryEvent,
  StoryPhase,
  StoryTone,
} from '@/lib/kurtosis-stories'

export const PHASE_LABEL: Record<StoryPhase, string> = {
  control: 'Control',
  'l2-execution': 'L2 execute',
  replay: 'Replay',
  approval: 'Sign',
  proving: 'Prove',
  recovery: 'Recover',
  adversary: 'Fault',
  'l1-submission': 'L1 submit',
  'l1-consensus': 'L1 block',
  'l1-verification': 'L1 verify',
}

export const PHASE_COLOR: Record<StoryPhase, string> = {
  control: 'var(--muted-foreground)',
  'l2-execution': 'var(--chart-1)',
  replay: 'var(--chart-1)',
  approval: 'var(--chart-2)',
  proving: 'var(--chart-3)',
  recovery: 'var(--chart-4)',
  adversary: 'var(--destructive)',
  'l1-submission': 'var(--chart-5)',
  'l1-consensus': 'var(--chart-5)',
  'l1-verification': 'var(--chart-3)',
}

export const TONE_COLOR: Record<StoryTone, string> = {
  neutral: 'var(--muted-foreground)',
  active: 'var(--primary)',
  accepted: 'var(--success)',
  rejected: 'var(--destructive)',
  fault: 'var(--warning)',
}

export function totalMs(story: KurtosisStory): number {
  return Math.max(1, ...story.events.map((event) => event.atMs + event.durationMs))
}

export function formatMs(value: number | null): string {
  if (value === null) return '-'
  if (value < 1_000) return `${Math.round(value)} ms`
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1)} s`
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`
}

export function short(value: string | null, start = 8, end = 6): string {
  if (!value) return '-'
  if (value.length <= start + end + 3) return value
  return `${value.slice(0, start)}…${value.slice(-end)}`
}

export function currentEventIndex(events: StoryEvent[], elapsedMs: number): number {
  let index = 0
  for (let i = 0; i < events.length; i += 1) {
    if (events[i]!.atMs <= elapsedMs) index = i
    else break
  }
  return index
}

export function eventLinks(event: StoryEvent): Array<[string, string]> {
  if (event.from.length === 0 || event.to.length === 0) return []
  if (event.from.length === 1) return event.to.map((target) => [event.from[0]!, target])
  if (event.to.length === 1) return event.from.map((source) => [source, event.to[0]!])
  const length = Math.max(event.from.length, event.to.length)
  return Array.from({ length }, (_, index) => [
    event.from[index % event.from.length]!,
    event.to[index % event.to.length]!,
  ])
}

export function phaseTotals(story: KurtosisStory): Array<{ phase: StoryPhase; value: number }> {
  const totals = new Map<StoryPhase, number>()
  for (const event of story.events) totals.set(event.phase, (totals.get(event.phase) ?? 0) + event.durationMs)
  return [...totals].map(([phase, value]) => ({ phase, value }))
}

export function importedRunKey(bundle: KurtosisStoryBundle, index: number): string {
  return `${bundle.run.label}:${bundle.generatedAt ?? 'reference'}:${bundle.run.gpuUuid ?? index}`
}
