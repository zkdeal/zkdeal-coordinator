export const KURTOSIS_STORY_SCHEMA = 'zkdeal-kurtosis-stories/v1' as const

export type StoryPhase =
  | 'control'
  | 'l2-execution'
  | 'replay'
  | 'approval'
  | 'proving'
  | 'recovery'
  | 'adversary'
  | 'l1-submission'
  | 'l1-consensus'
  | 'l1-verification'

export type StoryTone = 'neutral' | 'active' | 'accepted' | 'rejected' | 'fault'

export interface StoryNode {
  id: string
  label: string
  kind: 'driver' | 'client' | 'coordinator' | 'runtime' | 'prover' | 'l1' | 'contract'
  countedService: boolean
}

export interface StoryL1Block {
  slot?: string
  blockNumber?: string
  txHash?: string
  status: 'proposed' | 'accepted' | 'reverted' | 'censored' | 'simulated'
  contents: string[]
}

export interface StoryEvent {
  id: string
  atMs: number
  durationMs: number
  phase: StoryPhase
  tone: StoryTone
  title: string
  detail: string
  from: string[]
  to: string[]
  data: Record<string, string>
  l1?: StoryL1Block
  nodeStates?: Record<string, 'active' | 'standby' | 'restarting' | 'retired' | 'rejected'>
}

export interface KurtosisStory {
  id: string
  title: string
  category: 'recovery' | 'adversary'
  summary: string
  status: 'NOT_RUN' | 'COMPLETE' | 'FAILED'
  activeMembers: number
  expected: string
  observed: string | null
  evidencePath: string | null
  assumptions: string[]
  guarantees: string[]
  doesNotGuarantee: string[]
  events: StoryEvent[]
}

export interface KurtosisStoryBundle {
  schema: typeof KURTOSIS_STORY_SCHEMA
  generatedAt: string | null
  run: {
    label: string
    status: 'NOT_RUN' | 'COMPLETE' | 'FAILED'
    timingSource: 'measured-canonical-median' | 'protocol-reference'
    protocolVersion: number
    evmFork: string
    l1: string
    l1SlotSeconds: number
    gitCommit: string | null
    dirtyTree: boolean | null
    presetHash: string | null
    proofProgramId: string | null
    roomManager: string | null
    gpuName: string | null
    gpuUuid: string | null
    driverVersion: string | null
    cudaVersion: string | null
    risc0Version: string | null
    canonicalMedianMs: number | null
  }
  topology: {
    countedServices: number
    persistentServices: number
    memberClients: number
    coordinators: number
    note: string
    nodes: StoryNode[]
  }
  assumptions: string[]
  guarantees: string[]
  doesNotGuarantee: string[]
  stories: KurtosisStory[]
}

const nodes: StoryNode[] = [
  { id: 'bench', label: 'bench runner', kind: 'driver', countedService: true },
  { id: 'runtime', label: 'room runtime', kind: 'runtime', countedService: true },
  ...Array.from({ length: 7 }, (_, index) => ({
    id: `client-${index}`,
    label: `client ${index}`,
    kind: 'client' as const,
    countedService: true,
  })),
  { id: 'coordinator-0', label: 'active coordinator', kind: 'coordinator', countedService: true },
  { id: 'coordinator-1', label: 'standby coordinator', kind: 'coordinator', countedService: true },
  { id: 'prover', label: 'CUDA prover', kind: 'prover', countedService: true },
  { id: 'builder', label: 'builder proxy', kind: 'l1', countedService: true },
  { id: 'geth', label: 'geth EL', kind: 'l1', countedService: true },
  { id: 'beacon', label: 'Lighthouse CL', kind: 'l1', countedService: true },
  { id: 'validator', label: 'validator', kind: 'l1', countedService: true },
  { id: 'room-manager', label: 'RoomManager', kind: 'contract', countedService: false },
]

interface ReferenceDefinition {
  id: string
  title: string
  category: 'recovery' | 'adversary'
  summary: string
  assumption: string
  guarantee: string
  limitation: string
  activeMembers?: number
}

