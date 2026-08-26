/**
 * The coordinator client for a hidden-card duel: finding or opening a card
 * room, handing it one move, and asking it to prove and checkpoint.
 *
 * This is the EXISTING room path - the same `/demo/v1` control plane the
 * live room studio drives, through the same `api()` wrapper in
 * `components/demo-console/api.ts`. Nothing new is invented here: a card move
 * is an ordinary room action whose `calldata` the browser supplies instead of
 * taking from a canned preset action. The card preset ships `actions: []` for
 * exactly that reason - no duel move can be canned, because every one of them
 * depends on a participant leaf, a nonce and a proof that only the player has.
 *
 * The server checks the selector against the cold template's allow-list
 * (`demo-controller.addAction`), so a mis-encoded call is refused there as
 * well as here.
 *
 * PRIVACY. `cardMoveBody` is the ONLY place a request body for a move is
 * built, and its five fields are the whole body: an action id, an actor label,
 * the public calldata, the room block, and the EIP-2718 envelope carrying that
 * same calldata plus a signature. There is no field on it that could carry a
 * deck order, a salt, a hand or a Merkle path, and no overload that takes one;
 * `test/card-room-receipts.test.ts` asserts that against the bytes a real
 * witness bundle produces, for the envelope as well as for the calldata.
 *
 * WHY THE ENVELOPE IS REQUIRED. `demo-runtime-spec.ts` refuses a checkpoint
 * that carries duel calldata with no signed transaction, because the host would
 * otherwise throw the moves away and prove its own scripted opening plan -
 * producing a real L1 transaction hash for a duel nobody played. So the field
 * is non-optional on `CardMoveSubmission`: a move that cannot be signed is
 * not submittable, and that is a compile error rather than a runtime surprise.
 *
 * Every negative answer is reported in the COORDINATOR'S own words. A template
 * that failed to prepare, a room that has moved past ACTIVE and a checkpoint
 * that could not be proven are different operator problems, and paraphrasing
 * them into "unavailable" costs the operator the answer.
 */
import { api, type Preset, type Room, type Template } from '@/components/demo-console/api'
import { awaitDemoJob, demoIdempotencyKey, type DemoJobView } from '../demo-jobs'
import { readDemoSystem } from '../demo-system'

export const CARD_PRESET_ID = 'card-game'

/** Room phases that accept another action or checkpoint. */
const ACCEPTING = new Set(['ACTIVE', 'L1_FINALIZED'])

export interface CardRoomTarget {
  readonly roomId: string
  readonly roomName: string
  readonly chainRoomId: string | null
  readonly nextBlock: 1 | 2
  /** The coordinator's phase for this room, verbatim. */
  readonly phase: string
  /** Actions the room is holding, i.e. what the next batch would prove. */
  readonly actionCount: number
}

