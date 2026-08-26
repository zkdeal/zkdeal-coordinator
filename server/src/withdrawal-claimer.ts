import { createHash, randomUUID } from 'node:crypto'
import {
  bytesToHex,
  decodeFunctionResult,
  encodeFunctionData,
  hexToBytes,
  keccak256,
  type Hex,
} from 'viem'
import type { HostedRuntime } from './hosted-runtime.js'
import type {
  HostedL1Transaction,
  HostedWithdrawalClaim,
} from './postgres-hosted-store.js'
import type { L1Eip1559TransactionSigner } from './l1-transaction-signer.js'
import { emitHostedTrace } from './structured-log.js'
import {
  WITHDRAWAL_CLAIM_ABI,
  encodeWithdrawalClaim,
  normalizeWithdrawal,
  verifyWithdrawalProof,
  withdrawalLeaf,
  type WithdrawalValue,
} from './withdrawal-proofs.js'

interface StoredWithdrawalClaimRequest {
  schemaVersion: 1
  chainId: number
  sender: `0x${string}`
  roomManager: `0x${string}`
  claimId: string
  roomId: string
  outboxEpoch: string
  withdrawal: WithdrawalValue
  proof: Hex[]
  withdrawalRoot: Hex
  finalizedBlock: string
  finalizedHash: Hex
  calldata: Hex
  gas: string
  maxPriorityFeePerGas: string
  maxFeePerGas: string
  inclusionDeadline: string
}

export interface WithdrawalClaimerOptions {
  runtime: HostedRuntime
  chainId: number
  roomManager: `0x${string}`
  signer: L1Eip1559TransactionSigner
  workerId: string
  gasLimit?: bigint
  inclusionWindowBlocks?: bigint
}

export interface WithdrawalClaimerRun {
  leased: number
  submitted: number
  confirmed: number
  alreadyClaimed: number
  errors: number
  recoveryRequired: number
}

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

function hex(value: unknown, bytes: number, field: string): Hex {
  const text = String(value ?? '').toLowerCase()
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(text)) throw new Error(`${field} is malformed`)
  return text as Hex
}

function hexData(value: unknown, field: string): Hex {
  const text = String(value ?? '').toLowerCase()
  if (!/^0x(?:[0-9a-f]{2})*$/.test(text)) throw new Error(`${field} is malformed`)
  return text as Hex
}

function decimal(value: unknown, field: string): string {
  const text = String(value ?? '')
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) throw new Error(`${field} is not a canonical decimal`)
  return BigInt(text).toString()
}

function proofRequest(value: Record<string, unknown>, options: {
  chainId: number
  sender: `0x${string}`
  roomManager: `0x${string}`
  claimId: string
  gas: bigint
  maxPriorityFeePerGas: bigint
  maxFeePerGas: bigint
  inclusionDeadline: bigint
}): StoredWithdrawalClaimRequest {
  const withdrawal = normalizeWithdrawal({
    index: decimal(value.withdrawalIndex, 'withdrawalIndex'),
    approverEpoch: decimal(value.approverEpoch, 'approverEpoch'),
    recipient: String(value.recipient) as `0x${string}`,
    asset: String(value.asset) as `0x${string}`,
    amount: decimal(value.amount, 'amount'),
  })
  if (!Array.isArray(value.positionalProof)) throw new Error('withdrawal positional proof is missing')
  const proof = value.positionalProof.map((item) => hex(item, 32, 'withdrawal proof sibling'))
  const roomId = decimal(value.roomId, 'roomId')
  const outboxEpoch = decimal(value.epoch, 'outboxEpoch')
  const calldata = encodeWithdrawalClaim({ roomId, outboxEpoch, withdrawal, proof })
  return {
    schemaVersion: 1,
    chainId: options.chainId,
    sender: options.sender.toLowerCase() as `0x${string}`,
    roomManager: options.roomManager.toLowerCase() as `0x${string}`,
    claimId: options.claimId,
    roomId,
    outboxEpoch,
    withdrawal,
    proof,
    withdrawalRoot: hex(value.withdrawalRoot, 32, 'withdrawalRoot'),
    finalizedBlock: decimal(value.finalizedBlock, 'finalizedBlock'),
    finalizedHash: hex(value.finalizedHash, 32, 'finalizedHash'),
    calldata,
    gas: options.gas.toString(),
    maxPriorityFeePerGas: options.maxPriorityFeePerGas.toString(),
    maxFeePerGas: options.maxFeePerGas.toString(),
    inclusionDeadline: options.inclusionDeadline.toString(),
  }
}

