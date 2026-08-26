/**
 * A `DemoRuntime` that answers instantly and records what it was asked for.
 *
 * Shared by the control-plane tests and the progressive-checkpoint tests so
 * both exercise the SAME runtime contract: in particular `checkpointRoom`
 * asserts here that the controller named exactly the moves it wanted proved.
 */

import type {
  DemoCheckpoint,
  DemoCheckpointRequest,
  DemoPhase,
  DemoPreparedTemplate,
  DemoRoom,
  DemoRuntime,
  DemoSystemStatus,
  DemoTemplate,
} from '../../src/demo-control.js'
import { checkpointPolicyDocument, roomSettingsDocument } from '../../src/demo-control.js'
import { cardRoomDocument } from '../../src/card-deployment.js'
import { CARD_ROOM_PRESET_ID } from '../../src/card-room.js'
import { cardRoomFixture } from './card-room-fixture.js'

export interface CheckpointCall {
  sequence: number
  actionIds: string[]
  trigger: string
  /** Wall-clock ms, so a test can prove two proofs never overlapped. */
  startedAt: number
  finishedAt: number
}

export class FakeRuntime implements DemoRuntime {
  failAt: 'prepare' | 'deploy' | 'checkpoint' | null = null
  phases: DemoPhase[] = []
  /** Every checkpoint the controller asked for, in order. */
  checkpointCalls: CheckpointCall[] = []
  /** Resolved once the proof "runs"; set to hold the slot open in a test. */
  checkpointGate: (() => Promise<void>) | null = null
  private checkpointCount = 0

  async systemStatus(): Promise<DemoSystemStatus> {
    return {
      decision: 'READY',
      services: [{ id: 'l1', label: 'Local Ethereum', status: 'READY' }],
      gpu: {
        name: 'Test GPU',
        samplesSeconds: [10, 11, 12],
        medianSeconds: 11,
        maximumSeconds: 12,
        recommendedProofSeconds: 17,
        recommendedDeadlineBlocks: 3,
      },
      contracts: [],
      canary: {
        roomReference: 'Room 1',
        l1Block: '42',
        transactionReference: '0x1234…abcd',
        l1TransactionHash: `0x${'ab'.repeat(32)}`,
        explorerUrl: 'http://explorer/tx/example',
      },
      explorerUrl: 'http://explorer',
      apiUrl: 'http://api',
      deploymentDomain: `0x${'cd'.repeat(32)}`,
      checkpointPolicy: checkpointPolicyDocument(),
      roomSettings: roomSettingsDocument(),
      provingQueue: { active: null, waiting: [] },
    }
  }

  /** The same shape the live runtime publishes, so a test can assert the link. */
  transactionUrl(hash: string): string | null {
    return `http://explorer/tx/${hash}`
  }

  async recentBlocks() {
    return [
      {
        number: '42',
        timestamp: '2026-07-25T00:00:00.000Z',
        transactions: 1,
        reference: '0x1234…abcd',
        blockHash: `0x${'ef'.repeat(32)}`,
        explorerUrl: 'http://explorer/block/42',
      },
    ]
  }

  async prepareTemplate(
    template: DemoTemplate,
    onPhase: (phase: DemoPhase) => Promise<void>,
  ): Promise<DemoPreparedTemplate> {
    await onPhase('COLD_EXECUTING')
    this.phases.push('COLD_EXECUTING')
    if (this.failAt === 'prepare') throw new Error('provider returned 0x' + 'ab'.repeat(32))
    await onPhase('COLD_PROVING')
    await onPhase('TEMPLATE_REGISTERED')
    return {
      templateId: '0x' + '11'.repeat(32),
      initialStateRoot: '0x' + '22'.repeat(32),
      policyHash: '0x' + '33'.repeat(32),
      proofProgramId: '0x' + '44'.repeat(32),
      proofSystemVersion: '0x' + '55'.repeat(32),
      initialApproverRoot: '0x' + '66'.repeat(32),
      initialActiveCount: 0,
      initialParticipantRoot: '0x' + '77'.repeat(32),
      initialParticipantCount: 1,
      canonicalColdTemplateData: '0x1234',
      coldProofMs: 12_000,
      registrationTransaction: '0x' + '88'.repeat(32),
      contractAddress: null,
      // A card template's cold id commits to the duel deployment, so the real
      // runtime always publishes it here. The fake does the same, from the same
      // fixture the deployment tests use, so the control plane is exercised
      // against the shape it will actually see.
      ...(template.presetId === CARD_ROOM_PRESET_ID
        ? { cardRoom: cardRoomDocument(cardRoomFixture()) }
        : {}),
    }
  }

  async deployRoom(
    _room: DemoRoom,
    _template: DemoTemplate,
    onPhase: (phase: DemoPhase) => Promise<void>,
  ): Promise<{ chainRoomId: string; transaction: string }> {
    await onPhase('DEPLOYED')
    if (this.failAt === 'deploy') throw new Error('deployment unavailable')
    return { chainRoomId: '2', transaction: '0x' + '99'.repeat(32) }
  }

  async checkpointRoom(
    _room: DemoRoom,
    _template: DemoTemplate,
    onPhase: (phase: DemoPhase) => Promise<void>,
    request?: DemoCheckpointRequest,
  ): Promise<DemoCheckpoint> {
    const startedAt = Date.now()
    await onPhase('PROVING')
    if (this.checkpointGate) await this.checkpointGate()
    if (this.failAt === 'checkpoint') throw new Error('proof worker stopped')
    await onPhase('LOCALLY_VERIFIED')
    await onPhase('L1_PENDING')
    this.checkpointCount += 1
    const sequence = request?.sequence ?? this.checkpointCount
    this.checkpointCalls.push({
      sequence,
      actionIds: (request?.actions ?? []).map((action) => action.id),
      trigger: request?.trigger ?? 'MANUAL',
      startedAt,
      finishedAt: Date.now(),
    })
    const hash = `0x${String(sequence).padStart(2, '0').repeat(32)}`
    return {
      proofMs: 11_500,
      localVerificationMs: 12,
      transaction: hash,
      l1TransactionHash: hash,
      l1Block: String(76 + sequence),
      l1BlockHash: `0x${'cd'.repeat(32)}`,
      finalizedL1Block: String(140 + sequence),
      finalizedL1BlockHash: `0x${'ef'.repeat(32)}`,
      batchIndex: sequence,
      postStateRoot: '0x' + 'bb'.repeat(32),
      explorerUrl: `http://explorer/tx/${hash}`,
    }
  }
}
