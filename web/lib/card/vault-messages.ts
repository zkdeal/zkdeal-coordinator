/**
 * The message contract between the page and the witness vault worker.
 *
 * The vault worker is the only realm that ever holds a `CardWitnessBundle`.
 * That is a structural claim, not a stylistic one: the worker module imports no
 * network, storage or console API, and everything it sends back has to survive
 * `assertCardVaultResponse` on the receiving side. The guard is an EXACT
 * allow-list - an unexpected property is an error, not something to ignore - so
 * a future edit to the worker that widened a response would fail on the main
 * thread instead of quietly landing deck order in React state.
 *
 * `CardVaultView.handCards` is the one piece of hidden material that is meant
 * to cross: the player has to see their own hand. It is what the coordinator
 * cannot see, and it must never reach `calldata.ts`, `fetch` or storage -
 * `CardMoveRequest` has no field that could accept it.
 */

/** Which of the two hot-seat duelists a message concerns. */
export type CardVaultSeat = 0 | 1

/** Everything the page is allowed to learn about a private bundle. */
export interface CardVaultView {
  /** How many committed deck cards have been consumed. Public on-chain. */
  readonly deckCursor: number
  /** Occupied hand slots. Public on-chain (`Seat.handCount`). */
  readonly handCount: number
  /** Public on-chain (`Seat.boardCount`). */
  readonly boardCount: number
  /** Public on-chain (`Seat.actionCursor`), decimal. */
  readonly actionCursor: string
  /** Poseidon commitments; both are circuit public inputs. Decimal. */
  readonly deckRoot: string
  readonly handRoot: string
  /**
   * The player's OWN hand by slot, `0` for empty. Private to this browser: it
   * is exactly what the hidden-card claim protects, rendered so the demo has
   * something to protect. Never leaves the page.
   */
  readonly handCards: readonly number[]
  /** True while a prepared action is proved but not yet accepted on-chain. */
  readonly staged: boolean
}

export interface CardVaultArtifact {
  readonly wasm: Uint8Array
  readonly zkey: Uint8Array
  /**
   * The tracked verifying key. The vault verifies every proof it produces
   * against it before releasing one, so `proofAccepted` downstream comes from
   * real verification rather than from "snarkjs returned something".
   */
  readonly vkey: Uint8Array
  readonly wasmSha256: string
  readonly zkeySha256: string
}

export type CardVaultRequest =
  | { readonly id: number; readonly kind: 'load-artifacts'; readonly deckInit: CardVaultArtifact; readonly handAction: CardVaultArtifact }
  | { readonly id: number; readonly kind: 'open'; readonly seat: CardVaultSeat; readonly domain: string; readonly duelId: string; readonly player: string }
  | { readonly id: number; readonly kind: 'prove-deck-init'; readonly seat: CardVaultSeat }
  | {
      readonly id: number
      readonly kind: 'prove-hand-action'
      readonly seat: CardVaultSeat
      /** 1 = Draw, 2 = Play, 3 = Burn (`CardHandActionKind`). */
      readonly action: 1 | 2 | 3
      readonly handSlot?: number
      readonly publicBoardCount: number
    }
  | { readonly id: number; readonly kind: 'commit'; readonly seat: CardVaultSeat }
  | { readonly id: number; readonly kind: 'discard'; readonly seat: CardVaultSeat }
  | {
      readonly id: number
      readonly kind: 'board-count-change'
      readonly seat: CardVaultSeat
      readonly previousBoardCount: number
      readonly boardCount: number
      readonly turnNumber: number
      readonly attackerSlot: number
    }
  | { readonly id: number; readonly kind: 'audit'; readonly seat: CardVaultSeat; readonly calldata: string }
  | { readonly id: number; readonly kind: 'export'; readonly seat: CardVaultSeat; readonly password: string }

/**
 * A request without its correlation id. `Omit` over a union collapses to the
 * shared keys, so it is distributed explicitly - otherwise every request body
 * would typecheck as `{ kind }` alone and a missing field would reach the
 * worker.
 */
export type CardVaultRequestBody = CardVaultRequest extends infer T
  ? T extends { readonly id: number }
    ? Omit<T, 'id'>
    : never
  : never

export type CardVaultResponse =
  | { readonly id: number; readonly ok: true; readonly kind: 'ready' }
  | { readonly id: number; readonly ok: true; readonly kind: 'view'; readonly seat: CardVaultSeat; readonly view: CardVaultView }
  | {
      readonly id: number
      readonly ok: true
      readonly kind: 'proof'
      readonly seat: CardVaultSeat
      readonly circuit: 'deck-init-v4' | 'hand-action-v4'
      /** Decimal, in the circuit's declared public-input order. */
      readonly publicInputs: readonly string[]
      /**
       * The 256-byte `abi.encode(uint256[2],uint256[2][2],uint256[2])` payload
       * `CardProofVerifierAdapterV5` consumes, with the G2 coefficients already
       * in EVM order. The page receives the bytes it will publish rather than
       * the coordinates behind them, so the snarkjs proof object - and the
       * encoder that knows how to reorder it - never leave the worker.
       */
      readonly innerProof: string
      readonly provingMs: number
      /** Always true: an unverifiable proof is an error, never a response. */
      readonly verified: true
      readonly view: CardVaultView
    }
  | { readonly id: number; readonly ok: true; readonly kind: 'audit'; readonly seat: CardVaultSeat; readonly cleared: true }
  | { readonly id: number; readonly ok: true; readonly kind: 'export'; readonly envelope: string }
  | { readonly id: number; readonly ok: false; readonly kind: 'error'; readonly message: string }

class CardVaultProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CardVaultProtocolError'
  }
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CardVaultProtocolError(`${label} must be an object`)
  }
  const object = value as Record<string, unknown>
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      throw new CardVaultProtocolError(`${label}.${key} is required`)
    }
  }
  for (const key of Object.keys(object)) {
    if (!keys.includes(key)) {
      throw new CardVaultProtocolError(
        `${label}.${key} is not part of the vault response contract; the witness boundary refused it`,
      )
    }
  }
  return object
}

const DECIMAL = /^[0-9]+$/

function decimal(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new CardVaultProtocolError(`${label} must be a canonical decimal string`)
  }
  return value
}

function count(value: unknown, label: string, max: number): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new CardVaultProtocolError(`${label} must be an integer in [0, ${max}]`)
  }
  return value as number
}

function view(value: unknown, label: string): CardVaultView {
  const object = exact(
    value,
    ['deckCursor', 'handCount', 'boardCount', 'actionCursor', 'deckRoot', 'handRoot', 'handCards', 'staged'],
    label,
  )
  if (!Array.isArray(object.handCards) || object.handCards.length !== 8) {
    throw new CardVaultProtocolError(`${label}.handCards must hold exactly eight slots`)
  }
  if (typeof object.staged !== 'boolean') {
    throw new CardVaultProtocolError(`${label}.staged must be a boolean`)
  }
  return {
    deckCursor: count(object.deckCursor, `${label}.deckCursor`, 12),
    handCount: count(object.handCount, `${label}.handCount`, 8),
    boardCount: count(object.boardCount, `${label}.boardCount`, 5),
    actionCursor: decimal(object.actionCursor, `${label}.actionCursor`),
    deckRoot: decimal(object.deckRoot, `${label}.deckRoot`),
    handRoot: decimal(object.handRoot, `${label}.handRoot`),
    handCards: object.handCards.map((card, index) => count(card, `${label}.handCards[${index}]`, 12)),
    staged: object.staged,
  }
}

function seat(value: unknown, label: string): CardVaultSeat {
  if (value !== 0 && value !== 1) throw new CardVaultProtocolError(`${label} must be seat 0 or 1`)
  return value
}

function identifier(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new CardVaultProtocolError('$.id must be a request identifier')
  }
  return value as number
}

/**
 * Validate a message arriving from the vault worker before any of it reaches
 * application state. Rejects unknown properties outright, which is what makes
 * this an allow-list rather than a shape hint.
 */
export function assertCardVaultResponse(value: unknown): CardVaultResponse {
  if (!value || typeof value !== 'object') {
    throw new CardVaultProtocolError('$ must be a vault response object')
  }
  const kind = (value as { kind?: unknown }).kind
  switch (kind) {
    case 'ready': {
      const object = exact(value, ['id', 'ok', 'kind'], '$')
      return { id: identifier(object.id), ok: true, kind: 'ready' }
    }
    case 'view': {
      const object = exact(value, ['id', 'ok', 'kind', 'seat', 'view'], '$')
      return {
        id: identifier(object.id),
        ok: true,
        kind: 'view',
        seat: seat(object.seat, '$.seat'),
        view: view(object.view, '$.view'),
      }
    }
    case 'proof': {
      const object = exact(
        value,
        ['id', 'ok', 'kind', 'seat', 'circuit', 'publicInputs', 'innerProof', 'provingMs', 'verified', 'view'],
        '$',
      )
      if (object.circuit !== 'deck-init-v4' && object.circuit !== 'hand-action-v4') {
        throw new CardVaultProtocolError('$.circuit is not a supported card circuit')
      }
      const arity = object.circuit === 'deck-init-v4' ? 5 : 15
      if (!Array.isArray(object.publicInputs) || object.publicInputs.length !== arity) {
        throw new CardVaultProtocolError(`$.publicInputs must hold ${arity} ordered values`)
      }
      if (typeof object.innerProof !== 'string' || !/^0x[0-9a-f]{512}$/i.test(object.innerProof)) {
        throw new CardVaultProtocolError('$.innerProof must be the 256-byte adapter payload')
      }
      if (typeof object.provingMs !== 'number' || !Number.isFinite(object.provingMs)) {
        throw new CardVaultProtocolError('$.provingMs must be a measured duration')
      }
      if (object.verified !== true) {
        throw new CardVaultProtocolError('$.verified must be true; the vault releases no unverified proof')
      }
      return {
        id: identifier(object.id),
        ok: true,
        kind: 'proof',
        seat: seat(object.seat, '$.seat'),
        circuit: object.circuit,
        publicInputs: object.publicInputs.map((input, index) =>
          decimal(input, `$.publicInputs[${index}]`),
        ),
        innerProof: object.innerProof,
        provingMs: object.provingMs,
        verified: true,
        view: view(object.view, '$.view'),
      }
    }
    case 'audit': {
      const object = exact(value, ['id', 'ok', 'kind', 'seat', 'cleared'], '$')
      if (object.cleared !== true) throw new CardVaultProtocolError('$.cleared must be true')
      return { id: identifier(object.id), ok: true, kind: 'audit', seat: seat(object.seat, '$.seat'), cleared: true }
    }
    case 'export': {
      const object = exact(value, ['id', 'ok', 'kind', 'envelope'], '$')
      if (typeof object.envelope !== 'string') {
        throw new CardVaultProtocolError('$.envelope must be the encrypted bundle document')
      }
      return { id: identifier(object.id), ok: true, kind: 'export', envelope: object.envelope }
    }
    case 'error': {
      const object = exact(value, ['id', 'ok', 'kind', 'message'], '$')
      if (typeof object.message !== 'string') {
        throw new CardVaultProtocolError('$.message must be a string')
      }
      return { id: identifier(object.id), ok: false, kind: 'error', message: object.message }
    }
    default:
      throw new CardVaultProtocolError(`$.kind ${String(kind)} is not a vault response`)
  }
}