const definitions: ReferenceDefinition[] = [
  ['dynamic-membership-frozen-retire', 'Approver change at one proof boundary', 'recovery', 'Remove one approver, add a consenting entrant, and allocate the removed approver a proven withdrawal in one verified transition.', 'The old active approver set unanimously signs the exact delta.', 'Approver set, epoch, accounting, and withdrawal changes are accepted atomically.', 'An unavailable old approver can halt progress.'],
  ['coordinator-restart', 'Active coordinator restart', 'recovery', 'Restart the active coordinator and continue from its verified signed snapshot.', 'A valid signed recovery envelope survives restart.', 'Recovery cannot fork or roll back the latest L1 root.', 'Coordinator availability is still a liveness dependency.'],
  ['client-restart', 'Member client restart', 'recovery', 'Restart a member, reconstruct state, and approve the continuous closing batch.', 'The member key and authenticated state remain available.', 'The client signs only after exact local replay.', 'N-of-N cannot force an offline member to return.'],
  ['prover-restart', 'CUDA prover restart', 'recovery', 'Restart the CUDA prover and retry the same content-addressed job boundary.', 'The pinned image, witness, program, and GPU become available.', 'A substituted result cannot change the accepted journal.', 'GPU availability affects latency and liveness.'],
  ['snapshot-recovery', 'Engine snapshot recovery', 'recovery', 'Restore a snapshot, verify its history prefix, and extend the exact verified root.', 'Signed snapshot bytes are available.', 'A divergent or rollback snapshot cannot be extended.', 'Snapshot storage is an availability dependency.'],
  ['honest-coordinator-failover', 'Standby coordinator failover', 'recovery', 'Move the signed state to the honest standby and finish the same room.', 'One coordinator can read L1 and the signed envelope.', 'Failover remains bounded by the same roots and approvals.', 'No leader-election fairness is promised.'],
  ['reorder', 'Reject reordered L2 transactions', 'adversary', 'Swap canonical transaction positions after approval.', 'Approvals bind the ordered batch digest.', 'A different internal order cannot reuse the proof and signatures.', 'Ordering before approval is not guaranteed fair.'],
  ['omit', 'Reject an omitted L2 transaction', 'adversary', 'Remove one approved transaction from canonical calldata.', 'Canonical data is independently replayable.', 'An approved batch cannot partially execute.', 'The coordinator may still withhold a new proposal.'],
  ['duplicate', 'Reject a duplicated L2 transaction', 'adversary', 'Repeat one approved transaction in canonical calldata.', 'Nonce and canonical encodings are enforced.', 'Duplicate execution cannot be smuggled into an approved update.', 'Members may approve a deliberately different future batch.'],
  ['mutate', 'Reject a mutated signed transaction', 'adversary', 'Flip a security-relevant byte after replay and signing.', 'Transaction signatures and batch hashes are canonical.', 'Post-approval mutation cannot preserve authorization.', 'Compromised member keys are outside this test.'],
  ['inject', 'Reject an injected transaction', 'adversary', 'Insert a transaction absent from the approved execution.', 'Every executed transaction is in committed canonical data.', 'A builder cannot inject execution inside the proved batch.', 'The builder may transact before or after it.'],
  ['stale-root', 'Reject a stale pre-state root', 'adversary', 'Try to extend an earlier verified state instead of the current root.', 'RoomManager is the canonical progress source.', 'An old proof cannot roll back or fork the room.', 'L1 reorg assumptions are inherited from Ethereum.'],
  ['wrong-preset', 'Reject the wrong preset', 'adversary', 'Substitute a different execution-policy commitment.', 'The room pins its preset and manifest.', 'The batch cannot silently change policy or resource limits.', 'Preset governance must still be correct.'],
  ['wrong-image', 'Reject the wrong proof program', 'adversary', 'Substitute a different guest/image commitment.', 'The verifier and program ID are pinned on L1.', 'Another guest program cannot advance this room.', 'A bug in the pinned guest remains possible.'],
  ['forged-seal', 'Reject a forged Groth16 seal', 'adversary', 'Replace the canonical Ethereum seal.', 'RISC Zero proof soundness and verifier correctness hold.', 'A forged seal cannot authenticate the journal.', 'Proof availability is not guaranteed.'],
  ['altered-calldata', 'Reject altered submitBatch calldata', 'adversary', 'Change a bound field in the L1 submission.', 'Every security-relevant field is bound or checked.', 'Accepted calldata matches the proved, signed transition.', 'Unbound telemetry is not a correctness input.'],
  ['builder-censor', 'Builder censors one L1 submission', 'adversary', 'Drop one whole transaction before it reaches an L1 block.', 'The controlled one-shot builder fault is faithfully recorded.', 'Censorship causes no partial execution or nonce change.', 'Bounded inclusion and censorship resistance are not claimed.', 1],
  ['builder-surround', 'Builder surrounds the rollup update', 'adversary', 'Place L1 transactions before and after the atomic rollup call.', 'The builder controls whole-transaction ordering only.', 'External transactions cannot enter the proved L2 execution.', 'Value extraction outside the update is still possible.'],
].map(([id, title, category, summary, assumption, guarantee, limitation, activeMembers]) => ({
  id: id as string,
  title: title as string,
  category: category as 'recovery' | 'adversary',
  summary: summary as string,
  assumption: assumption as string,
  guarantee: guarantee as string,
  limitation: limitation as string,
  activeMembers: (activeMembers as number | undefined) ?? 2,
}))

