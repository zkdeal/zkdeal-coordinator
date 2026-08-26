/**
 * The witness vault: the ONLY realm in this app that holds deck order, salts,
 * hand contents or Merkle siblings.
 *
 * It runs as a dedicated Web Worker so the separation is enforced by the
 * platform rather than by discipline. Read the imports: there is no `fetch`, no
 * `XMLHttpRequest`, no `localStorage`, no `sessionStorage`, no `console` and no
 * `navigator.sendBeacon` anywhere in this module or in `@zkdeal/card`, so there
 * is no code path by which a bundle could be transmitted or persisted. The
 * proving artifacts are handed in as bytes by the page, already digest-checked,
 * precisely so this file never needs a network primitive.
 *
 * Everything sent back is built by an explicit constructor here and re-validated
 * against an exact allow-list on the page (`assertCardVaultResponse`).
 *
 * `audit` is the runtime half of the privacy claim: the page asks the vault to
 * inspect the finished calldata for its own secrets, and only the vault can
 * answer, because only the vault knows them. It returns a boolean and nothing
 * else.
 */
import * as snarkjs from 'snarkjs'
import {
  BrowserLocalCardProver,
  CardHandActionKind,
  createCardWitnessBundle,
  exportEncryptedCardWitnessBundle,
  applyPublicCardBoardCountChange,
  cardVerifierCall,
  prepareCardHandAction,
  type CardCoordinatorProofEnvelope,
  type CardWitnessBundle,
  type PreparedCardAction,
} from '@zkdeal/card'
import {
  auditCardCalldata,
  auditCardText,
  cardBundleSecretTexts,
  cardBundleSecrets,
} from './privacy'
import type {
  CardVaultArtifact,
  CardVaultRequest,
  CardVaultResponse,
  CardVaultSeat,
  CardVaultView,
} from './vault-messages'

/** Minimal view of the worker scope, so `lib: dom` and `webworker` never clash. */
interface WorkerScope {
  postMessage(message: unknown): void
  onmessage: ((event: { data: unknown }) => void) | null
}
const scope = self as unknown as WorkerScope

interface Vault {
  bundle: CardWitnessBundle
  /** Proved but not yet accepted on-chain; committed only after acceptance. */
  staged: PreparedCardAction | null
}

const vaults = new Map<CardVaultSeat, Vault>()
let prover: BrowserLocalCardProver | null = null
/** Verifying keys, by circuit id, parsed from the tracked `*.demo.vkey.json`. */
const verifyingKeys = new Map<string, unknown>()

function vaultOf(seat: CardVaultSeat): Vault {
  const vault = vaults.get(seat)
  if (!vault) throw new Error(`seat ${seat} has no open witness vault`)
  return vault
}

function viewOf(vault: Vault): CardVaultView {
  const bundle = vault.bundle
  return {
    deckCursor: bundle.deckCursor,
    handCount: bundle.handCards.filter((card) => card !== 0).length,
    boardCount: bundle.boardCount,
    actionCursor: bundle.actionCursor,
    deckRoot: bundle.deckRoot,
    handRoot: bundle.handRoot,
    handCards: [...bundle.handCards],
    staged: vault.staged !== null,
  }
}

function parseVerifyingKey(bytes: Uint8Array, circuit: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new Error(`the ${circuit} verifying key is not readable JSON`)
  }
}

function artifact(input: CardVaultArtifact) {
  return {
    wasm: input.wasm,
    zkey: input.zkey,
    wasmSha256: input.wasmSha256,
    zkeySha256: input.zkeySha256,
  }
}

/**
 * Verify a freshly produced proof with the same verifying key the on-chain
 * `CardDeckInitGroth16VerifierV5` / `CardHandActionGroth16VerifierV5` were
 * generated from. Producing a proof and verifying one are different statements,
 * and `duel.ts` requires `proofAccepted` to come from the second.
 */
