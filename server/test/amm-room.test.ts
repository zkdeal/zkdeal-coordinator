import { describe, expect, it } from 'vitest'
import { decodeFunctionData, type Hex } from 'viem'
import {
  AMM_ATTACKER,
  AMM_COORDINATOR,
  AMM_MULTI_SIGNER_CAPABILITY,
  AMM_VICTIM,
  COMMIT_REVEAL_AMM_ABI,
  ammPreset,
} from '../src/amm-room.js'
import { movesOf } from '../src/demo-runtime-checkpoint.js'
import { baseSpec } from '../src/demo-runtime-spec.js'
import type { DemoAction } from '../src/demo-types.js'
import { validateTemplateRequest } from '../src/demo-validation.js'

const runtimeCode = '0x600160005500' as Hex
const contractAddress = '0x000000000000000000000000000000000000a440' as Hex

function acceptedActions(): DemoAction[] {
  return ammPreset().actions.map((action, index) => ({
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

describe('the commit-reveal AMM room', () => {
  it('publishes eight real ABI calls as four transactions per block', () => {
    const preset = ammPreset()
    expect(preset.actions).toHaveLength(8)
    expect(preset.actions.map((action) => action.recommendedBlock)).toEqual([
      1, 1, 1, 1, 2, 2, 2, 2,
    ])
    expect(preset.actions.map((action) => action.fixtureSignerIndex)).toEqual([
      0, 1, 2, 0, 2, 2, 1, 2,
    ])
    expect(preset.proverCapabilities).toContain(AMM_MULTI_SIGNER_CAPABILITY)
    expect(new Set(preset.peers?.map((peer) => peer.fixtureSignerIndex))).toEqual(
      new Set([0, 1, 2]),
    )

    const decoded = preset.actions.map((action) =>
      decodeFunctionData({ abi: COMMIT_REVEAL_AMM_ABI, data: action.calldata as Hex }),
    )
    expect(decoded.map((call) => call.functionName)).toEqual([
      'initialize',
      'commitSwap',
      'commitSwap',
      'closeCommitPhase',
      'swapExactInput',
      'revealSwap',
      'revealSwap',
      'revealSwap',
    ])
    expect(decoded[0]!.args?.slice(1, 3)).toEqual([AMM_VICTIM, AMM_ATTACKER])
  })

  it('uses distinct coordinator, victim and searcher accounts', () => {
    expect(new Set([AMM_COORDINATOR, AMM_VICTIM, AMM_ATTACKER]).size).toBe(3)
  })

  it('carries all signer indices, gas bounds, cold slots and runtime into the prover request', () => {
    const template = {
      ...validateTemplateRequest({ name: 'MEV AMM test', presetId: 'amm' }),
      id: 'tpl-amm',
      phase: 'ROOM_READY' as const,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      runtimeCode,
    }
    const moves = movesOf(acceptedActions())
    expect(moves.blockCalls?.[0]).toHaveLength(4)
    expect(moves.blockCalls?.[1]).toHaveLength(4)
    expect(moves.blockCalls?.flat().map((call) => call.signerIndex)).toEqual([
      0, 1, 2, 0, 2, 2, 1, 2,
    ])

    const request = baseSpec(
      template,
      9,
      1_000,
      `0x${'11'.repeat(32)}`,
      moves,
      contractAddress,
    ) as Record<string, unknown>
    expect(request.blockCalls).toEqual(moves.blockCalls)
    expect(request.initialStorage).toHaveLength(22)
    expect(request.runtimeCode).toBe(runtimeCode)
    expect(request.contractAddress).toBe(contractAddress)
    expect(request.signerAccounts).toBeUndefined()
    expect(request.residentAccounts).toBe(4)
  })
})
