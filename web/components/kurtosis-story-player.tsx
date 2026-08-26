'use client'

/**
 * /kurtosis story player - run selection, playback clock and the panels the
 * page composes.
 *
 * The presentation tables and pure formatters live in
 * `components/kurtosis-story-format.ts`; the SVG topology and the two side
 * panels live in `components/kurtosis-protocol-graph.tsx` and
 * `components/kurtosis-event-inspector.tsx`.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  FileUp,
  Gauge,
  Network,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge, Panel, Select, StatTile } from '@/components/ui/primitives'
import {
  createReferenceKurtosisBundle,
  parseKurtosisStoryBundle,
  type KurtosisStoryBundle,
  type StoryPhase,
} from '@/lib/kurtosis-stories'
import {
  PHASE_COLOR,
  PHASE_LABEL,
  currentEventIndex,
  formatMs,
  importedRunKey,
  phaseTotals,
  short,
  totalMs,
} from '@/components/kurtosis-story-format'
import { ProtocolGraph } from '@/components/kurtosis-protocol-graph'
import { BoundaryPanel, EventInspector } from '@/components/kurtosis-event-inspector'

export function KurtosisStoryPlayer() {
  const [runs, setRuns] = useState<KurtosisStoryBundle[]>(() => [createReferenceKurtosisBundle()])
  const [runIndex, setRunIndex] = useState(0)
  const [storyId, setStoryId] = useState('dynamic-membership-frozen-retire')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [loadError, setLoadError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const bundle = runs[runIndex] ?? runs[0]!
  const story = bundle.stories.find((item) => item.id === storyId) ?? bundle.stories[0]!
  const durationMs = totalMs(story)
  const eventIndex = currentEventIndex(story.events, elapsedMs)
  const selectedEvent = story.events[eventIndex]!
  const eventProgress = Math.max(0, Math.min(1, (elapsedMs - selectedEvent.atMs) / selectedEvent.durationMs))

  useEffect(() => {
    setPlaying(false)
    setElapsedMs(0)
  }, [runIndex, storyId])

  useEffect(() => {
    if (!playing) return
    let frame = 0
    let previous = performance.now()
    const scale = durationMs / 14_000
    const tick = (now: number) => {
      const delta = now - previous
      previous = now
      setElapsedMs((value) => {
        const next = value + delta * speed * scale
        if (next >= durationMs) {
          setPlaying(false)
          return durationMs - 1
        }
        return next
      })
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [durationMs, playing, speed])

  const compatibleRuns = useMemo(() => runs.flatMap((candidate, index) => {
    const candidateStory = candidate.stories.find((item) => item.id === story.id)
    return candidateStory ? [{ bundle: candidate, story: candidateStory, index }] : []
  }), [runs, story.id])

  const jump = (index: number) => {
    const next = Math.max(0, Math.min(story.events.length - 1, index))
    setPlaying(false)
    setElapsedMs(story.events[next]!.atMs)
  }

  const loadRuns = async (files: FileList | null) => {
    if (!files?.length) return
    setLoadError(null)
    const loaded: KurtosisStoryBundle[] = []
    try {
      for (const file of Array.from(files)) {
        if (file.size > 5 * 1024 * 1024) throw new Error(`${file.name} exceeds the 5 MB trace limit`)
        loaded.push(parseKurtosisStoryBundle(await file.text()))
      }
      setRuns((current) => [...current, ...loaded])
      setRunIndex(runs.length)
      const matching = loaded[0]?.stories.find((item) => item.id === storyId)
      if (!matching && loaded[0]?.stories[0]) setStoryId(loaded[0].stories[0].id)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" />
            <Image src="/zkdeal-icon.ico" alt="" width={24} height={24} />
            zkdeal
          </Link>
          <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
            <Network className="size-4 text-primary" />
            Kurtosis story player
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-[1500px] flex-col gap-5 px-4 py-6 sm:px-6">
        <section className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Proof-room execution, event by event</h1>
              <Badge tone={bundle.run.status === 'COMPLETE' ? 'success' : bundle.run.status === 'FAILED' ? 'danger' : 'warn'}>
                {bundle.run.status === 'COMPLETE' ? 'MEASURED RUN' : bundle.run.status === 'FAILED' ? 'FAILED RUN' : 'UNMEASURED REFERENCE'}
              </Badge>
              {/* The bundle states its own generation; an imported trace must
                  not inherit the chrome of the built-in reference. */}
              <Badge tone="info">PROTOCOL V{bundle.run.protocolVersion}</Badge>
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
              Follow who executed, replayed, signed, sealed, submitted, proposed, and verified each transition. Import the
              trace emitted by any Kurtosis run to replace reference timing and identifiers with that machine&apos;s evidence.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-52 flex-col gap-1 text-xs text-muted-foreground">
              Run
              <Select value={runIndex} onChange={(event) => setRunIndex(Number(event.target.value))}>
                {runs.map((item, index) => (
                  <option key={importedRunKey(item, index)} value={index}>
                    {item.run.label}{item.run.gpuName ? ` · ${item.run.gpuName}` : ''}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex min-w-72 flex-col gap-1 text-xs text-muted-foreground">
              Story
              <Select value={story.id} onChange={(event) => setStoryId(event.target.value)}>
                <optgroup label="Recovery">
                  {bundle.stories.filter((item) => item.category === 'recovery').map((item) => (
                    <option key={item.id} value={item.id}>{item.title}</option>
                  ))}
                </optgroup>
                <optgroup label="Adversary">
                  {bundle.stories.filter((item) => item.category === 'adversary').map((item) => (
                    <option key={item.id} value={item.id}>{item.title}</option>
                  ))}
                </optgroup>
              </Select>
            </label>
            <input
              ref={inputRef}
              type="file"
              accept="application/json,.json"
              multiple
              className="sr-only"
              aria-label="Load Kurtosis story traces"
              onChange={(event) => void loadRuns(event.target.files)}
            />
            <Button variant="outline" onClick={() => inputRef.current?.click()}>
              <FileUp /> Load run trace
            </Button>
          </div>
        </section>

        {loadError && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" /> {loadError}
          </div>
        )}

        <section className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
          <StatTile label="Kurtosis services" value={bundle.topology.countedServices} hint={`${bundle.topology.persistentServices} persistent + runner`} />
          <StatTile label="Member clients" value={bundle.topology.memberClients} hint={`${story.activeMembers} active in this room`} />
          <StatTile label="Coordinators" value={bundle.topology.coordinators} hint="active + standby" />
          <StatTile label="L1 slot" value={`${bundle.run.l1SlotSeconds}s`} hint={bundle.run.l1} />
          <StatTile label="GPU" value={bundle.run.gpuName ?? 'not measured'} hint={short(bundle.run.gpuUuid)} tone={bundle.run.gpuName ? 'ok' : 'warn'} />
          <StatTile label="Canonical median" value={formatMs(bundle.run.canonicalMedianMs)} hint={bundle.run.timingSource === 'measured-canonical-median' ? 'run median profile' : 'reference sequence'} tone={bundle.run.canonicalMedianMs ? 'info' : 'warn'} />
        </section>

        <Panel
          title={story.title}
          subtitle={`${story.category} · ${story.id} · ${story.events.length} trace events`}
          action={<Badge tone={story.status === 'COMPLETE' ? 'success' : story.status === 'FAILED' ? 'danger' : 'muted'}>{story.status}</Badge>}
          className="overflow-hidden"
        >
          <p className="mb-4 max-w-4xl text-sm leading-6 text-muted-foreground">{story.summary}</p>
          <div className="flex flex-wrap items-center gap-2 border-y border-border py-3">
            <Button size="icon" variant="outline" aria-label="Restart story" onClick={() => { setPlaying(false); setElapsedMs(0) }}>
              <RotateCcw />
            </Button>
            <Button size="icon" variant="outline" aria-label="Previous event" disabled={eventIndex === 0} onClick={() => jump(eventIndex - 1)}>
              <ChevronLeft />
            </Button>
            <Button
              className="min-w-24"
              onClick={() => {
                if (elapsedMs >= durationMs - 1) setElapsedMs(0)
                setPlaying((value) => !value)
              }}
            >
              {playing ? <Pause /> : <Play />}{playing ? 'Pause' : 'Play'}
            </Button>
            <Button size="icon" variant="outline" aria-label="Next event" disabled={eventIndex === story.events.length - 1} onClick={() => jump(eventIndex + 1)}>
              <ChevronRight />
            </Button>
            <label className="ml-1 flex items-center gap-2 text-xs text-muted-foreground">
              Speed
              <Select className="w-24" value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
                <option value={0.25}>0.25×</option>
                <option value={0.5}>0.5×</option>
                <option value={1}>1×</option>
                <option value={2}>2×</option>
              </Select>
            </label>
            <span className="ml-auto font-mono text-xs text-muted-foreground">
              {formatMs(elapsedMs)} / {formatMs(durationMs)} · event {eventIndex + 1}/{story.events.length}
            </span>
          </div>
          <label className="mt-3 block text-xs text-muted-foreground">
            <span className="sr-only">Story position</span>
            <input
              type="range"
              min={0}
              max={durationMs - 1}
              step={1}
              value={Math.min(elapsedMs, durationMs - 1)}
              onChange={(event) => { setPlaying(false); setElapsedMs(Number(event.target.value)) }}
              className="w-full accent-primary"
            />
          </label>

          <div className="mt-4 grid gap-4 2xl:grid-cols-[minmax(0,1fr)_380px]">
            <ProtocolGraph
              nodes={bundle.topology.nodes}
              story={story}
              event={selectedEvent}
              eventProgress={eventProgress}
            />
            <EventInspector event={selectedEvent} story={story} />
          </div>
        </Panel>

        <section className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(360px,0.55fr)]">
          <Panel title="L1 production rail" subtitle="Only blocks or simulations that matter to this story">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {story.events.filter((item) => item.l1).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => jump(story.events.indexOf(item))}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    item.id === selectedEvent.id ? 'border-primary bg-primary/10' : 'border-border bg-background/40 hover:bg-muted/50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">{item.l1?.blockNumber ? `Block #${item.l1.blockNumber}` : item.l1?.slot ? `Slot ${item.l1.slot}` : 'No new block'}</span>
                    <Badge tone={item.l1?.status === 'accepted' ? 'success' : item.l1?.status === 'simulated' ? 'muted' : 'danger'}>{item.l1?.status}</Badge>
                  </div>
                  {item.l1?.txHash && <p className="mt-2 font-mono text-[0.68rem] text-muted-foreground">tx {short(item.l1.txHash, 10, 8)}</p>}
                  <ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
                    {item.l1?.contents.map((content) => <li key={content}>• {content}</li>)}
                  </ul>
                </button>
              ))}
            </div>
          </Panel>

          <Panel title="Run identity" subtitle="Keep this attached to every comparison">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
              <dt className="text-muted-foreground">Label</dt><dd className="font-mono text-right">{bundle.run.label}</dd>
              <dt className="text-muted-foreground">Generated</dt><dd className="font-mono text-right">{bundle.generatedAt ?? 'not run'}</dd>
              <dt className="text-muted-foreground">GPU / CUDA</dt><dd className="font-mono text-right">{bundle.run.gpuName ?? '-'} / {bundle.run.cudaVersion ?? '-'}</dd>
              <dt className="text-muted-foreground">RISC Zero</dt><dd className="font-mono text-right">{bundle.run.risc0Version ?? '-'}</dd>
              <dt className="text-muted-foreground">Git</dt><dd className="break-all font-mono text-right">{short(bundle.run.gitCommit, 12, 8)}{bundle.run.dirtyTree ? ' · dirty' : ''}</dd>
              <dt className="text-muted-foreground">Preset</dt><dd className="break-all font-mono text-right">{short(bundle.run.presetHash, 12, 8)}</dd>
              <dt className="text-muted-foreground">Program</dt><dd className="break-all font-mono text-right">{short(bundle.run.proofProgramId, 12, 8)}</dd>
            </dl>
          </Panel>
        </section>

        <Panel title="Loaded-run timing" subtitle="Stage shape changes when imported hardware or network evidence changes">
          <div className="space-y-4">
            {compatibleRuns.map(({ bundle: candidate, story: candidateStory, index }) => {
              const phases = phaseTotals(candidateStory)
              const total = totalMs(candidateStory)
              return (
                <button key={importedRunKey(candidate, index)} type="button" onClick={() => setRunIndex(index)} className="block w-full text-left">
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className={index === runIndex ? 'font-medium text-foreground' : 'text-muted-foreground'}>
                      {candidate.run.label} · {candidate.run.gpuName ?? 'reference'}
                    </span>
                    <span className="font-mono text-muted-foreground">story {formatMs(total)} · canonical median {formatMs(candidate.run.canonicalMedianMs)}</span>
                  </div>
                  <div className={`flex h-4 overflow-hidden rounded-sm ${index === runIndex ? 'ring-1 ring-primary' : 'ring-1 ring-border'}`}>
                    {phases.map((phase) => (
                      <span
                        key={phase.phase}
                        style={{ width: `${(phase.value / total) * 100}%`, backgroundColor: PHASE_COLOR[phase.phase] }}
                        aria-label={`${PHASE_LABEL[phase.phase]} ${formatMs(phase.value)}`}
                      />
                    ))}
                  </div>
                </button>
              )
            })}
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-[0.7rem] text-muted-foreground">
              {Object.entries(PHASE_LABEL).map(([phase, label]) => (
                <span key={phase} className="flex items-center gap-1.5">
                  <span className="size-2 rounded-sm" style={{ backgroundColor: PHASE_COLOR[phase as StoryPhase] }} /> {label}
                </span>
              ))}
            </div>
          </div>
        </Panel>

        <section className="grid gap-4 lg:grid-cols-3">
          <BoundaryPanel icon={<CircleAlert />} title="Assumptions" items={[...bundle.assumptions, ...story.assumptions]} tone="warning" />
          <BoundaryPanel icon={<ShieldCheck />} title="Guarantees" items={[...bundle.guarantees, ...story.guarantees]} tone="success" />
          <BoundaryPanel icon={<Gauge />} title="Not guaranteed" items={[...bundle.doesNotGuarantee, ...story.doesNotGuarantee]} tone="muted" />
        </section>

        <p className="pb-4 text-xs leading-5 text-muted-foreground">{bundle.topology.note}</p>
      </main>
    </div>
  )
}
