export const DEMO_PHASES = [
  'DRAFT',
  'VALIDATED',
  'COLD_EXECUTING',
  'COLD_PROVING',
  'TEMPLATE_REGISTERED',
  'ROOM_READY',
  'DEPLOYED',
  'ACTIVE',
  'PROVING',
  'LOCALLY_VERIFIED',
  'L1_PENDING',
  'L1_ACCEPTED',
  'L1_FINALIZED',
] as const

export type DemoPhase = (typeof DEMO_PHASES)[number] | 'CLOSED' | 'FAILED'

export function phaseLabel(phase: DemoPhase): string {
  return {
    DRAFT: 'Draft',
    VALIDATED: 'Validated',
    COLD_EXECUTING: 'Cold state executing',
    COLD_PROVING: 'Cold proof running',
    TEMPLATE_REGISTERED: 'Template registered',
    ROOM_READY: 'Ready to deploy',
    DEPLOYED: 'Deployed',
    ACTIVE: 'Room active',
    PROVING: 'Room proof running',
    LOCALLY_VERIFIED: 'Locally verified',
    L1_PENDING: 'Waiting for L1',
    L1_ACCEPTED: 'Included on Ethereum · finality pending',
    L1_FINALIZED: 'Finalized on Ethereum',
    CLOSED: 'Closed',
    FAILED: 'Needs attention',
  }[phase]
}

export function phaseIndex(phase: DemoPhase): number {
  if (phase === 'FAILED') return -1
  if (phase === 'CLOSED') return DEMO_PHASES.length - 1
  return DEMO_PHASES.indexOf(phase)
}

export function shortReference(value: string | null | undefined): string {
  if (!value) return 'Not available'
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value
}

export function formatSeconds(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(milliseconds)) {
    return 'Pending'
  }
  return `${(milliseconds / 1_000).toFixed(milliseconds >= 10_000 ? 1 : 2)} s`
}

export function idempotencyKey(scope: string): string {
  const nonce =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${scope}:${nonce}`.replace(/[^a-zA-Z0-9._:-]/g, '-').slice(0, 128)
}

/**
 * The value as an http(s) URL, or null.
 *
 * Explorer links arrive as untyped JSON from the demo service and are rendered
 * straight into anchor `href`s. A compromised or misconfigured service could
 * therefore choose the destination of a user-visible link, and a non-http
 * scheme is at minimum an unintended navigation.
 */
export function httpLink(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

export function parseConstructorArgs(raw: string): readonly unknown[] {
  const trimmed = raw.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed)
  if (!Array.isArray(parsed)) throw new Error('Constructor arguments must be a JSON array.')
  return parsed
}

export function roomProgress(phase: DemoPhase): number {
  if (phase === 'FAILED') return 0
  if (phase === 'CLOSED') return 100
  const roomStart = DEMO_PHASES.indexOf('ROOM_READY')
  const position = Math.max(roomStart, phaseIndex(phase))
  return Math.round(((position - roomStart) / (DEMO_PHASES.length - 1 - roomStart)) * 100)
}
