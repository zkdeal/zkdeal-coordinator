import { describe, expect, it } from 'vitest'
import { decodeFunctionData, parseTransaction, type Hex } from 'viem'
import {
  erc4626RoomDocument,
  restoreErc4626Room,
} from '../src/erc4626-deployment.js'
import { buildErc4626RoomRequest } from '../src/erc4626-request.js'
import {
  ERC4626_INVESTOR,
  ERC4626_LIQUIDITY_PROVIDER,
  ERC4626_VAULT_ABI,
  erc4626Preset,
} from '../src/erc4626-room.js'
import { signErc4626CheckpointActions } from '../src/erc4626-signing.js'
import {
  movesOf,
  provedBlocks,
  replayRequest,
} from '../src/demo-runtime-checkpoint.js'
import { baseSpec } from '../src/demo-runtime-spec.js'
import type { DemoAction, DemoCheckpointRecord, DemoRoom } from '../src/demo-types.js'
import { validateTemplateRequest } from '../src/demo-validation.js'

const vault = '0x0000000000000000000000000000000000004601' as const
const assetToken = '0x0000000000000000000000000000000000004602' as const
const domain = `0x${'46'.repeat(32)}` as Hex
const deployment = {
  vault: { address: vault, runtimeCode: '0x600160005500' as Hex },
  assetToken: { address: assetToken, runtimeCode: '0x600260005500' as Hex },
  investor: ERC4626_INVESTOR,
  liquidityProvider: ERC4626_LIQUIDITY_PROVIDER,
  participantCapacity: 128,
}

function acceptedActions(): DemoAction[] {
  return erc4626Preset().actions.map((action, index) => ({
    id: `accepted-${index}`,
    actionId: action.id,
    label: action.label,
    actorId: action.actor,
    calldata: action.calldata,
    fixtureSignerIndex: action.fixtureSignerIndex,
    gasLimit: action.gasLimit,
    block: action.recommendedBlock,
    acceptedAt: '2026-08-01T00:00:00.000Z',
    checkpointSequence: null,
  }))
}

function room(actions: DemoAction[]): DemoRoom {
  return {
    id: 'room-erc4626',
    name: 'Progressive vault',
    templateId: 'tpl-erc4626',
    managed: false,
    deadlineBlocksFromStart: 10,
    phase: 'ACTIVE',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    chainRoomId: '7',
    deploymentTransaction: null,
    actions,
    checkpoints: [],
    proofDeadlineBlock: null,
    lastCheckpointAt: null,
    closedAt: null,
  }
}

function acceptedCheckpoint(sequence: number, actions: readonly DemoAction[]): DemoCheckpointRecord {
  return {
    sequence,
    trigger: 'MANUAL',
    actionIds: actions.map((action) => action.id),
    startedAt: '2026-08-01T00:00:00.000Z',
    finishedAt: '2026-08-01T00:00:01.000Z',
    outcome: 'ACCEPTED',
    queueWaitMs: 0,
    result: {
      proofMs: 1,
      localVerificationMs: 1,
      transaction: `0x${String(sequence).padStart(64, '0')}`,
      l1TransactionHash: `0x${String(sequence).padStart(64, '0')}`,
      l1Block: String(sequence),
      l1BlockHash: `0x${'cd'.repeat(32)}`,
      finalizedL1Block: String(sequence + 64),
      finalizedL1BlockHash: `0x${'ef'.repeat(32)}`,
      batchIndex: sequence,
      postStateRoot: `0x${String(sequence).padStart(64, '0')}`,
      explorerUrl: null,
    },
  }
}

