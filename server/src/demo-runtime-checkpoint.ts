/**
 * One checkpoint: prepare, prove, verify locally, submit, read back.
 *
 * Split out of `demo-live-runtime.ts` when a room stopped checkpointing once
 * and started checkpointing repeatedly. Two things here are new and both exist
 * to keep a progressive room honest:
 *
 * 1. CONTINUATION. Batch N > 1 must open from the room's CURRENT on-chain
 *    state: `RoomManagerValidationFacet` requires `batchIndex == room.batchIndex
 *    + 1`, `startL2Block == room.l2BlockHeight + 1` and `preStateRoot ==
 *    room.stateRoot`. Those values are read off the RoomManager and sent to the
 *    prover as a `continuation` descriptor.
 *
 *    THE DESCRIPTOR IS NOT THE INPUT. `prepare` on the prover holds no room
 *    state at all - it is a pure function of its request - so it cannot be
 *    *told* where batch N opens; it has to rederive it. Batch N is rebuilt by
 *    replaying L2 blocks `1..=2N-2` natively and continuing from the state they
 *    leave behind, which means the request carries `batchIndex` plus every
 *    block the room has ever proved, oldest first, followed by the two blocks
 *    of the batch being asked for: `2 * batchIndex` blocks in `rawTransactions`.
 *    `replayRequest` below builds exactly that from the room's own move log,
 *    which is why the log keeps each move's signed envelope forever and marks
 *    it with the checkpoint that proved it instead of discarding it.
 *
 * 2. THE CROSS-CHECK. A prover that ignores the continuation - every host built
 *    before `v5_fixture/continuation.rs` existed does, because `v5_fixture.rs`
 *    hardcoded `batch_index: 1` and `pre_state_root: initial_state_root` -
 *    would happily return batch 1 again, and the demo would spend seventeen
 *    seconds of GPU on a batch L1 rejects with BadInput. The prepared journal
 *    is therefore compared against what was asked for BEFORE any proving
 *    starts, and a mismatch is a refusal naming both values.
 */

import {
  encodeAbiParameters,
  keccak256,
  toHex,
  type Abi,
  type AbiParameter,
  type Hex,
} from 'viem'
import { batchApprovals } from './demo-runtime-approvers.js'
import { contractJournal } from './demo-runtime-journal.js'
import { baseSpec, type RoomMoves } from './demo-runtime-spec.js'
import type { PreparedResponse, ProofResult } from './demo-runtime-types.js'
import type {
  DemoAction,
  DemoCheckpoint,
  DemoCheckpointRequest,
  DemoPhase,
  DemoRoom,
  DemoTemplate,
} from './demo-types.js'
import type { CardRoomDeployment } from './card-request.js'
import type { Erc7540RoomDeployment } from './erc7540-request.js'
import type { Erc4626RoomDeployment } from './erc4626-request.js'
import { signErc4626CheckpointActions } from './erc4626-signing.js'

/** The room fields `submitBatch` chains a batch onto. */
export interface OnChainRoom {
  stateRoot: Hex
  participantRoot: Hex
  participantEpoch: number
  participantCount: number
  batchIndex: number
  l2BlockHeight: number
  outboxEpoch: number
}

/** What batch N must open from, sent to the prover and checked on the way back. */
export interface RoomContinuation {
  batchIndex: number
  startL2Block: number
  preStateRoot: Hex
  preParticipantRoot: Hex
  preParticipantEpoch: number
  preParticipantCount: number
  outboxEpoch: number
}

export interface CheckpointContext {
  manager: Hex
  managerAbi: Abi
  deploymentDomain: Hex
  currentBlock: bigint
  cardRoom: CardRoomDeployment | null
  erc7540Room?: Erc7540RoomDeployment | null
  erc4626Room?: Erc4626RoomDeployment | null
  explorerUrl: string | null
  chainId: () => Promise<number>
  post: <T>(endpoint: string, body: unknown) => Promise<T>
  readRoom: () => Promise<OnChainRoom>
  submit: (
    args: readonly unknown[],
    lifecycle: {
      deadlineBlock: bigint
      onAccepted: (receipt: { transactionHash: Hex; blockNumber: bigint; blockHash: Hex }) =>
        | void
        | Promise<void>
      onRetracted: () => void | Promise<void>
    },
  ) => Promise<{
    transactionHash: Hex
    blockNumber: bigint
    blockHash: Hex
    finalizedBlockNumber: bigint
    finalizedBlockHash: Hex
  }>
}

