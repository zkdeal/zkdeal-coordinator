/**
 * Wire types and fetch wrapper for the local demo service (/demo route).
 *
 * Split out of `components/long-running-demo.tsx`; the shapes below are what
 * the service publishes over `/demo/v1/*` and are consumed by the console and
 * its sub-components. No React.
 */

import type { DemoPhase } from '@/lib/demo-console'

export type Service = { id: string; label: string; status: 'READY' | 'STARTING' | 'FAILED' }
export type SystemStatus = {
  decision: 'READY' | 'STARTING' | 'DEGRADED'
  services: Service[]
  gpu: null | {
    name: string
    samplesSeconds: number[]
    medianSeconds: number
    maximumSeconds: number
    recommendedProofSeconds: number
    recommendedDeadlineBlocks: number
  }
  contracts: Array<{ label: string; reference: string }>
  canary: null | {
    roomReference: string
    l1Block: string
    transactionReference: string
    explorerUrl: string | null
  }
  explorerUrl: string | null
  /**
   * The checkpoint policy's own constants, so a client can explain the policy
   * without restating it - in particular `l1BlockSeconds`, which is what turns
   * a presenter's "120 s" into the blocks the coordinator wants, and
   * `defaultDeadlineBlocks`, which is the allowance it recommends.
   */
  checkpointPolicy?: {
    l1BlockSeconds?: number
    defaultDeadlineBlocks?: number
    measuredProofSeconds?: number
    wallClockSeconds?: number
  } | null
}

export type PresetAction = {
  id: string
  label: string
  actor: string
  calldata: string
  recommendedBlock: 1 | 2
  fixtureSignerIndex?: number
  gasLimit?: number
}
export type Preset = {
  id: string
  name: string
  summary: string
  authorizationMode: string
  participantCapacity: number
  activeApprovers: number
  actions: PresetAction[]
  peers?: Array<{
    id: string
    label: string
    description: string
    fixtureSignerIndex?: number
  }>
  initialStorage: Array<{ label: string; slot: string; value: string; mode: string }>
}
/**
 * The duel a card template was prepared against, published in full (the
 * coordinator exempts these keys from its hex redaction) because a browser has
 * to ADDRESS them: `duelAddress` is the `to` of every signed duel move and,
 * with `roomApplicationDomain`, the preimage of `proofDomain` - public input 0
 * of every card circuit. Absent for every template that is not a duel.
 */
export type PreparedCardRoom = {
  duelAddress: string
  stakeTokenAddress: string
  proofAdapterAddress: string
  deckVerifierAddress: string
  handVerifierAddress: string
  roomApplicationDomain: string
  entryStake: string
  fundedAmount: string
  sessionExpiry: number
  participantCapacity: number
  duelistOwners: string[]
}
export type PreparedTemplate = {
  templateId: string
  coldProofMs: number
  registrationTransaction: string
  contractAddress: string | null
  cardRoom?: PreparedCardRoom
  erc7540Room?: {
    vaultAddress: string
    assetTokenAddress: string
    aliceAddress: string
    bobAddress: string
    managerAddress: string
    participantCapacity: number
    runtimeBindings: Array<{ role: 'vault' | 'assetToken'; address: string }>
  }
  erc4626Room?: {
    vaultAddress: string
    assetTokenAddress: string
    investorAddress: string
    liquidityProviderAddress: string
    participantCapacity: number
    runtimeBindings: Array<{ role: 'vault' | 'assetToken'; address: string }>
  }
}
export type Template = {
  id: string
  name: string
  presetId: string | null
  source: string
  phase: DemoPhase
  authorizationMode: string
  participantCapacity: number
  activeApprovers: number
  selectedState: Array<{ label: string; slot: string; value: string; mode: string }>
  preparation?: PreparedTemplate
  failure?: { explanation: string; recovery: string }
}
export type RoomAction = {
  id: string
  actionId: string
  label: string
  actorId: string
  block: 1 | 2
  acceptedAt: string
  /**
   * The checkpoint that PROVED this action, or null while it is still pending.
   *
   * A room keeps every action it ever accepted, so without this a reader cannot
   * tell the moves the next batch will carry from the ones already settled -
   * and a room that has checkpointed once would look as though its first L2
   * block were permanently occupied.
   */
  checkpointSequence?: number | null
}
export type Room = {
  id: string
  name: string
  templateId: string
  managed: boolean
  deadlineBlocksFromStart: number
  phase: DemoPhase
  chainRoomId: string | null
  /**
   * The room's own deployment transaction on L1.
   *
   * `publicDemoView` abbreviates it and publishes no link beside it, so it
   * arrives as `0x05d3ac...ce78` - a string that cannot be looked up. The two
   * optional fields below are the shapes that WOULD carry a usable reference
   * (`deploymentTransactionHash` is the `PUBLISHED_IN_FULL` convention the
   * checkpoint's `l1TransactionHash` already uses); readers here prefer them
   * when present and otherwise say the hash cannot be resolved rather than
   * linking to a guess.
   */
  deploymentTransaction: string | null
  deploymentTransactionHash?: string | null
  deploymentExplorerUrl?: string | null
  actions: RoomAction[]
  checkpoint?: DemoCheckpointView
  /**
   * Every checkpoint ATTEMPT this room has made, oldest first.
   *
   * Note the shape: these are attempts, not receipts. An attempt that is still
   * RUNNING or that FAILED has no `result`, and reading one as though it were a
   * receipt yields a row with an undefined transaction and an undefined L1
   * block - which is why `cardRoomCheckpoints` unwraps `result` and drops
   * attempts that never produced one.
   */
  checkpoints?: DemoCheckpointRecordView[]
  closedAt?: string | null
  failure?: { explanation: string; recovery: string }
}
export type DemoCheckpointRecordView = {
  /** 1-based, in start order. */
  sequence: number
  trigger?: string
  /** Exactly the actions this attempt proved, in acceptance order. */
  actionIds?: string[]
  startedAt?: string
  finishedAt?: string | null
  outcome?: 'RUNNING' | 'ACCEPTED' | 'FAILED'
  queueWaitMs?: number
  result?: DemoCheckpointView
  failure?: { explanation: string; recovery: string }
}
export type DemoCheckpointView = {
  proofMs: number
  localVerificationMs: number
  /**
   * The merged room transaction. `publicDemoView` abbreviates any hex string of
   * 40+ characters, so this arrives truncated; the full hash survives inside
   * `explorerUrl` and in `l1TransactionHash`, which is on the server's
   * `PUBLISHED_IN_FULL` list precisely because a player told a checkpoint
   * settled has to be able to look it up.
   */
  transaction: string
  l1TransactionHash?: string | null
  l1Block: string
  postStateRoot: string
  explorerUrl: string | null
}
export type L1Block = { number: string; timestamp: string; transactions: number; reference: string }

export const API = process.env.NEXT_PUBLIC_DEMO_API_URL?.replace(/\/$/, '') ?? ''

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  // Parse AFTER the status check: a 502 from a reverse proxy is HTML, and
  // parsing first reported "Unexpected token < in JSON" instead of the code
  // an operator needs.
  const body = await response.text()
  let value: (T & { error?: { explanation?: string } | string }) | null = null
  try {
    value = body ? (JSON.parse(body) as T & { error?: { explanation?: string } | string }) : null
  } catch {
    value = null
  }
  if (!response.ok) {
    const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
    const reason =
      typeof value?.error === 'string'
        ? value.error
        : value?.error?.explanation ?? `The local demo service returned ${status}.`
    throw new Error(reason)
  }
  if (value === null) throw new Error('The local demo service returned a non-JSON response.')
  return value
}
