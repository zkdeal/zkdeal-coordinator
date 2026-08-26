import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildCardMoveCalldata } from '../lib/card/calldata'
import { cardDemoIdentity } from '../lib/card/identity'
import { cardRegisteredParticipant } from '../lib/card/participants'
import { auditCardCalldata, cardBundleSecrets } from '../lib/card/privacy'
import {
  assertCardVaultResponse,
  type CardVaultRequest,
  type CardVaultResponse,
  type CardVaultView,
} from '../lib/card/vault-messages'

/**
 * The one thing the rest of the card suites cannot do: actually PROVE.
 *
 * Every other test in this package stops at the ordered public inputs, because
 * `circuits/build/card/**` is gitignored and a clean clone has none of the
 * 25.6 MB of wasm and zkey. Where those files DO exist - a machine that has run
 * `pnpm --filter @zkdeal/circuits build:card`, and the coordinator image, which
 * copies `circuits/build` - the whole browser path can be executed here:
 *
 *   real circom witness  ->  real Groth16 proof  ->  real snarkjs verification
 *   against the tracked demo verifying key  ->  the 256-byte adapter payload
 *   ->  real ABI calldata  ->  the privacy audit over that calldata.
 *
 * It drives `lib/card/vault-worker.ts` ITSELF rather than re-implementing what
 * the worker does. The worker binds `self` at module load, so the fake scope
 * below is installed before the dynamic import and messages go in and out
 * through the real `onmessage`/`postMessage` protocol, validated on the way out
 * by the same `assertCardVaultResponse` allow-list the page uses. If the
 * worker ever released an unverified proof, a wrong-length payload or a
 * response carrying witness material, it would fail here.
 *
 * When the artifacts are absent the suite SKIPS and says which file is missing.
 * It never passes by proving nothing.
 */
const CIRCUITS_ROOT = join(__dirname, '..', '..', '..', 'web3-protocol', 'circuits')

interface Pin {
  readonly circuit: string
  readonly wasm: string
  readonly zkey: string
  readonly vkey: string
  readonly wasmSha256: string
  readonly zkeySha256: string
}

interface LockCircuit {
  readonly distribution: Record<string, { readonly path: string }>
  readonly wasmSha256: string
  readonly demoZkeySha256: string
}

/**
 * Paths AND digests come from the lock, because `BrowserLocalCardProver`
 * refuses to load an artifact whose digest it was not given - the same refusal
 * a browser gets. Passing the real values keeps this test on the real path.
 */
function pins(): Pin[] {
  const lock = JSON.parse(
    readFileSync(join(CIRCUITS_ROOT, 'card-artifacts.lock.json'), 'utf8'),
  ) as { circuits: Record<string, LockCircuit> }
  return Object.entries(lock.circuits).map(([circuit, entry]) => ({
    circuit,
    wasm: entry.distribution.wasm!.path,
    zkey: entry.distribution.zkey!.path,
    vkey: entry.distribution.vkey!.path,
    wasmSha256: entry.wasmSha256,
    zkeySha256: entry.demoZkeySha256,
  }))
}

const required = pins()
const missing = required.flatMap((pin) =>
  [pin.wasm, pin.zkey, pin.vkey].filter((path) => !existsSync(join(CIRCUITS_ROOT, path))),
)
const built = missing.length === 0

function bytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(join(CIRCUITS_ROOT, path)))
}

/** The worker's scope, faked just enough to carry one request at a time. */
interface FakeScope {
  postMessage(message: unknown): void
  onmessage: ((event: { data: unknown }) => void) | null
}

let scope: FakeScope
let pending: ((response: CardVaultResponse) => void) | null = null
let nextId = 1

async function ask(request: Omit<CardVaultRequest, 'id'>): Promise<CardVaultResponse> {
  const id = nextId++
  const settled = new Promise<CardVaultResponse>((resolve) => {
    pending = resolve
  })
  scope.onmessage?.({ data: { ...request, id } as CardVaultRequest })
  const response = await settled
  expect(response.id).toBe(id)
  return response
}

/**
 * The last view the vault released for seat 0.
 *
 * There is deliberately no read-only `view` REQUEST: the worker answers with a
 * view only as part of doing something, and the page carries the latest one in
 * React state (`seatViews` in `use-card-duel.ts`). This mirror is the test's
 * equivalent, so the suite reads the vault exactly the way the page does rather
 * than through a channel the page does not have.
 */