export interface CardRoomTemplate {
  readonly id: string
  readonly name: string
  /**
   * The duel this cold template was actually prepared against, as the
   * coordinator published it - the `to` of every signed move and, with
   * `roomApplicationDomain`, the preimage of `proofDomain`.
   *
   * Null when the coordinator publishes no card-room document, in which case
   * the console falls back to its documented default and SAYS SO: the cold
   * template id commits to this address, so a guessed one produces envelopes
   * aimed at the wrong contract and proofs bound to the wrong domain, and
   * neither is visible until the guest rejects the batch.
   */
  readonly duelAddress: string | null
  readonly roomApplicationDomain: string | null
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const BYTES32 = /^0x[0-9a-fA-F]{64}$/

/**
 * The card-room half of a prepared template, validated rather than trusted. A
 * truncated address (the redaction's default for long hex) is rejected here
 * instead of being signed for.
 */
export function cardRoomTemplate(entry: Template): CardRoomTemplate {
  const room = entry.preparation?.cardRoom
  const duelAddress = room?.duelAddress
  const domain = room?.roomApplicationDomain
  return {
    id: entry.id,
    name: entry.name,
    duelAddress: typeof duelAddress === 'string' && ADDRESS.test(duelAddress) ? duelAddress : null,
    roomApplicationDomain: typeof domain === 'string' && BYTES32.test(domain) ? domain : null,
  }
}

/**
 * One card room as a reader should see it in a list.
 *
 * A room that has settled keeps existing, keeps its history and stops taking
 * moves. A presenter who has opened three rooms over an afternoon needs to see
 * at a glance which of them is the live one, so `accepting` is carried
 * explicitly rather than left to be re-derived from a phase string.
 */
export interface CardRoomSummary {
  readonly roomId: string
  readonly roomName: string
  readonly chainRoomId: string | null
  readonly phase: string
  readonly accepting: boolean
  /** The room deployment transaction, as published (usually abbreviated). */
  readonly deploymentTransaction: string | null
  readonly actionCount: number
}

export interface CardRoomLookup {
  readonly room: CardRoomTarget | null
  /** Why there is no room to submit to, in the coordinator's own words. */
  readonly reason: string | null
  /** A prepared cold template a room could be opened from, when one exists. */
  readonly template: CardRoomTemplate | null
  /** The room as the coordinator published it, for its checkpoint receipts. */
  readonly raw: Room | null
  /**
   * Every card room this coordinator holds, oldest first. This is what makes
   * "the room you were playing in has stopped accepting moves, THIS one is
   * live" answerable on screen instead of by reading a phase badge.
   */
  readonly rooms: readonly CardRoomSummary[]
}

export function cardRoomSummary(room: Room): CardRoomSummary {
  return {
    roomId: room.id,
    roomName: room.name,
    chainRoomId: room.chainRoomId,
    phase: room.phase,
    accepting: ACCEPTING.has(room.phase),
    deploymentTransaction: room.deploymentTransaction,
    actionCount: room.actions.length,
  }
}

export interface CardCoordinator {
  /** Blockscout root the coordinator advertises; never hardcoded here. */
  readonly explorerUrl: string | null
  /** CUDA device measured by the coordinator, for the focused presenter. */
  readonly gpuName: string | null
  /** Measured GPU proving seconds for one room batch, when published. */
  readonly proofSeconds: number | null
  /** L1 blocks the coordinator recommends allowing for inclusion. */
  readonly deadlineBlocks: number | null
  /**
   * `RoomManager.deploymentDomain()` as bytes32, exempt from the coordinator's
   * hex redaction. Without it a browser cannot compute
   * `room_chain_id_v5(deploymentDomain, roomId)`, and every envelope it signs
   * is refused by the host for the wrong chain id. Null when this coordinator
   * does not publish one - which is reported, not guessed around.
   */
  readonly deploymentDomain: string | null
  /** Seconds per L1 block on this stand, so a deadline can be shown in seconds. */
  readonly l1BlockSeconds: number
  readonly decision: string | null
}

/**
 * Read the coordinator's own view of itself. Never throws: a stand without
 * `/demo/v1/system` simply yields no explorer root and no measured proof time,
 * and the console then quotes its own documented defaults instead of inventing
 * a link.
 */
export async function readCardCoordinator(): Promise<CardCoordinator> {
  const system = await readDemoSystem()
  return {
    explorerUrl: system.explorerUrl,
    gpuName: system.gpuName,
    deploymentDomain: system.deploymentDomain,
    proofSeconds: system.proofSeconds,
    deadlineBlocks: system.deadlineBlocks,
    l1BlockSeconds: system.l1BlockSeconds,
    decision: system.decision,
  }
}

/** Actions the NEXT batch would carry: everything no checkpoint has proved. */
export function cardPendingActions(room: Room): Room['actions'] {
  return room.actions.filter(
    (action) => action.checkpointSequence === null || action.checkpointSequence === undefined,
  )
}

function target(room: Room): CardRoomTarget {
  const pending = cardPendingActions(room)
  return {
    roomId: room.id,
    roomName: room.name,
    chainRoomId: room.chainRoomId,
    // The coordinator files the first move of a BATCH into block 1 and
    // everything after it into block 2, and refuses a checkpoint that does not
    // cover both. Counted over PENDING actions only: a room keeps every action
    // it ever accepted, so counting all of them would leave block 1 looking
    // permanently occupied after the first checkpoint and no later batch could
    // ever cover both blocks.
    nextBlock: pending.some((action) => action.block === 1) ? 2 : 1,
    phase: room.phase,
    actionCount: pending.length,
  }
}

/**
 * Locate a room built from the card preset. Every negative answer names the
 * specific stage that is missing, and a room that exists but has moved past
 * ACTIVE is named with its phase rather than reported as absent.
 */
export async function findCardRoom(): Promise<CardRoomLookup> {
  const empty = { room: null, template: null, raw: null, rooms: [] } as const
  const presets = await api<{ presets: Preset[] }>('/demo/v1/presets')
  const preset = presets.presets.find((entry) => entry.id === CARD_PRESET_ID)
  if (!preset) {
    return {
      ...empty,
      reason: `This coordinator publishes no "${CARD_PRESET_ID}" preset, so it cannot host a hidden-card duel.`,
    }
  }
  const templates = await api<{ templates: Template[] }>('/demo/v1/templates')
  const cardTemplates = templates.templates.filter((entry) => entry.presetId === CARD_PRESET_ID)
  if (cardTemplates.length === 0) {
    return {
      ...empty,
      reason: `The "${preset.name}" preset exists but no cold template has been prepared from it. Prepare one in the live room studio.`,
    }
  }
  const ready = cardTemplates.filter((entry) => !entry.failure && entry.phase === 'ROOM_READY')
  if (ready.length === 0) {
    const pending = cardTemplates.find((entry) => !entry.failure)
    if (pending) {
      return {
        ...empty,
        reason: `The card cold template "${pending.name}" is at ${pending.phase} and cannot host a room yet.`,
      }
    }
    const failed = cardTemplates.find((entry) => entry.failure)
    return { ...empty, reason: failed?.failure?.explanation ?? 'No card cold template is usable.' }
  }
  const template = cardRoomTemplate(ready[0])
  const rooms = await api<{ rooms: Room[] }>('/demo/v1/rooms')
  const mine = rooms.rooms.filter((room) => ready.some((entry) => entry.id === room.templateId))
  const summaries = mine.map(cardRoomSummary)
  // The LAST accepting room, not the first: a presenter who opened a second
  // room after the first settled means the second one, and picking the earliest
  // would quietly send moves to whichever room happened to be created first.
  const active = mine.filter((room) => ACCEPTING.has(room.phase)).at(-1)
  if (active) {
    return { room: target(active), reason: null, template, raw: active, rooms: summaries }
  }
  const other = mine[mine.length - 1]
  if (other) {
    return {
      room: null,
      template,
      raw: other,
      rooms: summaries,
      reason:
        other.failure?.explanation ??
        `Room "${other.name}" is at ${other.phase}, which does not accept moves. Opening another room starts again from the cold template's state, so the moves already settled stay in this room.`,
    }
  }
  return {
    room: null,
    template,
    raw: null,
    rooms: summaries,
    reason: `The cold template "${template.name}" is ready, but no room has been opened from it yet.`,
  }
}

/**
 * Job waiting and idempotency keys are shared with the application demos
 * (`lib/demo-jobs.ts`), so "a failed job is rethrown with the coordinator's own
 * explanation, and a timeout is reported as still running rather than as a
 * loss" is one rule on this site rather than one per demo.
 */
const idempotencyKey = demoIdempotencyKey
const awaitJob = awaitDemoJob

/**
 * The proving deadline a duel room is opened with when the presenter expresses
 * no preference, in SECONDS of wall clock.
 *
 * A duel is the slowest thing this stand runs: a batch is ~17 s of GPU proving
 * on an idle prover, and the prover is not always idle - a queued room ahead of
 * this one pushes the start of the proof out by its whole duration. 120 s is
 * two minutes of allowance for a job that needs about fifty, which is the
 * margin that keeps a duel from racing its own deadline while the GPU is shared.
 * It is a DEFAULT and not a constant: the room panel offers it as a choice.
 */
export const CARD_ROOM_PROVING_DEADLINE_SECONDS = 120

/** The floor, in blocks, below which a batch would race its own inclusion. */
export const CARD_ROOM_MINIMUM_DEADLINE_BLOCKS = 8

/**
 * Open a room from a prepared card template and deploy it on L1.
 *
 * `deadlineBlocksFromStart` is the L1 INCLUSION allowance for one batch, not a
 * room lifetime: the coordinator recomputes it from the CURRENT block on every
 * checkpoint (`demo-live-runtime.checkpointRoom`), so it renews itself and a
 * long duel is never cut by a deadline chosen when it started. It is the
 * presenter's own choice, floored at eight blocks so ~17 s of proving plus a
 * prepare round-trip still fits inside 12 s L1 blocks whatever was picked.
 */
export async function createCardRoom(input: {
  readonly template: CardRoomTemplate
  readonly name: string
  readonly deadlineBlocks?: number | null
  readonly onPhase?: (phase: string) => void
}): Promise<CardRoomTarget> {
  // Sending nothing lets the coordinator apply the card preset's own default,
  // which is 120 s of proving headroom expressed in L1 blocks. Sending an
  // explicit value OVERRIDES that default, so only forward one the presenter
  // actually chose. The coordinator validates the range and refuses a value too
  // small for a whole checkpoint with the arithmetic in its message; it is the
  // single source of those bounds, so no second clamp lives here.
  const deadline =
    typeof input.deadlineBlocks === 'number' && Number.isFinite(input.deadlineBlocks)
      ? Math.round(input.deadlineBlocks)
      : null
  const created = await api<Room>('/demo/v1/rooms', {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey('card-room') },
    body: JSON.stringify({
      name: input.name,
      templateId: input.template.id,
      managed: false,
      ...(deadline === null ? {} : { deadlineBlocksFromStart: deadline }),
    }),
  })
  const job = await api<DemoJobView>(`/demo/v1/rooms/${created.id}/deploy`, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey('card-deploy') },
    body: '{}',
  })
  await awaitJob(job.id, { timeoutMs: 180_000, onPhase: input.onPhase })
  return target(await api<Room>(`/demo/v1/rooms/${created.id}`))
}

