/**
 * Page-side handle to the witness vault worker.
 *
 * There is deliberately NO main-thread fallback. `web/lib/room-client.ts` falls
 * back to single-threaded proving when `SharedArrayBuffer` is missing, which is
 * right for a settlement proof over public data and wrong here: running the
 * card prover on the main thread would put deck order, salts and Merkle
 * siblings in the same realm as `fetch`, `localStorage` and every React
 * DevTools inspector. If the worker cannot start, this class says so and the
 * duel stays unprovable.
 *
 * Every reply is passed through `assertCardVaultResponse` before it is
 * resolved, so the exact allow-list applies to the boundary rather than to the
 * worker's good behaviour.
 */
import {
  assertCardVaultResponse,
  type CardVaultArtifact,
  type CardVaultRequestBody,
  type CardVaultResponse,
  type CardVaultSeat,
  type CardVaultView,
} from './vault-messages'

export type { CardVaultSeat, CardVaultView }

/** A locally produced proof, in the only shape allowed to leave the vault. */
export interface CardLocalProof {
  readonly circuit: 'deck-init-v4' | 'hand-action-v4'
  readonly publicInputs: readonly string[]
  /** The exact 256 bytes the move will publish. */
  readonly innerProof: string
  readonly provingMs: number
  /** The vault verified this proof against the pinned verifying key. */
  readonly verified: true
  readonly view: CardVaultView
}

type Pending = {
  resolve: (response: CardVaultResponse) => void
  reject: (error: Error) => void
}

/** Proving 7 387 and 11 016 constraints in a browser is slow but not unbounded. */
const REQUEST_TIMEOUT_MS = 240_000

export class CardVaultUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CardVaultUnavailableError'
  }
}

export class CardVaultClient {
  #worker: Worker | null = null
  #pending = new Map<number, Pending>()
  #next = 1

  /** True once the proving artifacts have been handed to the worker. */
  loaded = false

  #ensureWorker(): Worker {
    if (this.#worker) return this.#worker
    if (typeof Worker === 'undefined') {
      throw new CardVaultUnavailableError(
        'This browser exposes no Web Worker, and the hidden-card prover refuses to run on the main thread.',
      )
    }
    const worker = new Worker(new URL('./vault-worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent) => {
      let response: CardVaultResponse
      try {
        response = assertCardVaultResponse(event.data)
      } catch (error) {
        // A reply that fails the allow-list is a boundary violation, not a
        // transport hiccup: fail every outstanding request rather than let one
        // unvalidated object be silently dropped and the rest continue.
        this.#failAll(error instanceof Error ? error : new Error(String(error)))
        return
      }
      const pending = this.#pending.get(response.id)
      if (!pending) return
      this.#pending.delete(response.id)
      if (response.ok) pending.resolve(response)
      else pending.reject(new Error(response.message))
    }
    worker.onerror = (event: ErrorEvent) => {
      this.#failAll(new CardVaultUnavailableError(event.message || 'the witness vault worker failed'))
    }
    this.#worker = worker
    return worker
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }

  #send(request: CardVaultRequestBody, transfer: Transferable[] = []): Promise<CardVaultResponse> {
    const worker = this.#ensureWorker()
    const id = this.#next++
    return new Promise<CardVaultResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`the witness vault did not answer within ${REQUEST_TIMEOUT_MS / 1000}s`))
      }, REQUEST_TIMEOUT_MS)
      this.#pending.set(id, {
        resolve: (response) => {
          clearTimeout(timer)
          resolve(response)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      worker.postMessage({ ...request, id }, transfer)
    })
  }

  async #expect<K extends CardVaultResponse['kind']>(
    request: CardVaultRequestBody,
    kind: K,
    transfer: Transferable[] = [],
  ): Promise<Extract<CardVaultResponse, { kind: K }>> {
    const response = await this.#send(request, transfer)
    if (response.kind !== kind) {
      throw new Error(`the witness vault answered ${response.kind}, expected ${kind}`)
    }
    return response as Extract<CardVaultResponse, { kind: K }>
  }

  /**
   * Hand the digest-checked proving artifacts to the worker. The buffers are
   * transferred, so the page's copies are detached and the ~25 MB exists once.
   */
  async loadArtifacts(deckInit: CardVaultArtifact, handAction: CardVaultArtifact): Promise<void> {
    await this.#expect({ kind: 'load-artifacts', deckInit, handAction }, 'ready', [
      deckInit.wasm.buffer as ArrayBuffer,
      deckInit.zkey.buffer as ArrayBuffer,
      deckInit.vkey.buffer as ArrayBuffer,
      handAction.wasm.buffer as ArrayBuffer,
      handAction.zkey.buffer as ArrayBuffer,
      handAction.vkey.buffer as ArrayBuffer,
    ])
    this.loaded = true
  }

  async open(
    seat: CardVaultSeat,
    identity: { domain: string; duelId: string; player: string },
  ): Promise<CardVaultView> {
    const response = await this.#expect({ kind: 'open', seat, ...identity }, 'view')
    return response.view
  }

  async proveDeckInit(seat: CardVaultSeat): Promise<CardLocalProof> {
    const response = await this.#expect({ kind: 'prove-deck-init', seat }, 'proof')
    return {
      circuit: response.circuit,
      publicInputs: response.publicInputs,
      innerProof: response.innerProof,
      provingMs: response.provingMs,
      verified: true,
      view: response.view,
    }
  }

  async proveHandAction(
    seat: CardVaultSeat,
    action: 1 | 2 | 3,
    options: { handSlot?: number; publicBoardCount: number },
  ): Promise<CardLocalProof> {
    const response = await this.#expect(
      { kind: 'prove-hand-action', seat, action, publicBoardCount: options.publicBoardCount, handSlot: options.handSlot },
      'proof',
    )
    return {
      circuit: response.circuit,
      publicInputs: response.publicInputs,
      innerProof: response.innerProof,
      provingMs: response.provingMs,
      verified: true,
      view: response.view,
    }
  }

  /** Ask the vault whether these bytes contain any of its own hidden material. */
  async audit(seat: CardVaultSeat, calldata: string): Promise<void> {
    await this.#expect({ kind: 'audit', seat, calldata }, 'audit')
  }

  async commit(seat: CardVaultSeat): Promise<CardVaultView> {
    return (await this.#expect({ kind: 'commit', seat }, 'view')).view
  }

  async discard(seat: CardVaultSeat): Promise<CardVaultView> {
    return (await this.#expect({ kind: 'discard', seat }, 'view')).view
  }

  async applyBoardCountChange(
    seat: CardVaultSeat,
    change: { previousBoardCount: number; boardCount: number; turnNumber: number; attackerSlot: number },
  ): Promise<CardVaultView> {
    return (await this.#expect({ kind: 'board-count-change', seat, ...change }, 'view')).view
  }

  /** The only sanctioned persistence: AES-256-GCM under a user password. */
  async exportEncrypted(seat: CardVaultSeat, password: string): Promise<string> {
    return (await this.#expect({ kind: 'export', seat, password }, 'export')).envelope
  }

  /** Terminating the worker discards every bundle it held. There is no copy. */
  destroy(): void {
    this.#failAll(new Error('the witness vault was closed'))
    this.#worker?.terminate()
    this.#worker = null
    this.loaded = false
  }
}
