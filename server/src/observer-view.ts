import type {
  ObservedBatch,
  ObservedBlock,
  ObservedRoom,
  ObservedTransaction,
} from './observer-types.js'

export function shortReference(value: string | null): string | null {
  if (value === null || !value.startsWith('0x') || value.length < 14) return value
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

export function publicTransaction(tx: ObservedTransaction) {
  return {
    ...tx,
    hash: shortReference(tx.hash),
    from: shortReference(tx.from),
    to: shortReference(tx.to),
  }
}

export function publicBlock(block: ObservedBlock) {
  return {
    ...block,
    stateRoot: shortReference(block.stateRoot),
    transactionCommitment: shortReference(block.transactionCommitment),
    transactions: block.transactions.map(publicTransaction),
  }
}

export function publicBatch(batch: ObservedBatch, includeBlocks = false) {
  return {
    batchIndex: batch.batchIndex,
    l2Blocks: `${batch.startL2Block}-${batch.endL2Block}`,
    preState: shortReference(batch.preStateRoot),
    postState: shortReference(batch.postStateRoot),
    batchCommitment: shortReference(batch.batchDataHash),
    canonicalData: shortReference(batch.canonicalDataHash),
    approverRoot: shortReference(batch.approverRoot),
    approverEpoch: batch.approverEpoch,
    activeApprovers: batch.activeCount,
    inboxCursor: batch.inboxCursor,
    admissionCursor: batch.admissionCursor,
    forcedCursor: batch.forcedCursor,
    importCursor: batch.importCursor,
    outboxEpoch: batch.outboxEpoch,
    withdrawalRoot: shortReference(batch.withdrawalRoot),
    transactionCount: batch.blocks.reduce((total, block) => total + block.transactions.length, 0),
    acceptedOnL1Block: batch.acceptedL1Block,
    acceptedTransaction: shortReference(batch.acceptedL1Transaction),
    acceptedAt: batch.acceptedAt,
    status: batch.close ? 'ROOM_CLOSED' : 'ACCEPTED',
    ...(includeBlocks ? { blocks: batch.blocks.map(publicBlock) } : {}),
  }
}

export function publicRoom(room: ObservedRoom) {
  const latest = room.batches.at(-1) ?? null
  return {
    roomId: room.roomId,
    status: room.status,
    authorizationMode: room.authorizationMode,
    admissionSigner: shortReference(room.admissionSigner),
    serviceBond: room.serviceBond,
    minimumServiceBond: room.minimumServiceBond,
    omissionPenalty: room.omissionPenalty,
    bondEpoch: room.bondEpoch,
    maximumAdmissionWindow: room.maximumAdmissionWindow,
    latestObservedL1Block: room.latestObservedL1Block,
    latestAcceptedBatch: latest?.batchIndex ?? '0',
    latestL2Block: latest?.endL2Block ?? '0',
    latestState: shortReference(latest?.postStateRoot ?? null),
    activeApprovers: latest?.activeCount ?? '0',
    registeredParticipants: room.participantCount,
    participantCapacity: room.participantCapacity,
    participantRoot: shortReference(room.participantRoot),
    participantEpoch: room.participantEpoch,
    approverEpoch: latest?.approverEpoch ?? '0',
    inboxCursor: latest?.inboxCursor ?? '0',
    admissionCursor: latest?.admissionCursor ?? '0',
    forcedCursor: latest?.forcedCursor ?? '0',
    importCursor: latest?.importCursor ?? '0',
    outboxEpoch: latest?.outboxEpoch ?? '0',
    coldTemplate: shortReference(room.coldTemplateId),
    coldTemplateData: shortReference(room.coldTemplateDataHash),
    policy: shortReference(room.policyHash),
    supportedAssets: room.supportedAssets.map(shortReference),
    dataAvailability:
      latest && latest.blocks.length > 0 ? 'FULL_PUBLIC_BATCH' : 'L1_COMMITMENTS_ONLY',
    managedService: room.managedService
      ? {
          allocation: shortReference(room.managedService.allocationId),
          node: shortReference(room.managedService.nodeId),
          slot: shortReference(room.managedService.slotId),
          status: room.managedService.status,
          startBlock: room.managedService.startBlock,
          proofDeadlineBlock: room.managedService.proofDeadlineBlock,
          deadlineBlocksRemaining:
            BigInt(room.managedService.proofDeadlineBlock) > BigInt(room.latestObservedL1Block)
              ? (
                  BigInt(room.managedService.proofDeadlineBlock) -
                  BigInt(room.latestObservedL1Block)
                ).toString()
              : '0',
          priceEpoch: room.managedService.priceEpoch,
          lastHealthyBlock: room.managedService.lastHealthyBlock,
          refundableBalance: room.managedService.refundableBalance,
          nextAction:
            room.managedService.status === 'INTERRUPTED'
              ? 'Migrate or dispose the managed allocation.'
              : room.managedService.status === 'DISPOSED'
                ? 'Use an unmanaged prover or reserve another allocation.'
                : 'Continue within the selected proof deadline.',
        }
      : null,
  }
}