/** Room-block split of the moves this checkpoint carries. */
export function movesOf(actions: readonly DemoAction[]): RoomMoves {
  const inBlock = (block: 1 | 2) => actions.filter((action) => action.block === block)
  const signed = actions.every((action) => typeof action.signedTransaction === 'string')
  const hostSigned = actions.every(
    (action) =>
      Number.isInteger(action.fixtureSignerIndex)
      && action.fixtureSignerIndex! >= 0
      && Number.isInteger(action.gasLimit)
      && action.gasLimit! > 0,
  )
  return {
    calldata: [
      inBlock(1).map((action) => action.calldata),
      inBlock(2).map((action) => action.calldata),
    ],
    ...(hostSigned && actions.length > 0
      ? {
          blockCalls: [
            inBlock(1).map((action) => ({
              calldata: action.calldata,
              signerIndex: action.fixtureSignerIndex!,
              gasLimit: action.gasLimit!,
            })),
            inBlock(2).map((action) => ({
              calldata: action.calldata,
              signerIndex: action.fixtureSignerIndex!,
              gasLimit: action.gasLimit!,
            })),
          ] as RoomMoves['blockCalls'],
        }
      : {}),
    ...(signed && actions.length > 0
      ? {
          signed: [
            inBlock(1).map((action) => action.signedTransaction!),
            inBlock(2).map((action) => action.signedTransaction!),
          ] as [string[], string[]],
        }
      : {}),
  }
}

/**
 * Every L2 block this room has already proved, oldest first, carried as the
 * exact signed envelopes it proved them with - two blocks per accepted batch.
 *
 * This is the room's replay history, and it is reconstructed from the move log
 * rather than remembered separately: `completeCheckpoint` stamps each proved
 * move with the sequence of the checkpoint that proved it, and each accepted
 * checkpoint record names the moves it carried in acceptance order. Nothing new
 * is stored and nothing new is serialized - these are the same public
 * calldata-plus-signature envelopes that already crossed the wire once.
 *
 * Throws, naming the move, when the history cannot be reproduced. A history
 * that is not byte-exact is worse than no history: the prover would replay a
 * different room and prepare a batch L1 refuses.
 */
export function provedBlocks(room: DemoRoom): string[][] {
  const byId = new Map(room.actions.map((action) => [action.id, action]))
  const blocks: string[][] = []
  const accepted = room.checkpoints
    .filter((record) => record.outcome === 'ACCEPTED')
    .sort((left, right) => left.sequence - right.sequence)
  for (const record of accepted) {
    const split: [string[], string[]] = [[], []]
    for (const id of record.actionIds) {
      const action = byId.get(id)
      if (!action) {
        throw new Error(
          `checkpoint ${record.sequence} proved move ${id}, which is no longer in this room's ` +
            'move log; the room\'s block history cannot be replayed, so it cannot be continued',
        )
      }
      if (typeof action.signedTransaction !== 'string') {
        throw new Error(
          `move ${id}, proved by checkpoint ${record.sequence}, holds no signed transaction. A ` +
            'continuation is rebuilt by re-executing the room\'s earlier blocks from the exact ' +
            'envelopes that were proved, so a move without one cannot be replayed',
        )
      }
      split[action.block - 1].push(action.signedTransaction)
    }
    if (split[0].length === 0 || split[1].length === 0) {
      throw new Error(
        `checkpoint ${record.sequence} left one of its two L2 blocks empty ` +
          `(${split[0].length} and ${split[1].length} moves); the prover requires between one ` +
          'and 32 transactions in every replayed block',
      )
    }
    blocks.push(split[0], split[1])
  }
  return blocks
}

/**
 * The two fields that turn a prepare request into a continuation: which batch
 * is wanted, and every block from block 1 onwards that leads to it.
 *
 * Returns null for batch one (nothing to replay) and for a room whose moves are
 * not browser-signed. The second case is deliberate rather than an error: only
 * `rawTransactions` can carry a history, so a `blockCalls` room simply cannot
 * be continued, and it is `assertPreparedMatches` that says so - after a cheap
 * prepare, before any proving slot is spent.
 */