function event(
  id: string,
  atMs: number,
  durationMs: number,
  phase: StoryPhase,
  tone: StoryTone,
  title: string,
  detail: string,
  from: string[],
  to: string[],
  data: Record<string, string>,
  l1?: StoryL1Block,
): StoryEvent {
  return { id, atMs, durationMs, phase, tone, title, detail, from, to, data, ...(l1 ? { l1 } : {}) }
}

function referenceEvents(definition: ReferenceDefinition): StoryEvent[] {
  const clients = definition.activeMembers === 1
    ? ['client-6']
    : Array.from({ length: Math.min(7, definition.activeMembers ?? 2) }, (_, index) => `client-${index}`)
  if (definition.id === 'builder-censor') {
    return [
      event('control', 0, 700, 'control', 'active', 'Arm one-shot censorship', 'This story isolates L1 liveness; no L2 batch is built.', ['bench', 'runtime'], ['builder'], { mode: 'censor-next-submission' }),
      event('sign', 700, 900, 'l1-submission', 'active', 'Client 6 signs an L1 marker', 'The raw transaction is sent through the controlled builder proxy.', clients, ['builder'], { l1Intent: 'builder-censor-marker' }),
      event('censor', 1_600, 700, 'adversary', 'rejected', 'Builder drops the whole transaction', 'No block, nonce change, or partial execution occurs.', ['builder'], clients, { nonce: 'unchanged', builderModeAfter: 'honest' }, { status: 'censored', contents: ['no L1 block produced', 'no nonce change', 'no partial execution'] }),
    ]
  }
  const mutation = definition.category === 'adversary' && definition.id !== 'builder-surround'
  const recovery = definition.category === 'recovery'
  const result: StoryEvent[] = [
    event('control', 0, 400, 'control', 'active', 'Start isolated Kurtosis story', 'The bench runner selects the scenario and network profile.', ['bench'], ['runtime'], { source: 'protocol reference; import a run for exact evidence' }),
    event('open', 400, 1_000, 'l1-submission', 'accepted', 'Open room and pin trust roots', 'L1 commits the approver set, policy, manifest, program, verifier, and genesis roots.', ['runtime', ...clients], ['builder', 'geth', 'room-manager'], { commitments: 'approvers · policy · manifest · program · genesis roots' }, { status: 'simulated', contents: ['create/open room', 'approver set + trust roots + genesis roots'] }),
    event('l2', 1_400, 900, 'l2-execution', 'active', 'Execute ordered Osaka L2 blocks', 'The FIFO leader admits signed transactions and gossips canonical block data.', [clients[0] ?? 'client-0'], clients.slice(1), { importantContents: 'signed txs · canonical order · block env · post-state roots' }),
    event('replay', 2_300, 650, 'replay', 'active', 'Every active member replays', 'Clients recompute results, roots, batch data, journal, and withdrawals.', [clients[0] ?? 'client-0'], clients, { checks: 'state · approvers · withdrawals · inbox · close flag' }),
    event('sign', 2_950, 750, 'approval', 'accepted', `Collect ${clients.length}-of-${clients.length} approvals`, 'EIP-712 signatures bind the exact batch commitments and deadline.', clients, ['coordinator-0'], { signed: 'room · batch · journal · data · approver set · epoch · deadline' }),
    event('prove', 3_700, 4_000, 'proving', 'active', 'Prove with the pinned CUDA guest', 'The content-addressed job binds program, preset, witness, and expected journal.', ['runtime', 'coordinator-0'], ['prover'], { result: 'journal + canonical Groth16 Ethereum seal' }),
  ]
  if (mutation) {
    result.push(
      event('fault', 7_700, 900, 'adversary', 'fault', definition.title, definition.summary, ['runtime'], ['builder'], { mutation: definition.id, original: 'canonical submitBatch', candidate: 'one protected dimension changed' }),
      event('reject', 8_600, 700, 'l1-verification', 'rejected', 'Historical L1 simulation reverts', 'The exact pre-submit state rejects the mutation; no L1 block or room progress is produced.', ['builder'], ['geth', 'room-manager'], { beforeProgress: 'verified state', afterProgress: 'byte-identical' }, { status: 'reverted', contents: ['historical eth_call only', `${definition.id} mutation`, 'revert · no state change'] }),
    )
    return result
  }
  if (recovery) {
    result.push(
      event('batch-1', 7_700, 2_500, 'l1-verification', 'accepted', 'Roll up batch 1', 'L1 verifies a non-closing batch and becomes the recovery anchor.', ['coordinator-0', 'builder', 'geth'], ['room-manager', 'beacon'], { batchIndex: '1', closed: 'false' }, { status: 'simulated', contents: ['submitBatch #1', 'journal + seal + approvals', 'BatchVerified(closed=false)'] }),
      event('recover', 10_200, 1_200, 'recovery', 'fault', definition.title, definition.summary, ['runtime'], [definition.id === 'client-restart' ? 'client-1' : definition.id === 'prover-restart' ? 'prover' : definition.id === 'honest-coordinator-failover' ? 'coordinator-1' : 'coordinator-0'], { recoveryRule: 'must match latest L1 root byte-for-byte' }),
      event('batch-2', 11_400, 4_000, 'l1-verification', 'accepted', 'Replay, re-sign, re-prove, and close', 'A fresh closing batch extends the same state/approver/withdrawal/timestamp/inbox commitments.', clients, ['prover', 'builder', 'geth', 'room-manager'], { batchIndex: '2', closed: 'true', continuity: 'exact' }, { status: 'simulated', contents: ['submitBatch #2', 'fresh journal + seal + approvals', 'BatchVerified(closed=true)'] }),
    )
    return result
  }
  result.push(
    event('surround', 7_700, 2_600, 'l1-consensus', 'active', 'Builder orders before → submitBatch → after', 'Whole L1 transactions surround but never enter the proved L2 batch.', ['builder'], ['geth', 'beacon'], { ordering: 'before marker · rollup · after marker' }, { status: 'simulated', contents: ['builder marker: before', 'submitBatch', 'builder marker: after'] }),
    event('verify', 10_300, 700, 'l1-verification', 'accepted', 'Exact journal remains verified', 'RoomManager advances only the unanimously approved, sealed transition.', ['geth'], ['room-manager', ...clients], { journal: 'expected = prover = L1', sealVerifiedOnL1: 'true' }),
  )
  return result
}

