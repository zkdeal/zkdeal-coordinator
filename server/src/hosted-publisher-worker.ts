import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeBlobKzg } from './blob-archive.js'
import { BlobPublisher } from './blob-publisher.js'
import { loadConfig } from './config.js'
import { HostedRuntime } from './hosted-runtime.js'
import { Web3SignerL1TransactionSigner } from './l1-transaction-signer.js'
import { ManagedL1Publisher } from './managed-l1-publisher.js'
import { ManagedBlobPublisher } from './managed-blob-publisher.js'
import { METRICS_CONTENT_TYPE, renderMetrics } from './metrics.js'
import { publisherWorkerMetricFamilies } from './metrics-worker.js'

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`publisher integer must be in [${minimum},${maximum}]`)
  }
  return parsed
}

export async function runHostedPublisherWorker(): Promise<never> {
  const config = loadConfig()
  const blobConfigured=Boolean(
    config.blobPublisherEnabled && config.l1SignerUrl && config.l1SignerAddress && config.l1SignerAuthToken,
  )
  const livenessConfigured=Boolean(
    config.nodeLivenessSignerUrl && config.nodeLivenessSignerAddress && config.nodeLivenessSignerAuthToken,
  )
  const roomConfigured=Boolean(
    config.roomOperationsSignerUrl && config.roomOperationsSignerAddress && config.roomOperationsSignerAuthToken,
  )
  const aggregateConfigured=Boolean(
    config.aggregateSignerUrl && config.aggregateSignerAddress && config.aggregateSignerAuthToken,
  )
  const poolSponsorConfigured=Boolean(config.poolSponsorSignerUrl && config.poolSponsorSignerAddress
    && config.poolSponsorSignerAuthToken)
  const poolFinalityConfigured=Boolean(config.poolFinalitySignerUrl && config.poolFinalitySignerAddress
    && config.poolFinalitySignerAuthToken)
  const poolBeneficiaryConfigured=Boolean(config.poolBeneficiarySignerUrl && config.poolBeneficiarySignerAddress
    && config.poolBeneficiarySignerAuthToken)
  if (!blobConfigured && !livenessConfigured && !roomConfigured && !aggregateConfigured && !poolSponsorConfigured
    && !poolFinalityConfigured && !poolBeneficiaryConfigured) {
    throw new Error('publisher worker requires at least one complete scoped publisher signer configuration')
  }
  // Prewarm before acquiring the delegated writer lease; KZG initialization
  // may briefly monopolize the event loop on a cold container.
  if (blobConfigured || aggregateConfigured) await initializeBlobKzg()
  const signer = blobConfigured ? new Web3SignerL1TransactionSigner({
    url: config.l1SignerUrl!,expectedAddress: config.l1SignerAddress!,
    authToken: config.l1SignerAuthToken!,previousAuthToken: config.l1SignerPreviousAuthToken,
  }) : null
  const livenessSigner=livenessConfigured ? new Web3SignerL1TransactionSigner({
    url:config.nodeLivenessSignerUrl!,expectedAddress:config.nodeLivenessSignerAddress!,
    authToken:config.nodeLivenessSignerAuthToken!,previousAuthToken:config.nodeLivenessSignerPreviousAuthToken,
  }) : null
  const roomSigner=roomConfigured ? new Web3SignerL1TransactionSigner({
    url:config.roomOperationsSignerUrl!,expectedAddress:config.roomOperationsSignerAddress!,
    authToken:config.roomOperationsSignerAuthToken!,previousAuthToken:config.roomOperationsSignerPreviousAuthToken,
  }) : null
  const aggregateSigner=aggregateConfigured ? new Web3SignerL1TransactionSigner({
    url:config.aggregateSignerUrl!,expectedAddress:config.aggregateSignerAddress!,
    authToken:config.aggregateSignerAuthToken!,previousAuthToken:config.aggregateSignerPreviousAuthToken,
  }) : null
  const poolSponsorSigner=poolSponsorConfigured ? new Web3SignerL1TransactionSigner({
    url:config.poolSponsorSignerUrl!,expectedAddress:config.poolSponsorSignerAddress!,
    authToken:config.poolSponsorSignerAuthToken!,previousAuthToken:config.poolSponsorSignerPreviousAuthToken,
  }) : null
  const poolFinalitySigner=poolFinalityConfigured ? new Web3SignerL1TransactionSigner({
    url:config.poolFinalitySignerUrl!,expectedAddress:config.poolFinalitySignerAddress!,
    authToken:config.poolFinalitySignerAuthToken!,previousAuthToken:config.poolFinalitySignerPreviousAuthToken,
  }) : null
  const poolBeneficiarySigner=poolBeneficiaryConfigured ? new Web3SignerL1TransactionSigner({
    url:config.poolBeneficiarySignerUrl!,expectedAddress:config.poolBeneficiarySignerAddress!,
    authToken:config.poolBeneficiarySignerAuthToken!,previousAuthToken:config.poolBeneficiarySignerPreviousAuthToken,
  }) : null
  await Promise.all([signer?.assertReady(),livenessSigner?.assertReady(),roomSigner?.assertReady(),aggregateSigner?.assertReady(),
    poolSponsorSigner?.assertReady(),poolFinalitySigner?.assertReady(),poolBeneficiarySigner?.assertReady()])
  const workerId = process.env.HOSTED_WORKER_ID?.trim() || `${config.coordinatorId}-publisher`
  const runtime = await HostedRuntime.create(config, { workerComponent: 'publisher', workerId })
  if (!runtime) throw new Error('hosted publisher runtime was not created')
  const publisher = signer ? new BlobPublisher(runtime, config.chainId, signer, config.beaconSidecarUrls) : null
  const livenessPublisher=livenessSigner ? new ManagedL1Publisher({
    runtime,chainId:config.chainId,signer:livenessSigner,operation:'node-heartbeat',
    bindingKind:'node-liveness',gasLimit:config.nodeLivenessGasLimit ?? 150_000n,
  }) : null
  const roomPublisher=roomSigner ? new ManagedL1Publisher({
    runtime,chainId:config.chainId,signer:roomSigner,operation:'room-batch',
    bindingKind:'room-submit',gasLimit:config.roomBatchGasLimit ?? 5_000_000n,
  }) : null
  const aggregatePublisher=aggregateSigner ? new ManagedBlobPublisher({
    runtime,chainId:config.chainId,signer:aggregateSigner,operation:'publish-aggregate',
    bindingKind:'room-aggregate',gasLimit:config.aggregateGasLimit ?? 12_000_000n,
    maxFeePerBlobGas:config.aggregateMaxFeePerBlobGas ?? 3_000_000_000n,
    beaconEndpoints:config.beaconSidecarUrls,
  }) : null
  const poolSponsorPublisher=poolSponsorSigner ? new ManagedL1Publisher({
    runtime,chainId:config.chainId,signer:poolSponsorSigner,operation:'pool-sponsor-mutation',
    bindingKind:'pool-sponsor',gasLimit:config.poolSponsorGasLimit ?? 5_000_000n,
  }) : null
  const poolFinalityPublisher=poolFinalitySigner ? new ManagedL1Publisher({
    runtime,chainId:config.chainId,signer:poolFinalitySigner,operation:'pool-finalized-checkpoint',
    bindingKind:'pool-finality-oracle',gasLimit:config.poolFinalityGasLimit ?? 500_000n,
  }) : null
  const poolBeneficiaryPublisher=poolBeneficiarySigner ? new ManagedL1Publisher({
    runtime,chainId:config.chainId,signer:poolBeneficiarySigner,operation:'pool-beneficiary-disposal',
    bindingKind:'pool-beneficiary',gasLimit:config.poolBeneficiaryGasLimit ?? 500_000n,
  }) : null
  await Promise.all([publisher?.assertReady(),livenessPublisher?.assertReady(),roomPublisher?.assertReady(),aggregatePublisher?.assertReady(),
    poolSponsorPublisher?.assertReady(),poolFinalityPublisher?.assertReady(),poolBeneficiaryPublisher?.assertReady()])

  const intervalMs = boundedInteger(process.env.HOSTED_WORKER_INTERVAL_MS, 3_000, 250, 60_000)
  const port = boundedInteger(process.env.WORKER_PORT, 3002, 1, 65_535)
  const host = process.env.WORKER_HOST?.trim() || config.bindHost
  let running = false
  let stopped = false
  let lastSuccessAt: string | null = null
  let lastError: string | null = null
  let completedRuns = 0
  let processedTransactions = 0
  let processingErrors = 0
  let recoveryRequired = 0
  let nextTimer: NodeJS.Timeout | null = null

  const capabilities = {
    service: 'zkdeal-hosted-publisher',
    schemaVersion: 1,
    transactionTypes: {
      blob:Boolean(publisher),nodeHeartbeat:Boolean(livenessPublisher),roomBatch:Boolean(roomPublisher),
      roomAggregate:Boolean(aggregatePublisher),
      poolSponsor:Boolean(poolSponsorPublisher),poolFinality:Boolean(poolFinalityPublisher),
      poolBeneficiary:Boolean(poolBeneficiaryPublisher),
    },
    signer: 'remote-web3signer',
    durableNonceJournal: true,
    archiveBeforeBroadcast: true,
    exactSignedBytesRetry: true,
    postFinalitySurprise: 'fail-closed-recovery-required',
    fencing: {
      mode: 'delegated-component-lease',
      boundToCoordinatorId: config.coordinatorId,
      workerId,
      promotionInvalidatesDelegation: true,
    },
    endpoints: { health: '/health', readiness: '/ready', metrics: '/metrics', capabilities: '/capabilities' },
    command: ['./node_modules/.bin/tsx', 'src/hosted-publisher-worker.ts'],
  }

  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8')
    if (request.url === '/health') {
      response.end(JSON.stringify({ ok: true, running, lastSuccessAt, lastError }))
      return
    }
    if (request.url === '/ready') {
      const fresh = lastSuccessAt !== null && Date.now() - Date.parse(lastSuccessAt) <= Math.max(30_000, intervalMs * 4)
      const ready = fresh && runtime.status().ready && !lastError
      response.statusCode = ready ? 200 : 503
      response.end(JSON.stringify({ ready, lastSuccessAt, runtime: runtime.status() }))
      return
    }
    if (request.url === '/capabilities') {
      response.end(JSON.stringify(capabilities))
      return
    }
    if (request.url === '/metrics') {
      response.setHeader('content-type', METRICS_CONTENT_TYPE)
      response.end(renderMetrics(publisherWorkerMetricFamilies({
        processedTransactions, processingErrors, recoveryRequired, completedRuns, lastSuccessAt,
      })))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: 'not found' }))
  })

  const tick = async () => {
    if (stopped || running) return
    running = true
    try {
      const results=await Promise.all([
        publisher?.processOnce(),livenessPublisher?.processOnce(),roomPublisher?.processOnce(),aggregatePublisher?.processOnce(),
        poolSponsorPublisher?.processOnce(),poolFinalityPublisher?.processOnce(),
        poolBeneficiaryPublisher?.processOnce(),
      ])
      const result=results.filter((item): item is NonNullable<typeof item> => Boolean(item))
        .reduce((total,item) => ({
          processed:total.processed+item.processed,errors:total.errors+item.errors,
          recoveryRequired:total.recoveryRequired+item.recoveryRequired,
        }),{ processed:0,errors:0,recoveryRequired:0 })
      processedTransactions += result.processed
      processingErrors += result.errors
      recoveryRequired += result.recoveryRequired
      completedRuns += 1
      lastSuccessAt = new Date().toISOString()
      lastError = result.errors > 0 ? `${result.errors} publisher operations remain retryable` : null
    } catch (error) {
      lastError = error instanceof Error ? error.message.slice(0, 500) : 'unknown publisher failure'
    } finally {
      running = false
      if (!stopped) {
        nextTimer = setTimeout(() => void tick(), intervalMs)
        nextTimer.unref?.()
      }
    }
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, host, () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  void tick()

  return await new Promise<never>((_resolve, reject) => {
    const stop = (signal: string) => {
      if (stopped) return
      stopped = true
      if (nextTimer) clearTimeout(nextTimer)
      server.close(() => {
        void runtime.close().finally(() => reject(new Error(`hosted publisher stopped by ${signal}`)))
      })
    }
    process.once('SIGINT', () => stop('SIGINT'))
    process.once('SIGTERM', () => stop('SIGTERM'))
  })
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  void runHostedPublisherWorker().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
