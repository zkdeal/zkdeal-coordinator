import { resolve } from 'node:path'
import type { Abi, AbiParameter } from 'viem'
import { decodeFunctionData, encodeFunctionData } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  HOSTED_INDEXER_PROJECTION_SCHEMA,
  HOSTED_OBSERVATION_SCHEMA,
  dataAvailabilityRequirement,
  loadContractAbi,
  mergeContractAbis,
  ROOM_MANAGER_CALL_KINDS,
  ROOM_MANAGER_EVENT_KINDS,
  ROOM_POOL_CALL_KINDS,
  ROOM_POOL_EVENT_KINDS,
} from '../src/hosted-indexer.js'

const contractsOut = resolve(import.meta.dirname, '../../../web3-protocol/contracts/out')
const artifact = (source: string, contract: string) => loadContractAbi(
  resolve(contractsOut, source, `${contract}.json`),
)

const managerAbi = mergeContractAbis(
  artifact('RoomManagerObservationFacet.sol', 'RoomManagerObservationFacet'),
  artifact('IRoomManager.sol', 'IRoomManager'),
  artifact('RoomManager.sol', 'RoomManager'),
)
const poolAbi = mergeContractAbis(
  artifact('RoomPoolManager.sol', 'RoomPoolManager'),
  artifact('RoomPoolHostingFacet.sol', 'RoomPoolHostingFacet'),
  artifact('RoomPoolNodeRegistry.sol', 'RoomPoolNodeRegistry'),
)

function eventNames(abi: Abi): string[] {
  return [...new Set(abi.flatMap((item) => item.type === 'event' ? [item.name] : []))]
    .sort()
}

function mutatingFunctionNames(abi: Abi): string[] {
  return [...new Set(abi.flatMap((item) => item.type === 'function'
    && !['view', 'pure'].includes(item.stateMutability) ? [item.name] : []))]
    .sort()
}

function dummy(parameter: AbiParameter): unknown {
  if (parameter.type.endsWith(']')) return []
  if (parameter.type === 'tuple') {
    return ('components' in parameter ? parameter.components : []).map(dummy)
  }
  if (parameter.type === 'address') return `0x${'00'.repeat(20)}`
  if (parameter.type === 'bool') return false
  if (parameter.type === 'string') return ''
  if (parameter.type === 'bytes') return '0x'
  const fixedBytes = /^bytes([0-9]+)$/.exec(parameter.type)
  if (fixedBytes) return `0x${'00'.repeat(Number(fixedBytes[1]))}`
  if (/^(?:u?int)[0-9]*$/.test(parameter.type)) return 0n
  throw new Error(`no ABI fixture for ${parameter.type}`)
}

describe('hosted indexer ABI conformance', () => {
  it('maps every current RoomManager and RoomPool event to a durable fact kind', () => {
    expect(eventNames(managerAbi).filter((name) => !ROOM_MANAGER_EVENT_KINDS[name as keyof typeof ROOM_MANAGER_EVENT_KINDS]))
      .toEqual([])
    expect(eventNames(poolAbi).filter((name) => !ROOM_POOL_EVENT_KINDS[name as keyof typeof ROOM_POOL_EVENT_KINDS]))
      .toEqual([])
  })

  it('maps every externally callable mutating selector whose events are indexed', () => {
    expect(mutatingFunctionNames(managerAbi).filter(
      (name) => !ROOM_MANAGER_CALL_KINDS[name as keyof typeof ROOM_MANAGER_CALL_KINDS],
    )).toEqual([])
    expect(mutatingFunctionNames(poolAbi).filter(
      (name) => !ROOM_POOL_CALL_KINDS[name as keyof typeof ROOM_POOL_CALL_KINDS],
    )).toEqual([])
  })

  it('covers hosting lifecycle facts and uses one explicit projection/observation schema', () => {
    const factKinds = new Set<string>([
      ...Object.values(ROOM_MANAGER_EVENT_KINDS),
      ...Object.values(ROOM_POOL_EVENT_KINDS),
    ])
    for (const required of [
      'node', 'capacity', 'escrow', 'sponsorship', 'renewal', 'handoff',
      'withdrawal', 'data-availability', 'aggregate', 'recovery',
      'node-lifecycle',
    ]) expect(factKinds.has(required)).toBe(true)
    expect(HOSTED_INDEXER_PROJECTION_SCHEMA).toBe(2)
    expect(HOSTED_OBSERVATION_SCHEMA).toBe(HOSTED_INDEXER_PROJECTION_SCHEMA)
  })

  it('decodes every installed hosting-facet lifecycle selector', () => {
    const names = [
      'configureNodeAuthorities', 'recordFinalizedCheckpoint',
      'renewRoomForWithPermit', 'renewRoomWithPermit',
      'requestColdPreparationForWithPermit',
      'beginNodeDrain', 'retireNode',
      'reserveAndStartForWithDataAvailabilityWithPermit',
      'reserveAndStartForWithPermit',
      'reserveAndStartWithDataAvailabilityWithPermit',
      'reserveRoomForWithPermit', 'startReservedRoomWithDataAvailability',
    ]
    for (const name of names) {
      const fn = poolAbi.find((item) => item.type === 'function' && item.name === name)
      expect(fn, `${name} missing from merged pool ABI`).toBeTruthy()
      if (!fn || fn.type !== 'function') continue
      const data = encodeFunctionData({
        abi: [fn], functionName: name, args: fn.inputs.map(dummy),
      })
      expect(decodeFunctionData({ abi: poolAbi, data }).functionName).toBe(name)
      expect(ROOM_POOL_CALL_KINDS[name as keyof typeof ROOM_POOL_CALL_KINDS]).toBeTruthy()
    }
  })

  it('extracts single-room and aggregate blob manifests from canonical calldata', () => {
    const transactionHash = `0x${'11'.repeat(32)}` as const
    const blockHash = `0x${'22'.repeat(32)}` as const
    const versionedHash = `0x${'33'.repeat(32)}` as const
    const commitment = `0x${'44'.repeat(48)}` as const
    const manifest = {
      blobStartIndex: 2n,
      blobVersionedHashes: [versionedHash],
      commitments: [commitment],
    }
    const common = {
      eventArgs: { usedBlob: true, roomId: 7n, batchIndex: 9n },
      chainId: 31_337,
      transactionHash,
      blockNumber: '101',
      blockHash,
    }
    expect(dataAvailabilityRequirement({
      ...common,
      functionName: 'submitBatchWithDataAvailability',
      functionArgs: [null, null, manifest],
    })).toEqual(expect.objectContaining({
      roomId: '7', batchIndex: '9', blobStartIndex: 2,
      versionedHashes: [versionedHash], commitments: [commitment],
    }))

    expect(dataAvailabilityRequirement({
      ...common,
      functionName: 'submitAggregate',
      functionArgs: [{
        members: [{
          roomId: 7n,
          submission: { journal: { batchIndex: 9n } },
          dataAvailability: manifest,
        }],
      }],
    })).toEqual(expect.objectContaining({
      roomId: '7', batchIndex: '9', blobStartIndex: 2,
      versionedHashes: [versionedHash], commitments: [commitment],
    }))

    expect(dataAvailabilityRequirement({
      ...common,
      eventArgs: { ...common.eventArgs, usedBlob: false },
      functionName: 'submitBatchWithDataAvailability',
      functionArgs: [null, null, manifest],
    })).toBeNull()
  })
})
