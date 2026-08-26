import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AdmissionService,
  localAdmissionSigner,
  type AdmissionServiceConfig,
  type AdmissionSigner,
} from '../src/admission.js'
import type { AdmissionWalRecord } from '../src/hosted-types.js'
import { ObserverStore } from '../src/observer.js'

const roots: string[] = []
const signer = localAdmissionSigner(`0x${'11'.repeat(32)}`)
const record: AdmissionWalRecord = {
  roomId: '7', admissionId: '1', tenantId: 'tenant-a',
  transactionHash: `0x${'01'.repeat(32)}`,
  rawSignedTransaction: '0x0102', sender: `0x${'aa'.repeat(20)}`,
  request: {
    depositInboxId: '0', depositContentHash: `0x${'00'.repeat(32)}`,
    deadlineBlock: '100', maximumBatchIndex: '3', bondEpoch: '1', admissionFee: '5',
    signerAddress: signer.address,
  },
  receipt: null, status: 'RESERVED', leaseOwner: null, leaseExpiresAt: null,
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function service(remoteSigner: AdmissionSigner, commits: object[]): AdmissionService {
  const root = mkdtempSync(join(tmpdir(), 'zkdeal-admission-recovery-'))
  roots.push(root)
  const hostedWal: NonNullable<AdmissionServiceConfig['hostedWal']> = {
    tenantId: async () => 'tenant-a',
    findByTransactionHash: async () => null,
    highWater: async () => 1n,
    pendingCount: async () => 1,
    pendingDeposit: async () => false,
    reserve: async () => record,
    reserved: async () => [record],
    commit: async (_roomId, _admissionId, receipt) => {
      commits.push(receipt)
      return {
        ...record,
        receipt: receipt as unknown as Record<string, unknown>,
        status: 'COMMITTED',
      }
    },
  }
  return new AdmissionService({
    chainId: 31337,
    roomManager: `0x${'99'.repeat(20)}`,
    signer: remoteSigner,
    observer: new ObserverStore(join(root, 'observer')),
    operatorToken: 'operator-token-00000001',
    latestL1Block: async () => 100n,
    hostedWal,
  })
}

describe('admission reservation recovery', () => {
  it('deterministically completes the exact reserved receipt after restart', async () => {
    const commits: object[] = []
    expect(await service(signer, commits).recoverHostedReservations()).toBe(1)
    expect(commits).toEqual([
      expect.objectContaining({
        roomId: '7', admissionId: '1', transactionHash: record.transactionHash,
        depositContentHash: record.request.depositContentHash,
        signature: expect.stringMatching(/^0x[0-9a-f]{130}$/),
      }),
    ])
  })

  it('leaves the durable reservation uncommitted when the signer is unavailable', async () => {
    const commits: object[] = []
    const unavailable: AdmissionSigner = {
      address: signer.address,
      signTypedData: async () => { throw new Error('remote signer unavailable') },
    }
    await expect(service(unavailable, commits).recoverHostedReservations()).rejects.toThrow('unavailable')
    expect(commits).toEqual([])
  })
})
