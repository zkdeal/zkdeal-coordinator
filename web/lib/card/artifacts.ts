/**
 * Obtaining the ~25.6 MB of circom proving artifacts a browser needs before it
 * can produce a single inner Groth16 proof, and refusing to prove without them.
 *
 * `circuits/build/card/**` is gitignored, so a clean clone and most CI runners
 * have none of these files. The coordinator publishes a `cardCircuits` section
 * in `/config` describing where they live and whether THIS machine actually
 * built them (`server/src/card-artifacts.ts`). This module turns that into a
 * gate with a specific reason, because the alternative - quietly falling back
 * to a server-side prover, or rendering a fabricated proof - would make the
 * whole demonstration a lie.
 *
 * `card-artifacts.lock.json` is the trust root, not `/config`. The digests
 * repeated in the config section are a convenience for deciding whether to
 * start a multi-megabyte download; every fetched byte is checked against the
 * lock itself. The check mirrors `circuits/src/card-artifact-manifest.ts`
 * rather than importing it, because `@zkdeal/circuits` is a build package and
 * is not - and should not become - a dependency of the browser bundle.
 *
 * DEMO ONLY, and the UI is required to repeat it: the zkeys are uncontributed
 * phase-2 keys, so anyone holding one can forge a proof of any statement of the
 * circuit. Matching a digest proves you received the bytes this repository
 * built. It does not make the proving key trustworthy.
 */
import type { CardVaultArtifact } from './vault-messages'

export const CARD_ARTIFACT_LOCK_FORMAT = 'zkdeal/card-artifacts-lock/v4'
export const CARD_DECK_CIRCUIT = 'deck-init-v4'
export const CARD_HAND_CIRCUIT = 'hand-action-v4'

export interface CardCircuitFile {
  readonly circuit: string
  readonly kind: 'wasm' | 'zkey' | 'vkey'
  readonly url: string
  readonly bytes: number
  readonly sha256: string
  readonly available: boolean
}

export interface CardCircuitsConfig {
  readonly lockUrl: string
  readonly ceremony: string
  readonly provingArtifactsAvailable: boolean
  readonly files: readonly CardCircuitFile[]
}

const SHA256 = /^[0-9a-f]{64}$/

/**
 * Read the `cardCircuits` section out of a `/config` document. Returns null -
 * never a partially populated object - when the coordinator publishes no lock,
 * exactly as the zkVM section is omitted when its lock is absent.
 */
export function readCardCircuitsConfig(config: unknown): CardCircuitsConfig | null {
  const section = (config as { cardCircuits?: unknown } | null)?.cardCircuits
  if (!section || typeof section !== 'object') return null
  const raw = section as Record<string, unknown>
  if (typeof raw.lockUrl !== 'string' || !Array.isArray(raw.files)) return null
  const files: CardCircuitFile[] = []
  for (const entry of raw.files) {
    const file = entry as Record<string, unknown>
    if (
      typeof file.circuit !== 'string' ||
      (file.kind !== 'wasm' && file.kind !== 'zkey' && file.kind !== 'vkey') ||
      typeof file.url !== 'string' ||
      typeof file.bytes !== 'number' ||
      typeof file.sha256 !== 'string' ||
      !SHA256.test(file.sha256)
    ) {
      return null
    }
    files.push({
      circuit: file.circuit,
      kind: file.kind,
      url: file.url,
      bytes: file.bytes,
      sha256: file.sha256,
      available: file.available === true,
    })
  }
  return {
    lockUrl: raw.lockUrl,
    ceremony: typeof raw.ceremony === 'string' ? raw.ceremony : 'unknown',
    provingArtifactsAvailable: raw.provingArtifactsAvailable === true,
    files,
  }
}

export interface CardProvingGate {
  readonly ready: boolean
  /** Exactly what is missing, in the words an operator can act on. */
  readonly missing: readonly string[]
  readonly ceremony: string | null
  /** Bytes a first proof costs on this connection. */
  readonly downloadBytes: number
}

