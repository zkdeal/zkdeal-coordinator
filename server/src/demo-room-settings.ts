/**
 * The one knob a client may set on a room - how long a batch has to reach L1 -
 * published as arithmetic instead of a number to copy.
 *
 * `deadlineBlocksFromStart` is an INCLUSION allowance, not a room lifetime: the
 * coordinator recomputes `l1InclusionDeadline = head + deadlineBlocksFromStart`
 * from the CURRENT chain head at the start of every checkpoint
 * (`demo-runtime-checkpoint.ts`), so it renews itself and a long duel is
 * never cut short by a value chosen when the room opened.
 *
 * The shipped allowance is 74 blocks: five for one complete checkpoint, 64 for
 * the reorg margin, and five for a full retry. A hidden-card proof's measured
 * 120-second workload headroom is retained as a named input, but the same
 * 74-block safety floor wins because it is larger.
 *
 * Every bound below is derived. Nothing here is a magic integer.
 */

import { CARD_ROOM_PRESET_ID } from './card-room.js'
import {
  CHECKPOINT_START_MARGIN_BLOCKS,
  CHECKPOINT_WALL_CLOCK_SECONDS,
  DEFAULT_DEADLINE_BLOCKS_FROM_START,
  L1_BLOCK_SECONDS,
  MEASURED_ROOM_PROOF_SECONDS,
} from './demo-checkpoint-policy.js'

/**
 * Proving headroom a hidden-card room gives one batch, in seconds.
 *
 * The measured workload-only allowance before reorg and retry policy is added.
 */
export const CARD_WORKLOAD_PROVING_HEADROOM_SECONDS = 120

export const CARD_ROOM_PROVING_HEADROOM_SECONDS = Math.max(
  CARD_WORKLOAD_PROVING_HEADROOM_SECONDS,
  CHECKPOINT_START_MARGIN_BLOCKS * L1_BLOCK_SECONDS,
)

/**
 * The effective headroom in L1 blocks: max(120 s, 74 * 12 s) / 12 s = 74.
 */
export const CARD_ROOM_DEADLINE_BLOCKS = Math.ceil(
  CARD_ROOM_PROVING_HEADROOM_SECONDS / L1_BLOCK_SECONDS,
)

/**
 * Below this the publication claim is not met: the allowance must contain a
 * whole checkpoint, the 64-block reorg margin, and a complete retry.
 */
export const MINIMUM_DEADLINE_BLOCKS = CHECKPOINT_START_MARGIN_BLOCKS

/**
 * Above this the demo stops demonstrating anything: a batch that has not been
 * included within thirty minutes is a stuck stand, not a slow one, and a viewer
 * waiting on it learns nothing the failure would not have told them sooner.
 */
export const MAXIMUM_DEADLINE_SECONDS = 1_800

/** floor(1,800 s / 12 s per block) = 150 blocks. */
export const MAXIMUM_DEADLINE_BLOCKS = Math.floor(MAXIMUM_DEADLINE_SECONDS / L1_BLOCK_SECONDS)

/** Preset ids whose rooms want more headroom than the generic default. */
const PRESET_DEADLINE_BLOCKS: Readonly<Record<string, number>> = Object.freeze({
  [CARD_ROOM_PRESET_ID]: CARD_ROOM_DEADLINE_BLOCKS,
})

/** The allowance a room opened from `presetId` gets when the caller chooses none. */
export function defaultDeadlineBlocks(presetId: string | null | undefined): number {
  return (presetId && PRESET_DEADLINE_BLOCKS[presetId]) || DEFAULT_DEADLINE_BLOCKS_FROM_START
}

/** Seconds an allowance of `blocks` is worth on this stand. */
export function deadlineSeconds(blocks: number): number {
  return blocks * L1_BLOCK_SECONDS
}

/**
 * The caller's chosen allowance, or the preset default, refused by name and
 * with the arithmetic when it is outside the range a checkpoint can use.
 */
