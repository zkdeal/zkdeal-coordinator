import { describe, expect, it } from 'vitest'
import { decodeFunctionData, type Hex } from 'viem'
import {
  NAIVE_AMM_ATTACKER,
  NAIVE_AMM_COORDINATOR,
  NAIVE_AMM_VICTIM,
  SEQUENCED_AMM_ABI,
  naiveAmmPreset,
} from '../src/naive-amm-room.js'
import { AMM_MULTI_SIGNER_CAPABILITY } from '../src/amm-room.js'
import { movesOf } from '../src/demo-runtime-checkpoint.js'
import { baseSpec } from '../src/demo-runtime-spec.js'
import { DEMO_PRESETS } from '../src/demo-presets.js'
import type { DemoAction } from '../src/demo-types.js'
import { validateTemplateRequest } from '../src/demo-validation.js'

const runtimeCode = '0x600160005500' as Hex
const contractAddress = '0x000000000000000000000000000000000000a441' as Hex

function acceptedActions(): DemoAction[] {
  return naiveAmmPreset().actions.map((action, index) => ({
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

describe('the sequenced (MEV) AMM room', () => {
  it('is registered as the amm-naive preset', () => {
    expect(DEMO_PRESETS.find((preset) => preset.id === 'amm-naive')).toBeDefined()
  })

  it('scripts the sandwich as three transactions across two blocks', () => {
    const preset = naiveAmmPreset()
    expect(preset.actions).toHaveLength(6)
    expect(preset.actions.map((action) => action.recommendedBlock)).toEqual([1, 1, 1, 2, 2, 2])
    // block 1: coordinator sets up; block 2: searcher, victim, searcher.
    expect(preset.actions.map((action) => action.fixtureSignerIndex)).toEqual([0, 0, 0, 2, 1, 2])
    expect(preset.proverCapabilities).toContain(AMM_MULTI_SIGNER_CAPABILITY)
    expect(new Set(preset.peers?.map((peer) => peer.fixtureSignerIndex))).toEqual(new Set([0, 1, 2]))

    const decoded = preset.actions.map((action) =>
      decodeFunctionData({ abi: SEQUENCED_AMM_ABI, data: action.calldata as Hex }),
    )
    expect(decoded.map((call) => call.functionName)).toEqual([
      'initialize',
      'register',
      'register',
      'swapExactInput',
      'swapExactInput',
      'swapMax',
    ])
    // The two register calls name the searcher and victim seats respectively.
    expect(decoded[1]!.args?.[0]).toEqual(NAIVE_AMM_ATTACKER)
    expect(decoded[2]!.args?.[0]).toEqual(NAIVE_AMM_VICTIM)
  })

  it('uses distinct coordinator, victim and searcher accounts', () => {
    expect(new Set([NAIVE_AMM_COORDINATOR, NAIVE_AMM_VICTIM, NAIVE_AMM_ATTACKER]).size).toBe(3)
  })

  it('carries signer indices, gas bounds, cold slots and runtime into the prover request', () => {
    const template = {
      ...validateTemplateRequest({ name: 'Naive AMM test', presetId: 'amm-naive' }),
      id: 'tpl-amm-naive',
      phase: 'ROOM_READY' as const,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      runtimeCode,
    }
    const moves = movesOf(acceptedActions())
    expect(moves.blockCalls?.[0]).toHaveLength(3)
    expect(moves.blockCalls?.[1]).toHaveLength(3)
    expect(moves.blockCalls?.flat().map((call) => call.signerIndex)).toEqual([0, 0, 0, 2, 1, 2])

    const request = baseSpec(
      template,
      9,
      1_000,
      `0x${'11'.repeat(32)}`,
      moves,
      contractAddress,
    ) as Record<string, unknown>
    expect(request.blockCalls).toEqual(moves.blockCalls)
    expect(request.initialStorage).toHaveLength(20)
    expect(request.runtimeCode).toBe(runtimeCode)
    expect(request.contractAddress).toBe(contractAddress)
    expect(request.residentAccounts).toBe(4)
  })
})
