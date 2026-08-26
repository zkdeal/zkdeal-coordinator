import { describe, expect, it, vi } from 'vitest'
import type { Hex } from 'viem'
import {
  watchSettlement,
  type SettlementRpc,
  type WatchedBlock,
  type WatchedReceipt,
} from '../src/l1-settlement-watcher.js'

const h = (byte: string) => `0x${byte.repeat(64)}` as Hex
const calldata = '0x12345678' as Hex

function rpc(input: {
  receipts: Record<string, WatchedReceipt | null>
  blocks: Record<string, WatchedBlock>
}): SettlementRpc {
  return {
    async getTransactionReceipt({ hash }) {
      const receipt = input.receipts[hash]
      if (!receipt) throw new Error('not found')
      return receipt
    },
    async getTransaction() {
      return { input: calldata }
    },
    async getBlock(selector) {
      const key = selector.blockTag ?? String(selector.blockNumber)
      const block = input.blocks[key]
      if (!block) throw new Error(`missing block ${key}`)
      return block
    },
  }
}

describe('L1 settlement watcher', () => {
  it('rechecks the receipt block after finalized covers it', async () => {
    const hash = h('1')
    const blockHash = h('a')
    const receipt: WatchedReceipt = {
      transactionHash: hash,
      blockNumber: 10n,
      blockHash,
      status: 'success',
    }
    const client = rpc({
      receipts: { [hash]: receipt },
      blocks: {
        '10': { number: 10n, hash: blockHash },
        finalized: { number: 12n, hash: h('f') },
        latest: { number: 12n, hash: h('f') },
      },
    })
    const accepted = vi.fn()
    const result = await watchSettlement({
      operation: 'submitBatch',
      rpcs: [client],
      initialHash: hash,
      expectedCalldata: calldata,
      broadcastIdenticalCalldata: async () => hash,
      l1InclusionDeadline: 100n,
      onAccepted: accepted,
      pollMs: 0,
    })
    expect(result).toMatchObject({ blockHash, finalizedBlockNumber: 12n, resubmissions: 0 })
    expect(accepted).toHaveBeenCalledOnce()
  })

  it('resubmits the identical calldata when a transaction disappears', async () => {
    const firstHash = h('1')
    const retryHash = h('2')
    const retryBlockHash = h('b')
    const client = rpc({
      receipts: {
        [firstHash]: null,
        [retryHash]: {
          transactionHash: retryHash,
          blockNumber: 11n,
          blockHash: retryBlockHash,
          status: 'success',
        },
      },
      blocks: {
        latest: { number: 10n, hash: h('a') },
        finalized: { number: 12n, hash: h('f') },
        '11': { number: 11n, hash: retryBlockHash },
      },
    })
    const rebroadcast = vi.fn(async () => retryHash)
    const result = await watchSettlement({
      operation: 'submitBatch',
      rpcs: [client],
      initialHash: firstHash,
      expectedCalldata: calldata,
      broadcastIdenticalCalldata: rebroadcast,
      l1InclusionDeadline: 100n,
      missingPollsBeforeResubmit: 1,
      pollMs: 0,
    })
    expect(rebroadcast).toHaveBeenCalledOnce()
    expect(result.transactionHash).toBe(retryHash)
    expect(result.resubmissions).toBe(1)
  })

  it('retracts a provisional acceptance before publishing the retried placement', async () => {
    const firstHash = h('1')
    const retryHash = h('2')
    const firstReceipt: WatchedReceipt = {
      transactionHash: firstHash,
      blockNumber: 10n,
      blockHash: h('a'),
      status: 'success',
    }
    const retryReceipt: WatchedReceipt = {
      transactionHash: retryHash,
      blockNumber: 11n,
      blockHash: h('b'),
      status: 'success',
    }
    let firstReceiptReads = 0
    let finalizedReads = 0
    const client: SettlementRpc = {
      async getTransactionReceipt({ hash }) {
        if (hash === firstHash && firstReceiptReads++ === 0) return firstReceipt
        if (hash === retryHash) return retryReceipt
        throw new Error('reorganized out')
      },
      async getTransaction() {
        return { input: calldata }
      },
      async getBlock(selector) {
        if (selector.blockNumber === 10n) return { number: 10n, hash: h('a') }
        if (selector.blockNumber === 11n) return { number: 11n, hash: h('b') }
        if (selector.blockTag === 'latest') return { number: 12n, hash: h('c') }
        if (selector.blockTag === 'finalized') {
          return finalizedReads++ === 0
            ? { number: 9n, hash: h('9') }
            : { number: 12n, hash: h('f') }
        }
        throw new Error('unknown block')
      },
    }
    const phases: string[] = []
    const result = await watchSettlement({
      operation: 'submitBatch',
      rpcs: [client],
      initialHash: firstHash,
      expectedCalldata: calldata,
      broadcastIdenticalCalldata: async () => retryHash,
      l1InclusionDeadline: 100n,
      missingPollsBeforeResubmit: 1,
      pollMs: 0,
      onAccepted: () => {
        phases.push('L1_ACCEPTED')
      },
      onRetracted: () => {
        phases.push('L1_PENDING')
      },
    })
    expect(phases).toEqual(['L1_ACCEPTED', 'L1_PENDING', 'L1_ACCEPTED'])
    expect(result.transactionHash).toBe(retryHash)
  })

  it('alerts and fails rather than guessing past the inclusion deadline', async () => {
    const hash = h('1')
    const client = rpc({
      receipts: { [hash]: null },
      blocks: { latest: { number: 20n, hash: h('a') } },
    })
    const alert = vi.fn()
    await expect(
      watchSettlement({
        operation: 'forceTransaction',
        rpcs: [client],
        initialHash: hash,
        expectedCalldata: calldata,
        broadcastIdenticalCalldata: async () => hash,
        l1InclusionDeadline: 20n,
        onDeadlineAlert: alert,
        pollMs: 0,
      }),
    ).rejects.toThrow(/inclusion deadline/)
    expect(alert).toHaveBeenCalledWith(0n)
  })
})
