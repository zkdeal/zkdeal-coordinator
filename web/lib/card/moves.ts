/**
 * Turning one chosen step into the three things a move needs: the calldata to
 * publish, the rules payload to rehearse it against, and the participant leaf
 * the mirror must adopt.
 *
 * All three are derived from the SAME proof vector, so the bytes on the wire,
 * the local rules check and the participant nonce cannot disagree. In
 * particular the roots that reach calldata are read out of the circuit's own
 * ordered public inputs rather than recomputed, which is why a mismatch between
 * what was proved and what is published is not expressible here.
 *
 * React-free, so an entire duel can be driven in a unit test.
 */
import {
  CardHandActionKind,
  CardMove,
  cardSeedCommitment,
  type CardHandActionPublicInputs,
  type CardMovePayload,
  type CardSeatIndex,
} from '@zkdeal/card'
import type { Hex } from '@zkdeal/protocol'
import {
  buildCardMoveCalldata,
  cardFieldToBytes32,
  type CardCalldata,
  type CardMoveRequest,
} from './calldata'
import { CARD_DEMO_SESSION_EXPIRY, type CardDemoIdentity } from './identity'
import {
  cardAdvancedParticipant,
  cardEmptyLeafProof,
  cardLedgerProof,
  cardParticipant,
  cardRegisteredParticipant,
  type ParticipantLeaf,
} from './participants'
import type { CardSessionState } from './session'
import type { CardStep } from './steps'
/**
 * A proof exactly as the vault released it: the ordered public inputs plus the
 * 256-byte adapter payload. The page never handles proof coordinates, which is
 * also why the snarkjs encoder stays inside the worker's module graph.
 */
export interface CardProofResult {
  readonly circuit: 'deck-init-v4' | 'hand-action-v4'
  readonly publicInputs: readonly string[]
  readonly innerProof: string
}

export interface CardStepChoiceInput {
  readonly handSlot?: number
  readonly boardSlot?: number
  readonly attackerSlot?: number
  readonly targetSlot?: number
}

export interface CardMoveBuild {
  readonly seat: CardSeatIndex
  readonly calldata: CardCalldata
  /** Null for escrow-only entry points, which the read-model does not mirror. */
  readonly payload: CardMovePayload | null
  readonly participant: ParticipantLeaf
  readonly publicInputs: readonly string[] | null
}

export interface CardStepBuildInput {
  readonly session: CardSessionState
  readonly identity: CardDemoIdentity
  readonly step: CardStep
  readonly choice?: CardStepChoiceInput
  readonly proof?: CardProofResult
  /** 32-byte seed for `commitSeed` / `revealSeed`; never persisted anywhere. */
  readonly seed?: Hex
}

const HAND_ACTION_ORDER = [
  'domain',
  'duelId',
  'player',
  'action',
  'actionCursor',
  'deckRoot',
  'oldHandRoot',
  'newHandRoot',
  'oldDeckCursor',
  'newDeckCursor',
  'oldHandCount',
  'newHandCount',
  'oldBoardCount',
  'newBoardCount',
  'publicCard',
] as const

function handActionInputs(vector: readonly string[]): CardHandActionPublicInputs {
  if (vector.length !== HAND_ACTION_ORDER.length) {
    throw new Error(`a hand-action proof carries ${HAND_ACTION_ORDER.length} public inputs`)
  }
  const at = (name: (typeof HAND_ACTION_ORDER)[number]) => vector[HAND_ACTION_ORDER.indexOf(name)]!
  return {
    kind: 'hand-action-v4',
    domain: at('domain'),
    duelId: at('duelId'),
    player: at('player'),
    action: Number(at('action')) as CardHandActionKind,
    actionCursor: at('actionCursor'),
    deckRoot: at('deckRoot'),
    oldHandRoot: at('oldHandRoot'),
    newHandRoot: at('newHandRoot'),
    oldDeckCursor: at('oldDeckCursor'),
    newDeckCursor: at('newDeckCursor'),
    oldHandCount: at('oldHandCount'),
    newHandCount: at('newHandCount'),
    oldBoardCount: at('oldBoardCount'),
    newBoardCount: at('newBoardCount'),
    publicCard: at('publicCard'),
  }
}

