import { createHash } from 'node:crypto'
import type { HostedRuntime } from './hosted-runtime.js'
import {
  buildWithdrawalEpoch,
  normalizeWithdrawalWitness,
  type WithdrawalWitness,
} from './withdrawal-proofs.js'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Converts a complete proof witness into customer claim paths. The object is
 * archived first; PostgreSQL then binds its computed root to the finalized,
 * independently indexed WithdrawalRootPublished event in one fenced write.
 */
export class WithdrawalProofService {
  constructor(
    private readonly runtime: HostedRuntime,
    private readonly chainId: number,
  ) {}

  async ingest(value: WithdrawalWitness): Promise<{
    created: boolean
    roomId: string
    epoch: string
    withdrawalRoot: `0x${string}`
    withdrawals: number
    sourceObjectKey: string
    sourceSha256: string
    finalizedBlock: string
    finalizedHash: string
  }> {
    const witness = normalizeWithdrawalWitness(value)
    const epoch = buildWithdrawalEpoch(witness)
    const bytes = new TextEncoder().encode(canonical(epoch.witness))
    const sourceSha256 = createHash('sha256').update(bytes).digest('hex')
    const object = await this.runtime.objects.putContent(
      bytes, 'application/vnd.zkdeal.withdrawal-witness+json',
    )
    if (object.sha256 !== sourceSha256) throw new Error('withdrawal witness object digest mismatch')
    const bound = await this.runtime.store.indexFinalizedWithdrawalEpoch(
      this.runtime.writableFence(),
      {
        chainId: this.chainId,
        roomId: witness.roomId,
        epoch: witness.outboxEpoch,
        deploymentDomain: witness.deploymentDomain,
        capacity: witness.capacity,
        withdrawalRoot: epoch.root,
        sourceObjectKey: object.key,
        records: epoch.records,
      },
    )
    return {
      created: bound.created,
      roomId: witness.roomId,
      epoch: witness.outboxEpoch,
      withdrawalRoot: epoch.root,
      withdrawals: epoch.records.length,
      sourceObjectKey: object.key,
      sourceSha256,
      finalizedBlock: bound.finalizedBlock,
      finalizedHash: bound.finalizedHash,
    }
  }
}
