#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.js'
import { HostedRuntime } from './hosted-runtime.js'
import { Web3SignerL1TransactionSigner } from './l1-transaction-signer.js'
import { METRICS_CONTENT_TYPE, renderMetrics } from './metrics.js'
import { withdrawalWorkerMetricFamilies } from './metrics-worker.js'
import { WithdrawalClaimer } from './withdrawal-claimer.js'

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`withdrawal worker integer must be in [${minimum},${maximum}]`)
  }
  return parsed
}

function option(args: string[], name: string): string | null {
  const index = args.indexOf(name)
  if (index < 0) return null
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

async function clientCommand(command: 'proof' | 'claim', args: string[]): Promise<void> {
  const baseUrl = option(args, '--api')
  const tokenFile = option(args, '--token-file')
  const roomId = option(args, '--room')
  const epoch = option(args, '--epoch')
  const index = option(args, '--index')
  if (!baseUrl || !tokenFile || !roomId || !epoch || !index) {
    throw new Error(`${command} requires --api, --token-file, --room, --epoch, and --index`)
  }
  const token = (await readFile(resolve(tokenFile), 'utf8')).trim()
  if (token.length < 16) throw new Error('withdrawal API token file is empty or unsafe')
  const path = `/hosting/v1/withdrawals/${encodeURIComponent(roomId)}/${encodeURIComponent(epoch)}/${encodeURIComponent(index)}`
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}/${command === 'proof' ? 'proof' : 'claims'}`, {
    method: command === 'proof' ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(command === 'claim'
        ? { 'idempotency-key': option(args, '--idempotency-key') ?? `withdrawal-cli:${roomId}:${epoch}:${index}` }
        : {}),
    },
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`withdrawal API ${response.status}: ${body.slice(0, 500)}`)
  process.stdout.write(`${JSON.stringify(JSON.parse(body), null, 2)}\n`)
}

export async function runHostedWithdrawalWorker(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? 'run'
  if (command === '--help' || command === 'help') {
    process.stdout.write(`zkdeal-withdrawal\n\nCommands:\n  run\n  once\n  proof --api URL --token-file PATH --room ID --epoch ID --index ID\n  claim --api URL --token-file PATH --room ID --epoch ID --index ID [--idempotency-key KEY]\n`)
    return
  }
  if (command === 'proof' || command === 'claim') return clientCommand(command, argv)
  if (command !== 'run' && command !== 'once') throw new Error(`unknown withdrawal command ${command}`)

  const config = loadConfig()
  if (
    !config.withdrawalClaimerEnabled || !config.withdrawalSignerUrl
    || !config.withdrawalSignerAddress || !config.withdrawalSignerAuthToken
  ) throw new Error('withdrawal worker requires WITHDRAWAL_CLAIMER_ENABLED and its scoped signer configuration')
  const signer = new Web3SignerL1TransactionSigner({
    url: config.withdrawalSignerUrl,
    expectedAddress: config.withdrawalSignerAddress,
    authToken: config.withdrawalSignerAuthToken,
    previousAuthToken: config.withdrawalSignerPreviousAuthToken,
  })
  await signer.assertReady()
  const workerId = process.env.HOSTED_WORKER_ID?.trim() || `${config.coordinatorId}-withdrawal`
  const runtime = await HostedRuntime.create(config, { workerComponent: 'withdrawal', workerId })
  if (!runtime) throw new Error('hosted withdrawal runtime was not created')
  const claimer = new WithdrawalClaimer({
    runtime,
    chainId: config.chainId,
    roomManager: config.roomManager,
    signer,
    workerId,
    gasLimit: config.withdrawalClaimGasLimit,
    inclusionWindowBlocks: BigInt(config.withdrawalClaimInclusionWindowBlocks),
  })
  try {
    await claimer.assertReady()
    if (command === 'once') {
      process.stdout.write(`${JSON.stringify(await claimer.processOnce(), null, 2)}\n`)
      return
    }

    const intervalMs = boundedInteger(process.env.HOSTED_WORKER_INTERVAL_MS, 3_000, 250, 60_000)
    const port = boundedInteger(process.env.WORKER_PORT, 3003, 1, 65_535)
    const host = process.env.WORKER_HOST?.trim() || config.bindHost
    let running = false
    let stopped = false
    let lastSuccessAt: string | null = null
    let lastError: string | null = null
    let runs = 0
    const totals = { leased: 0, submitted: 0, confirmed: 0, alreadyClaimed: 0, errors: 0, recoveryRequired: 0 }
    let timer: NodeJS.Timeout | null = null
    const capabilities = {
      service: 'zkdeal-withdrawal-auto-claimer', schemaVersion: 1,
      entrypoint: 'autoClaimer', workerComponent: 'withdrawal',
      proofSource: 'finalized-indexed-root+content-addressed-complete-witness',
      localRootVerification: true, onchainProofPreflight: true,
      signer: 'scoped-remote-web3signer-eip1559', durableNonceJournal: true,
      exactSignedBytesRetry: true, permissionlessRecipientBoundClaims: true,
      command: ['./node_modules/.bin/tsx', 'src/hosted-withdrawal-worker.ts', 'run'],
      endpoints: { health: '/health', readiness: '/ready', metrics: '/metrics', capabilities: '/capabilities' },
    }
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json; charset=utf-8')
      if (request.url === '/health') response.end(JSON.stringify({ ok: true, running, lastSuccessAt, lastError }))
      else if (request.url === '/ready') {
        const fresh = lastSuccessAt !== null && Date.now() - Date.parse(lastSuccessAt) <= Math.max(30_000, intervalMs * 4)
        const ready = fresh && runtime.status().ready && !lastError
        response.statusCode = ready ? 200 : 503
        response.end(JSON.stringify({ ready, lastSuccessAt, runtime: runtime.status() }))
      } else if (request.url === '/capabilities') response.end(JSON.stringify(capabilities))
      else if (request.url === '/metrics') {
        response.setHeader('content-type', METRICS_CONTENT_TYPE)
        response.end(renderMetrics(withdrawalWorkerMetricFamilies({ totals, runs, lastSuccessAt })))
      } else {
        response.statusCode = 404
        response.end(JSON.stringify({ error: 'not found' }))
      }
    })
    const tick = async () => {
      if (stopped || running) return
      running = true
      try {
        const result = await claimer.processOnce()
        for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += result[key]
        runs += 1
        lastSuccessAt = new Date().toISOString()
        lastError = result.errors > 0 ? `${result.errors} withdrawal operations remain retryable` : null
      } catch (error) {
        lastError = error instanceof Error ? error.message.slice(0, 500) : 'unknown withdrawal worker failure'
      } finally {
        running = false
        if (!stopped) {
          timer = setTimeout(() => void tick(), intervalMs)
          timer.unref?.()
        }
      }
    }
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(port, host, () => { server.off('error', rejectListen); resolveListen() })
    })
    void tick()
    await new Promise<void>((resolveStop) => {
      const stop = () => {
        if (stopped) return
        stopped = true
        if (timer) clearTimeout(timer)
        server.close(() => resolveStop())
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
  } finally {
    await runtime.close()
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : ''
if (invoked === resolve(fileURLToPath(import.meta.url))) {
  void runHostedWithdrawalWorker().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