async function verifyLocally(envelope: CardCoordinatorProofEnvelope): Promise<void> {
  const key = verifyingKeys.get(envelope.circuit)
  if (!key) throw new Error(`no verifying key was loaded for ${envelope.circuit}`)
  const accepted = await snarkjs.groth16.verify(
    key as Parameters<typeof snarkjs.groth16.verify>[0],
    envelope.publicInputs as unknown as Parameters<typeof snarkjs.groth16.verify>[1],
    envelope.proof,
  )
  if (!accepted) {
    throw new Error(`the locally produced ${envelope.circuit} proof did not verify against the pinned key`)
  }
}

function requireProver(): BrowserLocalCardProver {
  if (!prover) {
    throw new Error('the card proving artifacts have not been loaded into this vault yet')
  }
  return prover
}

/**
 * Repackage a proof envelope into the response shape. `envelope.proof` came out
 * of snarkjs and is already validated by `assertServerBlindCardPayload`
 * inside the prover, so only its coordinates are copied - never the object.
 */
function proofResponse(
  id: number,
  seat: CardVaultSeat,
  envelope: CardCoordinatorProofEnvelope,
  provingMs: number,
  view: CardVaultView,
): CardVaultResponse {
  return {
    id,
    ok: true,
    kind: 'proof',
    seat,
    circuit: envelope.circuit,
    publicInputs: envelope.publicInputs.map((input) => String(input)),
    // `cardVerifierCall` re-runs the proof-only allow-list and performs the
    // snarkjs -> Ethereum G2 coordinate swap, so the page gets bytes it can
    // publish unchanged and never sees a proof object.
    innerProof: cardVerifierCall(envelope).proof,
    provingMs,
    verified: true,
    view,
  }
}

/**
 * An error message is a transport like any other. Anything a thrown string can
 * carry is checked against this seat's own secrets before it is allowed out;
 * a hit is replaced rather than truncated, because a partial match is still a
 * disclosure.
 *
 * TWO scans, because a message can carry a secret two different ways and each
 * scan is blind to the other's form:
 *
 *   - `auditCardText` reads the message AS TEXT, which is how a thrown string
 *     actually quotes a salt (`salt 1234… rejected`, or `0xab54…`). This is the
 *     scan that matters and it is the one that was missing: hex-encoding the
 *     message first, as this function used to do on its own, turns the digits
 *     into their ASCII codes, and the ASCII of a number never contains that
 *     number's own hex spelling, so nothing could ever match.
 *   - `auditCardCalldata` over the hex of the message still runs, because a
 *     diagnostic that embeds raw calldata or a raw byte dump carries the secret
 *     in nibbles rather than in characters.
 *
 * Both the current and the staged bundle are covered: a prepared-but-unaccepted
 * action holds the salt of the card it just drew, and that is exactly the
 * moment a proving error is most likely to be thrown.
 */
function safeMessage(error: unknown, seat: CardVaultSeat | null): string {
  const raw = error instanceof Error ? error.message : String(error)
  const vault = seat === null ? undefined : vaults.get(seat)
  if (!vault) return raw
  const bundles = [vault.bundle, vault.staged?.nextBundle].filter(
    (bundle): bundle is CardWitnessBundle => bundle !== undefined,
  )
  try {
    for (const bundle of bundles) {
      auditCardText(cardBundleSecretTexts(bundle), raw, 'vault error')
      auditCardCalldata(cardBundleSecrets(bundle), `0x${textToHex(raw)}`, 'vault error')
    }
    return raw
  } catch {
    return 'the vault refused a diagnostic that referenced hidden witness material'
  }
}

