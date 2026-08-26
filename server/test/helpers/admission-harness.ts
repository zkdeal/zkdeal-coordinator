/**
 * Shared fixtures for the admission suites (admission.test.ts and
 * admission-validation.test.ts). Every harness registers its app and
 * temporary archive here; each suite closes them with `afterAll`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { privateKeyToAccount } from 'viem/accounts'
import {
  registerAdmissionRoutes,
  AdmissionIdStore,
  AdmissionService,
  localAdmissionSigner,
  type ChainDepositEntry,
} from '../../src/admission.js'
import { type ObservedRoom, ObserverStore } from '../../src/observer.js'

export const h = (byte: string) => `0x${byte.repeat(64)}` as `0x${string}`
export const a = (byte: string) => `0x${byte.repeat(40)}` as `0x${string}`
export const admissionKey = `0x${'11'.repeat(32)}` as `0x${string}`
export const customerKey = `0x${'22'.repeat(32)}` as `0x${string}`
export const strangerKey = `0x${'33'.repeat(32)}` as `0x${string}`
export const operatorToken = 'operator-token-abcdefghij'
export const operator = { authorization: `Bearer ${operatorToken}` }
export const customer = privateKeyToAccount(customerKey)

/** Harnesses built by hand inside a test push their app + directory here too. */
export const contexts: Array<{ app: FastifyInstance; directory: string }> = []

/** Tear down every harness this suite created. */
export async function closeHarnesses(): Promise<void> {
  for (const { app, directory } of contexts.splice(0)) {
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

export function room(id: string, signer: `0x${string}`, overrides: Partial<ObservedRoom> = {}) {
  const base: ObservedRoom = {
    roomId: id,
    status: 'OPEN',
    authorizationMode: 'VALIDITY_ONLY',
    admissionSigner: signer,
    serviceBond: '1000000000000000000',
    minimumServiceBond: '100000000000000000',
    omissionPenalty: '100000000000000000',
    bondEpoch: '1',
    maximumAdmissionWindow: '50',
    minimumDepositConfirmations: '0',
    latestObservedL1Block: '60',
    coldTemplateId: h('1'),
    coldTemplateDataHash: h('a'),
    policyHash: h('2'),
    participantRoot: h('3'),
    participantEpoch: '1',
    participantCount: '1',
    participantCapacity: '128',
    supportedAssets: [a('0')],
    approvers: [],
    liabilities: [],
    imports: [],
    deposits: [],
    withdrawals: [],
    admissions: [],
    forcedTransactions: [],
    applications: [],
    batches: [],
  }
  return { ...base, ...overrides }
}

export interface HarnessOptions {
  chainId?: number
  latestL1Block?: () => Promise<bigint>
  minimumAdmissionFee?: bigint
  minimumDeadlineLeadBlocks?: bigint
  maximumArchiveLagBlocks?: bigint
  maximumPendingPerRoom?: number
  issuedIds?: AdmissionIdStore
  canonicalL1BlockHash?: (blockNumber: bigint) => Promise<`0x${string}` | null>
  chainDepositEntry?: (roomId: bigint, inboxId: bigint) => Promise<ChainDepositEntry | null>
  chainAdmissionCursor?: (roomId: bigint) => Promise<bigint>
}

export async function harness(rooms: ObservedRoom[] = [], options: HarnessOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'zkdeal-admission-'))
  const observer = new ObserverStore(directory)
  const app = Fastify({ logger: false })
  const service = new AdmissionService({
    chainId: options.chainId ?? 31337,
    roomManager: a('9'),
    signer: localAdmissionSigner(admissionKey),
    observer,
    operatorToken,
    latestL1Block: options.latestL1Block ?? (async () => 60n),
    canonicalL1BlockHash: options.canonicalL1BlockHash ?? (async () => h('d')),
    // The default chain readers mirror the archive: a chain that agrees with
    // what the indexer wrote. Suites that test the chain-first divergence
    // rules inject their own.
    chainDepositEntry:
      options.chainDepositEntry ??
      (async (roomId, inboxId) => {
        const current = observer.get(roomId.toString())
        const entry = current?.deposits.find((deposit) => BigInt(deposit.inboxId) === inboxId)
        if (!entry) return null
        return {
          depositor: entry.depositor,
          beneficiary: entry.beneficiary,
          asset: entry.asset,
          amount: BigInt(entry.amount),
          queuedAtBlock: BigInt(entry.queuedAtBlock),
          consumed: entry.status === 'CONSUMED',
          refunded: entry.status === 'REFUNDED',
        }
      }),
    chainAdmissionCursor:
      options.chainAdmissionCursor ??
      (async (roomId) => {
        const current = observer.get(roomId.toString())
        return BigInt(current?.batches.at(-1)?.admissionCursor ?? '0')
      }),
    minimumAdmissionFee: options.minimumAdmissionFee,
    minimumDeadlineLeadBlocks: options.minimumDeadlineLeadBlocks,
    maximumArchiveLagBlocks: options.maximumArchiveLagBlocks,
    maximumPendingPerRoom: options.maximumPendingPerRoom,
    issuedIds: options.issuedIds,
  })
  for (const entry of rooms) observer.put(entry)
  registerAdmissionRoutes(app, service)
  await app.ready()
  contexts.push({ app, directory })
  return { app, observer, service }
}

/**
 * `data` is optional so an L2 application transaction - a duel move carrying a
 * 256-byte inner Groth16 proof, for instance - can be admitted through the same
 * harness as a bare transfer.
 */
export function signed(
  nonce: number,
  key: `0x${string}` = customerKey,
  data?: `0x${string}`,
) {
  return privateKeyToAccount(key).signTransaction({
    chainId: 31337,
    type: 'eip1559',
    to: a('8'),
    nonce,
    gas: 50_000n,
    maxFeePerGas: 0n,
    maxPriorityFeePerGas: 0n,
    value: 0n,
    ...(data ? { data } : {}),
  })
}