export interface CardMoveSubmission {
  readonly roomId: string
  readonly actorId: string
  readonly move: string
  /** Selector plus ABI-encoded arguments. Nothing else is sent. */
  readonly calldata: string
  /**
   * The player's own EIP-2718 envelope carrying exactly that calldata. Required:
   * a duel move can only be proved as a signed transaction, and a move without
   * one would be silently replaced by the host's scripted plan.
   */
  readonly signedTransaction: string
  readonly block: 1 | 2
}

/** The complete request body for a move. Five public fields, and no others. */
export interface CardMoveBody {
  readonly actionId: string
  readonly actorId: string
  readonly calldata: string
  readonly signedTransaction: string
  readonly block: 1 | 2
}

/**
 * An EIP-2718 envelope is at least a type byte, an RLP header and a 65-byte
 * signature; the coordinator applies the same floor
 * (`MINIMUM_ENVELOPE_BYTES` in `server/src/demo-action.ts`).
 */
const MINIMUM_ENVELOPE_BYTES = 32

export function cardMoveBody(submission: CardMoveSubmission): CardMoveBody {
  if (!/^0x[0-9a-fA-F]+$/.test(submission.calldata)) {
    throw new Error('a card move must be plain hex calldata')
  }
  if (
    !/^0x([0-9a-fA-F]{2})+$/.test(submission.signedTransaction) ||
    (submission.signedTransaction.length - 2) / 2 < MINIMUM_ENVELOPE_BYTES
  ) {
    throw new Error('a card move must carry the player\'s signed EIP-2718 envelope')
  }
  // The envelope IS the calldata plus a signature, so a body whose two fields
  // disagree would ask the room to prove one thing and publish another.
  if (!submission.signedTransaction.toLowerCase().includes(submission.calldata.slice(2).toLowerCase())) {
    throw new Error('the signed envelope does not contain the calldata it was submitted with')
  }
  return {
    actionId: submission.move,
    actorId: submission.actorId,
    calldata: submission.calldata,
    signedTransaction: submission.signedTransaction,
    block: submission.block,
  }
}

