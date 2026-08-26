import type { Hex } from 'viem'

/**
 * Re-shape the guest's snake_case journal into the exact field order and types
 * the RoomManager `submitBatch` tuple expects. A missing key is a hard error:
 * silently defaulting one would produce a journal hash that no verifier accepts.
 */
export function contractJournal(raw: Record<string, unknown>) {
  const take = <T>(key: string): T => {
    const value = raw[key]
    if (value === undefined || value === null) throw new Error(`proved journal omitted ${key}`)
    return value as T
  }
  return {
    protocolVersion: BigInt(take<number>('protocol_version')),
    deploymentDomain: take<Hex>('deployment_domain'),
    roomId: BigInt(take<number>('room_id')),
    authorizationMode: take<number>('authorization_mode'),
    coldTemplateId: take<Hex>('cold_template_id'),
    proofProgramId: take<Hex>('proof_program_id'),
    proofSystemVersion: take<Hex>('proof_system_version'),
    policyHash: take<Hex>('policy_hash'),
    batchIndex: BigInt(take<number>('batch_index')),
    startL2Block: BigInt(take<number>('start_l2_block')),
    endL2Block: BigInt(take<number>('end_l2_block')),
    preStateRoot: take<Hex>('pre_state_root'),
    postStateRoot: take<Hex>('post_state_root'),
    batchDataHash: take<Hex>('batch_data_hash'),
    canonicalDataHash: take<Hex>('canonical_data_hash'),
    preParticipantRoot: take<Hex>('pre_participant_root'),
    postParticipantRoot: take<Hex>('post_participant_root'),
    preParticipantEpoch: BigInt(take<number>('pre_participant_epoch')),
    postParticipantEpoch: BigInt(take<number>('post_participant_epoch')),
    preParticipantCount: BigInt(take<number>('pre_participant_count')),
    postParticipantCount: BigInt(take<number>('post_participant_count')),
    participantCapacity: BigInt(take<number>('participant_capacity')),
    preApproverRoot: take<Hex>('pre_approver_root'),
    postApproverRoot: take<Hex>('post_approver_root'),
    preApproverEpoch: BigInt(take<number>('pre_approver_epoch')),
    postApproverEpoch: BigInt(take<number>('post_approver_epoch')),
    preActiveCount: BigInt(take<number>('pre_active_count')),
    postActiveCount: BigInt(take<number>('post_active_count')),
    approverChangeCursorBefore: BigInt(take<number>('approver_change_cursor_before')),
    approverChangeCursorAfter: BigInt(take<number>('approver_change_cursor_after')),
    inboxCursorBefore: BigInt(take<number>('inbox_cursor_before')),
    inboxCursorAfter: BigInt(take<number>('inbox_cursor_after')),
    inboxRecordsHash: take<Hex>('inbox_records_hash'),
    admissionCursorBefore: BigInt(take<number>('admission_cursor_before')),
    admissionCursorAfter: BigInt(take<number>('admission_cursor_after')),
    admissionRecordsHash: take<Hex>('admission_records_hash'),
    forcedCursorBefore: BigInt(take<number>('forced_cursor_before')),
    forcedCursorAfter: BigInt(take<number>('forced_cursor_after')),
    forcedOutcomesHash: take<Hex>('forced_outcomes_hash'),
    importCursorBefore: BigInt(take<number>('import_cursor_before')),
    importCursorAfter: BigInt(take<number>('import_cursor_after')),
    importedL1Block: BigInt(take<number>('imported_l1_block')),
    importedL1HeaderHash: take<Hex>('imported_l1_header_hash'),
    importedL1StateRoot: take<Hex>('imported_l1_state_root'),
    importRoot: take<Hex>('import_root'),
    outboxEpoch: BigInt(take<number>('outbox_epoch')),
    withdrawalRoot: take<Hex>('withdrawal_root'),
    preLiabilitiesHash: take<Hex>('pre_liabilities_hash'),
    postLiabilitiesHash: take<Hex>('post_liabilities_hash'),
    approverChangesHash: take<Hex>('approver_changes_hash'),
    l1InclusionDeadline: BigInt(take<number>('l1_inclusion_deadline')),
    close: take<boolean>('close'),
  }
}