function decodeStoredRequest(bytes: Uint8Array): StoredWithdrawalClaimRequest {
  const value = JSON.parse(new TextDecoder().decode(bytes)) as StoredWithdrawalClaimRequest
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.chainId) || value.chainId <= 0) {
    throw new Error('stored withdrawal claim request has an unsupported schema')
  }
  const withdrawal = normalizeWithdrawal(value.withdrawal)
  if (!Array.isArray(value.proof)) throw new Error('stored withdrawal proof is missing')
  const proof = value.proof.map((item) => hex(item, 32, 'withdrawal proof sibling'))
  const normalized: StoredWithdrawalClaimRequest = {
    schemaVersion: 1,
    chainId: value.chainId,
    sender: hex(value.sender, 20, 'sender') as `0x${string}`,
    roomManager: hex(value.roomManager, 20, 'roomManager') as `0x${string}`,
    claimId: String(value.claimId),
    roomId: decimal(value.roomId, 'roomId'),
    outboxEpoch: decimal(value.outboxEpoch, 'outboxEpoch'),
    withdrawal,
    proof,
    withdrawalRoot: hex(value.withdrawalRoot, 32, 'withdrawalRoot'),
    finalizedBlock: decimal(value.finalizedBlock, 'finalizedBlock'),
    finalizedHash: hex(value.finalizedHash, 32, 'finalizedHash'),
    calldata: encodeWithdrawalClaim({
      roomId: decimal(value.roomId, 'roomId'),
      outboxEpoch: decimal(value.outboxEpoch, 'outboxEpoch'),
      withdrawal,
      proof,
    }),
    gas: decimal(value.gas, 'gas'),
    maxPriorityFeePerGas: decimal(value.maxPriorityFeePerGas, 'maxPriorityFeePerGas'),
    maxFeePerGas: decimal(value.maxFeePerGas, 'maxFeePerGas'),
    inclusionDeadline: decimal(value.inclusionDeadline, 'inclusionDeadline'),
  }
  if (
    normalized.calldata !== hexData(value.calldata, 'calldata')
    || normalized.withdrawalRoot !== hex(value.withdrawalRoot, 32, 'withdrawalRoot')
    || normalized.finalizedHash !== hex(value.finalizedHash, 32, 'finalizedHash')
  ) throw new Error('stored withdrawal claim request changed canonical bytes')
  return normalized
}

/** Durable, permissionless auto-claimer; the signer pays gas but can never redirect funds. */
export class WithdrawalClaimer {
  private readonly gasLimit: bigint
  private readonly inclusionWindowBlocks: bigint

