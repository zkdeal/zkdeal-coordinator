import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encodeFunctionResult, hexToBytes, keccak256, type Hex } from 'viem'
import type { HostedRuntime } from '../src/hosted-runtime.js'
import type {
  HostedL1Transaction,
  HostedWithdrawalClaim,
} from '../src/postgres-hosted-store.js'
import type { L1Eip1559TransactionSigner } from '../src/l1-transaction-signer.js'
import { WithdrawalClaimer } from '../src/withdrawal-claimer.js'
import {
  WITHDRAWAL_CLAIM_ABI,
  buildWithdrawalEpoch,
} from '../src/withdrawal-proofs.js'

const DOMAIN = `0x${'11'.repeat(32)}` as Hex
const ROOM_MANAGER = `0x${'22'.repeat(20)}` as `0x${string}`
const SIGNER = `0x${'33'.repeat(20)}` as `0x${string}`
const FINALIZED_HASH = `0x${'44'.repeat(32)}` as Hex
const INCLUDED_HASH = `0x${'55'.repeat(32)}` as Hex
const LATEST_HASH = `0x${'66'.repeat(32)}` as Hex

function claim(): HostedWithdrawalClaim {
  return {
    claimId: '1', chainId: 31337, roomId: '7', epoch: '3', withdrawalIndex: '0',
    tenantId: 'tenant-a', idempotencyKey: 'claim-request-a', operationId: null,
    transactionHash: null, status: 'PENDING', leaseOwner: 'withdrawal-worker-a',
    leaseExpiresAt: '2030-01-01T00:00:00.000Z', attempts: 1,
    nextAttemptAt: '2026-08-21T00:00:00.000Z', errorCode: null, errorMessage: null,
    createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z',
  }
}

function l1Row(input: {
  operationId: string
  requestHash: string
  requestObjectKey: string
  calldata: Hex
  inclusionDeadline: string
}): HostedL1Transaction {
  return {
    operationId: input.operationId, chainId: 31337, sender: SIGNER, nonce: '9',
    operation: 'claim-withdrawal', idempotencyKey: 'withdrawal-claim:1',
    requestHash: input.requestHash, requestObjectKey: input.requestObjectKey,
    destinationAddress: ROOM_MANAGER,
    calldata: input.calldata, inclusionDeadline: input.inclusionDeadline,
    transactionHash: null, rawTransactionObjectKey: null, bundleObjectKey: null,
    transportRequestHash: null, transportRequestObjectKey: null,
    status: 'PREPARED', attempts: 0, lastAttemptAt: null,
    nextAttemptAt: '2026-08-21T00:00:00.000Z', deadlineRisk: false,
    blockNumber: null, blockHash: null,gasUsed: null,effectiveGasPrice: null,
    blobGasUsed: null,blobGasPrice: null,receiptProviderIds: [],receiptObservedAt: null,
    receiptCanonical: false,finalizedBlock: null, finalizedHash: null,
    lastError: null, createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
  }
}

function booleanResult(functionName: 'verifyWithdrawalProof' | 'isWithdrawalClaimed', result: boolean): Hex {
  return encodeFunctionResult({ abi: WITHDRAWAL_CLAIM_ABI, functionName, result })
}

