/**
 * The two shapes settlement speaks in.
 *
 * They live apart from the hook because they are a CONTRACT rather than an
 * implementation detail: `CardSettlementDuel` is the exact slice of the duel
 * that settlement is allowed to touch - no raw state setter crosses it - and
 * `CardSettlementControls` is what the room panel, the checkpoint panel and
 * the move log all read. Reading them without reading the hook is the point.
 */
import type { Hex } from '@zkdeal/protocol'
import type {
  CardCoordinator,
  CardRoomSummary,
  CardRoomTarget,
  CardRoomTemplate,
} from '@/lib/card/demo-room'
import type { L1Receipt } from '@/lib/l1-receipt'
import type { CardSessionState, CardSubmissionStatus } from '@/lib/card/session'
import type {
  CardCheckpointDue,
  CardCheckpointPolicy,
  CardCheckpointRecord,
  CardSettlementCounts,
} from '@/lib/card/settlement'

export type CardSettlementActivity =
  | 'idle'
  | 'looking'
  | 'opening'
  | 'submitting'
  | 'checkpointing'

/** The slice of `useCardDuel` settlement drives. Nothing here is settlement-only. */
export interface CardSettlementDuel {
  readonly session: CardSessionState
  readonly busy: string | null
  /**
   * The duel contract every envelope calls. It is also what `proofDomain` - and
   * therefore every proof in the log - was derived from, so signing against a
   * different address would publish moves for another duel entirely.
   */
  readonly duelContract: Hex
  /**
   * Ask the vault to confirm a byte string carries none of the seat's hidden
   * material. The vault is the only realm that holds the secrets, so it is the
   * only party that can answer; the envelope goes through it for the same
   * reason the calldata does.
   */
  readonly auditBytes: (seat: number, hex: string) => Promise<void>
  /**
   * Point the console at the duel the coordinator prepared its cold template
   * against. Not cosmetic and not guessable: the address is the `to` of every
   * signed move AND, with `roomApplicationDomain`, the preimage of
   * `proofDomain`, public input 0 of every card circuit.
   */
  readonly setDuelAddress: (address: string) => void
  readonly markMove: (
    sequence: number,
    patch: {
      status: CardSubmissionStatus
      actionId?: string | null
      block?: 1 | 2 | null
      error?: string | null
    },
  ) => void
  readonly markCheckpoint: (sequences: readonly number[], checkpointIndex: number) => void
}

export interface CardSettlementControls {
  readonly room: CardRoomTarget | null
  readonly reason: string | null
  /**
   * Every card room the coordinator holds, oldest first, so a presenter can see
   * at a glance which one is live. A room that has settled keeps existing and
   * stops accepting moves; without this list the only signal that the duel is
   * now pointed at a DIFFERENT room is a name changing in one line of text.
   */
  readonly rooms: readonly CardRoomSummary[]
  /** The current room's own deployment transaction, when one can be resolved. */
  readonly deployment: L1Receipt | null
  readonly template: CardRoomTemplate | null
  /**
   * The L1 inclusion allowance a NEW room is opened with, in seconds of wall
   * clock - the unit a presenter thinks in. Converted to blocks with the
   * coordinator's own `l1BlockSeconds` at the moment the room is created.
   */
  readonly deadlineSeconds: number
  readonly setDeadlineSeconds: (seconds: number) => void
  /** What that choice comes to in L1 blocks on this stand, after the floor. */
  readonly deadlineBlocks: number
  readonly coordinator: CardCoordinator | null
  readonly policy: CardCheckpointPolicy
  readonly counts: CardSettlementCounts
  readonly due: CardCheckpointDue
  readonly hint: string
  readonly checkpoints: readonly CardCheckpointRecord[]
  /**
   * `room_chain_id_v5(deploymentDomain, roomId)`, or null with `signingReason`
   * naming what is missing. Every move this console signs carries it.
   */
  readonly chainId: number | null
  /** Why no move can be signed for this room right now, or null. */
  readonly signingReason: string | null
  readonly activity: CardSettlementActivity
  /** The coordinator's own phase while a job runs, e.g. PROVING or L1_PENDING. */
  readonly stage: string | null
  /** A refusal, verbatim, that has stopped automatic settlement. */
  readonly blockedBy: string | null
  readonly notice: string | null
  readonly auto: boolean
  readonly setAuto: (value: boolean) => void
  /** Why autoplay is standing still, or null when it may act. */
  readonly hold: string | null
  readonly attach: () => Promise<void>
  readonly openRoom: () => Promise<void>
  readonly submitMove: (sequence: number) => Promise<void>
  readonly checkpointNow: () => Promise<void>
  readonly clearBlock: () => void
}
