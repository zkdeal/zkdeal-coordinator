import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { Hex } from 'viem'
import type { Erc4626RoomDeployment } from '../src/erc4626-request.js'
import {
  ERC4626_INVESTOR,
  ERC4626_LIQUIDITY_PROVIDER,
  erc4626Preset,
} from '../src/erc4626-room.js'
import { signErc4626CheckpointActions } from '../src/erc4626-signing.js'
import {
  movesOf,
  replayRequest,
  type RoomContinuation,
} from '../src/demo-runtime-checkpoint.js'
import { baseSpec } from '../src/demo-runtime-spec.js'
import type { DemoAction, DemoRoom } from '../src/demo-types.js'
import { validateTemplateRequest } from '../src/demo-validation.js'

const prover = process.env.ERC4626_PROVER_URL ?? 'http://127.0.0.1:18081'
const repoRoot = basename(process.cwd()).toLowerCase() === 'server'
  ? resolve(process.cwd(), '..')
  : process.cwd()
const domain = `0x${'46'.repeat(32)}` as Hex
const vaultAddress = '0x0000000000000000000000000000000000004601' as Hex
const assetTokenAddress = '0x0000000000000000000000000000000000004602' as Hex

async function runtime(name: string): Promise<Hex> {
  const artifact = JSON.parse(
    await readFile(resolve(repoRoot, '..', 'web3-protocol', 'contracts', 'out', `${name}.sol`, `${name}.json`), 'utf8'),
  ) as { deployedBytecode?: { object?: string } | string }
  const value = artifact.deployedBytecode
  const code = typeof value === 'string' ? value : value?.object
  if (!code || !/^0x[0-9a-fA-F]+$/.test(code) || code.length <= 2) {
    throw new Error(`${name} has no deployed bytecode`)
  }
  return code as Hex
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${prover}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${text}`)
  return JSON.parse(text) as T
}

interface Prepared {
  roomRequest: { roomWitness: { journal: Record<string, unknown> } }
}

const preset = erc4626Preset()
const deployment: Erc4626RoomDeployment = {
  vault: { address: vaultAddress, runtimeCode: await runtime('RoomVault4626') },
  assetToken: { address: assetTokenAddress, runtimeCode: await runtime('RoomERC20') },
  investor: ERC4626_INVESTOR,
  liquidityProvider: ERC4626_LIQUIDITY_PROVIDER,
  participantCapacity: 128,
}
const template = {
  ...validateTemplateRequest({ name: 'ERC-4626 native validation', presetId: 'erc4626' }),
  id: 'tpl-erc4626-native',
  phase: 'ROOM_READY' as const,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
}
const actions: DemoAction[] = preset.actions.map((action, index) => ({
  id: `native-${index}`,
  actionId: action.id,
  label: action.label,
  actorId: action.actor,
  calldata: action.calldata,
  fixtureSignerIndex: action.fixtureSignerIndex,
  gasLimit: action.gasLimit,
  block: action.recommendedBlock,
  acceptedAt: new Date(index).toISOString(),
  checkpointSequence: null,
}))
const room: DemoRoom = {
  id: 'room-erc4626-native',
  name: 'ERC-4626 native validation',
  templateId: template.id,
  managed: false,
  deadlineBlocksFromStart: 100,
  phase: 'ACTIVE',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  chainRoomId: '46',
  deploymentTransaction: null,
  actions,
  checkpoints: [],
  proofDeadlineBlock: null,
  lastCheckpointAt: null,
  closedAt: null,
}

const journals: Record<string, unknown>[] = []
for (let index = 0; index < 3; index += 1) {
  const pair = actions.slice(index * 2, index * 2 + 2)
  await signErc4626CheckpointActions(room, pair, domain, deployment)
  const moves = movesOf(pair)
  const previous = journals.at(-1)
  const continuation: RoomContinuation | null = previous
    ? {
        batchIndex: index + 1,
        startL2Block: Number(previous.end_l2_block) + 1,
        preStateRoot: previous.post_state_root as Hex,
        preParticipantRoot: previous.post_participant_root as Hex,
        preParticipantEpoch: Number(previous.post_participant_epoch),
        preParticipantCount: Number(previous.post_participant_count),
        outboxEpoch: Number(previous.outbox_epoch) + 1,
      }
    : null
  const replay = replayRequest(room, moves, continuation)
  const spec = {
    ...baseSpec(template, 46, 10_000, domain, moves, null, null, null, deployment),
    ...(continuation ? { continuation } : {}),
    ...(replay ?? {}),
  }
  const prepared = await post<Prepared>('/v5/rooms/prepare', spec)
  const journal = prepared.roomRequest.roomWitness.journal
  if (Number(journal.batch_index) !== index + 1) {
    throw new Error(`prepared batch ${String(journal.batch_index)} instead of ${index + 1}`)
  }
  if (
    continuation
    && String(journal.pre_state_root).toLowerCase() !== continuation.preStateRoot.toLowerCase()
  ) {
    throw new Error(`batch ${index + 1} does not continue from the previous post-state root`)
  }
  journals.push(journal)
  for (const action of pair) action.checkpointSequence = index + 1
  room.checkpoints.push({
    sequence: index + 1,
    trigger: 'MANUAL',
    actionIds: pair.map((action) => action.id),
    startedAt: new Date(index).toISOString(),
    finishedAt: new Date(index + 1).toISOString(),
    outcome: 'ACCEPTED',
    queueWaitMs: 0,
  })
}

process.stdout.write(
  `${JSON.stringify(
    {
      workload: preset.workload,
      checkpoints: journals.map((journal) => ({
        batchIndex: journal.batch_index,
        startL2Block: journal.start_l2_block,
        endL2Block: journal.end_l2_block,
        preStateRoot: journal.pre_state_root,
        postStateRoot: journal.post_state_root,
      })),
      transactions: actions.length,
      replayedBlocksInFinalRequest: 6,
      finalSignedNonces: actions.map((action) => action.signedTransaction?.slice(0, 18)),
    },
    null,
    2,
  )}\n`,
)