export function replayRequest(
  room: DemoRoom,
  moves: RoomMoves,
  continuation: RoomContinuation | null,
): { batchIndex: number; rawTransactions: string[][] } | null {
  if (!continuation || continuation.batchIndex <= 1 || !moves.signed) return null
  const history = provedBlocks(room)
  const required = 2 * (continuation.batchIndex - 1)
  if (history.length !== required) {
    throw new Error(
      `Ethereum holds this room at batch ${continuation.batchIndex - 1}, so its next batch must ` +
        `replay ${required} already-proved L2 block(s); this room's move log reproduces ` +
        `${history.length}. The room's stored history and its on-chain height disagree, so no ` +
        'continuation was prepared rather than one that opens from the wrong state.',
    )
  }
  return {
    batchIndex: continuation.batchIndex,
    rawTransactions: [...history, ...moves.signed],
  }
}

function continuationOf(room: OnChainRoom): RoomContinuation {
  return {
    batchIndex: room.batchIndex + 1,
    startL2Block: room.l2BlockHeight + 1,
    preStateRoot: room.stateRoot,
    preParticipantRoot: room.participantRoot,
    preParticipantEpoch: room.participantEpoch,
    preParticipantCount: room.participantCount,
    outboxEpoch: room.outboxEpoch + 1,
  }
}

/**
 * Refuse a prepared batch that does not open where it was told to. Without
 * this, a prover that cannot continue a room silently rebuilds batch 1 and the
 * demo reports a settlement L1 never accepted.
 */
function assertPreparedMatches(
  prepared: PreparedResponse,
  expected: RoomContinuation | null,
): void {
  if (!expected) return
  const witness = (prepared.roomRequest as { roomWitness?: { journal?: Record<string, unknown> } })
    .roomWitness
  const journal = witness?.journal
  if (!journal) throw new Error('the prover returned no room journal to check the continuation against')
  const batchIndex = Number(journal.batch_index)
  const preStateRoot = String(journal.pre_state_root ?? '').toLowerCase()
  if (batchIndex !== expected.batchIndex || preStateRoot !== expected.preStateRoot.toLowerCase()) {
    throw new Error(
      `this room is at batch ${expected.batchIndex - 1} on Ethereum, so its next batch must be ` +
        `${expected.batchIndex} opening from state root ${expected.preStateRoot}; the prover ` +
        `prepared batch ${batchIndex} opening from ${preStateRoot}. The configured prover cannot ` +
        'continue a room yet, so this checkpoint was refused before any proving started rather ' +
        'than submitted and rejected on L1.',
    )
  }
}

