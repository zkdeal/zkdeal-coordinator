import type { ObservedRoom } from './observer-types.js'

/**
 * Room ids are uint64 on L1 and are interpolated straight into an archive
 * filename, so an unbounded digit string produced `ENAMETOOLONG` - surfacing
 * as a 500 with a filesystem path rather than a 400. Canonical, non-zero, and
 * within the uint64 range. Exported so every caller shares one rule.
 */
export function canonicalRoomId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 20) return null
  if (!/^[1-9][0-9]*$/.test(value)) return null
  return BigInt(value) <= 0xffff_ffff_ffff_ffffn ? value : null
}

function roomId(value: string): string | null {
  return canonicalRoomId(value)
}

function uint(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be a canonical uint`)
  return BigInt(value)
}

/**
 * Byte-width patterns are compiled once. `validateRoom` calls `hex` for every
 * field of every batch, block and transaction in the archive, so building a
 * fresh RegExp per field dominated the cost of a long-lived room.
 */
const HEX_PATTERNS = new Map<number, RegExp>()

function hexPattern(bytes: number): RegExp {
  let pattern = HEX_PATTERNS.get(bytes)
  if (!pattern) {
    pattern = new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`)
    HEX_PATTERNS.set(bytes, pattern)
  }
  return pattern
}

function hex(value: string, bytes: number, label: string): void {
  if (!hexPattern(bytes).test(value)) {
    throw new Error(`${label} must be a ${bytes}-byte hexadecimal identifier`)
  }
}