export function createReferenceKurtosisBundle(): KurtosisStoryBundle {
  return {
    schema: KURTOSIS_STORY_SCHEMA,
    generatedAt: null,
    run: {
      label: 'Protocol reference', status: 'NOT_RUN', timingSource: 'protocol-reference', protocolVersion: 6,
      evmFork: 'osaka', l1: 'geth + Lighthouse', l1SlotSeconds: 12, gitCommit: null,
      dirtyTree: null, presetHash: null, proofProgramId: null, roomManager: null, gpuName: null,
      gpuUuid: null, driverVersion: null, cudaVersion: null, risc0Version: null, canonicalMedianMs: null,
    },
    topology: {
      countedServices: 16, persistentServices: 15, memberClients: 7, coordinators: 2,
      note: '16 services while a bench story runs: 15 persistent services plus the one-shot runner. RoomManager is drawn but is not a separate service.',
      nodes,
    },
    assumptions: [
      'All active members independently replay and sign the exact Osaka batch; N-of-N safety can stall when a member is unavailable.',
      'RoomManager pins the approver set, policy, verifier, proof program, and root-continuity rules; Ethereum consensus and cryptography hold.',
      'Canonical batch data is on L1. Coordinators and the prover may fail or lie, but are not trusted for correctness.',
    ],
    guarantees: [
      'Accepted updates have the exact active-approver approvals, a verifier-accepted seal, and continuous state/approver/withdrawal/inbox commitments.',
      'An L1 builder may surround, delay, or censor submitBatch, but cannot change its proved internal order or partially apply it.',
      'Clients recompute the journal and verify the content-addressed proof result before submission.',
    ],
    doesNotGuarantee: [
      'No fair ordering, censorship resistance, input truth, public-testnet inclusion, or hardware-independent latency is claimed.',
      'Reference timing is illustrative. Import the story-trace JSON emitted by a Kurtosis run for measured GPU/run timing and exact evidence.',
    ],
    stories: definitions.map((definition) => ({
      id: definition.id, title: definition.title, category: definition.category, summary: definition.summary,
      status: 'NOT_RUN', activeMembers: definition.activeMembers ?? 2, expected: definition.guarantee,
      observed: null, evidencePath: null, assumptions: [definition.assumption], guarantees: [definition.guarantee],
      doesNotGuarantee: [definition.limitation], events: referenceEvents(definition),
    })),
  }
}

