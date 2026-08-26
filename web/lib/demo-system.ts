/**
 * The coordinator's own view of itself, read once from `/demo/v1/system`.
 *
 * Everything on this site that needs to know WHERE the block explorer is, how
 * long a proof takes on this stand, or whether the single GPU is currently
 * busy reads it from here. Nothing hardcodes a host, a port or a proving time:
 * the same build runs against a laptop stand and against the RTX 4090 box, and
 * a baked-in explorer root would produce links that are confidently wrong on
 * every stand but one.
 *
 * Never throws. A coordinator without `/demo/v1/system` yields no explorer root
 * and no measured proof time, and the callers then say so instead of inventing
 * a link.
 *
 * React-free.
 */
import { api } from '@/components/demo-console/api'
import { httpLink } from './demo-console'

/**
 * L1 block time in seconds, used only when the coordinator publishes none.
 * The reference stand mines every 12 s; this is the number the deadline pickers
 * fall back to so a "120 s" choice still converts to blocks.
 */
export const DEMO_L1_BLOCK_SECONDS_FALLBACK = 12

export interface DemoSystem {
  /** Blockscout root the coordinator advertises, http(s) only, or null. */
  readonly explorerUrl: string | null
  readonly decision: string | null
  /** The CUDA device the coordinator measured, for honest presenter labels. */
  readonly gpuName: string | null
  /** Measured GPU proving seconds for one room batch, when published. */
  readonly proofSeconds: number | null
  /** L1 blocks the coordinator recommends allowing for inclusion. */
  readonly deadlineBlocks: number | null
  /** Seconds per L1 block on this stand, from the coordinator's own policy. */
  readonly l1BlockSeconds: number
  /** The policy's own default inclusion allowance, in blocks, when published. */
  readonly defaultDeadlineBlocks: number | null
  /**
   * `RoomManager.deploymentDomain()` as bytes32. A browser needs it in full to
   * compute `room_chain_id_v5(deploymentDomain, roomId)`; truncated, every
   * envelope it signs is refused for the wrong chain id.
   */
  readonly deploymentDomain: string | null
  /**
   * True while the single prover is working or has work queued.
   *
   * There is ONE GPU on the reference stand and proofs serialize on it. A demo
   * that starts a checkpoint while another room is proving does not get a
   * second GPU, it gets a queue - so a self-driving demo waits on this and says
   * it is waiting, rather than appearing to hang.
   */
  readonly proverBusy: boolean
  readonly proverQueueDepth: number
}

export const EMPTY_DEMO_SYSTEM: DemoSystem = Object.freeze({
  explorerUrl: null,
  decision: null,
  gpuName: null,
  proofSeconds: null,
  deadlineBlocks: null,
  l1BlockSeconds: DEMO_L1_BLOCK_SECONDS_FALLBACK,
  defaultDeadlineBlocks: null,
  deploymentDomain: null,
  proverBusy: false,
  proverQueueDepth: 0,
})

const BYTES32 = /^0x[0-9a-fA-F]{64}$/

/** The `/demo/v1/system` fields this module reads. Everything is optional. */
export interface DemoSystemPayload {
  decision?: string
  explorerUrl?: string | null
  deploymentDomain?: string | null
  gpu?: {
    name?: string
    recommendedProofSeconds?: number
    recommendedDeadlineBlocks?: number
  } | null
  checkpointPolicy?: { l1BlockSeconds?: number; defaultDeadlineBlocks?: number } | null
  provingQueue?: { active?: unknown; waiting?: unknown[] } | null
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Interpret a `/demo/v1/system` body. Split from the fetch so the mapping - in
 * particular "the explorer base is whatever this endpoint said, and null when
 * it said nothing usable" - can be asserted directly.
 */
export function readDemoSystemPayload(payload: DemoSystemPayload): DemoSystem {
  const waiting = Array.isArray(payload.provingQueue?.waiting)
    ? payload.provingQueue.waiting.length
    : 0
  const active = payload.provingQueue?.active
  return {
    // `httpLink` is the allowlist: the coordinator's JSON chooses the
    // destination of a link a viewer clicks, so a non-http scheme is dropped.
    explorerUrl: httpLink(payload.explorerUrl),
    decision: typeof payload.decision === 'string' ? payload.decision : null,
    gpuName:
      typeof payload.gpu?.name === 'string' && payload.gpu.name.trim().length > 0
        ? payload.gpu.name.trim()
        : null,
    proofSeconds: positive(payload.gpu?.recommendedProofSeconds),
    deadlineBlocks: positive(payload.gpu?.recommendedDeadlineBlocks),
    l1BlockSeconds:
      positive(payload.checkpointPolicy?.l1BlockSeconds) ?? DEMO_L1_BLOCK_SECONDS_FALLBACK,
    defaultDeadlineBlocks: positive(payload.checkpointPolicy?.defaultDeadlineBlocks),
    deploymentDomain:
      typeof payload.deploymentDomain === 'string' && BYTES32.test(payload.deploymentDomain)
        ? payload.deploymentDomain
        : null,
    proverBusy: (active !== null && active !== undefined) || waiting > 0,
    proverQueueDepth: waiting + (active === null || active === undefined ? 0 : 1),
  }
}

export async function readDemoSystem(): Promise<DemoSystem> {
  try {
    return readDemoSystemPayload(await api<DemoSystemPayload>('/demo/v1/system'))
  } catch {
    return EMPTY_DEMO_SYSTEM
  }
}

/**
 * A proving-deadline choice expressed the way a presenter thinks about it -
 * in seconds of wall clock - converted to the blocks the coordinator wants.
 *
 * The floor of two blocks is the coordinator's own minimum for
 * `deadlineBlocksFromStart`; the ceiling is its maximum.
 */
export function deadlineBlocksForSeconds(seconds: number, l1BlockSeconds: number): number {
  const perBlock = l1BlockSeconds > 0 ? l1BlockSeconds : DEMO_L1_BLOCK_SECONDS_FALLBACK
  return Math.max(2, Math.min(7_200, Math.ceil(seconds / perBlock)))
}

export function deadlineSecondsForBlocks(blocks: number, l1BlockSeconds: number): number {
  const perBlock = l1BlockSeconds > 0 ? l1BlockSeconds : DEMO_L1_BLOCK_SECONDS_FALLBACK
  return Math.round(blocks * perBlock)
}
