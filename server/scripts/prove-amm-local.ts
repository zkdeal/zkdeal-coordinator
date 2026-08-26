/**
 * Direct local-GPU evidence harness for the commit-reveal AMM preset.
 *
 * This intentionally bypasses Kurtosis, the coordinator and L1: it builds the
 * exact room request the coordinator sends, asks the configured production
 * prover to prepare/prove/verify it, and writes a compact provenance record.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { resolve } from 'node:path'
import type { Hex } from 'viem'
import { ammPreset } from '../src/amm-room.js'
import { baseSpec } from '../src/demo-runtime-spec.js'
import type { DemoTemplate } from '../src/demo-types.js'
import { validateTemplateRequest } from '../src/demo-validation.js'

const root = resolve(import.meta.dirname, '..', '..')
const proverUrl = process.env.ZKDEAL_LOCAL_PROVER_URL ?? 'http://127.0.0.1:18080'
const output = resolve(
  process.env.ZKDEAL_AMM_PROOF_OUTPUT
    ?? resolve(root, 'outputs', 'proofs', 'zkdeal-amm-mev-local-3080.json'),
)
const contractAddress = '0x000000000000000000000000000000000000a440' as Hex
const deploymentDomain = `0x${'11'.repeat(32)}` as Hex

interface FoundryArtifact {
  deployedBytecode?: { object?: Hex } | Hex
}

interface PreparedResponse {
  contractConfig: Record<string, unknown>
  measurement: Record<string, unknown>
  roomRequest: Record<string, unknown>
}

interface ProofResponse {
  proofMode?: string
  journal?: string
  journalHash?: string
  receiptB64?: string
  ethereumSealB64?: string
  [key: string]: unknown
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const payload = body === undefined ? null : JSON.stringify(body)
  const response = await new Promise<{ status: number; text: string }>((resolveResponse, reject) => {
    const request = httpRequest(`${proverUrl}${path}`, {
      method: payload === null ? 'GET' : 'POST',
      headers:
        payload === null
          ? undefined
          : {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            },
    }, (incoming) => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
      incoming.on('end', () => {
        resolveResponse({
          status: incoming.statusCode ?? 0,
          text: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    // Node's fetch/Undici has a five-minute response-header timeout even when
    // AbortSignal allows longer. A production proof on an 8 GB RTX 3080 can
    // legitimately exceed it, so this direct local harness owns one explicit
    // 45-minute socket bound instead.
    request.setTimeout(45 * 60_000, () => request.destroy(new Error(`${path} timed out`)))
    request.on('error', reject)
    if (payload !== null) request.write(payload)
    request.end()
  })
  const text = response.text
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${path} returned HTTP ${response.status} with non-JSON body: ${text.slice(0, 500)}`)
  }
  if (response.status < 200 || response.status >= 300) {
    const reason = (parsed as { reason?: unknown }).reason
    throw new Error(`${path} returned HTTP ${response.status}: ${String(reason ?? text.slice(0, 500))}`)
  }
  return parsed as T
}

const artifact = JSON.parse(
  await readFile(
    resolve(root, '..', 'web3-protocol', 'contracts', 'out', 'CommitRevealAMM.sol', 'CommitRevealAMM.json'),
    'utf8',
  ),
) as FoundryArtifact
const deployed = artifact.deployedBytecode
const runtimeCode = (typeof deployed === 'string' ? deployed : deployed?.object) ?? null
if (!runtimeCode || runtimeCode === '0x') throw new Error('CommitRevealAMM runtime artifact is absent')

const validated = validateTemplateRequest({ name: 'Local RTX 3080 AMM proof', presetId: 'amm' })
const template: DemoTemplate = {
  ...validated,
  id: 'tpl-amm-local-3080',
  phase: 'ROOM_READY',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  runtimeCode,
}
const spec = baseSpec(
  template,
  44,
  10_000,
  deploymentDomain,
  undefined,
  contractAddress,
)
const preset = ammPreset()
const startedAt = new Date().toISOString()
const started = performance.now()
const capabilities = await request<Record<string, unknown>>('/v5/capabilities')
const prepared = await request<PreparedResponse>('/v5/rooms/prepare', spec)
const preparedAtMs = performance.now() - started
const proof = await request<ProofResponse>('/v5/rooms/prove', prepared.roomRequest)
const provedAtMs = performance.now() - started
if (
  proof.proofMode !== 'groth16'
  || !proof.journal
  || !proof.receiptB64
  || !proof.ethereumSealB64
) {
  throw new Error('the prover returned no complete Groth16 room proof')
}
const verification = await request<Record<string, unknown>>('/v5/rooms/verify', {
  journal: proof.journal,
  journalHash: proof.journalHash,
  receiptB64: proof.receiptB64,
})
const verifiedAtMs = performance.now() - started

const evidence = {
  format: 'zkdeal/amm-mev-local-gpu-evidence/v1',
  startedAt,
  finishedAt: new Date().toISOString(),
  proverUrl,
  gpu: {
    name: capabilities.gpuName,
    uuid: capabilities.gpuUuid,
    cuda: capabilities.cuda,
    cudaVersion: capabilities.cudaVersion,
    cpuFallback: capabilities.cpuFallback,
  },
  program: {
    programId: capabilities.programId,
    risc0Version: capabilities.risc0Version,
    proofMode: proof.proofMode,
  },
  workload: {
    presetId: preset.id,
    workload: preset.workload,
    transactions: preset.actions.length,
    block1Transactions: preset.actions.filter((action) => action.recommendedBlock === 1).length,
    block2Transactions: preset.actions.filter((action) => action.recommendedBlock === 2).length,
    signerIndices: [...new Set(preset.actions.map((action) => action.fixtureSignerIndex))],
    actionIds: preset.actions.map((action) => action.id),
    contractAddress,
    runtimeBytes: (runtimeCode.length - 2) / 2,
  },
  timingMs: {
    prepare: preparedAtMs,
    prove: provedAtMs - preparedAtMs,
    verify: verifiedAtMs - provedAtMs,
    total: verifiedAtMs,
  },
  measurement: prepared.measurement,
  contractConfig: prepared.contractConfig,
  verification,
  proof: {
    proofMode: proof.proofMode,
    journal: proof.journal,
    journalHash: proof.journalHash,
    receiptB64: proof.receiptB64,
    ethereumSealB64: proof.ethereumSealB64,
  },
}
await mkdir(resolve(output, '..'), { recursive: true })
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ output, ...evidence.timingMs, gpu: evidence.gpu })}\n`)
