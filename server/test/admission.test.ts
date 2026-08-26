import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { zeroHash } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { afterAll, describe, expect, it } from 'vitest'
import { registerAdmissionRoutes, AdmissionService, localAdmissionSigner } from '../src/admission.js'
import { ObserverStore } from '../src/observer.js'
import {
  a,
  admissionKey,
  closeHarnesses,
  customer,
  harness,
  operator,
  operatorToken,
  room,
  signed,
} from './helpers/admission-harness.js'

afterAll(closeHarnesses)

describe('validity-only admission transport', () => {
  it('returns a signed sequential receipt and queues no customer consensus vote', async () => {
    const { app, observer, service } = await harness([room('7', privateKeyToAccount(admissionKey).address)])
    const rawSignedTransaction = await signed(0)
    const response = await app.inject({
      method: 'POST',
      url: '/rooms/7/transactions',
      headers: operator,
      payload: {
        rawSignedTransaction,
        depositInboxId: '0',
        deadlineBlock: '100',
        maximumBatchIndex: '2',
      },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({
      decision: 'LOCALLY_ADMITTED',
      receipt: { roomId: '7', admissionId: '1', deadlineBlock: '100' },
    })
    expect(response.json().receipt.signature).toMatch(/^0x[0-9a-f]{130}$/)
    expect(response.json().receipt.depositContentHash).toBe(zeroHash)
    expect(response.body).not.toContain(rawSignedTransaction)
    expect(service.takePending('7')).toHaveLength(1)
    expect(observer.get('7')?.admissions[0]?.status).toBe('PENDING')

    const duplicate = await app.inject({
      method: 'POST',
      url: '/rooms/7/transactions',
      headers: operator,
      payload: {
        rawSignedTransaction,
        depositInboxId: '0',
        deadlineBlock: '100',
        maximumBatchIndex: '2',
      },
    })
    expect(duplicate.statusCode).toBe(400)
    expect(duplicate.json().decision).toBe('NOT_ADMITTED')
    expect(duplicate.json().reason).toMatch(/already has an admission/)

    const observed = observer.get('7')!
    observer.put({ ...observed, serviceBond: observed.omissionPenalty })
    const uncovered = await app.inject({
      method: 'POST',
      url: '/rooms/7/transactions',
      headers: operator,
      payload: {
        rawSignedTransaction: await signed(1),
        depositInboxId: '0',
        deadlineBlock: '100',
        maximumBatchIndex: '2',
      },
    })
    expect(uncovered.statusCode).toBe(400)
    expect(uncovered.json().reason).toMatch(/cannot cover another admission/)
  })

  // C1: the route makes the operator key sign receipts that are slashable
  // against the room service bond. An anonymous caller must never reach it.
  it('refuses to sign a receipt for a caller with no operator credential', async () => {
    const { app, observer, service } = await harness([room('7', privateKeyToAccount(admissionKey).address)])
    const payload = {
      rawSignedTransaction: await signed(0),
      depositInboxId: '0',
      deadlineBlock: '100',
      maximumBatchIndex: '2',
    }

    const anonymous = await app.inject({
      method: 'POST',
      url: '/rooms/7/transactions',
      payload,
    })
    expect(anonymous.statusCode).toBe(401)
    expect(anonymous.json()).toMatchObject({ decision: 'NOT_ADMITTED' })
    expect(anonymous.json()).not.toHaveProperty('receipt')
    expect(anonymous.headers['www-authenticate']).toMatch(/zkdeal-admission/)

    const wrongToken = await app.inject({
      method: 'POST',
      url: '/rooms/7/transactions',
      headers: { authorization: `Bearer ${operatorToken}x` },
      payload,
    })
    expect(wrongToken.statusCode).toBe(401)

    // No bond was committed and no receipt was queued by either attempt.
    expect(observer.get('7')?.admissions).toHaveLength(0)
    expect(service.takePending('7')).toHaveLength(0)

    const drain = await app.inject({ method: 'POST', url: '/rooms/7/pending-transactions' })
    expect(drain.statusCode).toBe(401)
  })

  it('refuses to construct a service without an operator credential or an L1 head reader', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'zkdeal-admission-cfg-'))
    const observer = new ObserverStore(directory)
    try {
      expect(
        () =>
          new AdmissionService({
            chainId: 31337,
            roomManager: a('9'),
            signer: localAdmissionSigner(admissionKey),
            observer,
            operatorToken: 'short',
            latestL1Block: async () => 60n,
          }),
      ).toThrow(/at least 16 characters/)
      expect(
        () =>
          new AdmissionService({
            chainId: 31337,
            roomManager: a('9'),
            signer: localAdmissionSigner(admissionKey),
            observer,
            operatorToken,
            latestL1Block: undefined as unknown as () => Promise<bigint>,
          }),
      ).toThrow(/live L1 block reader/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  // H2: an admitted transaction that no consumer can read is guaranteed to be
  // omitted, so the queue is drainable on the operator credential.
  it('hands queued transactions to an authenticated operator exactly once', async () => {
    const { app } = await harness([room('7', privateKeyToAccount(admissionKey).address)])
    const rawSignedTransaction = await signed(0)
    const admitted = await app.inject({
      method: 'POST',
      url: '/rooms/7/transactions',
      headers: operator,
      payload: {
        rawSignedTransaction,
        depositInboxId: '0',
        deadlineBlock: '100',
        maximumBatchIndex: '2',
      },
    })
    expect(admitted.statusCode, admitted.body).toBe(200)

    const drained = await app.inject({
      method: 'POST',
      url: '/rooms/7/pending-transactions',
      headers: operator,
    })
    expect(drained.statusCode).toBe(200)
    expect(drained.json().transactions).toHaveLength(1)
    expect(drained.json().transactions[0].rawSignedTransaction).toBe(rawSignedTransaction)
    expect(drained.json().transactions[0].sender.toLowerCase()).toBe(
      customer.address.toLowerCase(),
    )

    const again = await app.inject({
      method: 'POST',
      url: '/rooms/7/pending-transactions',
      headers: operator,
    })
    expect(again.json().transactions).toHaveLength(0)
  })

  it('refuses to grow the operator queue past its bound', async () => {
    const { app } = await harness([room('7', privateKeyToAccount(admissionKey).address)], {
      maximumPendingPerRoom: 1,
    })
    const post = async (nonce: number) =>
      app.inject({
        method: 'POST',
        url: '/rooms/7/transactions',
        headers: operator,
        payload: {
          rawSignedTransaction: await signed(nonce),
          depositInboxId: '0',
          deadlineBlock: '100',
          maximumBatchIndex: '2',
        },
      })
    expect((await post(0)).statusCode).toBe(200)
    const saturated = await post(1)
    expect(saturated.statusCode).toBe(503)
    expect(saturated.json().reason).toMatch(/queue for this room is saturated/)
  })

  it('reports 503 rather than signing when no admission service is configured', async () => {
    const app = Fastify({ logger: false })
    registerAdmissionRoutes(app, null)
    await app.ready()
    const response = await app.inject({
      method: 'POST',
      url: '/rooms/7/transactions',
      headers: operator,
      payload: {},
    })
    expect(response.statusCode).toBe(503)
    expect(response.json().decision).toBe('ADMISSION_UNAVAILABLE')
    await app.close()
  })
})
