import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCardWitnessBundle, type CardWitnessBundle } from '@zkdeal/card'
import { cardDemoIdentity } from '../lib/card/identity'
import { cardMoveBody, submitCardMove } from '../lib/card/demo-room'
import {
  cardEnvelopeFields,
  cardSeatNonce,
  signCardMoveEnvelope,
} from '../lib/card/envelope'
import { buildCardStep, type CardProofResult } from '../lib/card/moves'
import {
  CARD_WITNESS_FIELD_NAMES,
  assertNoWitnessFieldNames,
  auditCardCalldata,
  cardBundleSecrets,
} from '../lib/card/privacy'
import {
  applyCardEscrowMove,
  applyCardSessionMove,
  createCardSession,
} from '../lib/card/session'
import { cardAutoplayReducer, createCardAutoplayState } from '../lib/card/autoplay-state'
import { cardAvailableSteps, type CardStep } from '../lib/card/steps'
import {
  cardCheckpointReceipt,
  cardCheckpointRecord,
  cardProvenSequences,
  cardRoomCheckpoints,
} from '../lib/card/settlement'
import { FAKE_PROOF, entry, submitted, viewOf } from './helpers/card-settlement-fixtures'

/**
 * Progressive settlement, half two: RECEIPTS, BACK-PRESSURE and THE WIRE.
 *
 * Three properties are load-bearing here:
 *
 *   1. The merged room transaction hash the console renders is the real one.
 *      The coordinator abbreviates it, so it is recovered from the explorer URL
 *      - and when it cannot be recovered, that is reported rather than papered
 *      over with the abbreviation.
 *   2. Autoplay HOLDS while a checkpoint proves instead of ending, so a player
 *      is never cut off by settlement they did not ask for.
 *   3. Submitting a move sends the published calldata and nothing else. This is
 *      asserted against the actual request body the real transport puts on the
 *      wire, with real witness material to compare against.
 *
 * The move stages and the checkpoint cadence are asserted in
 * `card-room-settlement.test.ts`; shared fixtures live in
 * `helpers/card-settlement-fixtures.ts`.
 */
const identity = cardDemoIdentity()
describe('the merged room transaction', () => {
  const HASH = `0x${'ab'.repeat(32)}`

  it('recovers the full hash the coordinator abbreviated', () => {
    // `publicDemoView` rewrites any 40+ character hex string, so `transaction`
    // arrives truncated and only the explorer URL still carries the real hash.
    const receipt = cardCheckpointReceipt(
      { transaction: '0xebf39d...7bcf', explorerUrl: `http://192.168.0.11:3200/tx/${HASH}` },
      'http://192.168.0.11:3200',
    )
    expect(receipt.transaction).toBe(HASH)
    expect(receipt.complete).toBe(true)
    expect(receipt.note).toBeNull()
    expect(receipt.url).toBe(`http://192.168.0.11:3200/tx/${HASH}`)
  })

  it('builds the explorer link from the coordinator-advertised root, never a hardcoded one', () => {
    const receipt = cardCheckpointReceipt(
      { transaction: HASH, explorerUrl: null },
      'https://explorer.example/',
    )
    expect(receipt.url).toBe(`https://explorer.example/tx/${HASH}`)
    expect(cardCheckpointReceipt({ transaction: HASH, explorerUrl: null }, null).url).toBeNull()
  })

  it('admits an abbreviation instead of presenting it as the hash', () => {
    const receipt = cardCheckpointReceipt({ transaction: '0xebf39d...7bcf' }, null)
    expect(receipt.complete).toBe(false)
    expect(receipt.transaction).toBe('0xebf39d...7bcf')
    expect(receipt.note).toMatch(/abbreviated/)
    expect(receipt.url).toBeNull()
  })

  it('refuses a non-http explorer link', () => {
    const receipt = cardCheckpointReceipt(
      { transaction: HASH, explorerUrl: 'javascript:alert(1)' },
      null,
    )
    expect(receipt.url).toBeNull()
  })

  it('records which moves a checkpoint proved, so a long game reads as a progression', () => {
    const record = cardCheckpointRecord({
      index: 2,
      roomId: 'room-1',
      checkpoint: {
        transaction: '0xabc...def',
        l1Block: '4211',
        postStateRoot: `0x${'11'.repeat(32)}`,
        proofMs: 17_170,
        localVerificationMs: 42,
        explorerUrl: `http://192.168.0.11:3200/tx/${HASH}`,
      },
      sequences: [7, 8, 9],
      explorerBase: 'http://192.168.0.11:3200',
      at: 5,
    })
    expect(record.index).toBe(2)
    expect(record.sequences).toEqual([7, 8, 9])
    expect(record.receipt.transaction).toBe(HASH)
  })

  it('refuses to credit a move whose accepted action the room no longer lists', () => {
    const entries = [submitted(1, 1), submitted(2, 2), submitted(3, 2)]
    // The room lists the actions for moves 1 and 3 only.
    const { proven, dropped } = cardProvenSequences(
      [1, 2, 3],
      entries,
      ['act-1', 'act-3', 'act-unrelated'],
    )
    expect(proven).toEqual([1, 3])
    expect(dropped).toEqual([2])
    // A move that was never handed over has no action id and can never be
    // credited to a receipt, even one that really did land on L1.
    expect(cardProvenSequences([4], [entry({ sequence: 4 })], ['act-4'])).toEqual({
      proven: [],
      dropped: [4],
    })
  })

  it('prefers a published checkpoint list over the single latest receipt', () => {
    const one = { transaction: '0x1', l1Block: '1', postStateRoot: '0x', proofMs: 1, localVerificationMs: 1 }
    const two = { ...one, l1Block: '2' }
    expect(cardRoomCheckpoints({ checkpoint: one })).toEqual([one])
    expect(cardRoomCheckpoints({ checkpoint: one, checkpoints: [one, two] })).toEqual([one, two])
    expect(cardRoomCheckpoints(null)).toEqual([])
    expect(cardRoomCheckpoints({})).toEqual([])
  })
})

