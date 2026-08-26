import type { Hex } from 'viem'

export type WatchedSettlementOperation =
  | 'submitBatch'
  | 'publishL1StateInput'
  | 'forceTransaction'

export interface WatchedReceipt {
  transactionHash: Hex
  blockNumber: bigint
  blockHash: Hex
  status: 'success' | 'reverted'
}

export interface WatchedBlock {
  number: bigint | null
  hash: Hex | null
}

export interface SettlementRpc {
  getTransactionReceipt(args: { hash: Hex }): Promise<WatchedReceipt>
  getTransaction(args: { hash: Hex }): Promise<{ input: Hex }>
  getBlock(args: {
    blockNumber?: bigint
    blockTag?: 'latest' | 'finalized'
    includeTransactions?: false
  }): Promise<WatchedBlock>
}

export interface SettlementWatchOptions {
  operation: WatchedSettlementOperation
  rpcs: readonly SettlementRpc[]
  initialHash: Hex
  expectedCalldata: Hex
  /** Re-broadcasts the same encoded function call; only the envelope may change. */
  broadcastIdenticalCalldata: () => Promise<Hex>
  l1InclusionDeadline: bigint
  onAccepted?: (receipt: WatchedReceipt) => void | Promise<void>
  onRetracted?: (receiptHash: Hex) => void | Promise<void>
  onDeadlineAlert?: (remainingBlocks: bigint) => void | Promise<void>
  deadlineAlertBlocks?: bigint
  pollMs?: number
  missingPollsBeforeResubmit?: number
  maxResubmissions?: number
  maxWaitMs?: number
}

