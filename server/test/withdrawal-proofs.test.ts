import { describe, expect, it } from 'vitest'
import { decodeFunctionData } from 'viem'
import {
  WITHDRAWAL_CLAIM_ABI,
  ZERO_BYTES32,
  buildWithdrawalEpoch,
  encodeWithdrawalClaim,
  verifyWithdrawalProof,
  withdrawalLeaf,
} from '../src/withdrawal-proofs.js'

const DOMAIN = `0x${'11'.repeat(32)}` as const
const RECIPIENT_A = '0x0000000000000000000000000000000000001234' as const
const RECIPIENT_B = '0x000000000000000000000000000000000000beef' as const
const ASSET = '0x0000000000000000000000000000000000000000' as const

describe('withdrawal positional proofs', () => {
  it('matches the Solidity two-leaf construction and emits claim calldata', () => {
    const first = {
      index: '0', approverEpoch: '1', recipient: RECIPIENT_A,
      asset: ASSET, amount: '1000000000000000000',
    }
    const second = {
      index: '1', approverEpoch: '1', recipient: RECIPIENT_B,
      asset: ASSET, amount: '2000000000000000000',
    }
    const epoch = buildWithdrawalEpoch({
      schemaVersion: 1,
      deploymentDomain: DOMAIN,
      roomId: '1',
      outboxEpoch: '1',
      capacity: 2,
      withdrawals: [first, second],
    })
    expect(epoch.records[0]!.positionalProof).toEqual([epoch.records[1]!.leafHash])
    expect(epoch.records[1]!.positionalProof).toEqual([epoch.records[0]!.leafHash])
    expect(epoch.records[0]!.leafHash).toBe(withdrawalLeaf(DOMAIN, '1', '1', first))
    expect(verifyWithdrawalProof(
      epoch.root, epoch.records[0]!.leafHash, '0', epoch.records[0]!.positionalProof,
    )).toBe(true)
    expect(verifyWithdrawalProof(
      epoch.root, epoch.records[0]!.leafHash, '0', [ZERO_BYTES32],
    )).toBe(false)

    const decoded = decodeFunctionData({
      abi: WITHDRAWAL_CLAIM_ABI,
      data: encodeWithdrawalClaim({
        roomId: '1', outboxEpoch: '1', withdrawal: first,
        proof: epoch.records[0]!.positionalProof,
      }),
    })
    expect(decoded.functionName).toBe('claimWithdrawal')
    expect(decoded.args?.[0]).toBe(1n)
    expect(decoded.args?.[1]).toBe(1n)
    expect((decoded.args?.[2] as { amount: bigint }).amount).toBe(1_000_000_000_000_000_000n)
  })

  it('supports sparse trees and rejects ambiguous or unsafe witnesses', () => {
    const epoch = buildWithdrawalEpoch({
      schemaVersion: 1,
      deploymentDomain: DOMAIN,
      roomId: '9',
      outboxEpoch: '6',
      capacity: 8,
      withdrawals: [{
        index: '6', approverEpoch: '4', recipient: RECIPIENT_A,
        asset: ASSET, amount: '7',
      }],
    })
    expect(epoch.records[0]!.positionalProof).toHaveLength(3)
    expect(verifyWithdrawalProof(
      epoch.root, epoch.records[0]!.leafHash, '6', epoch.records[0]!.positionalProof,
    )).toBe(true)

    expect(() => buildWithdrawalEpoch({
      schemaVersion: 1, deploymentDomain: DOMAIN, roomId: '9', outboxEpoch: '6',
      capacity: 3, withdrawals: [],
    })).toThrow('power of two')
    expect(() => buildWithdrawalEpoch({
      schemaVersion: 1, deploymentDomain: DOMAIN, roomId: '9', outboxEpoch: '6',
      capacity: 8,
      withdrawals: [
        { index: '2', approverEpoch: '1', recipient: RECIPIENT_A, asset: ASSET, amount: '1' },
        { index: '2', approverEpoch: '1', recipient: RECIPIENT_B, asset: ASSET, amount: '2' },
      ],
    })).toThrow('strictly ordered')
    expect(() => buildWithdrawalEpoch({
      schemaVersion: 1, deploymentDomain: DOMAIN, roomId: '9', outboxEpoch: '6',
      capacity: 8,
      withdrawals: [{ index: '0', approverEpoch: '1', recipient: ASSET, asset: ASSET, amount: '1' }],
    })).toThrow('recipient cannot be zero')
  })

  it('uses the protocol zero root for an empty withdrawal epoch', () => {
    expect(buildWithdrawalEpoch({
      schemaVersion: 1, deploymentDomain: DOMAIN, roomId: '1', outboxEpoch: '2',
      capacity: 32_768, withdrawals: [],
    }).root).toBe(ZERO_BYTES32)
  })
})