describe('autoplay under checkpoint back-pressure', () => {
  const HOLD = 'Waiting for the room to prove 6 submitted moves and land the batch on L1.'

  it('holds a run without ending it, and gives back its budget when the batch lands', () => {
    let state = cardAutoplayReducer(createCardAutoplayState(), { type: 'start' })
    state = cardAutoplayReducer(state, { type: 'act', move: 'draw', seat: 0, proving: true })
    state = cardAutoplayReducer(state, { type: 'hold', hold: HOLD })
    // A checkpoint is not a reason to end a run: seventeen seconds of proving
    // must read as "waiting on L1", not as a finished demo.
    expect(state.status).toBe('running')
    expect(state.end).toBeNull()
    expect(state.hold).toBe(HOLD)
    expect(state.movesMade).toBe(1)
    // The hook re-derives the hold on every render, so an identical hold has to
    // be a no-op or the console re-renders forever.
    expect(cardAutoplayReducer(state, { type: 'hold', hold: HOLD })).toBe(state)
    const resumed = cardAutoplayReducer(state, { type: 'hold', hold: null })
    expect(resumed).toMatchObject({ status: 'running', hold: null, movesMade: 1 })
  })

  it('never holds a run that is not running, and drops the hold when one ends', () => {
    const idle = createCardAutoplayState()
    expect(cardAutoplayReducer(idle, { type: 'hold', hold: HOLD })).toBe(idle)
    const held = cardAutoplayReducer(
      cardAutoplayReducer(idle, { type: 'start' }),
      { type: 'hold', hold: HOLD },
    )
    expect(cardAutoplayReducer(held, { type: 'stop' })).toMatchObject({
      status: 'ended',
      hold: null,
    })
  })

  it('carries no hidden material in the state a presenter sees', () => {
    const held = cardAutoplayReducer(
      cardAutoplayReducer(createCardAutoplayState(), { type: 'start' }),
      { type: 'hold', hold: HOLD },
    )
    assertNoWitnessFieldNames(JSON.parse(JSON.stringify(held)), 'autoplay state')
  })
})