/** What a browser must DOWNLOAD before it can prove. */
const PROVING_KINDS: readonly ('wasm' | 'zkey')[] = ['wasm', 'zkey']
/**
 * Everything the plan pins. The verifying key is tracked in git (a clean clone
 * has it) and is what lets the browser verify its own proof with the same key
 * `CardDeckInitGroth16VerifierV5` / `CardHandActionGroth16VerifierV5` were
 * generated from, instead of trusting that a produced proof is a valid one.
 */
const PLAN_KINDS: readonly ('wasm' | 'zkey' | 'vkey')[] = ['wasm', 'zkey', 'vkey']

/**
 * Decide whether this stand can prove, and if not, say precisely why. The
 * answer is rendered verbatim; "something went wrong" is not an acceptable
 * failure mode for the one screen that claims confidentiality.
 */
export function cardProvingGate(section: CardCircuitsConfig | null): CardProvingGate {
  if (!section) {
    return {
      ready: false,
      missing: [
        'This coordinator publishes no cardCircuits section in /config, so it distributes no card proving artifacts. Serve the app from a coordinator whose circuits/card-artifacts.lock.json is present.',
      ],
      ceremony: null,
      downloadBytes: 0,
    }
  }
  const missing: string[] = []
  const needed = section.files.filter((file) => PROVING_KINDS.includes(file.kind as 'wasm' | 'zkey'))
  for (const circuit of [CARD_DECK_CIRCUIT, CARD_HAND_CIRCUIT]) {
    for (const kind of PROVING_KINDS) {
      const file = needed.find((entry) => entry.circuit === circuit && entry.kind === kind)
      if (!file) {
        missing.push(`The artifact lock names no ${kind} for circuit ${circuit}.`)
      } else if (!file.available) {
        missing.push(
          `${file.url} is not built on this coordinator. Run \`pnpm --filter @zkdeal/circuits build:card\` where it runs.`,
        )
      }
    }
  }
  if (typeof Worker === 'undefined') {
    missing.push(
      'This browser exposes no Web Worker. The prover will not run on the main thread, so the duel stays unprovable here.',
    )
  }
  return {
    ready: missing.length === 0,
    missing,
    ceremony: section.ceremony,
    downloadBytes: needed.reduce((total, file) => total + file.bytes, 0),
  }
}

interface LockCircuit {
  readonly wasmSha256?: unknown
  readonly demoZkeySha256?: unknown
  readonly demoVkeySha256?: unknown
  readonly distribution?: Record<string, { path?: unknown; bytes?: unknown } | undefined>
}

const DIGEST_FIELD = {
  wasm: 'wasmSha256',
  zkey: 'demoZkeySha256',
  vkey: 'demoVkeySha256',
} as const

export interface CardArtifactPin {
  readonly circuit: string
  readonly kind: 'wasm' | 'zkey' | 'vkey'
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

/**
 * Derive the download plan from the lock, so a path, a length and a digest can
 * only be wrong in one place. Throws on an incomplete entry rather than
 * skipping it: a plan that quietly omits the zkey would let a client "verify" a
 * set it never fetched.
 */
export function cardArtifactPlan(lock: unknown): CardArtifactPin[] {
  const document = lock as { format?: unknown; circuits?: Record<string, LockCircuit> }
  if (document?.format !== CARD_ARTIFACT_LOCK_FORMAT) {
    throw new Error(`unexpected card artifact lock format ${String(document?.format)}`)
  }
  const circuits = document.circuits
  if (!circuits || typeof circuits !== 'object') throw new Error('the card artifact lock declares no circuits')
  const plan: CardArtifactPin[] = []
  for (const circuit of [CARD_DECK_CIRCUIT, CARD_HAND_CIRCUIT]) {
    const entry = circuits[circuit]
    if (!entry) throw new Error(`the card artifact lock has no entry for ${circuit}`)
    for (const kind of PLAN_KINDS) {
      const file = entry.distribution?.[kind]
      const sha256 = entry[DIGEST_FIELD[kind]]
      if (!file || typeof file.path !== 'string' || typeof file.bytes !== 'number') {
        throw new Error(`the card artifact lock has no ${kind} distribution entry for ${circuit}`)
      }
      if (typeof sha256 !== 'string' || !SHA256.test(sha256)) {
        throw new Error(`the card artifact lock has no usable ${kind} digest for ${circuit}`)
      }
      plan.push({ circuit, kind, path: file.path, bytes: file.bytes, sha256 })
    }
  }
  return plan
}

export async function cardSha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new Error('crypto.subtle is unavailable, so card artifacts cannot be verified in this runtime')
  }
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const digest = await subtle.digest('SHA-256', copy)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Length first and separately: a truncated response is the common failure, and
 * reporting it as a digest mismatch hides which of "wrong file" and "incomplete
 * transfer" happened.
 */
