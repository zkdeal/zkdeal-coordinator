'use client'

/**
 * Kurtosis topology diagram - the SVG rail rendered inside the story player.
 *
 * The fixed node geometry and the always-drawn service edges live here with
 * the component that consumes them; per-event links come from `eventLinks`.
 * Split out of `components/kurtosis-story-player.tsx` unchanged.
 */

import type { KurtosisStory, StoryEvent, StoryNode } from '@/lib/kurtosis-stories'
import { TONE_COLOR, eventLinks } from '@/components/kurtosis-story-format'

const NODE_POSITIONS: Record<string, { x: number; y: number; w: number }> = {
  bench: { x: 78, y: 74, w: 126 },
  runtime: { x: 258, y: 74, w: 132 },
  'coordinator-0': { x: 472, y: 46, w: 152 },
  'coordinator-1': { x: 472, y: 132, w: 152 },
  prover: { x: 704, y: 74, w: 132 },
  'client-0': { x: 84, y: 286, w: 106 },
  'client-1': { x: 250, y: 286, w: 106 },
  'client-2': { x: 416, y: 286, w: 106 },
  'client-3': { x: 582, y: 286, w: 106 },
  'client-4': { x: 748, y: 286, w: 106 },
  'client-5': { x: 914, y: 286, w: 106 },
  'client-6': { x: 1_080, y: 286, w: 106 },
  builder: { x: 688, y: 490, w: 130 },
  geth: { x: 862, y: 490, w: 126 },
  'room-manager': { x: 1_048, y: 490, w: 148 },
  beacon: { x: 862, y: 606, w: 126 },
  validator: { x: 1_048, y: 606, w: 126 },
}

const BASE_EDGES: Array<[string, string]> = [
  ['bench', 'runtime'],
  ['runtime', 'coordinator-0'],
  ['runtime', 'coordinator-1'],
  ['coordinator-0', 'prover'],
  ['coordinator-1', 'prover'],
  ...Array.from({ length: 7 }, (_, index) => [`client-${index}`, 'coordinator-0'] as [string, string]),
  ['coordinator-0', 'builder'],
  ['builder', 'geth'],
  ['geth', 'room-manager'],
  ['geth', 'beacon'],
  ['validator', 'beacon'],
]

export function ProtocolGraph({
  nodes,
  story,
  event,
  eventProgress,
}: {
  nodes: StoryNode[]
  story: KurtosisStory
  event: StoryEvent
  eventProgress: number
}) {
  const links = eventLinks(event).filter(([from, to]) => from !== to && NODE_POSITIONS[from] && NODE_POSITIONS[to])
  const touched = new Set([...event.from, ...event.to])
  const activeClients = story.activeMembers === 1 && story.id === 'builder-censor'
    ? new Set(['client-6'])
    : new Set(Array.from({ length: story.activeMembers }, (_, index) => `client-${index}`))
  const nodeState = (node: StoryNode) => {
    const override = event.nodeStates?.[node.id]
    if (override) return override
    if (node.id === 'coordinator-0') return 'active'
    if (node.id === 'coordinator-1') return 'standby'
    if (node.kind === 'client') return activeClients.has(node.id) ? 'active' : 'standby'
    return 'standby'
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-background/35" role="img" aria-label={`Kurtosis topology during ${event.title}`}>
      <svg viewBox="0 0 1200 670" className="min-w-[760px]" aria-hidden="true">
        <defs>
          <marker id="story-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted-foreground)" />
          </marker>
          <marker id="story-arrow-active" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={TONE_COLOR[event.tone]} />
          </marker>
        </defs>
        <rect x="24" y="18" width="792" height="170" rx="16" fill="var(--muted)" opacity="0.22" />
        <text x="42" y="42" fill="var(--muted-foreground)" fontSize="15">CONTROL + PROVING</text>
        <rect x="24" y="214" width="1152" height="150" rx="16" fill="var(--muted)" opacity="0.18" />
        <text x="42" y="240" fill="var(--muted-foreground)" fontSize="15">SEVEN INDEPENDENT MEMBER CLIENT SERVICES</text>
        <rect x="630" y="410" width="546" height="240" rx="16" fill="var(--muted)" opacity="0.22" />
        <text x="648" y="436" fill="var(--muted-foreground)" fontSize="15">L1 · GETH + LIGHTHOUSE · 12 SECOND SLOTS</text>

        {BASE_EDGES.map(([from, to]) => {
          const a = NODE_POSITIONS[from]!
          const b = NODE_POSITIONS[to]!
          return <line key={`${from}-${to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--border)" strokeWidth="2" markerEnd="url(#story-arrow)" />
        })}
        {links.map(([from, to], index) => {
          const a = NODE_POSITIONS[from]!
          const b = NODE_POSITIONS[to]!
          const x = a.x + (b.x - a.x) * eventProgress
          const y = a.y + (b.y - a.y) * eventProgress
          return (
            <g key={`${from}-${to}-${index}`}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={TONE_COLOR[event.tone]} strokeWidth="4" markerEnd="url(#story-arrow-active)" opacity="0.85" />
              <circle cx={x} cy={y} r="7" fill={TONE_COLOR[event.tone]} stroke="var(--background)" strokeWidth="3" />
            </g>
          )
        })}

        {nodes.map((node) => {
          const position = NODE_POSITIONS[node.id]
          if (!position) return null
          const state = nodeState(node)
          const stateColor = state === 'restarting' || state === 'rejected' || state === 'retired'
            ? 'var(--destructive)'
            : touched.has(node.id)
              ? TONE_COLOR[event.tone]
              : state === 'active'
                ? 'var(--primary)'
              : 'var(--border)'
          const surface = touched.has(node.id) ? 'var(--accent)' : state === 'active' ? 'var(--secondary)' : 'var(--card)'
          const opacity = state === 'standby' ? 0.58 : 1
          return (
            <g key={node.id} opacity={opacity}>
              <rect
                x={position.x - position.w / 2}
                y={position.y - 27}
                width={position.w}
                height="54"
                rx={node.kind === 'client' ? 27 : 10}
                fill={surface}
                stroke={stateColor}
                strokeWidth={touched.has(node.id) ? 3 : 2}
              />
              {node.kind === 'coordinator' || node.kind === 'prover' ? (
                <image
                  href="/zkdeal-icon.ico"
                  x={position.x - position.w / 2 + 8}
                  y={position.y - 17}
                  width="30"
                  height="30"
                  preserveAspectRatio="xMidYMid meet"
                />
              ) : null}
              <text x={position.x} y={position.y - 2} textAnchor="middle" fill="var(--foreground)" fontSize="14" fontWeight="500">{node.label}</text>
              <text x={position.x} y={position.y + 16} textAnchor="middle" fill="var(--muted-foreground)" fontSize="11">
                {state === 'standby' && node.kind === 'client' ? 'ready' : state}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
