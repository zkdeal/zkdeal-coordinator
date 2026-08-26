'use client'

/**
 * Side panels of the Kurtosis story player: the per-event inspector and the
 * assumption / guarantee / not-guaranteed boundary lists.
 *
 * Split out of `components/kurtosis-story-player.tsx` unchanged. The boundary
 * lists are claim copy - they are what the page promises and what it refuses
 * to promise - so they are kept together and away from the playback logic.
 */

import { CheckCircle2 } from 'lucide-react'
import { Badge } from '@/components/ui/primitives'
import type { KurtosisStory, StoryEvent } from '@/lib/kurtosis-stories'
import { PHASE_LABEL, formatMs } from '@/components/kurtosis-story-format'

export function EventInspector({ event, story }: { event: StoryEvent; story: KurtosisStory }) {
  const rows = Object.entries(event.data)
  return (
    <aside className="rounded-lg border border-border bg-background/40 p-4">
      <div className="flex items-center justify-between gap-2">
        <Badge tone={event.tone === 'accepted' ? 'success' : event.tone === 'rejected' ? 'danger' : event.tone === 'fault' ? 'warn' : 'info'}>
          {PHASE_LABEL[event.phase]}
        </Badge>
        <span className="font-mono text-xs text-muted-foreground">{formatMs(event.durationMs)}</span>
      </div>
      <h2 className="mt-3 text-base font-semibold">{event.title}</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{event.detail}</p>
      <div className="mt-3 flex flex-wrap gap-1 text-[0.7rem] text-muted-foreground">
        {event.from.map((item) => <span key={`from-${item}`} className="rounded bg-muted px-1.5 py-0.5 font-mono">{item}</span>)}
        <span className="px-1">→</span>
        {event.to.map((item) => <span key={`to-${item}`} className="rounded bg-muted px-1.5 py-0.5 font-mono">{item}</span>)}
      </div>
      <div className="mt-4 border-t border-border pt-3">
        <p className="mb-2 text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase">Security-relevant data</p>
        {rows.length ? (
          <dl className="space-y-2">
            {rows.map(([label, value]) => (
              <div key={label} className="grid gap-0.5">
                <dt className="text-[0.7rem] text-muted-foreground">{label}</dt>
                <dd className="break-all font-mono text-xs leading-5 text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        ) : <p className="text-xs text-muted-foreground">No additional payload for this event.</p>}
      </div>
      {story.observed && (
        <div className="mt-4 border-t border-border pt-3">
          <p className="flex items-center gap-1.5 text-[0.7rem] font-medium tracking-wide text-success uppercase"><CheckCircle2 className="size-3.5" /> Run observation</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{story.observed}</p>
        </div>
      )}
    </aside>
  )
}

export function BoundaryPanel({
  icon,
  title,
  items,
  tone,
}: {
  icon: React.ReactNode
  title: string
  items: string[]
  tone: 'warning' | 'success' | 'muted'
}) {
  const colors = tone === 'success'
    ? 'border-success/25 bg-success/[0.055] text-success'
    : tone === 'warning'
      ? 'border-warning/25 bg-warning/[0.055] text-warning'
      : 'border-border bg-card text-muted-foreground'
  return (
    <section className={`rounded-lg border p-4 ${colors}`}>
      <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <span className="[&_svg]:size-4">{icon}</span> {title}
      </h2>
      <ul className="mt-3 space-y-2 text-xs leading-5 text-muted-foreground">
        {items.map((item) => <li key={item}>• {item}</li>)}
      </ul>
    </section>
  )
}