export async function runCheckpoint(
  context: CheckpointContext,
  room: DemoRoom,
  template: DemoTemplate,
  onPhase: (phase: DemoPhase) => Promise<void>,
  request?: DemoCheckpointRequest,
): Promise<DemoCheckpoint> {
  const actions = request?.actions ?? room.actions
  const sequence = request?.sequence ?? 1
  const onChain = await context.readRoom()
  // Batch 1 is the cold-template opening batch; anything after it continues.
  const continuation = sequence > 1 || onChain.batchIndex > 0 ? continuationOf(onChain) : null
  if (context.erc4626Room) {
    await signErc4626CheckpointActions(
      room,
      actions,
      context.deploymentDomain,
      context.erc4626Room,
    )
  }
  const moves = movesOf(actions)
  // `baseSpec` emits this batch's own two blocks as `rawTransactions`; a
  // continuation replaces that with the whole history plus this batch, and
  // names the batch. Spread last so the widened list wins.
  const replay = replayRequest(room, moves, continuation)
  const spec = {
    ...baseSpec(
      template,
      Number(room.chainRoomId),
      Number(context.currentBlock + BigInt(room.deadlineBlocksFromStart)),
      context.deploymentDomain,
      moves,
      template.preparation?.contractAddress as Hex | null,
      // Never a second deployment: the cold template id commits to the duel's
      // address, so a checkpoint that redeployed would prove a different room.
      context.cardRoom,
      context.erc7540Room ?? null,
      context.erc4626Room ?? null,
    ),
    ...(continuation ? { continuation } : {}),
    ...(replay ?? {}),
  }
  // '/v5/...' mirrors the prover binary's HTTP surface (changes only in the gated image ceremony).
  const prepared = await context.post<PreparedResponse>('/v5/rooms/prepare', spec)
  assertPreparedMatches(prepared, continuation)

  await onPhase('PROVING')
  const proofStarted = performance.now()
  const proof = await context.post<ProofResult>('/v5/rooms/prove', prepared.roomRequest)
  const proofMs = performance.now() - proofStarted
  if (!proof.journal || !proof.ethereumSealB64 || proof.proofMode !== 'groth16') {
    throw new Error('room proving did not return a complete Ethereum proof')
  }
  const verifyStarted = performance.now()
  await context.post('/v5/rooms/verify', {
    journal: proof.journal,
    journalHash: proof.journalHash,
    receiptB64: proof.receiptB64,
  })
  const localVerificationMs = performance.now() - verifyStarted
  await onPhase('LOCALLY_VERIFIED')

  const submitFunction = context.managerAbi.find(
    (item) => item.type === 'function' && item.name === 'submitBatch',
  )
  if (!submitFunction || submitFunction.type !== 'function') {
    throw new Error('the room manager submission ABI is incomplete')
  }
  const submission = submitFunction.inputs[1]
  if (!submission || submission.type !== 'tuple' || !('components' in submission)) {
    throw new Error('the room manager journal ABI is incomplete')
  }
  const journal = contractJournal(proof.journal)
  const journalHash = keccak256(
    encodeAbiParameters([submission.components[0] as AbiParameter], [journal]),
  )
  const approvals = await batchApprovals({
    authorizationMode: template.authorizationMode,
    activeApprovers: template.activeApprovers,
    chainId: context.chainId,
    verifyingContract: context.manager,
    roomId: journal.roomId,
    batchIndex: journal.batchIndex,
    journalHash,
    approverRoot: journal.preApproverRoot,
    approverEpoch: journal.preApproverEpoch,
    deadline: BigInt(Math.floor(Date.now() / 1_000) + 3_600),
  })
  const roomWitness = (prepared.roomRequest as { roomWitness: Record<string, unknown> }).roomWitness
  const liabilities = (roomWitness.post_liabilities as Array<Record<string, string>>).map(
    (liability) => ({
      asset: liability.asset as Hex,
      pending: BigInt(liability.pending),
      controlled: BigInt(liability.controlled),
      claimable: BigInt(liability.claimable),
      paid: BigInt(liability.paid),
    }),
  )
  await onPhase('L1_PENDING')
  const receipt = await context.submit(
    [
      BigInt(room.chainRoomId!),
      {
        journal,
        seal: toHex(Buffer.from(proof.ethereumSealB64, 'base64')),
        canonicalBatchData: roomWitness.canonical_batch_data as Hex,
        approvals,
        approverChanges: [],
        admissions: [],
        forcedOutcomes: [],
        liabilities,
      },
    ],
    {
      deadlineBlock: journal.l1InclusionDeadline,
      onAccepted: async () => onPhase('L1_ACCEPTED'),
      onRetracted: async () => onPhase('L1_PENDING'),
    },
  )
  await onPhase('L1_FINALIZED')
  const settled = await context.readRoom()
  if (settled.stateRoot.toLowerCase() !== journal.postStateRoot.toLowerCase()) {
    throw new Error('the accepted L1 room state differs from the locally verified result')
  }
  return {
    proofMs,
    localVerificationMs,
    transaction: receipt.transactionHash,
    l1TransactionHash: receipt.transactionHash,
    l1Block: String(receipt.blockNumber),
    l1BlockHash: receipt.blockHash,
    finalizedL1Block: String(receipt.finalizedBlockNumber),
    finalizedL1BlockHash: receipt.finalizedBlockHash,
    batchIndex: Number(journal.batchIndex),
    postStateRoot: journal.postStateRoot,
    explorerUrl: context.explorerUrl ? `${context.explorerUrl}/tx/${receipt.transactionHash}` : null,
  }
}