export interface FinalizedSettlement extends WatchedReceipt {
  finalizedBlockNumber: bigint
  finalizedBlockHash: Hex
  resubmissions: number
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function sameBlock(left: WatchedBlock, right: WatchedBlock): boolean {
  return (
    left.number === right.number &&
    left.hash?.toLowerCase() === right.hash?.toLowerCase()
  )
}

export async function readAgreedBlock(
  rpcs: readonly SettlementRpc[],
  selector: { blockNumber: bigint } | { blockTag: 'latest' | 'finalized' },
): Promise<WatchedBlock> {
  const blocks = await Promise.all(
    rpcs.map((rpc) => rpc.getBlock({ ...selector, includeTransactions: false })),
  )
  const first = blocks[0]
  if (!first || first.number === null || !first.hash) {
    throw new Error('an L1 RPC returned no usable canonical block')
  }
  if (blocks.some((block) => !sameBlock(first, block))) {
    throw new Error('L1 RPC providers disagree on a critical canonical block')
  }
  return first
}

async function agreedReceipt(
  rpcs: readonly SettlementRpc[],
  hash: Hex,
): Promise<WatchedReceipt | null> {
  const receipts = await Promise.all(
    rpcs.map(async (rpc) => {
      try {
        return await rpc.getTransactionReceipt({ hash })
      } catch {
        return null
      }
    }),
  )
  if (receipts.every((receipt) => receipt === null)) return null
  const first = receipts[0]
  if (
    !first ||
    receipts.some(
      (receipt) =>
        !receipt ||
        receipt.transactionHash.toLowerCase() !== first.transactionHash.toLowerCase() ||
        receipt.blockNumber !== first.blockNumber ||
        receipt.blockHash.toLowerCase() !== first.blockHash.toLowerCase() ||
        receipt.status !== first.status,
    )
  ) {
    throw new Error('L1 RPC providers disagree on the settlement receipt')
  }
  return first
}

/**
 * Watches an operator-owned settlement until the finalized checkpoint covers
 * it. A receipt is provisional: its block hash is re-read on every poll. If it
 * disappears, the exact encoded calldata is broadcast again while the
 * inclusion deadline still permits the single full retry budget.
 */
export async function watchSettlement(
  options: SettlementWatchOptions,
): Promise<FinalizedSettlement> {
  if (options.rpcs.length === 0) throw new Error('the settlement watcher requires an L1 RPC')
  const pollMs = Math.max(0, options.pollMs ?? 12_000)
  const missingLimit = Math.max(1, options.missingPollsBeforeResubmit ?? 2)
  const maxResubmissions = Math.max(0, options.maxResubmissions ?? 1)
  const alertAt = options.deadlineAlertBlocks ?? 8n
  const stopAt = Date.now() + (options.maxWaitMs ?? 30 * 60_000)
  let hash = options.initialHash
  let missingPolls = 0
  let resubmissions = 0
  let acceptedPlacement: string | null = null
  let alertedAt: bigint | null = null

  for (;;) {
    if (Date.now() > stopAt) {
      throw new Error(`${options.operation} did not reach L1 finality within the watcher budget`)
    }
    let receipt = await agreedReceipt(options.rpcs, hash)
    if (!receipt) {
      if (acceptedPlacement !== null) {
        await options.onRetracted?.(hash)
        acceptedPlacement = null
      }
      missingPolls += 1
      const latest = await readAgreedBlock(options.rpcs, { blockTag: 'latest' })
      const remaining = options.l1InclusionDeadline - latest.number!
      if (remaining <= alertAt && alertedAt !== latest.number) {
        alertedAt = latest.number
        await options.onDeadlineAlert?.(remaining)
      }
      if (latest.number! >= options.l1InclusionDeadline) {
        throw new Error(`${options.operation} disappeared before its L1 inclusion deadline`)
      }
      if (missingPolls >= missingLimit) {
        if (resubmissions >= maxResubmissions) {
          throw new Error(`${options.operation} disappeared and exhausted its identical-calldata retry`)
        }
        hash = await options.broadcastIdenticalCalldata()
        resubmissions += 1
        missingPolls = 0
        acceptedPlacement = null
      }
      if (pollMs > 0) await wait(pollMs)
      continue
    }

    missingPolls = 0
    if (receipt.status !== 'success') throw new Error(`${options.operation} reverted on L1`)
    const transactions = await Promise.all(
      options.rpcs.map((rpc) => rpc.getTransaction({ hash })),
    )
    if (
      transactions.some(
        (transaction) =>
          transaction.input.toLowerCase() !== options.expectedCalldata.toLowerCase(),
      )
    ) {
      throw new Error(`${options.operation} receipt does not carry the calldata being watched`)
    }
    const canonical = await readAgreedBlock(options.rpcs, { blockNumber: receipt.blockNumber })
    if (canonical.hash!.toLowerCase() !== receipt.blockHash.toLowerCase()) {
      // A stale receipt survived in an RPC cache. Treat it exactly like a
      // disappeared receipt and drive the identical-calldata retry path.
      const latest = await readAgreedBlock(options.rpcs, { blockTag: 'latest' })
      if (acceptedPlacement !== null) await options.onRetracted?.(hash)
      if (latest.number! >= options.l1InclusionDeadline || resubmissions >= maxResubmissions) {
        throw new Error(`${options.operation} was reorganized out and cannot be retried safely`)
      }
      hash = await options.broadcastIdenticalCalldata()
      resubmissions += 1
      missingPolls = 0
      acceptedPlacement = null
      continue
    }
    const placement = `${receipt.blockNumber}:${receipt.blockHash.toLowerCase()}`
    if (placement !== acceptedPlacement) {
      acceptedPlacement = placement
      await options.onAccepted?.(receipt)
    }
    const latest = await readAgreedBlock(options.rpcs, { blockTag: 'latest' })
    const remaining = options.l1InclusionDeadline - latest.number!
    if (remaining <= alertAt && alertedAt !== latest.number) {
      alertedAt = latest.number
      await options.onDeadlineAlert?.(remaining)
    }
    const finalized = await readAgreedBlock(options.rpcs, { blockTag: 'finalized' })
    if (finalized.number! >= receipt.blockNumber) {
      // Close the time-of-check/time-of-publication gap with one last receipt
      // and canonical-block read after observing the finalized checkpoint.
      const finalReceipt = await agreedReceipt(options.rpcs, hash)
      const finalBlock = await readAgreedBlock(options.rpcs, { blockNumber: receipt.blockNumber })
      if (
        finalReceipt &&
        finalReceipt.blockHash.toLowerCase() === receipt.blockHash.toLowerCase() &&
        finalBlock.hash!.toLowerCase() === receipt.blockHash.toLowerCase()
      ) {
        return {
          ...receipt,
          finalizedBlockNumber: finalized.number!,
          finalizedBlockHash: finalized.hash!,
          resubmissions,
        }
      }
    }
    if (pollMs > 0) await wait(pollMs)
  }
}