describe('what a submitted move puts on the wire', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends the published calldata and nothing else, against real witness material', async () => {
    const bundles: CardWitnessBundle[] = []
    for (const seat of [0, 1] as const) {
      bundles.push(
        await createCardWitnessBundle({
          domain: identity.proofDomainField,
          duelId: identity.duelId.toString(10),
          player: identity.seats[seat].playerField,
        }),
      )
    }
    let session = createCardSession({
      proofDomain: identity.proofDomain,
      duelId: identity.duelId,
      entryStake: identity.entryStake,
      participantCapacity: identity.participantCapacity,
    })
    const steps = (): CardStep[] =>
      cardAvailableSteps({
        session,
        views: [viewOf(bundles[0]!), viewOf(bundles[1]!)],
        registered: [session.ledger.records.has(0), session.ledger.records.has(1)],
      })
    const play = (move: string, seat?: number) => {
      const step = steps().find(
        (candidate) => candidate.move === move && (seat === undefined || candidate.seat === seat),
      )
      if (!step) throw new Error(`${move} is not offered in phase ${session.duel.phase}`)
      const proof =
        move === 'initializeDeck'
          ? ({
              circuit: 'deck-init-v4' as const,
              publicInputs: [
                bundles[step.seat]!.domain,
                bundles[step.seat]!.duelId,
                bundles[step.seat]!.player,
                bundles[step.seat]!.deckRoot,
                bundles[step.seat]!.handRoot,
              ],
              innerProof: FAKE_PROOF,
            } satisfies CardProofResult)
          : undefined
      const build = buildCardStep({ session, identity, step, proof })
      session = build.payload
        ? applyCardSessionMove(session, {
            seat: build.seat,
            payload: build.payload,
            calldata: build.calldata,
            participant: build.participant,
            publicInputs: build.publicInputs ?? undefined,
          })
        : applyCardEscrowMove(session, {
            seat: build.seat,
            calldata: build.calldata,
            participant: build.participant,
          })
    }

    play('registerDuelist', 0)
    play('registerDuelist', 1)
    play('openDuel')
    play('joinDuel')
    play('initializeDeck', 0)
    play('initializeDeck', 1)
    expect(session.entries.length).toBe(6)

    const sent: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body ?? '{}')))
        return {
          ok: true,
          status: 202,
          statusText: 'Accepted',
          text: async () => JSON.stringify({ id: 'act-000' }),
        } as unknown as Response
      }),
    )

    const chainId = 1_134_288_386_081_462
    for (const [index, item] of session.entries.entries()) {
      const envelope = await signCardMoveEnvelope({
        seat: item.seat,
        move: item.move,
        duelAddress: identity.duelAddress,
        chainId,
        nonce: cardSeatNonce(session.entries, item.seat, item.sequence),
        calldata: item.calldata.calldata,
      })
      // The seat that PROVED the move is the seat that signed it: the recovered
      // sender is the address the circuit's `player` public input commits to.
      expect(envelope.signer.toLowerCase()).toBe(identity.seats[item.seat]!.owner.toLowerCase())
      const accepted = await submitCardMove({
        roomId: 'room-1',
        actorId: `seat-${item.seat}`,
        move: item.move,
        calldata: item.calldata.calldata,
        signedTransaction: envelope.signedTransaction,
        block: index === 0 ? 1 : 2,
      })
      expect(accepted.actionId).toBe('act-000')
    }

    expect(sent.length).toBe(session.entries.length)
    const secrets = bundles.flatMap((bundle) => cardBundleSecrets(bundle))
    for (const body of sent) {
      // The body has exactly five keys, and none of them can name a witness.
      expect(Object.keys(body as object).sort()).toEqual([
        'actionId',
        'actorId',
        'block',
        'calldata',
        'signedTransaction',
      ])
      assertNoWitnessFieldNames(body, 'card move request')
      const serialized = JSON.stringify(body).toLowerCase()
      for (const name of CARD_WITNESS_FIELD_NAMES) {
        expect(serialized).not.toContain(name.toLowerCase())
      }
      const wire = body as { calldata: string; signedTransaction: string }
      auditCardCalldata(secrets, wire.calldata)
      // The envelope is scanned as well, not just the calldata it wraps: it is
      // the larger of the two payloads and is the one that actually reaches L1.
      auditCardCalldata(secrets, wire.signedTransaction, 'card move envelope')
      // And it carries the SUBMITTED calldata, byte for byte - a room that
      // proved one payload while the console published another would be the
      // exact dishonesty this console exists to make checkable.
      const fields = cardEnvelopeFields(wire.signedTransaction)
      expect(fields.calldata.toLowerCase()).toBe(wire.calldata.toLowerCase())
      expect(fields.to.toLowerCase()).toBe(identity.duelAddress.toLowerCase())
      expect(fields.chainId).toBe(chainId)
      expect(fields.value).toBe(0n)
      expect(fields.maxFeePerGas).toBe(0n)
      expect(fields.maxPriorityFeePerGas).toBe(0n)
      expect(fields.accessListEntries).toBe(0)
    }
  })

  it('refuses to build a body out of anything that is not plain hex calldata', () => {
    expect(() =>
      cardMoveBody({
        roomId: 'room-1',
        actorId: 'seat-0',
        move: 'draw',
        calldata: '{"deckCards":[1,2,3]}',
        signedTransaction: `0x02${'11'.repeat(80)}`,
        block: 1,
      }),
    ).toThrow(/plain hex calldata/)
  })

  it('refuses a move with no signed envelope, and one whose envelope is not its calldata', async () => {
    const calldata = '0x1234567800000000000000000000000000000000000000000000000000000000000000ff'
    const envelope = await signCardMoveEnvelope({
      seat: 0,
      move: 'draw',
      duelAddress: identity.duelAddress,
      chainId: 1_134_288_386_081_462,
      nonce: 0,
      calldata,
    })
    expect(() =>
      cardMoveBody({
        roomId: 'room-1',
        actorId: 'seat-0',
        move: 'draw',
        calldata,
        signedTransaction: '0x02',
        block: 1,
      }),
    ).toThrow(/signed EIP-2718 envelope/)
    // The envelope belongs to a DIFFERENT move's calldata. A body whose two
    // fields disagree would ask the room to prove one thing and publish another.
    expect(() =>
      cardMoveBody({
        roomId: 'room-1',
        actorId: 'seat-0',
        move: 'draw',
        calldata: `${calldata.slice(0, -2)}ee`,
        signedTransaction: envelope.signedTransaction,
        block: 1,
      }),
    ).toThrow(/does not contain the calldata/)
  })
})