/*
 * Import validation.
 *
 * A trace file is the only untrusted input on a shipped route, and the player
 * dereferences far more of it than the parser used to check: it spreads the
 * three boundary arrays, sizes an array from `story.activeMembers`, maps
 * `l1.contents`, iterates `event.data`, and indexes colour tables by `phase`
 * and `tone`. Casting the parsed root meant a file with the right schema
 * string but a missing `assumptions` array threw during render, OUTSIDE the
 * importer's try/catch - a blank page with the run already in state instead of
 * the inline error banner the component was built to show. So every field the
 * UI reads is validated here and the bundle is CONSTRUCTED, never cast.
 */

const NODE_KINDS = ['driver', 'client', 'coordinator', 'runtime', 'prover', 'l1', 'contract'] as const
const NODE_STATES = ['active', 'standby', 'restarting', 'retired', 'rejected'] as const
const PHASES: readonly StoryPhase[] = [
  'control', 'l2-execution', 'replay', 'approval', 'proving',
  'recovery', 'adversary', 'l1-submission', 'l1-consensus', 'l1-verification',
]
const TONES: readonly StoryTone[] = ['neutral', 'active', 'accepted', 'rejected', 'fault']
const L1_STATUSES = ['proposed', 'accepted', 'reverted', 'censored', 'simulated'] as const
const RUN_STATUSES = ['NOT_RUN', 'COMPLETE', 'FAILED'] as const
const TIMING_SOURCES = ['measured-canonical-median', 'protocol-reference'] as const
const CATEGORIES = ['recovery', 'adversary'] as const

/**
 * Structural caps. A file well under the importer's 5 MB limit can still hold
 * >100k events, and `Math.max(...events)` throws RangeError on that spread
 * while `Array.from({ length })` on an unbounded count hangs the tab.
 */
const MAX_NODES = 512
const MAX_STORIES = 256
const MAX_EVENTS = 4_096
const MAX_LIST = 256
const MAX_ENTRIES = 128

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function str(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  return value
}

function nullableStr(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null
  return str(value, label)
}

function nullableBool(value: unknown, label: string): boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
  return value
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
  return value
}

function nullableNumber(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null
  return finiteNumber(value, label)
}

function boundedInt(value: unknown, label: string, min: number, max: number): number {
  const n = finiteNumber(value, label)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be an integer between ${min} and ${max}`)
  return n
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const text = str(value, label)
  if (!(allowed as readonly string[]).includes(text)) {
    throw new Error(`${label} must be one of ${allowed.join(', ')}`)
  }
  return text as T
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings`)
  if (value.length > MAX_LIST) throw new Error(`${label} has more than ${MAX_LIST} entries`)
  return value.map((item, index) => str(item, `${label}[${index}]`))
}