function requireProof(input: CardStepBuildInput, circuit: CardProofResult['circuit']): CardProofResult {
  const proof = input.proof
  if (!proof) throw new Error(`${input.step.move} requires a locally produced ${circuit} proof`)
  if (proof.circuit !== circuit) throw new Error(`${input.step.move} needs a ${circuit} proof`)
  return proof
}

/**
 * Build a move. Throws rather than guessing whenever a required choice, proof
 * or participant leaf is absent: a partially specified transaction is worse
 * than no transaction.
 */
export function buildCardStep(input: CardStepBuildInput): CardMoveBuild {
  const { session, identity, step } = input
  const seat = step.seat
  const seatIdentity = identity.seats[seat]
  const index = seatIdentity.participantIndex
  const duelId = identity.duelId

  if (step.move === 'registerDuelist') {
    const participant = cardRegisteredParticipant({
      index,
      owner: seatIdentity.owner,
      sessionKey: seatIdentity.sessionKey,
      sessionExpiry: CARD_DEMO_SESSION_EXPIRY,
      fundedAmount: identity.fundedAmount,
    })
    const calldata = buildCardMoveCalldata({
      move: 'registerDuelist',
      registration: {
        index,
        sessionKey: seatIdentity.sessionKey,
        sessionExpiry: CARD_DEMO_SESSION_EXPIRY,
        fundedAmount: identity.fundedAmount,
        emptyLeafProof: cardEmptyLeafProof(session.ledger, index),
      },
    })
    return { seat, calldata, payload: null, participant, publicInputs: null }
  }

  const previous = cardParticipant(session.ledger, index)
  const participantProof = cardLedgerProof(session.ledger, index)
  const shared = { previous, participantProof, duelId } satisfies Partial<CardMoveRequest>

  switch (step.move) {
    case 'openDuel':
    case 'joinDuel': {
      const calldata = buildCardMoveCalldata({ ...shared, move: step.move })
      return {
        seat,
        calldata,
        payload: {
          move: step.move === 'openDuel' ? CardMove.OpenDuel : CardMove.JoinDuel,
          participantIndex: BigInt(index),
          owner: seatIdentity.owner,
        },
        participant: cardAdvancedParticipant(previous, {
          paymentSpent: previous.paymentSpent + identity.entryStake,
        }),
        publicInputs: null,
      }
    }
    case 'abandonDuel':
      return {
        seat,
        calldata: buildCardMoveCalldata({ ...shared, move: 'abandonDuel' }),
        payload: { move: CardMove.AbandonDuel },
        participant: cardAdvancedParticipant(previous, {
          paymentSpent: previous.paymentSpent - identity.entryStake,
        }),
        publicInputs: null,
      }
    case 'initializeDeck': {
      const proof = requireProof(input, 'deck-init-v4')
      const [, , , deckRoot, emptyHandRoot] = proof.publicInputs
      return {
        seat,
        calldata: buildCardMoveCalldata({
          ...shared,
          move: 'initializeDeck',
          deckRoot: cardFieldToBytes32(deckRoot!),
          emptyHandRoot: cardFieldToBytes32(emptyHandRoot!),
          innerProof: proof.innerProof as Hex,
        }),
        payload: {
          move: CardMove.InitializeDeck,
          deckRoot: deckRoot!,
          emptyHandRoot: emptyHandRoot!,
          proofAccepted: true,
          publicInputs: {
            kind: 'deck-init-v4',
            domain: proof.publicInputs[0]!,
            duelId: proof.publicInputs[1]!,
            player: proof.publicInputs[2]!,
            deckRoot: deckRoot!,
            emptyHandRoot: emptyHandRoot!,
          },
        },
        participant: cardAdvancedParticipant(previous),
        publicInputs: proof.publicInputs,
      }
    }
    case 'commitSeed': {
      if (!input.seed) throw new Error('commitSeed needs a locally generated seed')
      const commitment = cardSeedCommitment({
        proofDomain: identity.proofDomain,
        duelId,
        player: seatIdentity.owner,
        seed: input.seed,
      })
      return {
        seat,
        calldata: buildCardMoveCalldata({ ...shared, move: 'commitSeed', commitment }),
        payload: { move: CardMove.CommitSeed, commitment },
        participant: cardAdvancedParticipant(previous),
        publicInputs: null,
      }
    }
    case 'revealSeed': {
      if (!input.seed) throw new Error('revealSeed needs the seed that was committed')
      return {
        seat,
        calldata: buildCardMoveCalldata({ ...shared, move: 'revealSeed', seed: input.seed }),
        payload: { move: CardMove.RevealSeed, seed: input.seed },
        participant: cardAdvancedParticipant(previous),
        publicInputs: null,
      }
    }
    case 'draw':
    case 'burn': {
      const proof = requireProof(input, 'hand-action-v4')
      const inputs = handActionInputs(proof.publicInputs)
      const newHandRoot = String(inputs.newHandRoot)
      return {
        seat,
        calldata: buildCardMoveCalldata({
          ...shared,
          move: step.move,
          newHandRoot: cardFieldToBytes32(newHandRoot),
          innerProof: proof.innerProof as Hex,
        }),
        payload: {
          move: step.move === 'draw' ? CardMove.Draw : CardMove.Burn,
          newHandRoot,
          proofAccepted: true,
          publicInputs: inputs,
        },
        participant: cardAdvancedParticipant(previous),
        publicInputs: proof.publicInputs,
      }
    }
    case 'play': {
      const proof = requireProof(input, 'hand-action-v4')
      const inputs = handActionInputs(proof.publicInputs)
      const newHandRoot = String(inputs.newHandRoot)
      const cardId = Number(inputs.publicCard)
      const boardSlot = input.choice?.boardSlot
      if (boardSlot === undefined) throw new Error('play needs a board slot')
      return {
        seat,
        calldata: buildCardMoveCalldata({
          ...shared,
          move: 'play',
          newHandRoot: cardFieldToBytes32(newHandRoot),
          cardId,
          boardSlot,
          innerProof: proof.innerProof as Hex,
        }),
        payload: {
          move: CardMove.Play,
          newHandRoot,
          cardId,
          boardSlot,
          proofAccepted: true,
          publicInputs: inputs,
        },
        participant: cardAdvancedParticipant(previous),
        publicInputs: proof.publicInputs,
      }
    }
    case 'attack': {
      const attackerSlot = input.choice?.attackerSlot
      const targetSlot = input.choice?.targetSlot
      if (attackerSlot === undefined || targetSlot === undefined) {
        throw new Error('attack needs an attacker slot and a target slot')
      }
      return {
        seat,
        calldata: buildCardMoveCalldata({ ...shared, move: 'attack', attackerSlot, targetSlot }),
        payload: { move: CardMove.Attack, attackerSlot, targetSlot },
        participant: cardAdvancedParticipant(previous),
        publicInputs: null,
      }
    }
    case 'endTurn':
      return {
        seat,
        calldata: buildCardMoveCalldata({ ...shared, move: 'endTurn' }),
        payload: { move: CardMove.EndTurn },
        participant: cardAdvancedParticipant(previous),
        publicInputs: null,
      }
    case 'concede':
      return {
        seat,
        calldata: buildCardMoveCalldata({ ...shared, move: 'concede' }),
        payload: { move: CardMove.Concede },
        participant: cardAdvancedParticipant(previous),
        publicInputs: null,
      }
    case 'claimPrize':
      return {
        seat,
        calldata: buildCardMoveCalldata({ ...shared, move: 'claimPrize' }),
        payload: { move: CardMove.ClaimPrize },
        // claimPrize consumes exactly the slack the two entries created:
        // spendLimit gains the pot minus this seat's own stake, and the stake
        // itself stops being spent.
        participant: cardAdvancedParticipant(previous, {
          spendLimit: previous.spendLimit + (session.duel.pot - identity.entryStake),
          paymentSpent: previous.paymentSpent - identity.entryStake,
        }),
        publicInputs: null,
      }
    default:
      throw new Error(`${step.move} is not a move this console builds`)
  }
}
