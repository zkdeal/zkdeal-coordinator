import { describe, expect, it } from 'vitest'
import { decodeFunctionData, type Hex } from 'viem'
import { loadConfig } from '../src/config.js'
import {
  erc7540RoomDocument,
  restoreErc7540Room,
} from '../src/erc7540-deployment.js'
import { buildErc7540RoomRequest } from '../src/erc7540-request.js'
import {
  ERC7540_ALICE,
  ERC7540_BOB,
  ERC7540_MANAGER,
  ERC7540_MULTI_SIGNER_CAPABILITY,
  ERC7540_VAULT_ABI,
  erc7540Preset,
} from '../src/erc7540-room.js'
import { movesOf } from '../src/demo-runtime-checkpoint.js'
import { baseSpec } from '../src/demo-runtime-spec.js'
import type { DemoAction } from '../src/demo-types.js'
import { validateTemplateRequest } from '../src/demo-validation.js'

const vault = '0x0000000000000000000000000000000000007001' as const
const assetToken = '0x0000000000000000000000000000000000007002' as const
const deployment = {
  vault: { address: vault, runtimeCode: '0x600160005500' as Hex },
  assetToken: { address: assetToken, runtimeCode: '0x600260005500' as Hex },
  alice: ERC7540_ALICE,
  bob: ERC7540_BOB,
  manager: ERC7540_MANAGER,
  participantCapacity: 128,
}

function acceptedActions(): DemoAction[] {
  return erc7540Preset().actions.map((action, index) => ({
    id: `accepted-${index}`,
    actionId: action.id,
    label: action.label,
    actorId: action.actor,
    calldata: action.calldata,
    fixtureSignerIndex: action.fixtureSignerIndex,
    gasLimit: action.gasLimit,
    block: action.recommendedBlock,
    acceptedAt: '2026-07-27T00:00:00.000Z',
    checkpointSequence: null,
  }))
}

describe('the certified ERC-7540 room', () => {
  it('publishes twelve ABI calls in actor, nonce and block order', () => {
    const preset = erc7540Preset()
    expect(preset.actions).toHaveLength(12)
    expect(preset.actions.map((action) => action.recommendedBlock)).toEqual([
      1, 1, 1, 1, 1, 1,
      2, 2, 2, 2, 2, 2,
    ])
    expect(preset.actions.map((action) => action.fixtureSignerIndex)).toEqual([
      0, 1, 2, 2, 0, 1,
      0, 1, 2, 2, 0, 1,
    ])
    expect(new Set(preset.peers?.map((peer) => peer.fixtureSignerIndex))).toEqual(
      new Set([0, 1, 2]),
    )
    expect(preset.proverCapabilities).toContain(ERC7540_MULTI_SIGNER_CAPABILITY)

    const decoded = preset.actions.map((action) =>
      decodeFunctionData({ abi: ERC7540_VAULT_ABI, data: action.calldata as Hex }),
    )
    expect(decoded.map((call) => call.functionName)).toEqual([
      'requestDeposit',
      'requestDeposit',
      'fulfillDeposit',
      'fulfillDeposit',
      'deposit',
      'deposit',
      'requestRedeem',
      'requestRedeem',
      'fulfillRedeem',
      'fulfillRedeem',
      'redeem',
      'redeem',
    ])
    expect(decoded[0]!.args).toEqual([100n, ERC7540_ALICE, ERC7540_ALICE])
    expect(decoded[1]!.args).toEqual([60n, ERC7540_BOB, ERC7540_BOB])
    expect(decoded[6]!.args).toEqual([40n, ERC7540_ALICE, ERC7540_ALICE])
    expect(decoded[7]!.args).toEqual([20n, ERC7540_BOB, ERC7540_BOB])
  })

  it('builds per-contract runtimes, storage and caller-specific rules', () => {
    const request = buildErc7540RoomRequest(deployment) as {
      signerAccounts: number
      maxTransactionsPerBlock: number
      contracts: Array<Record<string, unknown>>
      callRules: Array<Record<string, unknown>>
      participantRegistry: Record<string, unknown>
    }
    expect(request.signerAccounts).toBe(3)
    expect(request.maxTransactionsPerBlock).toBe(6)
    expect(request.contracts).toHaveLength(2)
    expect(request.contracts[0]).toMatchObject({
      role: 'vault',
      address: vault,
      runtimeCode: deployment.vault.runtimeCode,
    })
    expect(request.contracts[1]).toMatchObject({
      role: 'assetToken',
      address: assetToken,
      runtimeCode: deployment.assetToken.runtimeCode,
    })
    expect(request.callRules).toEqual([
      expect.objectContaining({ caller: 'active-member', target: vault, kinds: [0] }),
      expect.objectContaining({ caller: vault, target: assetToken, kinds: [0, 1] }),
    ])
    expect(request.participantRegistry).toMatchObject({ contract: vault, capacitySlot: '1003' })
  })

  it('carries signer index and gas bound into both prover blocks', () => {
    const template = {
      ...validateTemplateRequest({ name: 'ERC-7540 test', presetId: 'erc7540' }),
      id: 'tpl-erc7540',
      phase: 'ROOM_READY' as const,
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
    }
    const moves = movesOf(acceptedActions())
    expect(moves.blockCalls?.[0]).toHaveLength(6)
    expect(moves.blockCalls?.[1]).toHaveLength(6)
    expect(moves.blockCalls?.flat().map((call) => call.signerIndex)).toEqual([
      0, 1, 2, 2, 0, 1,
      0, 1, 2, 2, 0, 1,
    ])
    const request = baseSpec(
      template,
      7,
      1_000,
      `0x${'11'.repeat(32)}`,
      moves,
      null,
      null,
      deployment,
    )
    expect(request.blockCalls).toEqual(moves.blockCalls)
    expect(request.contracts).toHaveLength(2)
    expect(request).not.toHaveProperty('initialStorage')
    expect(request).not.toHaveProperty('runtimeCode')
  })

  it('persists public bindings and restores real runtime code after restart', async () => {
    const document = erc7540RoomDocument(deployment)
    const restored = await restoreErc7540Room(document, {
      publicClient: {
        getCode: async ({ address }: { address: Hex }) =>
          address.toLowerCase() === vault ? deployment.vault.runtimeCode : deployment.assetToken.runtimeCode,
      } as never,
    })
    expect(restored).toEqual(deployment)
    expect(document.runtimeBindings).toEqual([
      { role: 'vault', address: vault },
      { role: 'assetToken', address: assetToken },
    ])
  })
})

describe('managed room profile configuration', () => {
  const profile = {
    nodeId: `0x${'11'.repeat(32)}` as Hex,
    slotId: `0x${'22'.repeat(32)}` as Hex,
    presetId: `0x${'33'.repeat(32)}` as Hex,
    participantCapacity: 128,
    nodeLabel: 'Proof node',
    slotLabel: 'Standard slot',
    presetLabel: 'ERC-7540 room',
  }

  it('is optional, validated and preserved as public metadata', () => {
    expect(loadConfig({ port: 0 }).managedRoomProfile).toBeUndefined()
    expect(loadConfig({ port: 0, managedRoomProfile: profile }).managedRoomProfile).toEqual(profile)
    expect(() =>
      loadConfig({
        port: 0,
        managedRoomProfile: { ...profile, participantCapacity: 1_000 },
      }),
    ).toThrow(/managedRoomProfile.participantCapacity/)
  })
})