describe('the progressive ERC-4626 room', () => {
  it('publishes three quote/mutation pairs in checkpoint order', () => {
    const preset = erc4626Preset()
    expect(preset.actions.map((action) => action.recommendedBlock)).toEqual([1, 2, 1, 2, 1, 2])
    expect(preset.actions.map((action) => action.fixtureSignerIndex)).toEqual([0, 0, 1, 1, 0, 0])
    const decoded = preset.actions.map((action) =>
      decodeFunctionData({ abi: ERC4626_VAULT_ABI, data: action.calldata as Hex }),
    )
    expect(decoded.map((call) => call.functionName)).toEqual([
      'previewDeposit',
      'deposit',
      'totalAssets',
      'donate',
      'previewRedeem',
      'redeem',
    ])
    expect(decoded[0]!.args).toEqual([100n])
    expect(decoded[1]!.args).toEqual([100n, ERC4626_INVESTOR])
    expect(decoded[3]!.args).toEqual([50n])
    expect(decoded[5]!.args).toEqual([100n, ERC4626_INVESTOR, ERC4626_INVESTOR])
  })

  it('builds the real vault/token cold state and contract-to-contract rules', () => {
    const request = buildErc4626RoomRequest(deployment) as {
      signerAccounts: number
      maxTransactionsPerBlock: number
      contracts: Array<{ role: string; initialStorage: Array<{ slot: string; value: string }> }>
      callRules: Array<Record<string, unknown>>
      participantRegistry: Record<string, unknown>
    }
    expect(request.signerAccounts).toBe(2)
    expect(request.maxTransactionsPerBlock).toBe(3)
    expect(request.contracts.map((contract) => contract.role)).toEqual(['vault', 'assetToken'])
    expect(request.contracts[0]!.initialStorage).toEqual(
      expect.arrayContaining([
        { slot: '0', value: BigInt(assetToken).toString() },
        { slot: '4', value: '0' },
        { slot: '7', value: '1' },
      ]),
    )
    expect(request.contracts[1]!.initialStorage).toEqual(
      expect.arrayContaining([{ slot: '2', value: '2000' }]),
    )
    expect(request.callRules).toEqual([
      expect.objectContaining({ caller: 'active-member', target: vault, kinds: [0] }),
      expect.objectContaining({ caller: vault, target: assetToken, kinds: [0, 1] }),
    ])
    expect(request.participantRegistry).toMatchObject({ contract: vault, capacitySlot: '1003' })
  })

  it('signs exact replayable envelopes and carries six blocks into checkpoint three', async () => {
    const actions = acceptedActions()
    const liveRoom = room(actions)
    for (let checkpoint = 0; checkpoint < 2; checkpoint += 1) {
      const pair = actions.slice(checkpoint * 2, checkpoint * 2 + 2)
      await signErc4626CheckpointActions(liveRoom, pair, domain, deployment)
      for (const action of pair) action.checkpointSequence = checkpoint + 1
      liveRoom.checkpoints.push(acceptedCheckpoint(checkpoint + 1, pair))
    }
    const finalPair = actions.slice(4, 6)
    await signErc4626CheckpointActions(liveRoom, finalPair, domain, deployment)

    const parsed = actions.map((action) => parseTransaction(action.signedTransaction as Hex))
    expect(parsed.map((tx) => tx.nonce)).toEqual([0, 1, 0, 1, 2, 3])
    expect(parsed.map((tx) => tx.to)).toEqual(Array(6).fill(vault))
    expect(provedBlocks(liveRoom)).toHaveLength(4)

    const moves = movesOf(finalPair)
    const replay = replayRequest(liveRoom, moves, {
      batchIndex: 3,
      startL2Block: 5,
      preStateRoot: `0x${'11'.repeat(32)}`,
      preParticipantRoot: `0x${'22'.repeat(32)}`,
      preParticipantEpoch: 1,
      preParticipantCount: 0,
      outboxEpoch: 3,
    })
    expect(replay?.batchIndex).toBe(3)
    expect(replay?.rawTransactions).toHaveLength(6)

    const template = {
      ...validateTemplateRequest({ name: 'ERC-4626 test', presetId: 'erc4626' }),
      id: 'tpl-erc4626',
      phase: 'ROOM_READY' as const,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    }
    const request = {
      ...baseSpec(template, 7, 1_000, domain, moves, null, null, null, deployment),
      ...replay,
    } as Record<string, unknown>
    expect(request.rawTransactions).toHaveLength(6)
    expect(request).not.toHaveProperty('blockCalls')
    expect(request.contracts as unknown[]).toHaveLength(2)
  })

  it('persists public bindings and restores runtime code after restart', async () => {
    const document = erc4626RoomDocument(deployment)
    const restored = await restoreErc4626Room(document, {
      publicClient: {
        getCode: async ({ address }: { address: Hex }) =>
          address.toLowerCase() === vault
            ? deployment.vault.runtimeCode
            : deployment.assetToken.runtimeCode,
      } as never,
    })
    expect(restored).toEqual(deployment)
    expect(document.investorAddress).toBe(ERC4626_INVESTOR)
    expect(document.liquidityProviderAddress).toBe(ERC4626_LIQUIDITY_PROVIDER)
  })
})