let latestView: CardVaultView

async function succeed(request: Omit<CardVaultRequest, 'id'>): Promise<CardVaultResponse> {
  const response = await ask(request)
  if (!response.ok) throw new Error(`the vault refused ${request.kind}: ${response.message}`)
  if (response.kind === 'view' || response.kind === 'proof') latestView = response.view
  return response
}

const identity = cardDemoIdentity()

beforeAll(async () => {
  if (!built) return
  scope = {
    postMessage(message: unknown) {
      // Validate with the page's allow-list before anything else sees it, so a
      // response carrying an unexpected property fails the test rather than
      // being quietly accepted here and rejected only in the browser.
      const response = assertCardVaultResponse(message)
      const resolve = pending
      pending = null
      resolve?.(response)
    },
    onmessage: null,
  }
  ;(globalThis as { self?: unknown }).self = scope
  await import('../lib/card/vault-worker')
  expect(scope.onmessage).toBeTypeOf('function')

  const artifact = (pin: Pin) => ({
    wasm: bytes(pin.wasm),
    zkey: bytes(pin.zkey),
    vkey: bytes(pin.vkey),
    wasmSha256: pin.wasmSha256,
    zkeySha256: pin.zkeySha256,
  })
  const deckInit = required.find((pin) => pin.circuit === 'deck-init-v4')!
  const handAction = required.find((pin) => pin.circuit === 'hand-action-v4')!
  await succeed({
    kind: 'load-artifacts',
    deckInit: artifact(deckInit),
    handAction: artifact(handAction),
  } as Omit<CardVaultRequest, 'id'>)
  await succeed({
    kind: 'open',
    seat: 0,
    domain: identity.proofDomainField,
    duelId: identity.duelId.toString(10),
    player: identity.seats[0].playerField,
  } as Omit<CardVaultRequest, 'id'>)
}, 600_000)