function stringMap(value: unknown, label: string): Record<string, string> {
  const source = record(value, label)
  const entries = Object.entries(source)
  if (entries.length > MAX_ENTRIES) throw new Error(`${label} has more than ${MAX_ENTRIES} entries`)
  return Object.fromEntries(entries.map(([key, item]) => [key, str(item, `${label}.${key}`)]))
}

function parseNode(value: unknown, label: string): StoryNode {
  const node = record(value, label)
  return {
    id: str(node.id, `${label}.id`),
    label: str(node.label, `${label}.label`),
    kind: oneOf(node.kind, NODE_KINDS, `${label}.kind`),
    countedService: node.countedService === true,
  }
}

function parseL1Block(value: unknown, label: string): StoryL1Block {
  const l1 = record(value, label)
  const slot = nullableStr(l1.slot, `${label}.slot`)
  const blockNumber = nullableStr(l1.blockNumber, `${label}.blockNumber`)
  const txHash = nullableStr(l1.txHash, `${label}.txHash`)
  return {
    ...(slot === null ? {} : { slot }),
    ...(blockNumber === null ? {} : { blockNumber }),
    ...(txHash === null ? {} : { txHash }),
    status: oneOf(l1.status, L1_STATUSES, `${label}.status`),
    contents: stringList(l1.contents, `${label}.contents`),
  }
}

function parseEvent(value: unknown, label: string, knownNodes: Set<string>): StoryEvent {
  const event = record(value, label)
  const endpoints = (raw: unknown, field: string): string[] => {
    const list = stringList(raw, `${label}.${field}`)
    for (const endpoint of list) {
      if (!knownNodes.has(endpoint)) throw new Error(`${label} references unknown node ${endpoint}`)
    }
    return list
  }
  const nodeStates = event.nodeStates === undefined || event.nodeStates === null
    ? null
    : Object.fromEntries(
        Object.entries(record(event.nodeStates, `${label}.nodeStates`)).map(([key, state]) => [
          key,
          oneOf(state, NODE_STATES, `${label}.nodeStates.${key}`),
        ]),
      )
  return {
    id: str(event.id, `${label}.id`),
    atMs: finiteNumber(event.atMs, `${label}.atMs`),
    durationMs: finiteNumber(event.durationMs, `${label}.durationMs`),
    phase: oneOf(event.phase, PHASES, `${label}.phase`),
    tone: oneOf(event.tone, TONES, `${label}.tone`),
    title: str(event.title, `${label}.title`),
    detail: str(event.detail, `${label}.detail`),
    from: endpoints(event.from, 'from'),
    to: endpoints(event.to, 'to'),
    data: stringMap(event.data, `${label}.data`),
    ...(event.l1 === undefined || event.l1 === null ? {} : { l1: parseL1Block(event.l1, `${label}.l1`) }),
    ...(nodeStates === null ? {} : { nodeStates }),
  }
}

