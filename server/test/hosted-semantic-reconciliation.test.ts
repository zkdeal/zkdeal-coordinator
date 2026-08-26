import { describe,expect,it } from 'vitest'
import {
  roomSemanticReconciliationErrors,
} from '../src/hosted-indexer.js'
import type { HostedRoomSemanticProjection } from '../src/postgres-hosted-store.js'

const address=(byte:string) => `0x${byte.repeat(40)}`

const state=() => ({
  state:'1',authorizationMode:'1',closedAtBlock:'0',bondEpoch:'1',
  minimumServiceBond:'100',omissionPenalty:'10',serviceBond:'100',
  participantCount:'2',participantCapacity:'8',approverChangeCursor:'1',nextApproverChangeId:'2',
  inboxCursor:'2',nextInboxId:'4',admissionCursor:'3',forcedCursor:'3',nextForcedId:'4',
  importCursor:'2',nextImportId:'4',batchIndex:'5',outboxEpoch:'2',
  minimumImportConfirmations:'64',minimumDepositConfirmations:'64',
})

const projection=():HostedRoomSemanticProjection => ({
  errors:[],
  cursors:{
    admissionMax:'2',depositQueuedMax:'3',depositRefundedMax:'3',forcedQueuedMax:'3',
    forcedOutcomeMax:'2',importMax:'3',batchMax:'5',withdrawalRootMax:'2',withdrawalClaimMax:'2',
  },
  latestFacts:[],
})

describe('room semantic reconciliation',() => {
  it('accepts a complete field-consistent room projection',() => {
    expect(roomSemanticReconciliationErrors(
      state(),[address('1')],[{ asset:address('1'),liability:{ pending:'1',controlled:'2',claimable:'3',paid:'4' } }],
      projection(),
    )).toEqual([])
  })

  it('fails every canonical cursor domain closed on projection drift',() => {
    const drift=projection()
    drift.cursors={
      admissionMax:'3',depositQueuedMax:'4',depositRefundedMax:'4',forcedQueuedMax:'4',
      forcedOutcomeMax:'3',importMax:'4',batchMax:'6',withdrawalRootMax:'3',withdrawalClaimMax:'3',
    }
    const errors=roomSemanticReconciliationErrors(
      state(),[address('1')],[{ asset:address('1'),liability:{ pending:'1',controlled:'2',claimable:'3',paid:'4' } }],drift,
    )
    expect(errors).toEqual(expect.arrayContaining([
      'AdmissionRecorded admissionId exceeds canonical admissionCursor',
      'DepositQueued inboxId exceeds canonical nextInboxId',
      'DepositRefunded inboxId exceeds canonical nextInboxId',
      'ForcedTransactionQueued forcedId exceeds canonical nextForcedId',
      'ForcedOutcomeRecorded forcedId exceeds canonical forcedCursor',
      'L1StateInputPublished importId exceeds canonical nextImportId',
      'BatchAccepted batchIndex exceeds canonical batchIndex',
      'WithdrawalRootPublished epoch exceeds canonical outboxEpoch',
      'WithdrawalClaimed epoch exceeds canonical outboxEpoch',
    ]))
  })

  it('retains custody, withdrawal, sponsorship, and aggregate SQL failures and rejects liability drift',() => {
    const drift=projection()
    drift.errors=[
      'DepositRefunded inboxId 3 has no canonical DepositQueued fact',
      'claimed withdrawal projection has no canonical WithdrawalClaimed fact',
      'sponsorship counters or reservation tenant/unit/allocation binding drifted',
      'finalized aggregate outcome lacks success-only billing/sponsorship projection',
    ]
    const errors=roomSemanticReconciliationErrors(
      state(),[address('1'),address('1')],[
        { asset:address('2'),liability:{ pending:'-1',controlled:'2',claimable:'3',paid:'4' } },
      ],drift,
    )
    expect(errors).toEqual(expect.arrayContaining([
      ...drift.errors,'assets view contains duplicates',
      'liability 0x2222222222222222222222222222222222222222 pending is not a canonical unsigned decimal',
      'liability asset set does not exactly match the canonical assets view',
    ]))
  })

  it('fails closed on room lifecycle, challenge custody, allocation, and data-availability policy drift',() => {
    const room={ ...state(),state:'2',closedAtBlock:'0' }
    const errors=roomSemanticReconciliationErrors(
      room,[address('1')],[{ asset:address('1'),liability:{ pending:'1',controlled:'2',claimable:'3',paid:'4' } }],
      projection(),{
        challengeEscrow:'-1',managedAllocationId:'0x1234',
        dataAvailability:{
          policy:'2',fallbackAuthority:`0x${'00'.repeat(20)}`,
          equivalenceProgramId:`0x${'00'.repeat(32)}`,
        },
      },
    )
    expect(errors).toEqual(expect.arrayContaining([
      'closed room has no closedAtBlock',
      'challenge escrow is not a canonical unsigned decimal',
      'managed allocation id is malformed',
      'blob-preferred policy lacks its fallback/program binding',
    ]))
  })
})