export async function assertCardArtifactBytes(
  pin: CardArtifactPin,
  bytes: Uint8Array,
): Promise<void> {
  const label = `${pin.circuit} ${pin.kind} (${pin.path})`
  if (bytes.byteLength !== pin.bytes) {
    throw new Error(`card artifact ${label} is ${bytes.byteLength} bytes, the lock pins ${pin.bytes}`)
  }
  const actual = await cardSha256Hex(bytes)
  if (actual !== pin.sha256) {
    throw new Error(`card artifact ${label} sha256 ${actual} does not match the pinned ${pin.sha256}`)
  }
}

export interface CardArtifactBundle {
  readonly deckInit: CardVaultArtifact
  readonly handAction: CardVaultArtifact
}

export interface CardArtifactProgress {
  readonly path: string
  readonly loadedFiles: number
  readonly totalFiles: number
  readonly bytes: number
}

/**
 * Fetch the lock, then every pinned artifact, verifying each one before it is
 * allowed near snarkjs. A substituted proving key produces proofs against a
 * different constraint system, which no public-signal check downstream can see.
 */
export async function loadCardArtifacts(
  section: CardCircuitsConfig,
  options: {
    readonly fetchImpl?: typeof fetch
    readonly onProgress?: (progress: CardArtifactProgress) => void
    readonly signal?: AbortSignal
  } = {},
): Promise<CardArtifactBundle> {
  const request = options.fetchImpl ?? fetch
  const lockResponse = await request(section.lockUrl, { cache: 'no-store', signal: options.signal })
  if (!lockResponse.ok) {
    throw new Error(`the card artifact lock is unavailable at ${section.lockUrl} (${lockResponse.status})`)
  }
  const plan = cardArtifactPlan(await lockResponse.json())
  const urlFor = (pin: CardArtifactPin): string => {
    const published = section.files.find(
      (file) => file.circuit === pin.circuit && file.kind === pin.kind,
    )
    if (!published) throw new Error(`this coordinator does not serve ${pin.circuit} ${pin.kind}`)
    return published.url
  }

  const loaded = new Map<string, Uint8Array>()
  let index = 0
  for (const pin of plan) {
    const response = await request(urlFor(pin), { signal: options.signal })
    if (!response.ok) {
      throw new Error(
        `${pin.circuit} ${pin.kind} could not be downloaded (${response.status}). It is probably not built on this coordinator.`,
      )
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    await assertCardArtifactBytes(pin, bytes)
    loaded.set(`${pin.circuit}:${pin.kind}`, bytes)
    index += 1
    options.onProgress?.({ path: pin.path, loadedFiles: index, totalFiles: plan.length, bytes: pin.bytes })
  }

  const pick = (circuit: string): CardVaultArtifact => {
    const wasm = loaded.get(`${circuit}:wasm`)
    const zkey = loaded.get(`${circuit}:zkey`)
    const vkey = loaded.get(`${circuit}:vkey`)
    const wasmPin = plan.find((entry) => entry.circuit === circuit && entry.kind === 'wasm')
    const zkeyPin = plan.find((entry) => entry.circuit === circuit && entry.kind === 'zkey')
    if (!wasm || !zkey || !vkey || !wasmPin || !zkeyPin) {
      throw new Error(`${circuit} artifacts are incomplete`)
    }
    return { wasm, zkey, vkey, wasmSha256: wasmPin.sha256, zkeySha256: zkeyPin.sha256 }
  }
  return { deckInit: pick(CARD_DECK_CIRCUIT), handAction: pick(CARD_HAND_CIRCUIT) }
}