function textToHex(text: string): string {
  return Array.from(new TextEncoder().encode(text), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
}

async function handle(request: CardVaultRequest): Promise<CardVaultResponse> {
  switch (request.kind) {
    case 'load-artifacts': {
      prover = new BrowserLocalCardProver(
        {
          status: 'demo-only',
          ceremony: 'uncontributed-demo-only',
          deckInit: artifact(request.deckInit),
          handAction: artifact(request.handAction),
        },
        { acknowledgeDemoOnly: true },
      )
      verifyingKeys.set('deck-init-v4', parseVerifyingKey(request.deckInit.vkey, 'deck-init-v4'))
      verifyingKeys.set('hand-action-v4', parseVerifyingKey(request.handAction.vkey, 'hand-action-v4'))
      return { id: request.id, ok: true, kind: 'ready' }
    }
    case 'open': {
      const bundle = await createCardWitnessBundle({
        domain: request.domain,
        duelId: request.duelId,
        player: request.player,
      })
      const vault: Vault = { bundle, staged: null }
      vaults.set(request.seat, vault)
      return { id: request.id, ok: true, kind: 'view', seat: request.seat, view: viewOf(vault) }
    }
    case 'prove-deck-init': {
      const vault = vaultOf(request.seat)
      const started = performance.now()
      const envelope = await requireProver().proveDeckInit(vault.bundle)
      const provingMs = performance.now() - started
      await verifyLocally(envelope)
      return proofResponse(request.id, request.seat, envelope, provingMs, viewOf(vault))
    }
    case 'prove-hand-action': {
      const vault = vaultOf(request.seat)
      if (vault.staged) throw new Error('a prepared action is already awaiting acceptance')
      const action =
        request.action === 1
          ? CardHandActionKind.Draw
          : request.action === 2
            ? CardHandActionKind.Play
            : CardHandActionKind.Burn
      const prepared = await prepareCardHandAction(vault.bundle, action, {
        handSlot: request.handSlot,
        publicBoardCount: request.publicBoardCount,
      })
      const started = performance.now()
      const envelope = await requireProver().proveHandAction(prepared)
      const provingMs = performance.now() - started
      await verifyLocally(envelope)
      // Staged, not committed: no public data can rebuild a hand the bundle has
      // already advanced past, so the move must be accepted on-chain first.
      vault.staged = prepared
      return proofResponse(request.id, request.seat, envelope, provingMs, viewOf(vault))
    }
    case 'commit': {
      const vault = vaultOf(request.seat)
      if (!vault.staged) throw new Error('there is no prepared action to accept')
      vault.bundle = vault.staged.nextBundle
      vault.staged = null
      return { id: request.id, ok: true, kind: 'view', seat: request.seat, view: viewOf(vault) }
    }
    case 'discard': {
      const vault = vaultOf(request.seat)
      vault.staged = null
      return { id: request.id, ok: true, kind: 'view', seat: request.seat, view: viewOf(vault) }
    }
    case 'board-count-change': {
      const vault = vaultOf(request.seat)
      vault.bundle = await applyPublicCardBoardCountChange(vault.bundle, {
        format: 'zkdeal/card-board-count-change/v4',
        domain: vault.bundle.domain,
        duelId: vault.bundle.duelId,
        player: vault.bundle.player,
        cause: 'attack-kill',
        previousBoardCount: request.previousBoardCount,
        boardCount: request.boardCount,
        turnNumber: request.turnNumber,
        attackerSlot: request.attackerSlot,
      })
      return { id: request.id, ok: true, kind: 'view', seat: request.seat, view: viewOf(vault) }
    }
    case 'audit': {
      const vault = vaultOf(request.seat)
      // Throws on a hit; the page never receives the calldata back, only the
      // verdict, so the audit cannot itself become a disclosure channel.
      auditCardCalldata(cardBundleSecrets(vault.bundle), request.calldata)
      if (vault.staged) {
        auditCardCalldata(cardBundleSecrets(vault.staged.nextBundle), request.calldata)
      }
      return { id: request.id, ok: true, kind: 'audit', seat: request.seat, cleared: true }
    }
    case 'export': {
      const vault = vaultOf(request.seat)
      const envelope = await exportEncryptedCardWitnessBundle(vault.bundle, request.password)
      return { id: request.id, ok: true, kind: 'export', envelope: JSON.stringify(envelope) }
    }
    default: {
      const unreachable: never = request
      throw new Error(`unsupported vault request ${JSON.stringify(unreachable)}`)
    }
  }
}

scope.onmessage = (event: { data: unknown }) => {
  const request = event.data as CardVaultRequest
  const id = typeof request?.id === 'number' ? request.id : -1
  const seat = 'seat' in (request ?? {}) ? (request as { seat: CardVaultSeat }).seat : null
  void handle(request)
    .then((response) => scope.postMessage(response))
    .catch((error: unknown) => {
      scope.postMessage({ id, ok: false, kind: 'error', message: safeMessage(error, seat) })
    })
}