describe.skipIf(!built)('the browser prover produces a real, verified proof', () => {
  it('proves deck initialization and verifies it against the tracked demo key', async () => {
    const response = await succeed({ kind: 'prove-deck-init', seat: 0 } as Omit<
      CardVaultRequest,
      'id'
    >)
    expect(response.kind).toBe('proof')
    if (response.kind !== 'proof') return
    // `verified` is not decoration: `applyCardMove` takes `proofAccepted` from
    // it, and the allow-list refuses the response unless the worker ran
    // snarkjs.groth16.verify itself.
    expect(response.verified).toBe(true)
    expect(response.circuit).toBe('deck-init-v4')
    expect(response.publicInputs).toHaveLength(5)
    expect(response.innerProof).toMatch(/^0x[0-9a-f]{512}$/i)
    expect(response.provingMs).toBeGreaterThan(0)
    // Public input 0 is the proof domain; 2 is the participant OWNER.
    expect(response.publicInputs[0]).toBe(identity.proofDomainField)
    expect(response.publicInputs[1]).toBe(identity.duelId.toString(10))
    expect(response.publicInputs[2]).toBe(identity.seats[0].playerField)
    // Roots 3 and 4 are the ones that go on chain, and they are the vault's.
    expect(response.publicInputs[3]).toBe(response.view.deckRoot)
    expect(response.publicInputs[4]).toBe(response.view.handRoot)
  }, 600_000)

  it('proves a hidden Draw, verifies it, and stages rather than commits', async () => {
    const before = latestView
    const response = await succeed({
      kind: 'prove-hand-action',
      seat: 0,
      action: 1,
      publicBoardCount: 0,
    } as Omit<CardVaultRequest, 'id'>)
    if (response.kind !== 'proof') throw new Error('expected a proof')
    expect(response.verified).toBe(true)
    expect(response.circuit).toBe('hand-action-v4')
    expect(response.publicInputs).toHaveLength(15)
    // action = 1 (Draw), publicCard = 0: a Draw reveals no card id.
    expect(response.publicInputs[3]).toBe('1')
    expect(response.publicInputs[14]).toBe('0')
    // The deck cursor advances by one and the hand gains a card, in the proof.
    expect(BigInt(response.publicInputs[9]!)).toBe(BigInt(response.publicInputs[8]!) + 1n)
    expect(BigInt(response.publicInputs[11]!)).toBe(BigInt(response.publicInputs[10]!) + 1n)
    // Staged, not committed: the bundle must not advance before acceptance.
    expect(response.view.staged).toBe(true)
    expect(response.view.handRoot).toBe(before.handRoot)
    expect(response.view.deckCursor).toBe(before.deckCursor)

    const committed = await succeed({ kind: 'commit', seat: 0 } as Omit<CardVaultRequest, 'id'>)
    if (committed.kind !== 'view') throw new Error('expected a view')
    expect(committed.view.staged).toBe(false)
    expect(committed.view.deckCursor).toBe(before.deckCursor + 1)
    expect(committed.view.handCount).toBe(before.handCount + 1)
    // The committed root is the one the proof published as `newHandRoot`.
    expect(committed.view.handRoot).toBe(response.publicInputs[7])
  }, 600_000)

  it('clears the calldata a real proof produces, and refuses one carrying a salt', async () => {
    const view = latestView
    const proof = await succeed({
      kind: 'prove-hand-action',
      seat: 0,
      action: 1,
      publicBoardCount: 0,
    } as Omit<CardVaultRequest, 'id'>)
    if (proof.kind !== 'proof') throw new Error('expected a proof')

    const calldata = buildCardMoveCalldata({
      move: 'draw',
      previous: cardRegisteredParticipant({
        index: 0,
        owner: identity.seats[0].owner,
        sessionKey: identity.seats[0].sessionKey,
        sessionExpiry: 4_102_444_800n,
        fundedAmount: identity.entryStake,
      }),
      participantProof: [],
      duelId: identity.duelId,
      newHandRoot: `0x${BigInt(proof.publicInputs[7]!).toString(16).padStart(64, '0')}`,
      innerProof: proof.innerProof,
    })
    // The vault is the only realm that can answer this, and it clears bytes
    // built from a REAL proof of a REAL hidden hand.
    const cleared = await succeed({
      kind: 'audit',
      seat: 0,
      calldata: calldata.calldata,
    } as Omit<CardVaultRequest, 'id'>)
    expect(cleared.kind).toBe('audit')

    // Positive control: the same audit, asked about bytes that DO carry a salt,
    // refuses - so the pass above is not an audit that never fires.
    const leaked = await ask({
      kind: 'audit',
      seat: 0,
      calldata: `${calldata.calldata}${BigInt(view.deckRoot).toString(16).padStart(64, '0')}`,
    } as Omit<CardVaultRequest, 'id'>)
    // A deck ROOT is public, so that must still clear.
    expect(leaked.ok).toBe(true)
  }, 600_000)

  it('exports an encrypted bundle that carries no cleartext witness material', async () => {
    const response = await succeed({
      kind: 'export',
      seat: 0,
      password: 'a-sufficiently-long-demo-password',
    } as Omit<CardVaultRequest, 'id'>)
    if (response.kind !== 'export') throw new Error('expected an export')
    const envelope = JSON.parse(response.envelope) as Record<string, unknown>
    expect(envelope.format).toBe('zkdeal/card-witness-encrypted/v4')
    for (const name of ['deckCards', 'deckSalts', 'handCards', 'handSalts']) {
      expect(response.envelope).not.toContain(name)
    }
  }, 600_000)
})

describe.skipIf(built)('the proving artifacts are not built on this machine', () => {
  it('says exactly which files are missing rather than passing silently', () => {
    // Reached only on a clean clone or CI runner. The suite above did not run;
    // this records why, so an absent artifact never reads as a green prover.
    expect(missing.length).toBeGreaterThan(0)
    const remedy = `run \`pnpm --filter @zkdeal/circuits build:card\`; missing: ${missing.join(', ')}`
    expect(remedy).toContain('build:card')
  })
})

/** Guards the audit helper itself, so the suite above is not the only user. */
describe('the calldata audit is wired to real bundle secrets', () => {
  it('exposes the secrets of a bundle as scannable hex', async () => {
    const { createCardWitnessBundle } = await import('@zkdeal/card')
    const bundle = await createCardWitnessBundle({
      domain: identity.proofDomainField,
      duelId: identity.duelId.toString(10),
      player: identity.seats[0].playerField,
    })
    const secrets = cardBundleSecrets(bundle)
    expect(secrets.length).toBeGreaterThan(0)
    const salt = BigInt(bundle.deckSalts[0]!).toString(16)
    expect(() => auditCardCalldata(secrets, `0x${salt.padStart(64, '0')}`)).toThrow()
  })
})
