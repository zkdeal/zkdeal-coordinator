import { describe, expect, it } from 'vitest'
import { contractJournal,
  DEMO_MINIMUM_SERVICE_BOND,
  DEMO_OMISSION_PENALTY,
} from '../src/demo-live-runtime.js'

const HASH = `0x${'11'.repeat(32)}` as const

function proofJournal(): Record<string, unknown> {
  const raw: Record<string, unknown> = { close: false }
  for (const field of [
    'deployment_domain',
    'cold_template_id',
    'proof_program_id',
    'proof_system_version',
    'policy_hash',
    'pre_state_root',
    'post_state_root',
    'batch_data_hash',
    'canonical_data_hash',
    'pre_participant_root',
    'post_participant_root',
    'pre_approver_root',
    'post_approver_root',
    'inbox_records_hash',
    'admission_records_hash',
    'forced_outcomes_hash',
    'imported_l1_header_hash',
    'imported_l1_state_root',
    'import_root',
    'withdrawal_root',
    'pre_liabilities_hash',
    'post_liabilities_hash',
    'approver_changes_hash',
  ]) {
    raw[field] = HASH
  }
  for (const field of [
    'protocol_version',
    'room_id',
    'authorization_mode',
    'batch_index',
    'start_l2_block',
    'end_l2_block',
    'pre_participant_epoch',
    'post_participant_epoch',
    'pre_participant_count',
    'post_participant_count',
    'participant_capacity',
    'pre_approver_epoch',
    'post_approver_epoch',
    'pre_active_count',
    'post_active_count',
    'approver_change_cursor_before',
    'approver_change_cursor_after',
    'inbox_cursor_before',
    'inbox_cursor_after',
    'admission_cursor_before',
    'admission_cursor_after',
    'forced_cursor_before',
    'forced_cursor_after',
    'import_cursor_before',
    'import_cursor_after',
    'imported_l1_block',
    'outbox_epoch',
    'l1_inclusion_deadline',
  ]) {
    raw[field] = 1
  }
  return raw
}

describe('live proof journal decoding', () => {
  it('uses the current approver field names emitted by the prover', () => {
    const journal = contractJournal(proofJournal())
    expect(journal.preApproverRoot).toBe(HASH)
    expect(journal.postApproverEpoch).toBe(1n)
    expect(journal.approverChangeCursorAfter).toBe(1n)
    expect(journal.approverChangesHash).toBe(HASH)
  })

  it('rejects obsolete roster aliases instead of silently changing the proof boundary', () => {
    const raw = proofJournal()
    delete raw.pre_approver_root
    raw.pre_roster_root = HASH
    expect(() => contractJournal(raw)).toThrow(/pre_approver_root/)
  })
})

/**
 * `createRoom` refuses a VALIDITY_ONLY room whose omission penalty exceeds
 * `minimumServiceBond / MIN_SERVICE_BOND_MULTIPLE` (4). The division is integer,
 * so a bond of 1 permits only a penalty of 0 -- and a zero penalty is refused by
 * the preceding clause. A bond below the multiple therefore makes the room
 * impossible to create at ANY penalty, which is exactly how the live stand
 * failed with BadInput() before this was pinned.
 */
describe('VALIDITY_ONLY service bond ratio', () => {
  const MIN_SERVICE_BOND_MULTIPLE = 4n

  it('leaves the omission penalty within the bond the contract requires', () => {
    expect(DEMO_OMISSION_PENALTY).toBeGreaterThan(0n)
    expect(DEMO_MINIMUM_SERVICE_BOND).toBeGreaterThan(0n)
    expect(DEMO_OMISSION_PENALTY).toBeLessThanOrEqual(
      DEMO_MINIMUM_SERVICE_BOND / MIN_SERVICE_BOND_MULTIPLE,
    )
  })

  it('rejects the bond=1 shape that reverted on the stand', () => {
    // Regression guard: the previous values were 1n/1n, and 1n / 4n === 0n.
    expect(1n / MIN_SERVICE_BOND_MULTIPLE).toBe(0n)
    expect(DEMO_MINIMUM_SERVICE_BOND).toBeGreaterThanOrEqual(MIN_SERVICE_BOND_MULTIPLE)
  })
})