  constructor(private readonly options: WithdrawalClaimerOptions) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(options.roomManager)) throw new Error('RoomManager address is malformed')
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(options.workerId)) throw new Error('withdrawal worker id is invalid')
    this.gasLimit = options.gasLimit ?? 500_000n
    this.inclusionWindowBlocks = options.inclusionWindowBlocks ?? 64n
    if (this.gasLimit < 100_000n || this.gasLimit > 5_000_000n) throw new Error('withdrawal claim gas limit is unsafe')
    if (this.inclusionWindowBlocks < 8n || this.inclusionWindowBlocks > 1_024n) {
      throw new Error('withdrawal inclusion window is outside 8 through 1024 blocks')
    }
  }

  async assertReady(): Promise<void> {
    await this.options.signer.assertReady()
    this.options.runtime.writableFence()
    await Promise.all([
      this.options.runtime.l1.agreedTransactionCount(this.options.signer.address, 'pending'),
      this.options.runtime.l1.agreedEip1559Fees(),
    ])
  }

  private async onchainBoolean(
    blockHash: Hex,
    functionName: 'verifyWithdrawalProof' | 'isWithdrawalClaimed',
    args: readonly unknown[],
  ): Promise<boolean> {
    const data = functionName === 'verifyWithdrawalProof'
      ? encodeFunctionData({
          abi: WITHDRAWAL_CLAIM_ABI,
          functionName,
          args: args as readonly [
            bigint,
            bigint,
            { index: bigint; approverEpoch: bigint; recipient: `0x${string}`; asset: `0x${string}`; amount: bigint },
            readonly `0x${string}`[],
          ],
        })
      : encodeFunctionData({
          abi: WITHDRAWAL_CLAIM_ABI,
          functionName,
          args: args as readonly [bigint, bigint, bigint],
        })
    const result = await this.options.runtime.l1.agreedCall({
      to: this.options.roomManager,
      data,
      blockTag: { blockHash, requireCanonical: true },
    })
    return decodeFunctionResult({
      abi: WITHDRAWAL_CLAIM_ABI, functionName, data: result.data,
    }) as boolean
  }

  private tuple(request: StoredWithdrawalClaimRequest) {
    return {
      index: BigInt(request.withdrawal.index),
      approverEpoch: BigInt(request.withdrawal.approverEpoch),
      recipient: request.withdrawal.recipient,
      asset: request.withdrawal.asset,
      amount: BigInt(request.withdrawal.amount),
    }
  }

  private async requestFor(row: HostedL1Transaction): Promise<StoredWithdrawalClaimRequest> {
    const bytes = await this.options.runtime.objects.get(row.requestObjectKey)
    if (!bytes) throw new Error('durable withdrawal claim request object is missing')
    if (createHash('sha256').update(bytes).digest('hex') !== row.requestHash) {
      throw new Error('durable withdrawal claim request hash mismatch')
    }
    const request = decodeStoredRequest(bytes)
    if (
      request.chainId !== row.chainId || request.sender !== row.sender
      || request.calldata !== row.calldata || request.inclusionDeadline !== row.inclusionDeadline
    ) throw new Error('durable withdrawal request is not bound to its nonce journal row')
    return request
  }

  private async rawTransaction(row: HostedL1Transaction): Promise<Hex> {
    if (!row.rawTransactionObjectKey || !row.transactionHash) throw new Error('signed withdrawal row has no durable bytes')
    const bytes = await this.options.runtime.objects.get(row.rawTransactionObjectKey)
    if (!bytes) throw new Error('durable signed withdrawal transaction is missing')
    const raw = bytesToHex(bytes)
    if (keccak256(raw).toLowerCase() !== row.transactionHash) {
      throw new Error('durable signed withdrawal bytes do not match their transaction hash')
    }
    return raw
  }

  private async signPrepared(row: HostedL1Transaction): Promise<HostedL1Transaction> {
    const request = await this.requestFor(row)
    const signed = await this.options.signer.signEip1559({
      chainId: request.chainId,
      nonce: BigInt(row.nonce),
      to: request.roomManager,
      data: request.calldata,
      value: 0n,
      gas: BigInt(request.gas),
      maxPriorityFeePerGas: BigInt(request.maxPriorityFeePerGas),
      maxFeePerGas: BigInt(request.maxFeePerGas),
    })
    const raw = await this.options.runtime.objects.putContent(
      hexToBytes(signed.signedBody), 'application/vnd.ethereum.signed-transaction',
    )
    return this.options.runtime.store.attachSignedL1Transaction(
      this.options.runtime.writableFence(), row.operationId,
      { transactionHash: signed.transactionHash, rawTransactionObjectKey: raw.key, bundleObjectKey: null },
    )
  }

  private async broadcast(row: HostedL1Transaction): Promise<HostedL1Transaction> {
    if (!row.transactionHash) throw new Error('signed withdrawal has no transaction hash')
    const raw = await this.rawTransaction(row)
    await this.options.runtime.l1.broadcastRawTransaction(raw, row.transactionHash)
    return this.options.runtime.store.markL1TransactionBroadcast(
      this.options.runtime.writableFence(), row.operationId,
    )
  }

  private async prepare(claim: HostedWithdrawalClaim): Promise<{
    row: HostedL1Transaction | null
    alreadyClaimed: boolean
  }> {
    const idempotencyKey = `withdrawal-claim:${claim.claimId}`
    const existing = await this.options.runtime.store.l1TransactionByIdempotencyKey(idempotencyKey)
    if (existing) {
      // A crash may happen after nonce reservation or signing but before the
      // claim row is linked. Resume the immutable request and exact signed
      // bytes instead of recomputing fees/deadlines or consuming another nonce.
      await this.requestFor(existing)
      if (['FAILED', 'RECOVERY_REQUIRED'].includes(existing.status)) {
        throw new Error(`withdrawal L1 operation is ${existing.status}`)
      }
      let row = existing.status === 'PREPARED' ? await this.signPrepared(existing) : existing
      if (!row.transactionHash) throw new Error('withdrawal L1 operation has no signed hash')
      await this.options.runtime.store.attachWithdrawalClaimOperation(
        this.options.runtime.writableFence(), claim.claimId, this.options.workerId,
        row.operationId, row.transactionHash,
      )
      if (row.status === 'SIGNED') row = await this.broadcast(row)
      return { row, alreadyClaimed: false }
    }

    const value = await this.options.runtime.store.withdrawalClaimProof(claim.claimId)
    if (!value) throw new Error('finalized withdrawal proof is unavailable')
    const fees = await this.options.runtime.l1.agreedEip1559Fees()
    const request = proofRequest(value, {
      chainId: this.options.chainId,
      sender: this.options.signer.address,
      roomManager: this.options.roomManager,
      claimId: claim.claimId,
      gas: this.gasLimit,
      maxPriorityFeePerGas: BigInt(fees.maxPriorityFeePerGas),
      maxFeePerGas: BigInt(fees.maxFeePerGas),
      inclusionDeadline: BigInt(fees.blockNumber) + this.inclusionWindowBlocks,
    })
    const leaf = withdrawalLeaf(
      hex((value as { deploymentDomain?: unknown }).deploymentDomain, 32, 'deploymentDomain'),
      request.roomId, request.outboxEpoch, request.withdrawal,
    )
    if (!verifyWithdrawalProof(request.withdrawalRoot, leaf, request.withdrawal.index, request.proof)) {
      throw new Error('indexed withdrawal proof fails local root verification')
    }
    const tuple = this.tuple(request)
    if (!await this.onchainBoolean(request.finalizedHash, 'verifyWithdrawalProof', [
      BigInt(request.roomId), BigInt(request.outboxEpoch), tuple, request.proof,
    ])) throw new Error('RoomManager rejected the indexed withdrawal proof at its finalized block hash')
    const latest = await this.options.runtime.l1.agreedBlock('latest')
    const alreadyClaimed = await this.onchainBoolean(latest.hash, 'isWithdrawalClaimed', [
      BigInt(request.roomId), BigInt(request.outboxEpoch), BigInt(request.withdrawal.index),
    ])
    if (alreadyClaimed) {
      // A customer or another permissionless relayer may have won the race,
      // but a latest-state eth_call cannot self-attest final settlement. Only
      // the finalized canonical indexer fact may complete the tenant claim.
      if (await this.options.runtime.store.confirmExternallyClaimedWithdrawal(
        this.options.runtime.writableFence(), claim.claimId, this.options.workerId,
      )) return { row: null, alreadyClaimed: true }
      throw new Error('WITHDRAWAL_ALREADY_CLAIMED_AWAITING_FINALIZED_INDEXER_FACT')
    }
    const bytes = new TextEncoder().encode(canonical(request))
    const requestHash = createHash('sha256').update(bytes).digest('hex')
    const object = await this.options.runtime.objects.putContent(
      bytes, 'application/vnd.zkdeal.withdrawal-claim-request+json',
    )
    if (object.sha256 !== requestHash) throw new Error('withdrawal claim request object digest mismatch')
    const remotePendingNonce = await this.options.runtime.l1.agreedTransactionCount(
      this.options.signer.address, 'pending',
    )
    let row = await this.options.runtime.store.reserveL1Transaction(
      this.options.runtime.writableFence(),
      {
        operationId: randomUUID(), chainId: this.options.chainId,
        sender: this.options.signer.address, operation: 'claim-withdrawal',
        idempotencyKey,
        requestHash, requestObjectKey: object.key, destinationAddress: request.roomManager,
        calldata: request.calldata,
        inclusionDeadline: request.inclusionDeadline, remotePendingNonce,
      },
    )
    if (row.status === 'PREPARED') row = await this.signPrepared(row)
    if (!row.transactionHash) throw new Error('withdrawal L1 operation has no signed hash')
    await this.options.runtime.store.attachWithdrawalClaimOperation(
      this.options.runtime.writableFence(), claim.claimId, this.options.workerId,
      row.operationId, row.transactionHash,
    )
    if (row.status === 'SIGNED') row = await this.broadcast(row)
    return { row, alreadyClaimed: false }
  }

  private async watch(row: HostedL1Transaction): Promise<HostedL1Transaction> {
    if (row.status === 'PREPARED') row = await this.signPrepared(row)
    if (row.status === 'SIGNED') row = await this.broadcast(row)
    if (row.status === 'BROADCAST') {
      const receipt = row.transactionHash
        ? (await this.options.runtime.l1.agreedReceiptOptional(row.transactionHash)).transaction
        : null
      if (receipt) {
        if (String(receipt.status) === '0x0') {
          await this.options.runtime.store.markL1TransactionFailed(
            this.options.runtime.writableFence(), row.operationId, 'claimWithdrawal reverted',
          )
          return (await this.options.runtime.store.l1Transaction(row.operationId))!
        }
        row = await this.options.runtime.store.markL1TransactionIncluded(
          this.options.runtime.writableFence(), row.operationId,
           BigInt(String(receipt.blockNumber)).toString(),
           String(receipt.blockHash).toLowerCase() as `0x${string}`,
          receipt.gasUsed != null && receipt.effectiveGasPrice != null
            ? {
                gasUsed: BigInt(String(receipt.gasUsed)).toString(),
                effectiveGasPrice: BigInt(String(receipt.effectiveGasPrice)).toString(),
                blobGasUsed: receipt.blobGasUsed == null ? null : BigInt(String(receipt.blobGasUsed)).toString(),
                blobGasPrice: receipt.blobGasPrice == null ? null : BigInt(String(receipt.blobGasPrice)).toString(),
              }
            : undefined,
        )
      }
    }
    if (row.status === 'INCLUDED') {
      const receipt = row.transactionHash
        ? (await this.options.runtime.l1.agreedReceiptOptional(row.transactionHash)).transaction
        : null
      if (
        !receipt || BigInt(String(receipt.blockNumber)).toString() !== row.blockNumber
        || String(receipt.blockHash).toLowerCase() !== row.blockHash
      ) {
        row = await this.options.runtime.store.markL1TransactionRetracted(
          this.options.runtime.writableFence(), row.operationId,
          'canonical withdrawal receipt disappeared or moved before finality',
        )
        return this.broadcast(row)
      }
      const finalized = await this.options.runtime.l1.agreedBlock('finalized')
      if (BigInt(finalized.number) >= BigInt(row.blockNumber!)) {
        const included = await this.options.runtime.l1.agreedBlock(`0x${BigInt(row.blockNumber!).toString(16)}`)
        if (included.hash.toLowerCase() !== row.blockHash) {
          row = await this.options.runtime.store.markL1TransactionRetracted(
            this.options.runtime.writableFence(), row.operationId,
            'withdrawal inclusion block changed before finality',
          )
          return this.broadcast(row)
        }
        row = await this.options.runtime.store.markL1TransactionFinalized(
          this.options.runtime.writableFence(), row.operationId, finalized.number, finalized.hash,
        )
      }
    }
    return row
  }

  async processOnce(limit = 25): Promise<WithdrawalClaimerRun> {
    const result: WithdrawalClaimerRun = {
      leased: 0, submitted: 0, confirmed: 0, alreadyClaimed: 0,
      errors: 0, recoveryRequired: 0,
    }
    const leased = await this.options.runtime.store.leaseWithdrawalClaims(
      this.options.runtime.writableFence(), this.options.chainId, this.options.workerId, limit,
    )
    result.leased = leased.length
    for (const claim of leased) {
      const trace={
        correlationId:`withdrawal:${claim.claimId}`,tenantId:claim.tenantId,roomId:claim.roomId,
        jobId:null,operationId:claim.operationId,component:'withdrawal' as const,event:'claim.prepare',
      }
      emitHostedTrace({ ...trace,outcome:'started' })
      try {
        const prepared = await this.prepare(claim)
        if (prepared.alreadyClaimed) {
          result.alreadyClaimed += 1
          emitHostedTrace({ ...trace,event:'claim.already-claimed',outcome:'succeeded' })
          continue
        }
        if (!prepared.row?.transactionHash) throw new Error('withdrawal L1 operation has no signed hash')
        result.submitted += 1
        emitHostedTrace({
          ...trace,operationId:prepared.row.operationId,event:'claim.submitted',outcome:'succeeded',
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'withdrawal claim preparation failed'
        if (reason === 'WITHDRAWAL_ALREADY_CLAIMED_AWAITING_FINALIZED_INDEXER_FACT') {
          // Keep the claim retryable until the indexer observes WithdrawalClaimed;
          // it must not self-attest a successful external transaction.
          result.alreadyClaimed += 1
        } else {
          result.errors += 1
        }
        await this.options.runtime.store.releaseWithdrawalClaimLease(
          this.options.runtime.writableFence(), claim.claimId, this.options.workerId,
          reason, Math.min(300_000, 1_000 * (2 ** Math.min(claim.attempts, 8))),
        ).catch(() => {})
        emitHostedTrace({
          ...trace,event:'claim.prepare',
          outcome:reason==='WITHDRAWAL_ALREADY_CLAIMED_AWAITING_FINALIZED_INDEXER_FACT' ? 'retrying' : 'failed',
        })
      }
    }

    for (const claim of await this.options.runtime.store.withdrawalClaimsForProcessing(this.options.chainId, limit * 4)) {
      const trace={
        correlationId:`withdrawal:${claim.claimId}`,tenantId:claim.tenantId,roomId:claim.roomId,
        jobId:null,operationId:claim.operationId,component:'withdrawal' as const,event:'claim.watch',
      }
      emitHostedTrace({ ...trace,outcome:'started' })
      try {
        const row = claim.operationId
          ? await this.options.runtime.store.l1Transaction(claim.operationId)
          : null
        if (!row) throw new Error('withdrawal claim operation journal is missing')
        if (row.status === 'RECOVERY_REQUIRED' && claim.status === 'CONFIRMED') {
          await this.options.runtime.store.setWithdrawalClaimStatus(
            this.options.runtime.writableFence(), claim.claimId, 'RETRACTED',
            'POST_FINALITY_SURPRISE', row.lastError,
          )
          result.recoveryRequired += 1
          emitHostedTrace({ ...trace,event:'claim.post-finality-audit',outcome:'retracted' })
          continue
        }
        if (row.status === 'FAILED' && claim.status === 'SUBMITTED') {
          await this.options.runtime.store.setWithdrawalClaimStatus(
            this.options.runtime.writableFence(), claim.claimId, 'FAILED',
            'L1_REVERT', row.lastError,
          )
          emitHostedTrace({ ...trace,outcome:'failed' })
          continue
        }
        if (claim.status !== 'SUBMITTED') continue
        const watched = await this.watch(row)
        if (watched.status === 'FINALIZED') {
          await this.options.runtime.store.setWithdrawalClaimStatus(
            this.options.runtime.writableFence(), claim.claimId, 'CONFIRMED',
          )
          result.confirmed += 1
          emitHostedTrace({ ...trace,event:'claim.finalized',outcome:'succeeded' })
        } else {
          emitHostedTrace({ ...trace,outcome:'retrying' })
        }
      } catch (error) {
        result.errors += 1
        const row = claim.operationId ? await this.options.runtime.store.l1Transaction(claim.operationId).catch(() => null) : null
        if (row && ['PREPARED', 'SIGNED', 'BROADCAST', 'INCLUDED'].includes(row.status)) {
          const reason = error instanceof Error ? error.message : 'withdrawal watcher failed'
          if (row.attempts >= 31 || BigInt(row.inclusionDeadline) <= BigInt((await this.options.runtime.l1.agreedBlock('latest')).number)) {
            await this.options.runtime.store.markL1TransactionRecoveryRequired(
              this.options.runtime.writableFence(), row.operationId,
              `withdrawal claim requires operator recovery: ${reason}`,
            ).then(() => { result.recoveryRequired += 1 }).catch(() => {})
          } else {
            await this.options.runtime.store.recordL1TransactionAttemptError(
              this.options.runtime.writableFence(), row.operationId, reason,
              Math.min(60_000, 1_000 * (2 ** Math.min(row.attempts, 6))),
              false,
            ).catch(() => {})
          }
        }
        emitHostedTrace({ ...trace,outcome:'retrying' })
      }
    }

    // Round-robin finalized audit retains coverage after operations age out of
    // the newest-page window. A corroborated hash change is a static safety
    // surprise and must never be silently rewritten or auto-reclaimed.
    for (const row of await this.options.runtime.store.nextFinalizedL1AuditBatch(
      this.options.runtime.writableFence(), this.options.chainId, this.options.signer.address, limit,
    )) {
      if (row.operation !== 'claim-withdrawal' || !row.blockNumber || !row.blockHash) continue
      try {
        const canonical = await this.options.runtime.l1.agreedBlock(
          `0x${BigInt(row.blockNumber).toString(16)}`,
        )
        if (canonical.hash.toLowerCase() !== row.blockHash) {
          await this.options.runtime.store.markL1TransactionRetracted(
            this.options.runtime.writableFence(), row.operationId,
            'post-finality withdrawal inclusion block changed; manual recovery is required',
            canonical.verifiedSources,
          )
          result.recoveryRequired += 1
          const claim=await this.options.runtime.store.withdrawalClaimByOperationId(row.operationId).catch(() => null)
          emitHostedTrace({
            correlationId:claim ? `withdrawal:${claim.claimId}` : `withdrawal:${row.operationId}`,
            tenantId:claim?.tenantId ?? null,roomId:claim?.roomId ?? null,jobId:null,
            operationId:row.operationId,component:'withdrawal',event:'claim.post-finality-audit',outcome:'retracted',
          })
        }
      } catch {
        // Provider disagreement or outage is not evidence of a finalized reorg.
      }
    }
    return result
  }
}