export function validateDeadlineBlocks(
  value: unknown,
  presetId: string | null | undefined,
): number {
  const fallback = defaultDeadlineBlocks(presetId)
  const chosen = value ?? fallback
  if (!Number.isSafeInteger(chosen) || Number(chosen) <= 0) {
    throw new Error('deadline blocks must be a positive integer')
  }
  const blocks = Number(chosen)
  if (blocks < MINIMUM_DEADLINE_BLOCKS) {
    throw new Error(
      `a deadline of ${blocks} L1 block(s) is ${deadlineSeconds(blocks)} s, and one whole ` +
        `checkpoint takes ${CHECKPOINT_WALL_CLOCK_SECONDS.toFixed(2)} s ` +
        `(${MEASURED_ROOM_PROOF_SECONDS} s of proving plus submission and two blocks of ` +
        `inclusion); the smallest allowance a batch can land inside is ` +
        `${MINIMUM_DEADLINE_BLOCKS} blocks`,
    )
  }
  if (blocks > MAXIMUM_DEADLINE_BLOCKS) {
    throw new Error(
      `a deadline of ${blocks} L1 block(s) is ${deadlineSeconds(blocks)} s, over the ` +
        `${MAXIMUM_DEADLINE_BLOCKS} block (${MAXIMUM_DEADLINE_SECONDS} s) demo ceiling; past it a ` +
        'stuck batch is indistinguishable from a slow one',
    )
  }
  return blocks
}

/** One room's settled allowance, published on the room. */
export interface DemoRoomSettings {
  deadlineBlocksFromStart: number
  /** The same allowance in seconds, so a client shows time rather than blocks. */
  deadlineSeconds: number
  l1BlockSeconds: number
  minimumBlocks: number
  maximumBlocks: number
  /** The default this room's preset would have taken. */
  presetDefaultBlocks: number
}

export function roomSettings(
  deadlineBlocksFromStart: number,
  presetId: string | null | undefined,
): DemoRoomSettings {
  return {
    deadlineBlocksFromStart,
    deadlineSeconds: deadlineSeconds(deadlineBlocksFromStart),
    l1BlockSeconds: L1_BLOCK_SECONDS,
    minimumBlocks: MINIMUM_DEADLINE_BLOCKS,
    maximumBlocks: MAXIMUM_DEADLINE_BLOCKS,
    presetDefaultBlocks: defaultDeadlineBlocks(presetId),
  }
}

export type DemoRoomSettingsDocument = ReturnType<typeof roomSettingsDocument>

/**
 * Everything a client needs to render the control and pick a legal value,
 * including the per-preset defaults, so nothing is restated in a browser.
 */
export function roomSettingsDocument() {
  return {
    deadlineBlocksFromStart: {
      default: DEFAULT_DEADLINE_BLOCKS_FROM_START,
      defaultSeconds: deadlineSeconds(DEFAULT_DEADLINE_BLOCKS_FROM_START),
      minimum: MINIMUM_DEADLINE_BLOCKS,
      minimumSeconds: deadlineSeconds(MINIMUM_DEADLINE_BLOCKS),
      maximum: MAXIMUM_DEADLINE_BLOCKS,
      maximumSeconds: MAXIMUM_DEADLINE_SECONDS,
      l1BlockSeconds: L1_BLOCK_SECONDS,
      byPreset: Object.fromEntries(
        Object.entries(PRESET_DEADLINE_BLOCKS).map(([presetId, blocks]) => [
          presetId,
          { blocks, seconds: deadlineSeconds(blocks) },
        ]),
      ),
      cardProvingHeadroomSeconds: CARD_ROOM_PROVING_HEADROOM_SECONDS,
      explanation:
        'L1 inclusion allowance for ONE batch, recomputed from the chain head at the start of ' +
        `every checkpoint. Blocks are ${L1_BLOCK_SECONDS} s here, so ` +
        `${CARD_ROOM_DEADLINE_BLOCKS} blocks is the ${CARD_ROOM_PROVING_HEADROOM_SECONDS} s of ` +
        'proving headroom a hidden-card room opens with.',
    },
  }
}