describe('WithdrawalClaimer durable boundaries', () => {
  it('links signed bytes before broadcast and resumes after restart without a second signer call', async () => {
    const epoch = buildWithdrawalEpoch({
      schemaVersion: 1, deploymentDomain: DOMAIN, roomId: '7', outboxEpoch: '3', capacity: 2,
      withdrawals: [{
        index: '0', approverEpoch: '2', recipient: `0x${'77'.repeat(20)}`,
        asset: `0x${'00'.repeat(20)}`, amount: '123',
      }],
    })
    const proof = epoch.records[0]!
    const objects = new Map<string, Uint8Array>()
    const eventOrder: string[] = []
    let currentClaim = claim()
    let row: HostedL1Transaction | null = null
    const readRow = (): HostedL1Transaction | null => row
    let leasePending = true
    let processSubmitted = false
    let signerCalls = 0
    let broadcastCalls = 0
    let callIndex = 0

    const objectStore = {
      async putContent(body: Uint8Array) {
        const sha256 = createHash('sha256').update(body).digest('hex')
        const key = `test/sha256/${sha256.slice(0, 2)}/${sha256}`
        objects.set(key, body)
        return { key, sha256, bytes: body.length, contentType: 'application/octet-stream' }
      },
      async get(key: string) { return objects.get(key) ?? null },
      async head() { return null },
      async delete() {},
    }
    const store = {
      async leaseWithdrawalClaims() {
        if (!leasePending) return []
        leasePending = false
        return [currentClaim]
      },
      async l1TransactionByIdempotencyKey() { return row },
      async withdrawalClaimProof() {
        return {
          claimId: '1', chainId: '31337', roomId: '7', epoch: '3', withdrawalIndex: proof.index,
          tenantId: 'tenant-a', approverEpoch: proof.approverEpoch,
          recipient: proof.recipient, asset: proof.asset, amount: proof.amount,
          withdrawalRoot: epoch.root, leafHash: proof.leafHash,
          positionalProof: proof.positionalProof, deploymentDomain: DOMAIN, capacity: 2,
          finalizedBlock: '90', finalizedHash: FINALIZED_HASH, status: 'PENDING',
          operationId: null, transactionHash: null,
        }
      },
      async confirmExternallyClaimedWithdrawal() { return false },
      async reserveL1Transaction(_fence: unknown, input: {
        operationId: string; requestHash: string; requestObjectKey: string
        calldata: Hex; inclusionDeadline: string
      }) {
        row = l1Row(input)
        return row
      },
      async attachSignedL1Transaction(_fence: unknown, _operationId: string, signed: {
        transactionHash: Hex; rawTransactionObjectKey: string
      }) {
        row = { ...row!, ...signed, status: 'SIGNED' }
        eventOrder.push('signed-durable')
        return row
      },
      async attachWithdrawalClaimOperation(
        _fence: unknown, _claimId: string, _workerId: string,
        operationId: string, transactionHash: Hex,
      ) {
        currentClaim = { ...currentClaim, operationId, transactionHash, status: 'SUBMITTED' }
        eventOrder.push('claim-linked')
        return currentClaim
      },
      async markL1TransactionBroadcast() {
        row = { ...row!, status: 'BROADCAST', attempts: row!.attempts + 1 }
        return row
      },
      async releaseWithdrawalClaimLease() {},
      async withdrawalClaimsForProcessing() { return processSubmitted ? [currentClaim] : [] },
      async l1Transaction() { return row },
      async markL1TransactionIncluded(
        _fence: unknown, _operationId: string, blockNumber: string, blockHash: Hex,
      ) {
        row = { ...row!, status: 'INCLUDED', blockNumber, blockHash }
        return row
      },
      async markL1TransactionFinalized(
        _fence: unknown, _operationId: string, finalizedBlock: string, finalizedHash: Hex,
      ) {
        row = { ...row!, status: 'FINALIZED', finalizedBlock, finalizedHash }
        return row
      },
      async setWithdrawalClaimStatus() {
        currentClaim = { ...currentClaim, status: 'CONFIRMED' }
        return currentClaim
      },
      async nextFinalizedL1AuditBatch() { return [] },
      async markL1TransactionRecoveryRequired() { throw new Error('unexpected recovery') },
      async recordL1TransactionAttemptError() { throw new Error('unexpected retry accounting') },
    }
    const l1 = {
      async agreedEip1559Fees() {
        return { blockNumber: '100', baseFeePerGas: '10', maxPriorityFeePerGas: '2', maxFeePerGas: '22' }
      },
      async agreedTransactionCount() { return '9' },
      async agreedCall() {
        const result = callIndex++ === 0
          ? booleanResult('verifyWithdrawalProof', true)
          : booleanResult('isWithdrawalClaimed', false)
        return { data: result, verifiedSources: ['rpc-a', 'rpc-b'] }
      },
      async agreedBlock(tag: string) {
        if (tag === 'latest') return { number: '100', hash: LATEST_HASH, parentHash: FINALIZED_HASH }
        if (tag === 'finalized') return { number: '101', hash: FINALIZED_HASH, parentHash: LATEST_HASH }
        if (tag === '0x64') return { number: '100', hash: INCLUDED_HASH, parentHash: LATEST_HASH }
        throw new Error(`unexpected block tag ${tag}`)
      },
      async broadcastRawTransaction() {
        broadcastCalls += 1
        eventOrder.push('broadcast')
        if (broadcastCalls === 1) throw new Error('simulated RPC outage after durable signing')
        return `0x${'88'.repeat(32)}`
      },
      async agreedReceiptOptional() {
        return {
          transaction: { status: '0x1', blockNumber: '0x64', blockHash: INCLUDED_HASH },
          verifiedSources: ['rpc-a', 'rpc-b'],
        }
      },
    }
    const signedBody = '0x02010203' as Hex
    const signer = {
      address: SIGNER,
      async assertReady() {},
      async signEip1559() {
        signerCalls += 1
        return { signedBody, transactionHash: keccak256(signedBody) }
      },
    } as unknown as L1Eip1559TransactionSigner
    const runtime = {
      store, objects: objectStore, l1,
      writableFence: () => ({
        leaseName: 'coordinator-writer', holderId: 'coordinator-a', token: 1n,
        expiresAt: '2030-01-01T00:00:00.000Z',
      }),
    } as unknown as HostedRuntime
    const create = () => new WithdrawalClaimer({
      runtime, chainId: 31337, roomManager: ROOM_MANAGER, signer,
      workerId: 'withdrawal-worker-a',
    })

    const crashed = await create().processOnce()
    expect(crashed.errors).toBe(1)
    expect(signerCalls).toBe(1)
    expect(readRow()?.status).toBe('SIGNED')
    expect(currentClaim.status).toBe('SUBMITTED')
    expect(eventOrder.slice(0, 3)).toEqual(['signed-durable', 'claim-linked', 'broadcast'])

    processSubmitted = true
    const restarted = await create().processOnce()
    expect(restarted.confirmed).toBe(1)
    expect(signerCalls).toBe(1)
    expect(broadcastCalls).toBe(2)
    expect(readRow()?.status).toBe('FINALIZED')
    expect(currentClaim.status).toBe('CONFIRMED')
    const finalizedRow = readRow()
    if (!finalizedRow) throw new Error('withdrawal operation disappeared')
    expect(objects.get(finalizedRow.rawTransactionObjectKey!)).toEqual(hexToBytes(signedBody))
  })

  it('does not spend a nonce when only a finalized canonical fact proves an external claim', async () => {
    const epoch = buildWithdrawalEpoch({
      schemaVersion: 1, deploymentDomain: DOMAIN, roomId: '7', outboxEpoch: '3', capacity: 1,
      withdrawals: [{
        index: '0', approverEpoch: '2', recipient: `0x${'77'.repeat(20)}`,
        asset: `0x${'00'.repeat(20)}`, amount: '123',
      }],
    })
    const proof = epoch.records[0]!
    let signerCalls = 0
    let canonicalFact = false
    const pending = claim()
    const store = {
      async leaseWithdrawalClaims() { return [pending] },
      async l1TransactionByIdempotencyKey() { return null },
      async withdrawalClaimProof() {
        return {
          roomId: '7', epoch: '3', withdrawalIndex: '0', approverEpoch: '2',
          recipient: proof.recipient, asset: proof.asset, amount: proof.amount,
          withdrawalRoot: epoch.root, positionalProof: proof.positionalProof,
          deploymentDomain: DOMAIN, finalizedBlock: '90', finalizedHash: FINALIZED_HASH,
        }
      },
      async confirmExternallyClaimedWithdrawal() { return canonicalFact },
      async releaseWithdrawalClaimLease() {},
      async withdrawalClaimsForProcessing() { return [] },
      async nextFinalizedL1AuditBatch() { return [] },
    }
    let callIndex = 0
    const runtime = {
      store,
      objects: { async putContent() { throw new Error('must not store a claim request') } },
      l1: {
        async agreedEip1559Fees() {
          return { blockNumber: '100', maxPriorityFeePerGas: '2', maxFeePerGas: '22' }
        },
        async agreedCall() {
          return {
            data: callIndex++ === 0
              ? booleanResult('verifyWithdrawalProof', true)
              : booleanResult('isWithdrawalClaimed', true),
            verifiedSources: ['rpc-a', 'rpc-b'],
          }
        },
        async agreedBlock() { return { number: '100', hash: LATEST_HASH, parentHash: FINALIZED_HASH } },
      },
      writableFence: () => ({
        leaseName: 'coordinator-writer', holderId: 'coordinator-a', token: 1n,
        expiresAt: '2030-01-01T00:00:00.000Z',
      }),
    } as unknown as HostedRuntime
    const signer = {
      address: SIGNER, async assertReady() {},
      async signEip1559() { signerCalls += 1; throw new Error('must not sign') },
    } as unknown as L1Eip1559TransactionSigner
    const claimer = new WithdrawalClaimer({
      runtime, chainId: 31337, roomManager: ROOM_MANAGER, signer,
      workerId: 'withdrawal-worker-a',
    })

    const awaitingIndexer = await claimer.processOnce()
    expect(awaitingIndexer).toMatchObject({ alreadyClaimed: 1, errors: 0 })
    expect(signerCalls).toBe(0)

    callIndex = 0
    canonicalFact = true
    const confirmed = await claimer.processOnce()
    expect(confirmed).toMatchObject({ alreadyClaimed: 1, errors: 0 })
    expect(signerCalls).toBe(0)
  })
})