export function validateRoom(room: ObservedRoom): void {
  if (!roomId(room.roomId)) throw new Error('room id must be a positive canonical integer')
  if (room.revision !== undefined) uint(room.revision, 'observer revision')
  if (room.schemaVersion !== undefined && room.schemaVersion !== 2) {
    throw new Error('declared schema version is not a known write schema')
  }
  if (room.headBlockHash !== undefined) hex(room.headBlockHash, 32, 'head block hash')
  if (room.reorg) {
    uint(room.reorg.forkPointBlock, 'reorg fork point block')
    uint(room.reorg.detectedAtBlock, 'reorg detection block')
    hex(room.reorg.forkPointHash, 32, 'reorg fork point hash')
  }
  hex(room.coldTemplateId, 32, 'cold template id')
  hex(room.coldTemplateDataHash, 32, 'cold template data hash')
  hex(room.policyHash, 32, 'policy hash')
  hex(room.participantRoot, 32, 'participant root')
  if (room.admissionSigner !== null) hex(room.admissionSigner, 20, 'admission signer')
  uint(room.serviceBond, 'service bond')
  uint(room.minimumServiceBond, 'minimum service bond')
  uint(room.omissionPenalty, 'omission penalty')
  uint(room.bondEpoch, 'bond epoch')
  uint(room.maximumAdmissionWindow, 'maximum admission window')
  uint(room.minimumDepositConfirmations, 'minimum deposit confirmations')
  uint(room.latestObservedL1Block, 'latest observed L1 block')
  uint(room.participantEpoch, 'participant epoch')
  const participants = uint(room.participantCount, 'participant count')
  const capacity = uint(room.participantCapacity, 'participant capacity')
  if (participants > capacity || capacity < 128n || capacity > 32_768n) {
    throw new Error('participant count or capacity is invalid')
  }
  if (room.managedService) {
    hex(room.managedService.allocationId, 32, 'allocation id')
    hex(room.managedService.nodeId, 32, 'managed node id')
    hex(room.managedService.slotId, 32, 'managed slot id')
    uint(room.managedService.startBlock, 'managed start block')
    const deadline = uint(room.managedService.proofDeadlineBlock, 'managed proof deadline')
    if (deadline <= uint(room.managedService.startBlock, 'managed start block')) {
      throw new Error('managed proof deadline must be after room start')
    }
    uint(room.managedService.priceEpoch, 'managed price epoch')
    uint(room.managedService.lastHealthyBlock, 'managed last healthy block')
    uint(room.managedService.refundableBalance, 'managed refundable balance')
  }
  room.supportedAssets.forEach((asset) => hex(asset, 20, 'supported asset'))
  room.approvers.forEach((member) => {
    uint(member.index, 'approver index')
    uint(member.joinedEpoch, 'joined epoch')
    hex(member.member, 20, 'approver address')
  })
  room.liabilities.forEach((liability) => {
    hex(liability.asset, 20, 'liability asset')
    uint(liability.pending, 'pending liability')
    uint(liability.controlled, 'controlled liability')
    uint(liability.claimable, 'claimable liability')
    uint(liability.paid, 'paid liability')
  })
  room.imports.forEach((entry) => {
    uint(entry.importId, 'import id')
    uint(entry.sourceBlock, 'import source block')
    if (entry.sourceBlockHash !== undefined) {
      hex(entry.sourceBlockHash, 32, 'import source block hash')
    }
    hex(entry.source, 20, 'import source')
    hex(entry.adapterId, 32, 'import adapter')
    hex(entry.stateRoot, 32, 'import state root')
    if (entry.consumedBatch !== null) uint(entry.consumedBatch, 'import consumed batch')
  })
  room.deposits.forEach((entry) => {
    uint(entry.inboxId, 'deposit inbox id')
    uint(entry.amount, 'deposit amount')
    uint(entry.queuedAtBlock, 'deposit queued L1 block')
    hex(entry.depositor, 20, 'deposit depositor')
    hex(entry.asset, 20, 'deposit asset')
    hex(entry.beneficiary, 20, 'deposit beneficiary')
    hex(entry.queuedAtBlockHash, 32, 'deposit queued L1 block hash')
    if (entry.consumedBatch !== null) uint(entry.consumedBatch, 'deposit consumed batch')
  })
  room.withdrawals.forEach((entry) => {
    uint(entry.outboxEpoch, 'withdrawal epoch')
    uint(entry.index, 'withdrawal index')
    uint(entry.amount, 'withdrawal amount')
    hex(entry.asset, 20, 'withdrawal asset')
    hex(entry.recipient, 20, 'withdrawal recipient')
    if (entry.claimedL1Transaction !== null) {
      hex(entry.claimedL1Transaction, 32, 'withdrawal claim transaction')
    }
  })
  room.admissions.forEach((entry) => {
    uint(entry.admissionId, 'admission id')
    uint(entry.depositInboxId, 'admission deposit inbox id')
    hex(entry.depositContentHash, 32, 'admission deposit content hash')
    uint(entry.deadlineBlock, 'admission deadline')
    uint(entry.maximumBatchIndex, 'admission maximum batch')
    hex(entry.transactionHash, 32, 'admission transaction hash')
    if (entry.l2BlockNumber !== null) uint(entry.l2BlockNumber, 'admission L2 block')
  })
  room.forcedTransactions.forEach((entry) => {
    uint(entry.forcedId, 'forced transaction id')
    uint(entry.deadlineBlock, 'forced transaction deadline')
    hex(entry.transactionHash, 32, 'forced transaction hash')
    if (entry.l2BlockNumber !== null) uint(entry.l2BlockNumber, 'forced L2 block')
  })
  room.applications.forEach((entry) => {
    hex(entry.contract, 20, 'application contract')
    hex(entry.participantRoot, 32, 'application participant root')
    uint(entry.participantCount, 'application participant count')
    uint(entry.participantCapacity, 'application participant capacity')
  })
  let priorBatch = 0n
  let priorBlock = 0n
  if (room.archiveFloor) {
    const floorBatch = uint(room.archiveFloor.batchIndex, 'archive floor batch index')
    const floorPriorBlock = uint(room.archiveFloor.priorL2Block, 'archive floor prior L2 block')
    if (floorBatch === 0n) throw new Error('archive floor batch index must be positive')
    const first = room.batches[0]
    if (first && BigInt(first.batchIndex) !== floorBatch) {
      throw new Error('the first observed batch must be the declared archive floor')
    }
    priorBatch = floorBatch - 1n
    priorBlock = floorPriorBlock
  }
  for (const batch of room.batches) {
    const batchIndex = uint(batch.batchIndex, 'batch index')
    const start = uint(batch.startL2Block, 'batch start block')
    const end = uint(batch.endL2Block, 'batch end block')
    hex(batch.preStateRoot, 32, 'batch pre-state root')
    hex(batch.postStateRoot, 32, 'batch post-state root')
    hex(batch.batchDataHash, 32, 'batch data hash')
    hex(batch.canonicalDataHash, 32, 'canonical data hash')
    hex(batch.approverRoot, 32, 'batch approver root')
    hex(batch.acceptedL1Transaction, 32, 'accepted L1 transaction')
    uint(batch.approverEpoch, 'batch approver epoch')
    uint(batch.activeCount, 'batch active count')
    uint(batch.inboxCursor, 'batch inbox cursor')
    uint(batch.admissionCursor, 'batch admission cursor')
    uint(batch.forcedCursor, 'batch forced cursor')
    uint(batch.importCursor, 'batch import cursor')
    uint(batch.outboxEpoch, 'batch outbox epoch')
    uint(batch.acceptedL1Block, 'accepted L1 block')
    if (batch.acceptedL1BlockHash !== undefined) {
      hex(batch.acceptedL1BlockHash, 32, 'accepted L1 block hash')
    }
    if (batch.withdrawalRoot !== null) hex(batch.withdrawalRoot, 32, 'withdrawal root')
    if (batchIndex !== priorBatch + 1n || start !== priorBlock + 1n || end < start) {
      throw new Error('observed batches must be contiguous and ordered')
    }
    if (batch.blocks.length > 0) {
      if (
        batch.blocks[0]?.blockNumber !== batch.startL2Block ||
        batch.blocks.at(-1)?.blockNumber !== batch.endL2Block
      ) {
        throw new Error('public block archive does not match its accepted batch range')
      }
      for (let index = 1; index < batch.blocks.length; index += 1) {
        if (
          BigInt(batch.blocks[index]!.blockNumber) !==
          BigInt(batch.blocks[index - 1]!.blockNumber) + 1n
        ) {
          throw new Error('public room blocks must be contiguous and ordered')
        }
      }
      for (const block of batch.blocks) {
        uint(block.blockNumber, 'L2 block number')
        hex(block.stateRoot, 32, 'L2 state root')
        hex(block.transactionCommitment, 32, 'L2 transaction commitment')
        block.transactions.forEach((transaction, index) => {
          if (transaction.index !== index) {
            throw new Error('transactions must use contiguous indices inside each block')
          }
          hex(transaction.hash, 32, 'L2 transaction hash')
          hex(transaction.from, 20, 'L2 transaction sender')
          if (transaction.to !== null) hex(transaction.to, 20, 'L2 transaction recipient')
          uint(transaction.nonce, 'L2 transaction nonce')
          uint(transaction.gasUsed, 'L2 transaction gas')
          if (transaction.selector !== null) hex(transaction.selector, 4, 'L2 call selector')
        })
      }
    }
    priorBatch = batchIndex
    priorBlock = end
  }
}

/**
 * Write-schema gate for the observer write surface. v1 documents stay
 * readable (grandfathered by `validateRoom`), but every PUT must carry the
 * full v2 provenance triple: a v1-shaped write would otherwise bypass the
 * reorg guards those hashes exist to feed.
 */
export function validateRoomV2(room: ObservedRoom): void {
  validateRoom(room)
  if (room.schemaVersion !== 2) throw new Error('write schema version 2 is required')
  if (room.headBlockHash === undefined) {
    throw new Error('head block hash is required by the write schema')
  }
  for (const batch of room.batches) {
    if (batch.acceptedL1BlockHash === undefined) {
      throw new Error('every batch requires its accepted L1 block hash')
    }
  }
  for (const entry of room.imports) {
    if (entry.sourceBlockHash === undefined) {
      throw new Error('every import requires its source block hash')
    }
  }
}
