/**
 * @zkdeal/server - untrusted bootstrap coordinator for zkdeal execution rooms.
 *
 * Hosts static assets, the read-only room observation archive, a content
 * relay, and the admission surface. It does not hold member keys.
 * Public AMM/vault batch data is intentionally disclosed; card witnesses must
 * never enter this service. See README.md for the trust boundary.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createApp } from './app.js'
import { exposureViolation, isDevChain, isLoopbackHost, loadConfig } from './config.js'
import {
  createAdmissionCursorReader,
  createDepositEntryReader,
  createL1BlockNumberReader,
  createL1BlockHashReader,
  AdmissionIdStore,
  AdmissionService,
  localAdmissionSigner,
} from './admission.js'
import { Web3SignerAdmissionSigner } from './admission-signer.js'
import { ObserverStore } from './observer.js'
import { DemoController } from './demo-control.js'
import { DemoLiveRuntime } from './demo-live-runtime.js'
import { HostedRuntime } from './hosted-runtime.js'
import { initializeBlobKzg } from './blob-archive.js'
import { BlobPublisher } from './blob-publisher.js'
import { Web3SignerL1TransactionSigner } from './l1-transaction-signer.js'
import { WithdrawalProofService } from './withdrawal-service.js'
import { ManagedL1Publisher } from './managed-l1-publisher.js'
import { ManagedBlobPublisher } from './managed-blob-publisher.js'

async function main(): Promise<void> {
  const config = loadConfig()

  // Fail-closed exposure guard: dev-only surfaces (faucet, unsigned room
  // writes, default permissive CORS) may not be reachable off loopback unless
  // the chain id is a known throwaway devnet.
  const violation = exposureViolation(config)
  if (violation) {
    console.error(`[zkdeal] ${violation}`)
    process.exit(1)
  }

  const l1TransactionSigner = config.blobPublisherEnabled
    && config.l1SignerUrl
    && config.l1SignerAddress
    && config.l1SignerAuthToken
    ? new Web3SignerL1TransactionSigner({
        url: config.l1SignerUrl,
        expectedAddress: config.l1SignerAddress,
        authToken: config.l1SignerAuthToken,
        previousAuthToken: config.l1SignerPreviousAuthToken,
      })
    : null
  if (l1TransactionSigner) {
    // KZG and the remote signer must be ready before the coordinator acquires
    // its writer epoch; cold initialization must not create a lease gap.
    await initializeBlobKzg()
    await l1TransactionSigner.assertReady()
  }
  const nodeLivenessSigner = config.nodeLivenessSignerUrl
    && config.nodeLivenessSignerAddress && config.nodeLivenessSignerAuthToken
    ? new Web3SignerL1TransactionSigner({
        url:config.nodeLivenessSignerUrl,expectedAddress:config.nodeLivenessSignerAddress,
        authToken:config.nodeLivenessSignerAuthToken,
        previousAuthToken:config.nodeLivenessSignerPreviousAuthToken,
      }) : null
  const roomOperationsSigner = config.roomOperationsSignerUrl
    && config.roomOperationsSignerAddress && config.roomOperationsSignerAuthToken
    ? new Web3SignerL1TransactionSigner({
        url:config.roomOperationsSignerUrl,expectedAddress:config.roomOperationsSignerAddress,
        authToken:config.roomOperationsSignerAuthToken,
        previousAuthToken:config.roomOperationsSignerPreviousAuthToken,
      }) : null
  const aggregateSigner = config.aggregateSignerUrl
    && config.aggregateSignerAddress && config.aggregateSignerAuthToken
    ? new Web3SignerL1TransactionSigner({
        url:config.aggregateSignerUrl,expectedAddress:config.aggregateSignerAddress,
        authToken:config.aggregateSignerAuthToken,
        previousAuthToken:config.aggregateSignerPreviousAuthToken,
      }) : null
  if (aggregateSigner && !l1TransactionSigner) await initializeBlobKzg()
  const poolSponsorSigner=config.poolSponsorSignerUrl && config.poolSponsorSignerAddress
    && config.poolSponsorSignerAuthToken ? new Web3SignerL1TransactionSigner({
      url:config.poolSponsorSignerUrl,expectedAddress:config.poolSponsorSignerAddress,
      authToken:config.poolSponsorSignerAuthToken,previousAuthToken:config.poolSponsorSignerPreviousAuthToken,
    }) : null
  const poolFinalitySigner=config.poolFinalitySignerUrl && config.poolFinalitySignerAddress
    && config.poolFinalitySignerAuthToken ? new Web3SignerL1TransactionSigner({
      url:config.poolFinalitySignerUrl,expectedAddress:config.poolFinalitySignerAddress,
      authToken:config.poolFinalitySignerAuthToken,previousAuthToken:config.poolFinalitySignerPreviousAuthToken,
    }) : null
  const poolBeneficiarySigner=config.poolBeneficiarySignerUrl && config.poolBeneficiarySignerAddress
    && config.poolBeneficiarySignerAuthToken ? new Web3SignerL1TransactionSigner({
      url:config.poolBeneficiarySignerUrl,expectedAddress:config.poolBeneficiarySignerAddress,
      authToken:config.poolBeneficiarySignerAuthToken,previousAuthToken:config.poolBeneficiarySignerPreviousAuthToken,
    }) : null
  await Promise.all([
    nodeLivenessSigner?.assertReady(),roomOperationsSigner?.assertReady(),aggregateSigner?.assertReady(),poolSponsorSigner?.assertReady(),
    poolFinalitySigner?.assertReady(),poolBeneficiarySigner?.assertReady(),
  ])
  // Hosted dependencies may be initialized before the HTTP surface, but the
  // global writer epoch is deliberately deferred until Fastify has completed
  // all synchronous route/schema compilation. A cold start therefore cannot
  // consume a lease while the event loop is unable to renew it.
  const hosted = await HostedRuntime.create(config, { deferWriterLease: true })
  if (!hosted) mkdirSync(config.dataDir, { recursive: true })
  const publisher = hosted && l1TransactionSigner
    ? new BlobPublisher(hosted, config.chainId, l1TransactionSigner, config.beaconSidecarUrls)
    : null
  const nodeHeartbeatPublisher=hosted && nodeLivenessSigner
    ? new ManagedL1Publisher({
        runtime:hosted,chainId:config.chainId,signer:nodeLivenessSigner,
        operation:'node-heartbeat',bindingKind:'node-liveness',
        gasLimit:config.nodeLivenessGasLimit ?? 150_000n,
      }) : null
  const roomBatchPublisher=hosted && roomOperationsSigner
    ? new ManagedL1Publisher({
        runtime:hosted,chainId:config.chainId,signer:roomOperationsSigner,
        operation:'room-batch',bindingKind:'room-submit',
        gasLimit:config.roomBatchGasLimit ?? 5_000_000n,
      }) : null
  const roomAggregatePublisher=hosted && aggregateSigner
    ? new ManagedBlobPublisher({
        runtime:hosted,chainId:config.chainId,signer:aggregateSigner,
        operation:'publish-aggregate',bindingKind:'room-aggregate',
        gasLimit:config.aggregateGasLimit ?? 12_000_000n,
        maxFeePerBlobGas:config.aggregateMaxFeePerBlobGas ?? 3_000_000_000n,
        beaconEndpoints:config.beaconSidecarUrls,
      }) : null
  const poolSponsorPublisher=hosted && poolSponsorSigner ? new ManagedL1Publisher({
    runtime:hosted,chainId:config.chainId,signer:poolSponsorSigner,operation:'pool-sponsor-mutation',
    bindingKind:'pool-sponsor',gasLimit:config.poolSponsorGasLimit ?? 5_000_000n,
  }) : null
  const poolFinalityPublisher=hosted && poolFinalitySigner ? new ManagedL1Publisher({
    runtime:hosted,chainId:config.chainId,signer:poolFinalitySigner,operation:'pool-finalized-checkpoint',
    bindingKind:'pool-finality-oracle',gasLimit:config.poolFinalityGasLimit ?? 500_000n,
  }) : null
  const poolBeneficiaryPublisher=hosted && poolBeneficiarySigner ? new ManagedL1Publisher({
    runtime:hosted,chainId:config.chainId,signer:poolBeneficiarySigner,operation:'pool-beneficiary-disposal',
    bindingKind:'pool-beneficiary',gasLimit:config.poolBeneficiaryGasLimit ?? 500_000n,
  }) : null
  const withdrawals = hosted ? new WithdrawalProofService(hosted, config.chainId) : null

  const observer = hosted ? null : new ObserverStore(join(config.dataDir, 'room-observer'))
  const remoteAdmissionSigner = config.admissionSignerUrl
    && config.admissionSignerAddress
    && config.admissionSignerAuthToken
    ? new Web3SignerAdmissionSigner({
        url: config.admissionSignerUrl,
        expectedAddress: config.admissionSignerAddress,
        authToken: config.admissionSignerAuthToken,
        previousAuthToken: config.admissionSignerPreviousAuthToken,
      })
    : null
  if (remoteAdmissionSigner) await remoteAdmissionSigner.assertReady()
  const admissionSigner = remoteAdmissionSigner
    ?? (config.admissionKey ? localAdmissionSigner(config.admissionKey) : null)
  const admission =
    admissionSigner &&
    config.admissionToken &&
    config.roomManager !== '0x0000000000000000000000000000000000000000'
      ? new AdmissionService({
          chainId: config.chainId,
          roomManager: config.roomManager,
          signer: admissionSigner,
          observer: hosted
            ? { get: (roomId: string) => hosted.store.admissionRoomPolicy(config.chainId, roomId) }
            : observer!,
          operatorToken: config.admissionToken,
          latestL1Block: createL1BlockNumberReader(config.l1RpcUrls),
          canonicalL1BlockHash: createL1BlockHashReader(config.l1RpcUrls),
          // Chain-first signing: the signed deposit bytes and the admission-id
          // cap are re-read from the RoomManager, never from the archive.
          chainDepositEntry: createDepositEntryReader(config.l1RpcUrls, config.roomManager),
          chainAdmissionCursor: createAdmissionCursorReader(config.l1RpcUrls, config.roomManager),
          minimumAdmissionFee: config.minimumAdmissionFeeWei,
          minimumDeadlineLeadBlocks: BigInt(config.minimumDeadlineLeadBlocks),
          maximumArchiveLagBlocks: BigInt(config.maximumArchiveLagBlocks),
          // Operator-owned, deliberately NOT inside the public observer
          // archive an external indexer rewrites.
          ...(hosted
            ? {
                hostedWal: {
                  tenantId: async (roomId: string) => {
                    const tenantId = await hosted.store.roomTenant(config.chainId, roomId)
                    if (!tenantId) throw new Error('hosted room tenant is missing')
                    return tenantId
                  },
                  findByTransactionHash: (transactionHash: `0x${string}`) =>
                    hosted.store.admissionByTransactionHash(transactionHash),
                  highWater: (roomId: string) => hosted.store.admissionHighWater(roomId),
                  pendingCount: (roomId: string) => hosted.store.admissionPendingCount(roomId),
                  pendingDeposit: (roomId: string, depositInboxId: string) =>
                    hosted.store.admissionPendingDeposit(roomId, depositInboxId),
                  reserve: async (input) => {
                    // No slashable promise is persisted or signed while the
                    // two-RPC/canonical-index freshness gate is unhealthy.
                    await hosted.assertCriticalL1Ready()
                    return hosted.store.reserveAdmission(hosted.writableFence(), input)
                  },
                  commit: (roomId, admissionId, receipt) =>
                    hosted.store.commitAdmission(hosted.writableFence(), roomId, admissionId, receipt),
                  reserved: (limit?: number) => hosted.store.reservedAdmissions(limit),
                },
              }
            : {
                issuedIds: new AdmissionIdStore(
                  join(config.dataDir, 'admission-issued-ids.json'),
                ),
              }),
        })
      : null
  let demo: DemoController | null = null
  if (process.env.DEMO_ENABLED === '1') {
    if (!isLoopbackHost(config.bindHost) && !isDevChain(config.chainId)) {
      throw new Error('the local demo controller may only run on loopback or a throwaway dev chain')
    }
    const evidencePath =
      process.env.DEMO_EVIDENCE_PATH?.trim() ||
      join(config.dataDir, 'bootstrap', 'v5-kurtosis-evidence.json')
    const proverUrl = process.env.PROVER_URL?.trim()
    if (!proverUrl) throw new Error('PROVER_URL is required when the local demo is enabled')
    const runtime = new DemoLiveRuntime({
      l1RpcUrl: config.l1RpcUrl,
      l1RpcUrls: config.l1RpcUrls,
      proverUrl,
      contractsRoot: config.contractsRoot,
      evidencePath,
      explorerUrl: process.env.DEMO_EXPLORER_URL?.trim() || null,
      apiUrl: process.env.DEMO_API_URL?.trim() || null,
      // QUEUE_URL routes demo proof requests through the shared prove
      // queue; the submitter credential rides along from the same env the
      // queue plugin reads, so one deployment sets it once.
      queueUrl: config.queueUrl,
      queueSubmitToken: config.queueSubmitToken,
    })
    demo = new DemoController(config.dataDir, runtime)
    await demo.initialize()
  }
  const ctx = await createApp({
    config,observer,admission,demo,hosted,publisher,withdrawals,
    nodeHeartbeatPublisher,roomBatchPublisher,roomAggregatePublisher,poolSponsorPublisher,poolFinalityPublisher,
    poolBeneficiaryPublisher,
  })
  const { app, relay } = ctx

  // Complete schema/serializer compilation first, then acquire and immediately
  // validate the current writer epoch. No listener or recovery signer is
  // exposed while the process is still unfenced.
  await app.ready()
  if (hosted) {
    await hosted.activate()
    await Promise.all([
      publisher?.assertReady(),
      nodeHeartbeatPublisher?.assertReady(),
      roomBatchPublisher?.assertReady(),
      roomAggregatePublisher?.assertReady(),
      poolSponsorPublisher?.assertReady(),poolFinalityPublisher?.assertReady(),
      poolBeneficiaryPublisher?.assertReady(),
    ])
    if (admission) await admission.recoverHostedReservations()
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down')
    await ctx.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await app.listen({ port: config.port, host: config.bindHost })
  if (!isLoopbackHost(config.bindHost)) {
    app.log.warn(
      { host: config.bindHost, chainId: config.chainId },
      'coordinator is bound to a non-loopback interface',
    )
  }
  app.log.info(
    {
      port: config.port,
      host: config.bindHost,
      allowUnsignedWrites: config.allowUnsignedWrites,
      chainId: config.chainId,
      roomManager: config.roomManager,
      faucetEnabled: config.faucetEnabled,
      relayPeerId: relay?.node.peerId.toString() ?? null,
      relayMultiaddrs: relay?.multiaddrs ?? [],
      webRoot: config.webRoot,
      artifactsRoot: config.artifactsRoot,
    },
    'coordinator listening',
  )
}

main().catch((error) => {
  const reason = (error instanceof Error ? error.message : 'Startup validation failed.')
    .replace(/\b0x[0-9a-fA-F]{40,}\b/g, (value) => `${value.slice(0, 6)}...${value.slice(-4)}`)
    .replace(/(https?:\/\/[^/\s]+\/)[^\s]+/g, '$1[redacted]')
  console.error('Decision: Coordinator did not start')
  console.error(`Blocker: ${reason}`)
  console.error('Next action: Correct the environment or dependency and restart the coordinator.')
  console.error('Evidence saved: Check the configured private service log.')
  console.error('Resource budget: No room transition or transaction was submitted.')
  process.exit(1)
})
