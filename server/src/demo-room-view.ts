/**
 * A stored room turned into the document a browser can actually act on.
 *
 * Three things the snapshot does not hold, and all three were blockers:
 *
 * 1. THE CARD ROOM. A duel move is signed with `to = duel`, and `proofDomain` -
 *    public input 0 of every card circuit - is
 *    `keccak256(abi.encode(roomApplicationDomain, duel)) % p`. The addresses
 *    live on the TEMPLATE's preparation, so a client holding a room id had no
 *    route to them at all: `/demo/v1/rooms/:id` carried no card field, and a
 *    console had to be told the duel's address by hand. They are attached here,
 *    with `proofDomain` already reduced so a browser does not restate the
 *    derivation and quietly disagree about it.
 *
 * 2. WHY A ROOM IS REFUSING MOVES, AND WHERE THE GAME WENT. `addAction` used to
 *    say "room is not active" for two very different situations: a checkpoint
 *    is proving and the room reopens in a minute, or this room is finished and
 *    play moved to another one. An operator who reads the second as the first
 *    opens a fresh room from the same cold template and leaves every settled
 *    move behind, which is exactly the confusion that produced a duel that
 *    seemed to restart for no reason.
 *
 * 3. ADDRESSABLE TRANSACTIONS. `publicDemoView` truncates long hex by default,
 *    which turned the room's own deployment transaction into `0x05d3ac...ce78`
 *    - printable and unusable. Anything that represents state landed on L1
 *    carries its whole hash and an explorer link.
 *
 * Pure: every input is a value the caller already holds.
 */

import { cardProofDomain } from '@zkdeal/protocol'
import type { Hex } from 'viem'
import { roomIsOpen, pendingActions } from './demo-checkpoint-state.js'
import { roomSettings, type DemoRoomSettings } from './demo-room-settings.js'
import type {
  DemoAction,
  DemoCardRoom,
  DemoPhase,
  DemoRoom,
  DemoTemplate,
} from './demo-types.js'

/** Phases a room passes through while one of its checkpoints is in flight. */
const CHECKPOINTING_PHASES: readonly DemoPhase[] = [
  'PROVING',
  'LOCALLY_VERIFIED',
  'L1_PENDING',
]

/** Phases a room is in BEFORE it exists on L1; it has not refused anything yet. */
const UNDEPLOYED_PHASES: readonly DemoPhase[] = ['DRAFT', 'VALIDATED', 'ROOM_READY', 'DEPLOYED']

/**
 * The published card document: every address of the deployment this room's
 * cold template was prepared against, plus the field element those addresses
 * hash to.
 */
export interface DemoCardRoomPublication extends DemoCardRoom {
  /**
   * `keccak256(abi.encode(roomApplicationDomain, duelAddress)) % p` as a
   * DECIMAL string, because that is the form a circuit's public input takes.
   * Null only when the stored document cannot be reduced, which means it was
   * written by an incompatible build and should not be silently repaired.
   */
  proofDomain: string | null
}

/** One landed state sync, addressable rather than merely displayed. */
export interface DemoSettlementLink {
  checkpointSequence: number
  batchIndex: number
  l1Block: string
  l1BlockHash: string
  finalizedL1Block: string
  finalizedL1BlockHash: string
  /** Whole hash: `PUBLISHED_IN_FULL` exempts this key from truncation. */
  l1TransactionHash: string
  explorerUrl: string | null
}

/** The room's own creation transaction on L1. */
export interface DemoDeploymentLink {
  chainRoomId: string | null
  l1TransactionHash: string
  explorerUrl: string | null
}

/** Whether this room takes moves right now, and where play is if it does not. */
export interface DemoMoveAcceptance {
  accepting: boolean
  /** True when the refusal is temporary: a checkpoint is in flight. */
  reopens: boolean
  phase: DemoPhase
  /** Caller-safe sentence naming the phase and the consequence. */
  reason: string
  /**
   * The newest room still taking moves that was opened from the SAME cold
   * template after this one. Present only while this room refuses moves - that
   * is the moment an operator needs to be told where the game continued.
   */
  supersededBy: { id: string; name: string; phase: DemoPhase; createdAt: string } | null
}

export interface DemoActionView extends DemoAction {
  /** The L1 transaction that proved this move, or null while it is pending. */
  settlement: DemoSettlementLink | null
}

export interface DemoRoomView extends Omit<DemoRoom, 'actions'> {
  actions: DemoActionView[]
  settings: DemoRoomSettings
  moves: DemoMoveAcceptance
  deployment: DemoDeploymentLink | null
  cardRoom?: DemoCardRoomPublication
}

/** Everything `roomView` needs beyond the room itself. */
export interface RoomViewContext {
  /** The room's cold template, when it is still in the snapshot. */
  template: DemoTemplate | undefined
  /** Every room in the snapshot, for the supersession lookup. */
  rooms: readonly DemoRoom[]
  /** `${explorerUrl}/tx/${hash}`, or null when no explorer is configured. */
  transactionUrl: (hash: string) => string | null
}

