import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertCardArtifactBytes,
  cardArtifactPlan,
  cardProvingGate,
  cardSha256Hex,
  loadCardArtifacts,
  readCardCircuitsConfig,
  type CardCircuitsConfig,
} from '../lib/card/artifacts'

/**
 * The gate that decides whether this stand may prove at all.
 *
 * It has to fail loudly and specifically: `circuits/build/card/**` is
 * gitignored, so on a clean clone the honest answer is "not built here, run
 * this command", and the tempting alternatives - a server-side prover, or a
 * rendered proof that was never produced - would each make the page a lie.
 *
 * The lock is read from the repository rather than fabricated, so a change to
 * `circuits/card-artifacts.lock.json` that the browser plan cannot consume
 * fails here instead of at a download.
 */
const LOCK_PATH = join(__dirname, '..', '..', '..', 'web3-protocol', 'circuits', 'card-artifacts.lock.json')
const lock: unknown = JSON.parse(readFileSync(LOCK_PATH, 'utf8'))

function sectionFrom(available: boolean): CardCircuitsConfig {
  const plan = cardArtifactPlan(lock)
  return {
    lockUrl: '/artifacts/circuits/card-artifacts.lock.json',
    ceremony: 'uncontributed-demo-only',
    provingArtifactsAvailable: available,
    files: plan.map((pin) => ({
      circuit: pin.circuit,
      kind: pin.kind,
      url: `/artifacts/circuits/${pin.path}`,
      bytes: pin.bytes,
      sha256: pin.sha256,
      available,
    })),
  }
}

describe('card proving artifact plan', () => {
  it('derives wasm, zkey and vkey pins for both circuits from the tracked lock', () => {
    const plan = cardArtifactPlan(lock)
    expect(plan).toHaveLength(6)
    expect(new Set(plan.map((pin) => pin.circuit))).toEqual(
      new Set(['deck-init-v4', 'hand-action-v4']),
    )
    for (const pin of plan) {
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(pin.bytes).toBeGreaterThan(0)
      expect(pin.path.startsWith('/')).toBe(false)
    }
  })

  it('refuses a lock whose format it does not recognise', () => {
    expect(() => cardArtifactPlan({ format: 'something/else', circuits: {} })).toThrow(
      /unexpected card artifact lock format/,
    )
  })

  it('refuses a lock that omits a proving key rather than planning around it', () => {
    const damaged = JSON.parse(JSON.stringify(lock)) as {
      circuits: Record<string, { distribution: Record<string, unknown> }>
    }
    delete damaged.circuits['hand-action-v4']!.distribution.zkey
    expect(() => cardArtifactPlan(damaged)).toThrow(/no zkey distribution entry/)
  })
})

describe('card proving gate', () => {
  it('names the missing file and the command that builds it', () => {
    const gate = cardProvingGate(sectionFrom(false))
    expect(gate.ready).toBe(false)
    expect(gate.missing.length).toBeGreaterThan(0)
    expect(gate.missing.join('\n')).toContain('pnpm --filter @zkdeal/circuits build:card')
    expect(gate.missing.every((reason) => reason.length > 20)).toBe(true)
  })

  it('reports a coordinator that publishes no lock at all', () => {
    const gate = cardProvingGate(null)
    expect(gate.ready).toBe(false)
    expect(gate.missing[0]).toContain('cardCircuits')
    expect(gate.ceremony).toBeNull()
  })

  it('is ready only when every proving artifact is actually present', () => {
    const gate = cardProvingGate(sectionFrom(true))
    // `Worker` is absent in the Node test environment, which is itself one of
    // the gate's reasons - assert on the artifact half specifically.
    expect(gate.missing.some((reason) => reason.includes('build:card'))).toBe(false)
    expect(gate.downloadBytes).toBeGreaterThan(20_000_000)
    expect(gate.ceremony).toBe('uncontributed-demo-only')
  })

  it('ignores a /config section that is not shaped like a distribution', () => {
    expect(readCardCircuitsConfig({})).toBeNull()
    expect(readCardCircuitsConfig({ cardCircuits: { lockUrl: 7 } })).toBeNull()
    expect(
      readCardCircuitsConfig({
        cardCircuits: { lockUrl: '/x', files: [{ circuit: 'a', kind: 'wasm', url: '/y', bytes: 1, sha256: 'nope' }] },
      }),
    ).toBeNull()
  })
})

describe('downloaded artifacts are checked before they can prove', () => {
  const pin = { circuit: 'deck-init-v4', kind: 'wasm', path: 'x.wasm', bytes: 3, sha256: '' } as const

  it('reports a truncated transfer as a length problem, not a digest problem', async () => {
    const bytes = Uint8Array.from([1, 2, 3])
    const expected = { ...pin, sha256: await cardSha256Hex(bytes) }
    await expect(assertCardArtifactBytes(expected, Uint8Array.from([1, 2]))).rejects.toThrow(
      /is 2 bytes, the lock pins 3/,
    )
    await expect(assertCardArtifactBytes(expected, bytes)).resolves.toBeUndefined()
  })

  it('refuses a substituted proving key of the right length', async () => {
    const expected = { ...pin, sha256: await cardSha256Hex(Uint8Array.from([1, 2, 3])) }
    await expect(assertCardArtifactBytes(expected, Uint8Array.from([9, 9, 9]))).rejects.toThrow(
      /does not match the pinned/,
    )
  })

  it('stops the whole load when one artifact fails its digest', async () => {
    const section = sectionFrom(true)
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('card-artifacts.lock.json')) {
        return new Response(JSON.stringify(lock), { status: 200 })
      }
      // Right length is impossible to fake cheaply, so this trips the length
      // check first - which is exactly the message an operator needs.
      return new Response(new Uint8Array([0, 1, 2]), { status: 200 })
    }) as typeof fetch
    await expect(loadCardArtifacts(section, { fetchImpl })).rejects.toThrow(/bytes, the lock pins/)
  })
})
