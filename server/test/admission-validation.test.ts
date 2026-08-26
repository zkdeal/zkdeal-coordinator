import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { encodeAbiParameters, keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { afterAll, describe, expect, it } from 'vitest'
import {
  registerAdmissionRoutes,
  AdmissionIdStore,
  AdmissionService,
  localAdmissionSigner,
} from '../src/admission.js'
import { type ObservedRoom, ObserverStore } from '../src/observer.js'
import type { AdmissionWalRecord } from '../src/hosted-types.js'
import {
  a,
  admissionKey,
  closeHarnesses,
  contexts,
  customer,
  h,
  harness,
  operator,
  operatorToken,
  room,
  signed,
  strangerKey,
} from './helpers/admission-harness.js'

afterAll(closeHarnesses)

describe('admission validation and receipt binding', () => {
  it('uses the async hosted projection even when a divergent local observer says open', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'zkdeal-hosted-admission-policy-'))
    const localObserver = new ObserverStore(join(directory, 'replica-local-observer'))
    const signer = privateKeyToAccount(admissionKey).address
    localObserver.put(room('7', signer, { status: 'OPEN' }))
    let canonicalPolicy = room('7', signer, { status: 'CLOSED' })
    let wal: AdmissionWalRecord | null = null
    const service = new AdmissionService({
      chainId: 31337,roomManager: a('9'),signer: localAdmissionSigner(admissionKey),
      observer: { get: async () => canonicalPolicy },operatorToken,
      latestL1Block: async () => 60n,chainAdmissionCursor: async () => 0n,
      hostedWal: {
        tenantId: async () => 'tenant-a',findByTransactionHash: async () => wal,
        highWater: async () => 0n,pendingCount: async () => 0,pendingDeposit: async () => false,
        reserve: async (input) => {
          wal = {
            ...input,receipt: null,status: 'RESERVED',leaseOwner: null,leaseExpiresAt: null,
            createdAt: new Date(0).toISOString(),updatedAt: new Date(0).toISOString(),
          }
          return wal
        },
        commit: async (_roomId, _admissionId, receipt) => {
          if (!wal) throw new Error('missing reservation')
          const committed: AdmissionWalRecord = {
            ...wal,receipt: receipt as unknown as Record<string, unknown>,status: 'COMMITTED',
          }
          wal = committed
          return committed
        },
        reserved: async () => [],
      },
    })
    const app = Fastify({ logger: false })
    registerAdmissionRoutes(app, service)
    await app.ready()
    contexts.push({ app,directory })
    const request = async (nonce: number) => app.inject({
      method: 'POST',url: '/rooms/7/transactions',headers: operator,
      payload: {
        rawSignedTransaction: await signed(nonce),depositInboxId: '0',
        deadlineBlock: '100',maximumBatchIndex: '2',
      },
    })
    expect((await request(0)).json().reason).toMatch(/room is not open/)
    expect(localObserver.get('7')?.status).toBe('OPEN')
    canonicalPolicy = room('7', signer, { status: 'OPEN' })
    expect((await request(1)).statusCode).toBe(200)
  })

  // H1: deposit ids are public on /rooms/:id/deposits, and a receipt naming
  // one lets its holder force-refund somebody else's escrowed deposit.
  it('binds depositInboxId to a pending deposit owned by the transaction sender', async () => {
    const deposits: ObservedRoom['deposits'] = [
      {
        inboxId: '1',
        depositor: customer.address,
        asset: a('0'),
        amount: '100',
        beneficiary: customer.address,
        queuedAtBlock: '50',
        queuedAtBlockHash: h('d'),
        status: 'PENDING',
        consumedBatch: null,
      },
      {
        inboxId: '2',
        depositor: privateKeyToAccount(strangerKey).address,
        asset: a('0'),
        amount: '100',
        beneficiary: privateKeyToAccount(strangerKey).address,
        queuedAtBlock: '50',
        queuedAtBlockHash: h('d'),
        status: 'PENDING',
        consumedBatch: null,
      },
      {
        inboxId: '3',
        depositor: customer.address,
        asset: a('0'),
        amount: '100',
        beneficiary: customer.address,
        queuedAtBlock: '50',
        queuedAtBlockHash: h('d'),
        status: 'CONSUMED',
        consumedBatch: '1',
      },
    ]
    const { app } = await harness([
      room('7', privateKeyToAccount(admissionKey).address, { deposits }),
    ])
    const post = async (nonce: number, depositInboxId: string) =>
      app.inject({
        method: 'POST',
        url: '/rooms/7/transactions',
        headers: operator,
        payload: {
          rawSignedTransaction: await signed(nonce),
          depositInboxId,
          deadlineBlock: '100',
          maximumBatchIndex: '2',
        },
      })

    const foreign = await post(0, '2')
    expect(foreign.statusCode).toBe(400)
    expect(foreign.json().reason).toMatch(/another beneficiary/)

    const consumed = await post(1, '3')
    expect(consumed.statusCode).toBe(400)
    expect(consumed.json().reason).toMatch(/pending deposit/)

    const unknown = await post(2, '9')
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json().reason).toMatch(/pending deposit/)

    const owned = await post(3, '1')
    expect(owned.statusCode, owned.body).toBe(200)
    expect(owned.json().receipt.depositInboxId).toBe('1')
    expect(owned.json().receipt.depositContentHash).toBe(
      keccak256(
        encodeAbiParameters(
          [
            { type: 'address' },
            { type: 'address' },
            { type: 'address' },
            { type: 'uint256' },
          ],
          [customer.address, customer.address, a('0'), 100n],
        ),
      ),
    )

    const reused = await post(4, '1')
    expect(reused.statusCode).toBe(400)
    expect(reused.json().reason).toMatch(/already reserved/)
  })

  // H3: a deadline the operator cannot physically meet yields a receipt that
  // is challengeable the moment it is issued.
  it('rejects a deadline that does not leave the minimum lead time', async () => {
    const { app } = await harness([room('7', privateKeyToAccount(admissionKey).address)])
    const tight = await app.inject({
      method: 'POST',
      url: '/rooms/7/transactions',
      headers: operator,
      payload: {
        rawSignedTransaction: await signed(0),
        depositInboxId: '0',
        deadlineBlock: '61',
        maximumBatchIndex: '2',
      },
    })
    expect(tight.statusCode).toBe(400)
    expect(tight.json().reason).toMatch(/minimum lead time/)

    const beyondWindow = await app.inject({
      method: 'POST',
      url: '/rooms/7/transactions',
      headers: operator,
      payload: {
        rawSignedTransaction: await signed(1),
        depositInboxId: '0',
        deadlineBlock: '111',
        maximumBatchIndex: '2',
      },
    })
    expect(beyondWindow.statusCode).toBe(400)
    expect(beyondWindow.json().reason).toMatch(/already exhausted/)
  })

  // M2: the archive's latestObservedL1Block is never refreshed by this
  // process, so windows are decided against a live chain read instead.
  it('fails closed when the L1 head is unreadable or the archive is stale', async () => {
    const unreadable = await harness([room('7', privateKeyToAccount(admissionKey).address)], {
      latestL1Block: async () => {
        throw new Error('rpc down')
      },
      canonicalL1BlockHash: async () => h('d'),
    })
    const offline = await unreadable.app.inject({
      method: 'POST',
      url: '/rooms/7/transactions',
      headers: operator,
      payload: {
        rawSignedTransaction: await signed(0),
        depositInboxId: '0',
        deadlineBlock: '100',
        maximumBatchIndex: '2',
      },
    })
    expect(offline.statusCode).toBe(503)
    expect(offline.json()).toMatchObject({ decision: 'ADMISSION_UNAVAILABLE' })
    expect(unreadable.observer.get('7')?.admissions).toHaveLength(0)

    // The archive trails the chain by more than the configured lag bound, so
    // its window view can no longer be trusted for a bonded signature.
    const stale = await harness([room('7', privateKeyToAccount(admissionKey).address)], {
      latestL1Block: async () => 200n,
    })
    const behind = await stale.app.inject({
      method: 'POST',
      url: '/rooms/7/transactions',
      headers: operator,
      payload: {
        rawSignedTransaction: await signed(0),
        depositInboxId: '0',
        deadlineBlock: '240',
        maximumBatchIndex: '2',
      },
    })
    expect(behind.statusCode).toBe(503)
    expect(behind.json().reason).toMatch(/not current with the L1 head/)
  })

  it('enforces the operator fee floor instead of the caller-supplied fee', async () => {
    const { app } = await harness([room('7', privateKeyToAccount(admissionKey).address)], {
      minimumAdmissionFee: 1_000n,
    })
    const free = await app.inject({
      method: 'POST',
      url: '/rooms/7/transactions',
      headers: operator,
      payload: {
        rawSignedTransaction: await signed(0),
        depositInboxId: '0',
        deadlineBlock: '100',
        maximumBatchIndex: '2',
      },
    })
    expect(free.statusCode).toBe(400)
    expect(free.json().reason).toMatch(/below the operator minimum/)

    const paid = await app.inject({
      method: 'POST',
      url: '/rooms/7/transactions',
      headers: operator,
      payload: {
        rawSignedTransaction: await signed(1),
        depositInboxId: '0',
        deadlineBlock: '100',
        maximumBatchIndex: '2',
        admissionFee: '1000',
      },
    })
    expect(paid.statusCode, paid.body).toBe(200)
    expect(paid.json().receipt.admissionFee).toBe('1000')
  })

  // M1: submitSerial reads the whole room, then awaits transaction recovery
  // and signing. An indexer write landing in between must not be clobbered.
  it('refuses to overwrite an observer write that landed during signing', async () => {
    let indexed = false
    const directory = mkdtempSync(join(tmpdir(), 'zkdeal-admission-cas-'))
    const observer = new ObserverStore(directory)
    const app = Fastify({ logger: false })
    const seed = room('7', privateKeyToAccount(admissionKey).address)
    observer.put(seed, null)
    const service = new AdmissionService({
      chainId: 31337,
      roomManager: a('9'),
      signer: localAdmissionSigner(admissionKey),
      observer,
      operatorToken,
      latestL1Block: async () => {
        if (!indexed) {
          indexed = true
          // Stands in for the batch coordinator indexing an accepted batch
          // while the coordinator is signing.
          const current = observer.get('7')!
          observer.put({ ...current, serviceBond: '900000000000000000' }, current.revision ?? null)
        }
        return 60n
      },
      chainAdmissionCursor: async () => 0n,
    })
    registerAdmissionRoutes(app, service)
    await app.ready()
    contexts.push({ app, directory })

    const conflicted = await app.inject({
      method: 'POST',
      url: '/rooms/7/transactions',
      headers: operator,
      payload: {
        rawSignedTransaction: await signed(0),
        depositInboxId: '0',
        deadlineBlock: '100',
        maximumBatchIndex: '2',
      },
    })
    expect(conflicted.statusCode).toBe(503)
    expect(conflicted.json().reason).toMatch(/changed while this admission was signed/)
    // The indexer's write survived and no receipt was queued for it.
    expect(observer.get('7')?.serviceBond).toBe('900000000000000000')
    expect(observer.get('7')?.admissions).toHaveLength(0)
    expect(service.takePending('7')).toHaveLength(0)

    // The retry sees the current document and succeeds.
    const retried = await app.inject({
      method: 'POST',
      url: '/rooms/7/transactions',
      headers: operator,
      payload: {
        rawSignedTransaction: await signed(0),
        depositInboxId: '0',
        deadlineBlock: '100',
        maximumBatchIndex: '2',
      },
    })
    expect(retried.statusCode, retried.body).toBe(200)
  })

  // L1: the on-chain rule is `admissionId == admissionCursor + i + 1`, so an id
  // derived from a prunable public archive can be re-issued after a rebuild -
  // one cursor advance then satisfies two different transaction hashes.
  it('derives the admission id from the chain cursor and never re-issues one', async () => {
    const signer = privateKeyToAccount(admissionKey).address
    const withCursor = room('7', signer, {
      // Batch 1 has already consumed admissions 1..4 on L1, but the archive's
      // `admissions` list was pruned to nothing.
      batches: [
        {
          batchIndex: '1',
          startL2Block: '1',
          endL2Block: '1',
          preStateRoot: h('3'),
          postStateRoot: h('4'),
          batchDataHash: h('5'),
          canonicalDataHash: h('b'),
          approverRoot: h('6'),
          approverEpoch: '1',
          activeCount: '1',
          inboxCursor: '0',
          admissionCursor: '4',
          forcedCursor: '0',
          importCursor: '0',
          outboxEpoch: '1',
          withdrawalRoot: null,
          close: false,
          acceptedL1Block: '55',
          acceptedL1Transaction: h('7'),
          acceptedAt: '2026-07-24T12:00:00.000Z',
          blocks: [],
        },
      ],
    })
    const issuedIds = new AdmissionIdStore()
    const { app, observer } = await harness([withCursor], { issuedIds })
    const first = await app.inject({
      method: 'POST',
      url: '/rooms/7/transactions',
      headers: operator,
      payload: {
        rawSignedTransaction: await signed(0),
        depositInboxId: '0',
        deadlineBlock: '100',
        maximumBatchIndex: '2',
      },
    })
    expect(first.statusCode, first.body).toBe(200)
    // Not '1': the chain-observed cursor is a hard lower bound.
    expect(first.json().receipt.admissionId).toBe('5')

    // The indexer rebuilds the archive from an older copy, dropping admission 5.
    const rebuilt = observer.get('7')!
    observer.put({ ...rebuilt, admissions: [] })
    const rolledBack = await app.inject({
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
    expect(rolledBack.statusCode).toBe(503)
    expect(rolledBack.json().reason).toMatch(/rolled back/)
    expect(observer.get('7')?.admissions).toHaveLength(0)
  })

  it('keeps the last issued admission id outside the public archive', () => {
    const directory = mkdtempSync(join(tmpdir(), 'zkdeal-admission-ids-'))
    const path = join(directory, 'nested', 'issued.json')
    try {
      const store = new AdmissionIdStore(path)
      expect(store.highWater('7')).toBe(0n)
      store.record('7', 5n)
      // Monotonic: a lower id never moves the record backwards.
      store.record('7', 3n)
      expect(new AdmissionIdStore(path).highWater('7')).toBe(5n)
      expect(new AdmissionIdStore(path).highWater('8')).toBe(0n)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  // L18: the reason field echoed whatever submitSerial threw, including Node
  // filesystem messages carrying the absolute archive path and the pid.
  it('never echoes an internal error message to the caller', async () => {
    const { app, observer } = await harness([room('7', privateKeyToAccount(admissionKey).address)])
    const archivePath = join(tmpdir(), 'zkdeal-should-not-appear')
    // Force a non-authored failure out of the durable write.
    const original = observer.put.bind(observer)
    observer.put = () => {
      throw new Error(`ENOSPC: no space left on device, write '${archivePath}.${process.pid}.tmp'`)
    }
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/rooms/7/transactions',
        headers: operator,
        payload: {
          rawSignedTransaction: await signed(0),
          depositInboxId: '0',
          deadlineBlock: '100',
          maximumBatchIndex: '2',
        },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().reason).toBe('Admission validation failed.')
      expect(response.body).not.toContain(archivePath)
      expect(response.body).not.toContain('ENOSPC')
      expect(response.body).not.toContain(String(process.pid))
    } finally {
      observer.put = original
    }

    // An authored validation reason is still returned verbatim - the redaction
    // must not blind the caller to what they got wrong.
    const rejected = await app.inject({
      method: 'POST',
      url: '/rooms/7/transactions',
      headers: operator,
      payload: {
        rawSignedTransaction: await signed(0),
        depositInboxId: 'not-a-number',
        deadlineBlock: '100',
        maximumBatchIndex: '2',
      },
    })
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json().reason).toMatch(/deposit inbox id must be a decimal unsigned integer/)
  })

  // C1-C3 are regression coverage for the fail-closed reorg controls: live
  // head agreement, canonical event-block binding, and content-addressed
  // deposits in the v6 admission receipt.
  it('refuses to sign when the L1 head regresses behind the archive (reorg symptom)', async () => {
    // The archive recorded L1 up to block 50, but a reorg rewound the head to
    // 10. admission.ts fails closed on latestObservedL1Block > chainHead (the
    // archive-AHEAD-of-head arm) - the mirror of the behind-arm tested above at
    // 'fails closed when the L1 head is unreadable or the archive is stale'.
    const signer = privateKeyToAccount(admissionKey).address
    const { app, observer } = await harness([room('7', signer, { latestObservedL1Block: '50' })], {
      latestL1Block: async () => 10n,
    })
    const regressed = await app.inject({
      method: 'POST',
      url: '/rooms/7/transactions',
      headers: operator,
      payload: {
        rawSignedTransaction: await signed(0),
        depositInboxId: '0',
        deadlineBlock: '100',
        maximumBatchIndex: '2',
      },
    })
    expect(regressed.statusCode).toBe(503)
    expect(regressed.json()).toMatchObject({ decision: 'ADMISSION_UNAVAILABLE' })
    expect(regressed.json().reason).toMatch(/not current with the L1 head/)
    expect(observer.get('7')?.admissions).toHaveLength(0)
  })

  // C2: a receipt is signed only while its content-addressed deposit is live.
  it('signs against a live deposit, then refuses a successor after the deposit is reorged away', async () => {
    const signer = privateKeyToAccount(admissionKey).address
    const deposits: ObservedRoom['deposits'] = [
      {
        inboxId: '1',
        depositor: customer.address,
        asset: a('0'),
        amount: '100',
        beneficiary: customer.address,
        queuedAtBlock: '50',
        queuedAtBlockHash: h('d'),
        status: 'PENDING',
        consumedBatch: null,
      },
    ]
    const { app, observer } = await harness([room('7', signer, { deposits })])
    const post = async (nonce: number) =>
      app.inject({
        method: 'POST',
        url: '/rooms/7/transactions',
        headers: operator,
        payload: {
          rawSignedTransaction: await signed(nonce),
          depositInboxId: '1',
          deadlineBlock: '100',
          maximumBatchIndex: '2',
        },
      })

    const admitted = await post(0)
    expect(admitted.statusCode, admitted.body).toBe(200)
    expect(admitted.json().receipt.depositInboxId).toBe('1')

    // The reorg dropped the deposit tx and the archive re-indexed without it.
    const reorged = observer.get('7')!
    observer.put({ ...reorged, deposits: [] })

    const successor = await post(1)
    expect(successor.statusCode).toBe(400)
    expect(successor.json().reason).toMatch(/does not name a pending deposit/)

    // The original receipt stays as an audit record, but its depositContentHash
    // cannot validate a missing or replacement inbox entry on v6 L1.
    expect(observer.get('7')?.admissions).toHaveLength(1)
  })

  it('fails closed when the indexed deposit block hash is no longer canonical', async () => {
    const signer = privateKeyToAccount(admissionKey).address
    const deposits: ObservedRoom['deposits'] = [
      {
        inboxId: '1',
        depositor: customer.address,
        asset: a('0'),
        amount: '100',
        beneficiary: customer.address,
        queuedAtBlock: '50',
        queuedAtBlockHash: h('d'),
        status: 'PENDING',
        consumedBatch: null,
      },
    ]
    const { app, observer } = await harness([room('7', signer, { deposits })], {
      canonicalL1BlockHash: async () => h('e'),
    })
    const response = await app.inject({
      method: 'POST',
      url: '/rooms/7/transactions',
      headers: operator,
      payload: {
        rawSignedTransaction: await signed(0),
        depositInboxId: '1',
        deadlineBlock: '100',
        maximumBatchIndex: '2',
      },
    })
    expect(response.statusCode).toBe(503)
    expect(response.json().reason).toMatch(/no longer in its canonical L1 block/)
    expect(observer.get('7')?.admissions).toHaveLength(0)
  })

  it('refuses a production room whose deposit confirmation policy is below 12', async () => {
    const signer = privateKeyToAccount(admissionKey).address
    const deposits: ObservedRoom['deposits'] = [
      {
        inboxId: '1',
        depositor: customer.address,
        asset: a('0'),
        amount: '100',
        beneficiary: customer.address,
        queuedAtBlock: '1',
        queuedAtBlockHash: h('d'),
        status: 'PENDING',
        consumedBatch: null,
      },
    ]
    const { app } = await harness(
      [room('7', signer, { deposits, minimumDepositConfirmations: '11' })],
      { chainId: 1 },
    )
    const response = await app.inject({
      method: 'POST',
      url: '/rooms/7/transactions',
      headers: operator,
      payload: {
        rawSignedTransaction: await signed(0),
        depositInboxId: '1',
        deadlineBlock: '100',
        maximumBatchIndex: '2',
      },
    })
    expect(response.statusCode).toBe(503)
    expect(response.json().reason).toMatch(/below the production floor/)
  })

  // C3: a reorg that reassigns an inbox id cannot silently change its owner.
  it('refuses a deposit whose post-reorg owner is a different beneficiary', async () => {
    const signer = privateKeyToAccount(admissionKey).address
    const stranger = privateKeyToAccount(strangerKey).address
    const deposits: ObservedRoom['deposits'] = [
      {
        inboxId: '1',
        depositor: customer.address,
        asset: a('0'),
        amount: '100',
        beneficiary: customer.address,
        queuedAtBlock: '50',
        queuedAtBlockHash: h('d'),
        status: 'PENDING',
        consumedBatch: null,
      },
    ]
    const { app, observer } = await harness([room('7', signer, { deposits })])
    const post = async (nonce: number) =>
      app.inject({
        method: 'POST',
        url: '/rooms/7/transactions',
        headers: operator,
        payload: {
          rawSignedTransaction: await signed(nonce),
          depositInboxId: '1',
          deadlineBlock: '100',
          maximumBatchIndex: '2',
        },
      })

    const admitted = await post(0)
    expect(admitted.statusCode, admitted.body).toBe(200)

    // The reorg re-assigned inbox id 1 to a different depositor: the L1 inbox
    // counter is a bare sequence, so a reordered reorg rebinds the id to whoever
    // now sits at that slot (forge A4).
    const reorged = observer.get('7')!
    observer.put({
      ...reorged,
      deposits: [
        {
          inboxId: '1',
          depositor: stranger,
          asset: a('0'),
          amount: '100',
          beneficiary: stranger,
          queuedAtBlock: '50',
          queuedAtBlockHash: h('d'),
          status: 'PENDING',
          consumedBatch: null,
        },
      ],
    })

    const successor = await post(1)
    expect(successor.statusCode).toBe(400)
    expect(successor.json().reason).toMatch(/belongs to another beneficiary/)
    // Web2 rejects the new beneficiary before signing; independently, the v6
    // depositContentHash binds depositor, beneficiary, asset and net amount for
    // the on-chain comparison.
  })

  // T1.4 chain-first signing: a compromised indexer that edits one deposit's
  // amount would otherwise make this key sign an unsatisfiable receipt - a
  // guaranteed omission and bond slash. Signed bytes come from the chain.
  it('fails closed when the archived deposit amount diverges from the chain entry', async () => {
    const signer = privateKeyToAccount(admissionKey).address
    const deposits: ObservedRoom['deposits'] = [
      {
        inboxId: '1',
        depositor: customer.address,
        asset: a('0'),
        // Tampered: the chain credited 100, the archive claims 1000.
        amount: '1000',
        beneficiary: customer.address,
        queuedAtBlock: '50',
        queuedAtBlockHash: h('d'),
        status: 'PENDING',
        consumedBatch: null,
      },
    ]
    const { app, observer, service } = await harness([room('7', signer, { deposits })], {
      chainDepositEntry: async () => ({
        depositor: customer.address,
        beneficiary: customer.address,
        asset: a('0'),
        amount: 100n,
        queuedAtBlock: 50n,
        consumed: false,
        refunded: false,
      }),
    })
    const response = await app.inject({
      method: 'POST',
      url: '/rooms/7/transactions',
      headers: operator,
      payload: {
        rawSignedTransaction: await signed(0),
        depositInboxId: '1',
        deadlineBlock: '100',
        maximumBatchIndex: '2',
      },
    })
    expect(response.statusCode).toBe(503)
    expect(response.json().reason).toMatch(/does not match the canonical L1 deposit entry/)
    // Nothing was signed or queued for the poisoned row.
    expect(observer.get('7')?.admissions).toHaveLength(0)
    expect(service.takePending('7')).toHaveLength(0)
  })

  // T1.4 chain-first signing: an inflated archive cursor would both slash (ids
  // the contract can never accept) and permanently wedge admission via the
  // never-lower issued-id high-water, so the chain cursor caps the derived id.
  it('refuses an admission id beyond the chain cursor pending bound', async () => {
    const signer = privateKeyToAccount(admissionKey).address
    const inflated = room('7', signer, {
      // The archive proposes id 301 while the chain cursor still sits at 0:
      // 301 > 0 + 256, so no queue drain can ever deliver it.
      admissions: [
        {
          admissionId: '300',
          transactionHash: h('e'),
          depositInboxId: '0',
          depositContentHash: h('0'),
          deadlineBlock: '80',
          maximumBatchIndex: '2',
          status: 'SUCCEEDED',
          l2BlockNumber: '1',
          transactionIndex: 0,
        },
      ],
    })
    const { app, observer } = await harness([inflated], {
      chainAdmissionCursor: async () => 0n,
    })
    const response = await app.inject({
      method: 'POST',
      url: '/rooms/7/transactions',
      headers: operator,
      payload: {
        rawSignedTransaction: await signed(0),
        depositInboxId: '0',
        deadlineBlock: '100',
        maximumBatchIndex: '2',
      },
    })
    expect(response.statusCode).toBe(503)
    expect(response.json().reason).toMatch(/beyond the chain admission cursor/)
    expect(observer.get('7')?.admissions).toHaveLength(1)
  })
})
