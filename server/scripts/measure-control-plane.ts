import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { privateKeyToAccount } from 'viem/accounts'
import {
  registerAdmissionRoutes,
  AdmissionService,
} from '../src/admission.js'
import {
  registerObserverRoutes,
  type ObservedRoom,
  ObserverStore,
} from '../src/observer.js'

const sampleCount = 100
/** server/scripts → server → repo root. Resolved from the module, not from
 * `process.cwd()`, which wrote the evidence file somewhere unintended whenever
 * the script was run from outside `server/`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const outputPath = resolve(
  process.env.ZKDEAL_CONTROL_PLANE_RESULT ??
    join(REPO_ROOT, 'experiments', 'v5-participant-capacity-20260724', 'control-plane.json'),
)
const temporary = await mkdtemp(join(tmpdir(), 'zkdeal-control-plane-'))
const observer = new ObserverStore(temporary)
const app = Fastify({ logger: false })
const admissionAccount = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const customerAccount = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const address = (byte: string) => `0x${byte.repeat(40)}` as `0x${string}`
const operatorToken = 'measurement-operator-token'
const operatorAuthorization = { authorization: `Bearer ${operatorToken}` }
const hash = (byte: string) => `0x${byte.repeat(64)}` as `0x${string}`

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * quantile) - 1]!
}

try {
  const room: ObservedRoom = {
    roomId: '7',
    status: 'OPEN',
    authorizationMode: 'VALIDITY_ONLY',
    admissionSigner: admissionAccount.address,
    serviceBond: '1000000000000000000000',
    minimumServiceBond: '100000000000000000',
    omissionPenalty: '100000000000000000',
    bondEpoch: '1',
    maximumAdmissionWindow: '1000',
    minimumDepositConfirmations: '0',
    latestObservedL1Block: '100',
    coldTemplateId: hash('1'),
    coldTemplateDataHash: hash('2'),
    policyHash: hash('3'),
    participantRoot: hash('4'),
    participantEpoch: '1',
    participantCount: '32768',
    participantCapacity: '32768',
    supportedAssets: [address('5')],
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
  observer.put(room)
  const service = new AdmissionService({
    chainId: 31337,
    roomManager: address('9'),
    signer: admissionAccount,
    observer,
    operatorToken,
    // Deterministic head: this measurement bounds control-plane overhead, not
    // L1 round-trip time. Same for the chain-first cursor read.
    latestL1Block: async () => 100n,
    chainAdmissionCursor: async () => 0n,
  })
  registerObserverRoutes(app, observer)
  registerAdmissionRoutes(app, service)
  await app.ready()

  const latenciesMs: number[] = []
  let requestBytes = 0
  let receiptBytes = 0
  for (let nonce = 0; nonce < sampleCount; nonce += 1) {
    const rawSignedTransaction = await customerAccount.signTransaction({
      chainId: 31337,
      type: 'eip1559',
      to: address('8'),
      nonce,
      gas: 50_000n,
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
      value: 0n,
    })
    const payload = {
      rawSignedTransaction,
      depositInboxId: '0',
      deadlineBlock: '1000',
      maximumBatchIndex: '2',
    }
    const started = performance.now()
    const response = await app.inject({
      method: 'POST',
      url: '/rooms/7/transactions',
      headers: operatorAuthorization,
      payload,
    })
    latenciesMs.push(performance.now() - started)
    if (response.statusCode !== 200) {
      throw new Error('a representative admission was rejected')
    }
    requestBytes = Buffer.byteLength(JSON.stringify(payload))
    receiptBytes = Buffer.byteLength(response.body)
  }

  const roomResponse = await app.inject({ method: 'GET', url: '/rooms/7' })
  const admissionResponse = await app.inject({
    method: 'GET',
    url: '/rooms/7/admissions?limit=100',
  })
  if (roomResponse.statusCode !== 200 || admissionResponse.statusCode !== 200) {
    throw new Error('a representative observer endpoint was unavailable')
  }

  const result = {
    format: 'zkdeal/v5-control-plane-measurement',
    sampleCount,
    admission: {
      p50Milliseconds: percentile(latenciesMs, 0.5),
      p95Milliseconds: percentile(latenciesMs, 0.95),
      maximumMilliseconds: Math.max(...latenciesMs),
      signedRequestBytes: requestBytes,
      signedReceiptResponseBytes: receiptBytes,
    },
    observer: {
      roomSummaryBytes: Buffer.byteLength(roomResponse.body),
      oneHundredAdmissionPageBytes: Buffer.byteLength(admissionResponse.body),
    },
    boundary:
      'In-process Fastify request, transaction recovery, receipt signing, durable observer write, and response serialization on the local workstation.',
  }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')

  console.log('Decision: Validity-only admission control-plane overhead is measured')
  console.log(
    `Evidence: ${sampleCount} signed admissions completed; p95 was ${result.admission.p95Milliseconds.toFixed(2)} ms.`,
  )
  console.log(
    `Blocker: This local measurement excludes network latency and proof generation.`,
  )
  console.log('Next action: Compare admission latency with the final proof and L1 checkpoint evidence.')
  console.log(`Evidence saved: ${outputPath}`)
  console.log('Resource budget: Local CPU and disk only; no GPU or chain transaction.')
} catch (error) {
  // A bare `catch {}` left the operator with canned lines and no diagnostic.
  // Redacted the way index.ts redacts startup failures.
  const reason = (error instanceof Error ? error.message : 'The measurement failed.')
    .replace(/\b0x[0-9a-fA-F]{40,}\b/g, (value) => `${value.slice(0, 6)}...${value.slice(-4)}`)
    .replace(/(https?:\/\/[^/\s]+\/)[^\s]+/g, '$1[redacted]')
  console.error('Decision: Admission control-plane overhead was not measured')
  console.error(`Blocker: The representative admission or observer flow failed: ${reason}`)
  console.error('Next action: Repair the local control-plane flow and rerun this bounded measurement.')
  console.error(`Evidence saved: ${outputPath}`)
  console.error('Resource budget: No GPU or public-chain transaction.')
  process.exitCode = 1
} finally {
  await app.close()
  await rm(temporary, { recursive: true, force: true })
}