export function cardRoomPublication(
  document: DemoCardRoom,
): DemoCardRoomPublication {
  let proofDomain: string | null = null
  try {
    proofDomain = cardProofDomain(
      document.roomApplicationDomain as Hex,
      document.duelAddress as Hex,
    ).toString(10)
  } catch {
    // A document written by an incompatible build. Publishing null says so;
    // publishing a guess would make every proof commit to the wrong domain.
    proofDomain = null
  }
  return { ...document, proofDomain }
}

/** The newest still-open room opened from `room`'s template after `room`. */
function successorOf(room: DemoRoom, rooms: readonly DemoRoom[]): DemoRoom | null {
  const candidates = rooms.filter(
    (other) =>
      other.id !== room.id &&
      other.templateId === room.templateId &&
      roomIsOpen(other) &&
      Date.parse(other.createdAt) >= Date.parse(room.createdAt),
  )
  candidates.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
  return candidates[0] ?? null
}

export function moveAcceptance(
  room: DemoRoom,
  rooms: readonly DemoRoom[],
): DemoMoveAcceptance {
  if (roomIsOpen(room)) {
    return {
      accepting: true,
      reopens: false,
      phase: room.phase,
      reason: `this room is ${room.phase} and accepts moves; ${
        pendingActions(room).length
      } move(s) are waiting for the next checkpoint`,
      supersededBy: null,
    }
  }
  if (UNDEPLOYED_PHASES.includes(room.phase)) {
    return {
      accepting: false,
      reopens: true,
      phase: room.phase,
      reason:
        `this room is ${room.phase}: it does not exist on L1 yet, so there is nothing for a move ` +
        'to be proved against. Deploy it and it accepts moves. Nothing has been refused or lost.',
      supersededBy: null,
    }
  }
  if (CHECKPOINTING_PHASES.includes(room.phase)) {
    const running = room.checkpoints.find((record) => record.outcome === 'RUNNING')
    return {
      accepting: false,
      reopens: true,
      phase: room.phase,
      reason:
        `checkpoint ${running?.sequence ?? room.checkpoints.length} is ${room.phase} for this ` +
        'room. The refusal is temporary: this same room accepts moves again as soon as the ' +
        'batch lands, so do NOT open a second room - the moves it already settled stay here.',
      supersededBy: null,
    }
  }
  const successor = successorOf(room, rooms)
  return {
    accepting: false,
    reopens: false,
    phase: room.phase,
    reason: successor
      ? `this room is ${room.phase} and no longer accepts moves; play continued in '${successor.name}' ` +
        `(${successor.id}), opened from the same cold template. The moves this room settled stay ` +
        'here and remain verifiable at their own L1 transactions.'
      : `this room is ${room.phase} and no longer accepts moves. Nothing it settled was lost: ` +
        'every accepted checkpoint keeps its own L1 transaction. A new room opened from the same ' +
        'cold template starts from the COLD state, not from this room, so these moves stay behind.',
    supersededBy: successor
      ? {
          id: successor.id,
          name: successor.name,
          phase: successor.phase,
          createdAt: successor.createdAt,
        }
      : null,
  }
}

/** The refusal `addAction` throws, so the API says the same thing the room does. */
export function closedRoomExplanation(
  room: DemoRoom,
  rooms: readonly DemoRoom[],
): string {
  const acceptance = moveAcceptance(room, rooms)
  return `room '${room.name}' (${room.id}) is not accepting moves: ${acceptance.reason}`
}

function settlementOf(
  room: DemoRoom,
  action: DemoAction,
): DemoSettlementLink | null {
  if (action.checkpointSequence === null) return null
  const record = room.checkpoints.find(
    (item) => item.sequence === action.checkpointSequence && item.outcome === 'ACCEPTED',
  )
  if (!record?.result) return null
  return {
    checkpointSequence: record.sequence,
    batchIndex: record.result.batchIndex,
    l1Block: record.result.l1Block,
    l1BlockHash: record.result.l1BlockHash,
    finalizedL1Block: record.result.finalizedL1Block,
    finalizedL1BlockHash: record.result.finalizedL1BlockHash,
    l1TransactionHash: record.result.l1TransactionHash,
    explorerUrl: record.result.explorerUrl,
  }
}

/**
 * The published room. `room` must already be a clone the caller owns: the
 * returned document shares its action objects' identity only through the spread
 * below, and nothing here writes to the snapshot.
 */
export function roomView(room: DemoRoom, context: RoomViewContext): DemoRoomView {
  const cardRoom = context.template?.preparation?.cardRoom
  return {
    ...room,
    actions: room.actions.map((action) => ({
      ...action,
      settlement: settlementOf(room, action),
    })),
    settings: roomSettings(room.deadlineBlocksFromStart, context.template?.presetId),
    moves: moveAcceptance(room, context.rooms),
    deployment: room.deploymentTransaction
      ? {
          chainRoomId: room.chainRoomId,
          l1TransactionHash: room.deploymentTransaction,
          explorerUrl: context.transactionUrl(room.deploymentTransaction),
        }
      : null,
    ...(cardRoom ? { cardRoom: cardRoomPublication(cardRoom) } : {}),
  }
}
