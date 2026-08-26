'use client'

/**
 * Orchestration for the hidden-card duel console.
 *
 * Everything that can be decided without React lives in `lib/card/*`; this hook
 * only sequences it: produce a proof in the vault, build the calldata from that
 * proof's own public inputs, ask the vault to audit the bytes, rehearse the
 * move against the rules, and only then advance the private bundle.
 *
 * That order is deliberate. The bundle is committed LAST, after the move has
 * been accepted by the read-model, because no public data can rebuild a hand
 * the bundle has already advanced past - a bundle that ran ahead of a rejected
 * move is unrecoverable except from its encrypted export.
 *
 * The only piece of secret material this module holds is the pair of commit
 * seeds, in a ref rather than in state: they are secret only between
 * `commitSeed` and `revealSeed`, the protocol publishes them itself at reveal,
 * and they are never persisted or sent anywhere.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CardSeatIndex } from '@zkdeal/card'
import type { Hex } from '@zkdeal/protocol'
import {
  cardProvingGate,
  loadCardArtifacts,
  readCardCircuitsConfig,
  type CardArtifactProgress,
  type CardCircuitsConfig,
  type CardProvingGate,
} from '@/lib/card/artifacts'
import type { CardCalldata } from '@/lib/card/calldata'
import { cardDemoIdentity, CARD_DEMO_DUEL_ADDRESS } from '@/lib/card/identity'
import { buildCardStep, type CardStepChoiceInput } from '@/lib/card/moves'
import {
  applyCardEscrowMove,
  applyCardSessionMove,
  cardCarrySubmissions,
  createCardSession,
  markCardCheckpoint,
  markCardSubmission,
  type CardSessionState,
  type CardSubmissionStatus,
} from '@/lib/card/session'
import { cardAvailableSteps, type CardStep } from '@/lib/card/steps'
import { CardVaultClient } from '@/lib/card/vault-client'
import type { CardVaultView } from '@/lib/card/vault-messages'

export type CardArtifactPhase = 'checking' | 'absent' | 'downloading' | 'ready'

export interface CardLastMove {
  readonly sequence: number
  readonly calldata: CardCalldata
  readonly publicInputs: readonly string[] | null
  readonly provingMs: number | null
  /** The vault confirmed these bytes contain none of its hidden material. */
  readonly audited: boolean
}

type Views = readonly [CardVaultView | null, CardVaultView | null]