export function parseKurtosisStoryBundle(text: string): KurtosisStoryBundle {
  const root = record(JSON.parse(text), 'trace bundle')
  if (root.schema !== KURTOSIS_STORY_SCHEMA) throw new Error(`expected schema ${KURTOSIS_STORY_SCHEMA}`)

  const rawTopology = record(root.topology, 'topology')
  if (!Array.isArray(rawTopology.nodes) || rawTopology.nodes.length < 2) throw new Error('topology.nodes is missing')
  if (rawTopology.nodes.length > MAX_NODES) throw new Error(`topology.nodes has more than ${MAX_NODES} entries`)
  const nodeList = rawTopology.nodes.map((node, index) => parseNode(node, `node ${index}`))
  const knownNodes = new Set(nodeList.map((node) => node.id))
  const memberClients = boundedInt(rawTopology.memberClients, 'topology.memberClients', 0, MAX_NODES)
  const topology: KurtosisStoryBundle['topology'] = {
    countedServices: boundedInt(rawTopology.countedServices, 'topology.countedServices', 0, MAX_NODES),
    persistentServices: boundedInt(rawTopology.persistentServices, 'topology.persistentServices', 0, MAX_NODES),
    memberClients,
    coordinators: boundedInt(rawTopology.coordinators, 'topology.coordinators', 0, MAX_NODES),
    note: str(rawTopology.note, 'topology.note'),
    nodes: nodeList,
  }

  const rawRun = record(root.run, 'run')
  const run: KurtosisStoryBundle['run'] = {
    label: str(rawRun.label, 'run.label'),
    status: oneOf(rawRun.status, RUN_STATUSES, 'run.status'),
    timingSource: oneOf(rawRun.timingSource, TIMING_SOURCES, 'run.timingSource'),
    protocolVersion: boundedInt(rawRun.protocolVersion, 'run.protocolVersion', 0, 1_000),
    evmFork: str(rawRun.evmFork, 'run.evmFork'),
    l1: str(rawRun.l1, 'run.l1'),
    l1SlotSeconds: finiteNumber(rawRun.l1SlotSeconds, 'run.l1SlotSeconds'),
    gitCommit: nullableStr(rawRun.gitCommit, 'run.gitCommit'),
    dirtyTree: nullableBool(rawRun.dirtyTree, 'run.dirtyTree'),
    presetHash: nullableStr(rawRun.presetHash, 'run.presetHash'),
    proofProgramId: nullableStr(rawRun.proofProgramId, 'run.proofProgramId'),
    roomManager: nullableStr(rawRun.roomManager, 'run.roomManager'),
    gpuName: nullableStr(rawRun.gpuName, 'run.gpuName'),
    gpuUuid: nullableStr(rawRun.gpuUuid, 'run.gpuUuid'),
    driverVersion: nullableStr(rawRun.driverVersion, 'run.driverVersion'),
    cudaVersion: nullableStr(rawRun.cudaVersion, 'run.cudaVersion'),
    risc0Version: nullableStr(rawRun.risc0Version, 'run.risc0Version'),
    canonicalMedianMs: nullableNumber(rawRun.canonicalMedianMs, 'run.canonicalMedianMs'),
  }

  if (!Array.isArray(root.stories) || root.stories.length === 0) throw new Error('stories are missing')
  if (root.stories.length > MAX_STORIES) throw new Error(`stories has more than ${MAX_STORIES} entries`)
  const seenStories = new Set<string>()
  const stories = root.stories.map((rawStory, storyIndex) => {
    const story = record(rawStory, `story ${storyIndex}`)
    const id = typeof story.id === 'string' ? story.id : ''
    if (!id || seenStories.has(id)) throw new Error(`story ${storyIndex} has a missing or duplicate id`)
    seenStories.add(id)
    if (!Array.isArray(story.events) || story.events.length === 0) throw new Error(`${id} has no events`)
    if (story.events.length > MAX_EVENTS) throw new Error(`${id} has more than ${MAX_EVENTS} events`)
    let previous = -1
    const events = story.events.map((rawEvent, eventIndex) => {
      const parsed = parseEvent(rawEvent, `${id} event ${eventIndex}`, knownNodes)
      if (parsed.atMs < previous || parsed.durationMs <= 0) {
        throw new Error(`${id} event ${eventIndex} has invalid timing`)
      }
      previous = parsed.atMs
      return parsed
    })
    return {
      id,
      title: str(story.title, `${id}.title`),
      category: oneOf(story.category, CATEGORIES, `${id}.category`),
      summary: str(story.summary, `${id}.summary`),
      status: oneOf(story.status, RUN_STATUSES, `${id}.status`),
      // The graph renders one client node per active member; an unbounded
      // count is an immediate hang.
      activeMembers: boundedInt(story.activeMembers, `${id}.activeMembers`, 0, memberClients),
      expected: str(story.expected, `${id}.expected`),
      observed: nullableStr(story.observed, `${id}.observed`),
      evidencePath: nullableStr(story.evidencePath, `${id}.evidencePath`),
      assumptions: stringList(story.assumptions, `${id}.assumptions`),
      guarantees: stringList(story.guarantees, `${id}.guarantees`),
      doesNotGuarantee: stringList(story.doesNotGuarantee, `${id}.doesNotGuarantee`),
      events,
    }
  })

  return {
    schema: KURTOSIS_STORY_SCHEMA,
    generatedAt: nullableStr(root.generatedAt, 'generatedAt'),
    run,
    topology,
    assumptions: stringList(root.assumptions, 'assumptions'),
    guarantees: stringList(root.guarantees, 'guarantees'),
    doesNotGuarantee: stringList(root.doesNotGuarantee, 'doesNotGuarantee'),
    stories,
  }
}
