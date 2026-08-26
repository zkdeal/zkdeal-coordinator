/**
 * The action log the two application demos render, and the rule about what a
 * row is allowed to claim.
 *
 * Three claims are possible and they are not the same thing:
 *
 *   accepted     the coordinator holds this as a room action. Nothing about it
 *                is on L1 and the id beside it is a room ACTION id.
 *   on L1        a real transaction carries it, and the row therefore CARRIES
 *                THAT TRANSACTION as a link a viewer can open independently.
 *   refused      the coordinator declined, in its own words.
 *
 * Only the middle one gets a link, and it only gets one when the full 32-byte
 * hash could be recovered - see `lib/l1-receipt.ts`, which is where that
 * decision lives for the whole site.
 *
 * Two things land state on L1 in an application room and both are represented
 * here: the room DEPLOYMENT transaction, and each accepted CHECKPOINT.
 *
 * React-free so the link a row renders can be asserted in a unit test.
 */
import type { Room } from '@/components/demo-console/api'
import { l1Receipt, type L1Receipt } from '../l1-receipt'
import type { DemoStepKind } from './application-run'

export type DemoLogStatus = 'running' | 'accepted' | 'landed' | 'refused'

export interface DemoLogEntry {
  readonly sequence: number
  readonly kind: DemoStepKind
  readonly title: string
  /** One sentence of plain language, or null. */
  readonly detail: string | null
  readonly status: DemoLogStatus
  readonly at: number
  /** The room ACTION id when the coordinator accepted one. Never a tx hash. */
  readonly actionId: string | null
  readonly block: 1 | 2 | null
  /**
   * Present only on a row whose status is `landed`. A row with a receipt shows
   * its transaction as a link; a row whose receipt is incomplete says why it
   * cannot be looked up instead of rendering a dead reference.
   */
  readonly receipt: L1Receipt | null
  readonly l1Block: string | null
  readonly proofMs: number | null
}

let nextSequence = 0

export function demoLogEntry(
  input: Omit<DemoLogEntry, 'sequence' | 'at' | 'actionId' | 'block' | 'receipt' | 'l1Block' | 'proofMs'> &
    Partial<Pick<DemoLogEntry, 'actionId' | 'block' | 'receipt' | 'l1Block' | 'proofMs' | 'at'>>,
): DemoLogEntry {
  nextSequence += 1
  return {
    sequence: nextSequence,
    kind: input.kind,
    title: input.title,
    detail: input.detail,
    status: input.status,
    at: input.at ?? Date.now(),
    actionId: input.actionId ?? null,
    block: input.block ?? null,
    receipt: input.receipt ?? null,
    l1Block: input.l1Block ?? null,
    proofMs: input.proofMs ?? null,
  }
}

/**
 * The row for a deployed room.
 *
 * `deploymentTransaction` is abbreviated by the coordinator's `publicDemoView`
 * and no explorer URL is published beside it, so `l1Receipt` will usually
 * report it as incomplete - and the row then SAYS it cannot be looked up rather
 * than linking to a hash that would 404. It upgrades by itself the moment the
 * coordinator publishes the hash whole or a link for it.
 */
export function demoDeploymentEntry(
  room: Room & { deploymentTransactionHash?: string | null; deploymentExplorerUrl?: string | null },
  explorerBase: string | null,
): DemoLogEntry {
  return demoLogEntry({
    kind: 'deploy',
    title: `Room deployed on L1${room.chainRoomId ? ` · chain room #${room.chainRoomId}` : ''}`,
    detail:
      'The room now exists on Ethereum, registered against the cold template it was prepared from. Every later checkpoint settles into this room.',
    status: 'landed',
    receipt: l1Receipt(
      {
        hash: room.deploymentTransactionHash ?? null,
        transaction: room.deploymentTransaction,
        explorerUrl: room.deploymentExplorerUrl ?? null,
      },
      explorerBase,
    ),
  })
}

export interface DemoCheckpointSource {
  readonly transaction: string
  readonly l1TransactionHash?: string | null
  readonly l1Block: string
  readonly proofMs: number
  readonly explorerUrl?: string | null
}

/**
 * One checkpoint ATTEMPT: what it tried to prove, how it ended, and a `result`
 * only once it was accepted.
 */
export interface DemoCheckpointAttempt {
  readonly sequence?: number
  readonly outcome?: string
  readonly actionIds?: readonly string[]
  readonly result?: DemoCheckpointSource
}

/**
 * Every checkpoint RECEIPT a room has, oldest first.
 *
 * `room.checkpoints` is a list of ATTEMPTS: only an accepted one carries a
 * `result`, and an attempt still running or failed carries none. The same
 * unwrapping the duel does (`lib/card/settlement.cardRoomCheckpoints`) is
 * applied here, so a row never claims a settlement out of an attempt.
 */
export function demoRoomCheckpoints(
  room: {
    readonly checkpoint?: DemoCheckpointSource
    readonly checkpoints?: readonly (DemoCheckpointSource | DemoCheckpointAttempt)[]
  } | null,
): readonly DemoCheckpointSource[] {
  if (!room) return []
  if (Array.isArray(room.checkpoints)) {
    const receipts: DemoCheckpointSource[] = []
    for (const entry of room.checkpoints) {
      const receipt =
        'result' in entry && entry.result !== undefined
          ? entry.result
          : ((entry as DemoCheckpointSource).transaction !== undefined
              ? (entry as DemoCheckpointSource)
              : null)
      if (receipt) receipts.push(receipt)
    }
    if (receipts.length > 0) return receipts
  }
  return room.checkpoint ? [room.checkpoint] : []
}

export function demoCheckpointEntry(
  checkpoint: DemoCheckpointSource,
  explorerBase: string | null,
  detail: string,
): DemoLogEntry {
  return demoLogEntry({
    kind: 'checkpoint',
    title: `Checkpoint accepted · L1 block ${checkpoint.l1Block}`,
    detail,
    status: 'landed',
    l1Block: checkpoint.l1Block,
    proofMs: checkpoint.proofMs,
    receipt: l1Receipt(
      {
        hash: checkpoint.l1TransactionHash ?? null,
        transaction: checkpoint.transaction,
        explorerUrl: checkpoint.explorerUrl ?? null,
      },
      explorerBase,
    ),
  })
}