function randomSeed(): Hex {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}` as Hex
}

export function useCardDuel() {
  const [duelAddress, setDuelAddress] = useState<string>(CARD_DEMO_DUEL_ADDRESS)
  const identity = useMemo(() => {
    try {
      return cardDemoIdentity(duelAddress)
    } catch {
      return cardDemoIdentity(CARD_DEMO_DUEL_ADDRESS)
    }
  }, [duelAddress])

  const [config, setConfig] = useState<CardCircuitsConfig | null>(null)
  const [gate, setGate] = useState<CardProvingGate | null>(null)
  const [phase, setPhase] = useState<CardArtifactPhase>('checking')
  const [progress, setProgress] = useState<CardArtifactProgress | null>(null)
  const [session, setSession] = useState<CardSessionState>(() =>
    createCardSession({
      proofDomain: identity.proofDomain,
      duelId: identity.duelId,
      entryStake: identity.entryStake,
      participantCapacity: identity.participantCapacity,
    }),
  )
  const [views, setViews] = useState<Views>([null, null])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastMove, setLastMove] = useState<CardLastMove | null>(null)

  const vault = useRef<CardVaultClient | null>(null)
  const seeds = useRef<Record<number, Hex | undefined>>({})

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/config', { cache: 'no-store' })
        const document: unknown = response.ok ? await response.json() : null
        if (cancelled) return
        const section = readCardCircuitsConfig(document)
        setConfig(section)
        setGate(cardProvingGate(section))
        setPhase('absent')
      } catch {
        if (cancelled) return
        setConfig(null)
        setGate(cardProvingGate(null))
        setPhase('absent')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => () => vault.current?.destroy(), [])

  /**
   * Start a fresh duel. The worker is kept and its seats are re-opened rather
   * than destroyed: `open` replaces a seat's bundle outright, and destroying
   * the worker would detach the transferred artifact buffers and force another
   * ~25 MB download for what is a one-click reset.
   */
  const reset = useCallback(async () => {
    seeds.current = {}
    setLastMove(null)
    setError(null)
    setSession(
      createCardSession({
        proofDomain: identity.proofDomain,
        duelId: identity.duelId,
        entryStake: identity.entryStake,
        participantCapacity: identity.participantCapacity,
      }),
    )
    const client = vault.current
    if (!client) {
      setViews([null, null])
      return
    }
    try {
      const reopened: (CardVaultView | null)[] = [null, null]
      for (const seat of [0, 1] as const) {
        reopened[seat] = await client.open(seat, {
          domain: identity.proofDomainField,
          duelId: identity.duelId.toString(10),
          player: identity.seats[seat].playerField,
        })
      }
      setViews([reopened[0] ?? null, reopened[1] ?? null])
    } catch (caught) {
      setViews([null, null])
      setPhase('absent')
      setError(caught instanceof Error ? caught.message : 'The vault could not be re-opened.')
    }
  }, [identity])

  /**
   * A different duel address is a different `proofDomain`, so every commitment
   * and every proof already made belongs to another duel. Re-shuffle rather
   * than leave the page showing state bound to an address it no longer targets.
   */
  const boundDomain = useRef(identity.proofDomain)
  useEffect(() => {
    if (boundDomain.current === identity.proofDomain) return
    boundDomain.current = identity.proofDomain
    void reset()
  }, [identity.proofDomain, reset])

  /**
   * Download and digest-check the proving artifacts, then shuffle a deck inside
   * the vault for each seat. Nothing before this point can produce a proof, and
   * nothing here can produce one without the pinned bytes.
   */
  const prepare = useCallback(async () => {
    if (!config) {
      setError('This coordinator distributes no card proving artifacts.')
      return
    }
    setError(null)
    setPhase('downloading')
    setBusy('Downloading and verifying the proving artifacts')
    try {
      const artifacts = await loadCardArtifacts(config, { onProgress: setProgress })
      const client = new CardVaultClient()
      await client.loadArtifacts(artifacts.deckInit, artifacts.handAction)
      const next: (CardVaultView | null)[] = [null, null]
      for (const seat of [0, 1] as const) {
        next[seat] = await client.open(seat, {
          domain: identity.proofDomainField,
          duelId: identity.duelId.toString(10),
          player: identity.seats[seat].playerField,
        })
      }
      vault.current = client
      setViews([next[0] ?? null, next[1] ?? null])
      setPhase('ready')
    } catch (caught) {
      setPhase('absent')
      setError(caught instanceof Error ? caught.message : 'The proving artifacts could not be loaded.')
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }, [config, identity])

  const steps = useMemo<CardStep[]>(
    () =>
      cardAvailableSteps({
        session,
        views,
        registered: [session.ledger.records.has(0), session.ledger.records.has(1)],
      }),
    [session, views],
  )

  const run = useCallback(
    async (step: CardStep, choice?: CardStepChoiceInput) => {
      const client = vault.current
      if (!client) {
        setError('Prepare the vault before making a move.')
        return
      }
      setBusy(step.provesLocally ? `Proving ${step.move} in the browser` : `Building ${step.move}`)
      setError(null)
      const seat = step.seat
      let staged = false
      try {
        let proof
        if (step.move === 'initializeDeck') {
          proof = await client.proveDeckInit(seat)
        } else if (step.move === 'draw' || step.move === 'burn' || step.move === 'play') {
          const action = step.move === 'draw' ? 1 : step.move === 'play' ? 2 : 3
          proof = await client.proveHandAction(seat, action, {
            handSlot: choice?.handSlot,
            publicBoardCount: session.duel.seats[seat].boardCount,
          })
          staged = true
        }
        if (step.move === 'commitSeed' && !seeds.current[seat]) seeds.current[seat] = randomSeed()

        const build = buildCardStep({
          session,
          identity,
          step,
          choice,
          proof: proof
            ? { circuit: proof.circuit, publicInputs: proof.publicInputs, innerProof: proof.innerProof }
            : undefined,
          seed: seeds.current[seat],
        })

        // The vault is the only party that knows this seat's secrets, so it is
        // the only party that can answer whether these bytes carry any.
        await client.audit(seat, build.calldata.calldata)

        const nextSession = build.payload
          ? applyCardSessionMove(session, {
              seat,
              payload: build.payload,
              calldata: build.calldata,
              participant: build.participant,
              provingMs: proof?.provingMs,
              publicInputs: build.publicInputs ?? undefined,
            })
          : applyCardEscrowMove(session, {
              seat,
              calldata: build.calldata,
              participant: build.participant,
              publicInputs: build.publicInputs ?? undefined,
            })

        // Collected as (seat, view) pairs rather than folded into a pair copied
        // out of this render, and applied with a functional update below: the
        // vault's answer for THIS seat is the only thing this move learned, so
        // it is the only thing that may be written. Rebuilding the pair from a
        // captured `views` would make every move re-assert the other seat's
        // view as well, which is correct only for as long as nothing else can
        // write `views` while a move is in flight.
        const refreshed: [CardSeatIndex, CardVaultView][] = []
        if (staged) {
          refreshed.push([seat, await client.commit(seat)])
        } else if (proof) {
          refreshed.push([seat, proof.view])
        }

        // An attack that clears a slot changes the DEFENDER's public board
        // count, which their private bundle has to fold in before it can prove
        // another action against a stale `oldBoardCount`.
        if (step.move === 'attack') {
          const defender = (seat === 0 ? 1 : 0) as CardSeatIndex
          const before = session.duel.seats[defender].boardCount
          const after = nextSession.duel.seats[defender].boardCount
          if (after === before - 1 && choice?.attackerSlot !== undefined) {
            refreshed.push([
              defender,
              await client.applyBoardCountChange(defender, {
                previousBoardCount: before,
                boardCount: after,
                turnNumber: session.duel.turnNumber,
                attackerSlot: choice.attackerSlot,
              }),
            ])
          }
        }

        setViews((current) =>
          refreshed.reduce((pair, [index, view]) => seatViews(pair, index, view), current),
        )
        // `nextSession` is deliberately absolute rather than functional: the
        // calldata, the participant nonce and the proof's public inputs were all
        // built against the exact `session` this closure captured, so folding
        // the result into a different one would publish a move that was never
        // proved. `run` is rebuilt whenever `session` changes, which is what
        // keeps that capture current.
        //
        // Settlement writes to the same state concurrently and only ever
        // touches status fields, so the merge below keeps the rules answer from
        // `nextSession` and the "where does this move stand with the room"
        // answer from whatever settlement recorded while this move was proving.
        // Without it, a move that landed on L1 mid-proof would silently revert
        // to reading as local-only.
        setSession((current) => cardCarrySubmissions(current, nextSession))
        setLastMove({
          sequence: nextSession.entries.length,
          calldata: build.calldata,
          publicInputs: build.publicInputs,
          provingMs: proof?.provingMs ?? null,
          audited: true,
        })
      } catch (caught) {
        if (staged) await client.discard(seat).catch(() => undefined)
        setError(caught instanceof Error ? caught.message : `${step.move} was refused.`)
      } finally {
        setBusy(null)
      }
    },
    // No `views`: the functional `setViews` above reads the current pair inside
    // the updater, so this callback does not close over one and does not need
    // to be rebuilt when it changes.
    [identity, session],
  )

  /**
   * Record where a move stands with the room. Settlement owns the transport and
   * the policy (`use-card-settlement.ts`); this hook owns the log, so the two
   * meet here rather than by handing a raw `setSession` across the boundary.
   */
  const markMove = useCallback(
    (
      sequence: number,
      patch: {
        status: CardSubmissionStatus
        actionId?: string | null
        block?: 1 | 2 | null
        error?: string | null
      },
    ) => setSession((current) => markCardSubmission(current, sequence, patch)),
    [],
  )

  const markCheckpoint = useCallback(
    (sequences: readonly number[], checkpointIndex: number) =>
      setSession((current) => markCardCheckpoint(current, sequences, checkpointIndex)),
    [],
  )

  /**
   * Ask the vault whether a byte string carries any of a seat's hidden
   * material. Exposed so SETTLEMENT can audit the signed envelope it builds:
   * the vault worker is the only realm holding the secrets, and a boundary
   * check that lives outside it would be guessing.
   *
   * A move built before the vault existed cannot have been proved either, so a
   * missing client is a refusal rather than a silent pass.
   */
  const auditBytes = useCallback(async (seat: number, hex: string) => {
    const client = vault.current
    if (!client) throw new Error('there is no open vault to audit these bytes against')
    await client.audit(seat as CardSeatIndex, hex)
  }, [])

  const exportVault = useCallback(async (seat: CardSeatIndex, password: string) => {
    const client = vault.current
    if (!client) throw new Error('there is no open vault to export')
    return client.exportEncrypted(seat, password)
  }, [])

  return {
    identity,
    /** What the operator typed; may be mid-edit and therefore not an address. */
    duelAddress,
    /**
     * The VALIDATED duel address every envelope calls. `identity` falls back to
     * the default while the field is mid-edit, and signing against the raw text
     * would produce moves for a contract that does not exist - or, worse, for a
     * different duel than the one `proofDomain` bound the proofs to.
     */
    duelContract: identity.duelAddress,
    setDuelAddress,
    config,
    gate,
    phase,
    progress,
    session,
    views,
    steps,
    busy,
    error,
    lastMove,
    prepare,
    run,
    markMove,
    markCheckpoint,
    auditBytes,
    exportVault,
    reset,
  }
}

export type CardDuelConsole = ReturnType<typeof useCardDuel>

function seatViews(views: Views, seat: CardSeatIndex, view: CardVaultView): Views {
  return seat === 0 ? [view, views[1]] : [views[0], view]
}