export interface CardMoveAccepted {
  /** The coordinator's ROOM ACTION id. Not a transaction hash. */
  readonly actionId: string
  readonly block: 1 | 2
}

/**
 * Hand one move to the room. The request body is exactly the five public fields
 * of `CardMoveBody` - there is no place in it for a bundle, a salt or a hand,
 * and there is no second overload that takes one.
 *
 * The answer is a QUEUED L2 call, not a settlement. Nothing has reached L1
 * until a checkpoint proves the batch this action ends up in, which is why the
 * returned id is called `actionId` and never rendered as a transaction hash.
 */
export async function submitCardMove(
  submission: CardMoveSubmission,
): Promise<CardMoveAccepted> {
  const body = cardMoveBody(submission)
  const accepted = await api<{ id: string; block?: 1 | 2 }>(
    `/demo/v1/rooms/${submission.roomId}/actions`,
    {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey('card') },
      body: JSON.stringify(body),
    },
  )
  return { actionId: accepted.id, block: accepted.block ?? body.block }
}

export interface CardCheckpointLanded {
  readonly room: Room
  /** The coordinator's phase progression while the batch was proven. */
  readonly phases: readonly string[]
}

/**
 * Ask the room to prove its accepted actions and submit the batch to L1.
 *
 * On the reference stand this is ~17 s of GPU proving plus one or two 12 s L1
 * blocks, so the timeout is generous, and a timeout is reported as "still
 * running" rather than as a loss: the room holds the actions it accepted either
 * way, and a later checkpoint proves them.
 */
export async function checkpointCardRoom(
  roomId: string,
  onPhase?: (phase: string) => void,
): Promise<CardCheckpointLanded> {
  const phases: string[] = []
  const job = await api<DemoJobView>(`/demo/v1/rooms/${roomId}/checkpoints`, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey('card-checkpoint') },
    body: '{}',
  })
  await awaitJob(job.id, {
    timeoutMs: 300_000,
    onPhase: (phase) => {
      phases.push(phase)
      onPhase?.(phase)
    },
  })
  return { room: await api<Room>(`/demo/v1/rooms/${roomId}`), phases }
}
