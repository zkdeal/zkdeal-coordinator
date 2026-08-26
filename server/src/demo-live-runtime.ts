import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  parseEventLogs,
  toBytes,
  toHex,
  zeroAddress,
  zeroHash,
  type Abi,
  type AbiParameter,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  type DemoCheckpoint,
  type DemoCheckpointRequest,
  type DemoPhase,
  type DemoPreparedTemplate,
  type DemoRoom,
  type DemoRuntime,
  type DemoSystemStatus,
  type DemoTemplate,
} from './demo-control.js'
import { runCheckpoint, type OnChainRoom } from './demo-runtime-checkpoint.js'
import { DEFAULT_KEY, ROLE_KEYS } from './demo-runtime-approvers.js'
import { contractJournal } from './demo-runtime-journal.js'
import { assertPreparableTemplate } from './demo-runtime-capabilities.js'
import { cardRoomDocument, prepareCardRoom, restoreCardRoom } from './card-deployment.js'
import type { CardRoomDeployment } from './card-request.js'
import {
  erc7540RoomDocument,
  prepareErc7540Room,
  restoreErc7540Room,
} from './erc7540-deployment.js'
import type { Erc7540RoomDeployment } from './erc7540-request.js'
import { prepareAmmRoom } from './amm-deployment.js'
import { prepareNaiveAmmRoom } from './naive-amm-deployment.js'
import {
  erc4626RoomDocument,
  prepareErc4626Room,
  restoreErc4626Room,
} from './erc4626-deployment.js'
import type { Erc4626RoomDeployment } from './erc4626-request.js'
import { baseSpec } from './demo-runtime-spec.js'
import { shortReference, summarizeSystem } from './demo-runtime-status.js'
import {
  readAgreedBlock,
  watchSettlement,
  type SettlementRpc,
} from './l1-settlement-watcher.js'
import { trackDeadlineRiskJob } from './metrics.js'
import {
  assertProductionConfirmationDepth,
  DEFAULT_PRODUCTION_CONFIRMATIONS,
} from './l1-confirmation-policy.js'
import {
  ROOM_CREATED_EVENT_ABI,
  type Artifact,
  type DemoEvidence,
  type PreparedResponse,
  type ProofResult,
  type DemoLiveRuntimeOptions,
} from './demo-runtime-types.js'

/** Smallest legal omission penalty for a VALIDITY_ONLY demo room. */
export const DEMO_OMISSION_PENALTY = 1n
/**
 * `createRoom` enforces `omissionPenalty <= minimumServiceBond / 4`
 * (RoomManagerIntakeFacet.sol:118-124, MIN_SERVICE_BOND_MULTIPLE in
 * RoomManagerBase.sol:30). Integer division means a bond below the multiple
 * permits a penalty of 0, and a zero penalty is refused by the clause above
 * it -- so a bond of 1 makes a VALIDITY_ONLY room impossible to create at any
 * penalty. Keep these two in the ratio the contract demands.
 */
export const DEMO_MINIMUM_SERVICE_BOND = DEMO_OMISSION_PENALTY * 4n

export { contractJournal } from './demo-runtime-journal.js'
export type { DemoLiveRuntimeOptions } from './demo-runtime-types.js'

export class DemoLiveRuntime implements DemoRuntime {
  private readonly options: DemoLiveRuntimeOptions
  private readonly publicClient
  private readonly publicClients
  private readonly deployer
  private readonly deployerWallet
  private readonly accounts
  private readonly wallets
  private evidence: DemoEvidence | null = null
  private artifacts = new Map<string, Artifact>()
  /** One duel-room deployment per template; see `card-deployment.ts`. */
  private readonly cardRooms = new Map<string, CardRoomDeployment>()
  /** One asynchronous vault/token deployment per prepared ERC-7540 template. */
  private readonly erc7540Rooms = new Map<string, Erc7540RoomDeployment>()
  /** One real ERC-4626 vault/token deployment per prepared template. */
  private readonly erc4626Rooms = new Map<string, Erc4626RoomDeployment>()

  constructor(options: DemoLiveRuntimeOptions) {
    this.options = options
    this.deployer = privateKeyToAccount(options.deployerKey ?? DEFAULT_KEY)
    const rpcUrls = [...new Set(options.l1RpcUrls ?? [options.l1RpcUrl])]
    if (rpcUrls.length < 2) {
      throw new Error('the live demo requires two independent L1 RPC endpoints')
    }
    this.publicClients = rpcUrls.map((url) => createPublicClient({ transport: http(url) }))
    this.publicClient = this.publicClients[0]!
    this.deployerWallet = createWalletClient({
      account: this.deployer,
      transport: http(options.l1RpcUrl),
    })
    this.accounts = Object.fromEntries(
      Object.entries(ROLE_KEYS).map(([name, key]) => [name, privateKeyToAccount(key)]),
    ) as Record<keyof typeof ROLE_KEYS, ReturnType<typeof privateKeyToAccount>>
    this.wallets = Object.fromEntries(
      Object.entries(this.accounts).map(([name, account]) => [
        name,
        createWalletClient({ account, transport: http(options.l1RpcUrl) }),
      ]),
    ) as Record<keyof typeof ROLE_KEYS, ReturnType<typeof createWalletClient>>
  }

  private async loadEvidence(): Promise<DemoEvidence> {
    if (!this.evidence) {
      this.evidence = JSON.parse(await readFile(this.options.evidencePath, 'utf8')) as DemoEvidence
    }
    if (this.evidence.decision !== 'VERIFIED' || !this.evidence.contracts) {
      throw new Error('the startup canary deployment evidence is unavailable')
    }
    return this.evidence
  }

  private async artifact(name: string, alternatives: string[] = []): Promise<Artifact> {
    const cached = this.artifacts.get(name)
    if (cached) return cached
    const candidates = [
      resolve(this.options.contractsRoot, 'out', `${name}.sol`, `${name}.json`),
      ...alternatives.map((path) => resolve(this.options.contractsRoot, 'out', path)),
    ]
    for (const path of candidates) {
      try {
        const artifact = JSON.parse(await readFile(path, 'utf8')) as Artifact
        this.artifacts.set(name, artifact)
        return artifact
      } catch {
        // Try the next Foundry artifact layout.
      }
    }
    throw new Error(`the ${name} deployment artifact is unavailable`)
  }

  private async managerAbi(): Promise<Abi> {
    const manager = await this.artifact('RoomManager')
    const iface = await this.artifact('IRoomManager')
    return [...manager.abi, ...iface.abi] as Abi
  }

  private async post<T>(endpoint: string, body: unknown, timeoutMs = 20 * 60_000): Promise<T> {
    if (this.options.queueUrl) return this.postViaQueue<T>(endpoint, body, timeoutMs)
    const response = await fetch(`${this.options.proverUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const result = (await response.json()) as T & { decision?: string; reason?: string }
    if (!response.ok || result.decision === 'request-rejected') {
      throw new Error(
        `the local proof service rejected ${endpoint}${
          result.reason ? `: ${result.reason}` : ''
        }`,
      )
    }
    return result
  }

  /**
   * The same request through the shared prove queue: submit, poll once a
   * second inside the caller's budget, then fetch the verbatim prover JSON.
   * A FAILED job surfaces the queue-recorded reason, so the caller reads the
   * identical story whichever transport carried the proof.
   */
  private async postViaQueue<T>(endpoint: string, body: unknown, timeoutMs: number): Promise<T> {
    const base = this.options.queueUrl!.replace(/\/+$/, '')
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.options.queueSubmitToken) {
      headers.authorization = `Bearer ${this.options.queueSubmitToken}`
    }
    const call = async (path: string, init?: RequestInit): Promise<Response> => {
      const response = await fetch(`${base}${path}`, {
        headers,
        signal: AbortSignal.timeout(30_000),
        ...init,
      })
      if (response.status === 401) throw new Error('the prove queue refused the submitter token')
      return response
    }
    const submitted = await call('/queue/v1/jobs', {
      method: 'POST',
      body: JSON.stringify({ endpoint, request: body }),
    })
    if (!submitted.ok) throw new Error(`the prove queue rejected ${endpoint}`)
    const { jobId } = (await submitted.json()) as { jobId: string }
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const status = await call(`/queue/v1/jobs/${jobId}`)
      const job = (await status.json()) as { status?: string; failure?: { reason?: string } }
      if (job.status === 'FAILED') {
        throw new Error(
          `the local proof service rejected ${endpoint}${
            job.failure?.reason ? `: ${job.failure.reason}` : ''
          }`,
        )
      }
      if (job.status === 'DONE') {
        const result = (await (await call(`/queue/v1/jobs/${jobId}/result`)).json()) as T & {
          decision?: string
          reason?: string
        }
        if (result.decision === 'request-rejected') {
          throw new Error(
            `the local proof service rejected ${endpoint}${result.reason ? `: ${result.reason}` : ''}`,
          )
        }
        return result
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    throw new Error(`the prove queue did not finish ${endpoint} within the proof budget`)
  }

  private async sent(
    wallet: ReturnType<typeof createWalletClient>,
    address: Hex,
    abi: Abi,
    functionName: string,
    args: readonly unknown[] = [],
    gas?: bigint,
  ) {
    const hash = await wallet.writeContract({
      account: wallet.account!,
      address,
      abi,
      functionName,
      args,
      chain: null,
      ...(gas ? { gas } : {}),
    } as never)
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`${functionName} did not complete on local Ethereum`)
    return receipt
  }

  /**
   * The explorer link for an L1 transaction. Only this class knows the base
   * URL, and the control plane needs it to publish a room's own deployment
   * transaction as something a viewer can open rather than merely read.
   */
  transactionUrl(hash: string): string | null {
    return this.options.explorerUrl ? `${this.options.explorerUrl}/tx/${hash}` : null
  }

  async systemStatus(): Promise<DemoSystemStatus> {
    const services: DemoSystemStatus['services'] = []
    let evidence: DemoEvidence | null = null
    try {
      // The read itself is the liveness probe; the height is not reported here.
      await this.publicClient.getBlockNumber()
      services.push({ id: 'l1', label: 'Local Ethereum', status: 'READY' })
    } catch {
      services.push({ id: 'l1', label: 'Local Ethereum', status: 'FAILED' })
    }
    try {
      const response = await fetch(`${this.options.proverUrl}/healthz`, {
        signal: AbortSignal.timeout(5_000),
      })
      services.push({
        id: 'prover',
        label: 'Single-GPU prover',
        status: response.ok ? 'READY' : 'FAILED',
      })
    } catch {
      services.push({ id: 'prover', label: 'Single-GPU prover', status: 'FAILED' })
    }
    let deploymentDomain: string | null = null
    try {
      evidence = await this.loadEvidence()
      services.push({ id: 'contracts', label: 'zkdeal contracts', status: 'READY' })
      try {
        // A browser that signs its own room transactions computes
        // `room_chain_id_v5(deploymentDomain, roomId)`; without the domain every
        // envelope it produces is refused for the wrong chain id. A failed read
        // reports null rather than degrading the contracts probe.
        deploymentDomain = (await this.publicClient.readContract({
          address: evidence.contracts!.manager,
          abi: await this.managerAbi(),
          functionName: 'deploymentDomain',
        })) as Hex
      } catch {
        deploymentDomain = null
      }
    } catch {
      services.push({ id: 'contracts', label: 'zkdeal contracts', status: 'STARTING' })
    }
    return summarizeSystem(services, evidence, this.options, deploymentDomain)
  }

  async recentBlocks(): Promise<
    Array<{
      number: string
      timestamp: string
      transactions: number
      reference: string
      blockHash: string
      explorerUrl: string | null
    }>
  > {
    const latest = await this.publicClient.getBlockNumber()
    const floor = latest > 5n ? latest - 5n : 0n
    const blocks = await Promise.all(
      Array.from({ length: Number(latest - floor + 1n) }, (_, index) =>
        this.publicClient.getBlock({ blockNumber: latest - BigInt(index) }),
      ),
    )
    return blocks.map((block) => ({
      number: String(block.number),
      timestamp: new Date(Number(block.timestamp) * 1_000).toISOString(),
      transactions: block.transactions.length,
      reference: shortReference(block.hash),
      // `reference` is a label; a viewer checking the stand has to be able to
      // open the block, which a truncated hash makes impossible.
      blockHash: block.hash,
      explorerUrl: this.options.explorerUrl
        ? `${this.options.explorerUrl}/block/${block.number}`
        : null,
    }))
  }

  private async deployCustomContract(template: DemoTemplate): Promise<Hex | null> {
    if (template.source === 'attached') {
      const address = template.attachedAddress as Hex
      const code = await this.publicClient.getCode({ address })
      if (!code || code === '0x') throw new Error('the attached local-L1 address has no contract code')
      template.runtimeCode = code
      return address
    }
    if (template.source !== 'artifact' || !template.artifact) return null
    const bytecodeValue = template.artifact.bytecode
    const bytecode =
      typeof bytecodeValue === 'string' ? bytecodeValue : bytecodeValue?.object
    if (!bytecode || !/^0x[0-9a-fA-F]+$/.test(bytecode)) {
      throw new Error('the custom artifact has no valid creation bytecode')
    }
    const hash = await this.deployerWallet.deployContract({
      account: this.deployer,
      abi: template.artifact.abi as Abi,
      bytecode: bytecode as Hex,
      args: (template.constructorArgs ?? []) as never,
      chain: null,
    })
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash })
    if (!receipt.contractAddress || receipt.status !== 'success') {
      throw new Error('the custom contract did not deploy on local Ethereum')
    }
    const runtime = await this.publicClient.getCode({ address: receipt.contractAddress })
    if (!runtime || runtime === '0x') throw new Error('the deployed custom contract has empty runtime code')
    if (template.runtimeCode && runtime.toLowerCase() !== template.runtimeCode.toLowerCase()) {
      throw new Error('the deployed runtime code differs from the uploaded artifact')
    }
    template.runtimeCode = runtime
    return receipt.contractAddress
  }

  async prepareTemplate(
    template: DemoTemplate,
    onPhase: (phase: DemoPhase) => Promise<void>,
  ): Promise<DemoPreparedTemplate> {
    await assertPreparableTemplate(this.options.proverUrl, template)
    const evidence = await this.loadEvidence()
    let contractAddress = await this.deployCustomContract(template)
    const block = await this.publicClient.getBlockNumber()
    const deploymentDomain = (await this.publicClient.readContract({
      address: evidence.contracts!.manager,
      abi: await this.managerAbi(),
      functionName: 'deploymentDomain',
    })) as Hex
    const cardRoom = await prepareCardRoom(
      template,
      {
        publicClient: this.publicClient,
        wallet: this.deployerWallet,
        account: this.deployer,
        artifact: (name, alternatives) => this.artifact(name, alternatives),
      },
      this.cardRooms,
    )
    const erc7540Room = await prepareErc7540Room(
      template,
      {
        publicClient: this.publicClient,
        wallet: this.deployerWallet,
        account: this.deployer,
        artifact: (name, alternatives) => this.artifact(name, alternatives),
      },
      this.erc7540Rooms,
    )
    const erc4626Room = await prepareErc4626Room(
      template,
      {
        publicClient: this.publicClient,
        wallet: this.deployerWallet,
        account: this.deployer,
        artifact: (name, alternatives) => this.artifact(name, alternatives),
      },
      this.erc4626Rooms,
    )
    if (erc4626Room) contractAddress = erc4626Room.vault.address
    const ammRoom = await prepareAmmRoom(template, {
      publicClient: this.publicClient,
      wallet: this.deployerWallet,
      account: this.deployer,
      artifact: (name, alternatives) => this.artifact(name, alternatives),
    })
    if (ammRoom) {
      contractAddress = ammRoom.address
      // The address and exact runtime are persisted in `preparation` and the
      // template respectively, so checkpointing survives a coordinator restart
      // without deploying or trusting another copy.
      template.runtimeCode = ammRoom.runtimeCode
    }
    // The `amm-naive` preset deploys SequencedAMM the same clone-shaped way; it
    // reuses the generic runtimeCode + contractAddress forwarding in `baseSpec`.
    const naiveAmmRoom = await prepareNaiveAmmRoom(template, {
      publicClient: this.publicClient,
      wallet: this.deployerWallet,
      account: this.deployer,
      artifact: (name, alternatives) => this.artifact(name, alternatives),
    })
    if (naiveAmmRoom) {
      contractAddress = naiveAmmRoom.address
      template.runtimeCode = naiveAmmRoom.runtimeCode
    }
    const spec = baseSpec(
      template,
      1,
      Number(block + 1_000n),
      deploymentDomain,
      undefined,
      contractAddress,
      cardRoom,
      erc7540Room,
      erc4626Room,
    )
    await onPhase('COLD_EXECUTING')
    // '/v5/...' mirrors the prover binary's HTTP surface (changes only in the gated image ceremony).
    const prepared = await this.post<PreparedResponse>('/v5/rooms/prepare', spec)
    await this.post('/v5/cold-templates/execute', prepared.coldRequest)
    await onPhase('COLD_PROVING')
    const started = performance.now()
    const proof = await this.post<ProofResult>('/v5/cold-templates/prove', prepared.coldRequest)
    const coldProofMs = performance.now() - started
    if (!proof.ethereumSealB64 || proof.proofMode !== 'groth16') {
      throw new Error('cold preparation did not return an Ethereum Groth16 proof')
    }
    const registryArtifact = await this.artifact('ColdTemplateRegistry')
    const registry = evidence.contracts!.registry
    let registrationTransaction = evidence.transactions?.register ?? zeroHash
    try {
      await this.publicClient.readContract({
        address: registry,
        abi: registryArtifact.abi,
        functionName: 'get',
        args: [prepared.contractConfig.templateId],
      })
    } catch {
      const receipt = await this.sent(
        this.wallets.templateAdmin,
        registry,
        registryArtifact.abi,
        'register',
        [
          prepared.contractConfig.templateId,
          prepared.contractConfig.initialStateRoot,
          prepared.contractConfig.policyHash,
          prepared.contractConfig.proofProgramId,
          prepared.contractConfig.proofSystemVersion,
          prepared.contractConfig.genesisDataHash,
          evidence.contracts!.adapter,
          toHex(Buffer.from(proof.ethereumSealB64, 'base64')),
        ],
      )
      registrationTransaction = receipt.transactionHash
    }
    await onPhase('TEMPLATE_REGISTERED')
    return {
      templateId: prepared.contractConfig.templateId,
      initialStateRoot: prepared.contractConfig.initialStateRoot,
      policyHash: prepared.contractConfig.policyHash,
      proofProgramId: prepared.contractConfig.proofProgramId,
      proofSystemVersion: prepared.contractConfig.proofSystemVersion,
      initialApproverRoot: prepared.contractConfig.initialApproverRoot,
      initialActiveCount: prepared.contractConfig.initialActiveCount,
      initialParticipantRoot: prepared.contractConfig.initialParticipantRoot,
      initialParticipantCount: prepared.contractConfig.initialParticipantCount,
      // The registry statement now binds keccak256 of these exact framed
      // bytes, so the published data must be the prover's canonical frame,
      // never a JSON re-serialization of the request.
      canonicalColdTemplateData: prepared.contractConfig.canonicalColdTemplateData,
      coldProofMs,
      registrationTransaction,
      contractAddress,
      // The cold template id commits to these addresses, so publishing them is
      // publishing part of what was prepared. Without them a browser has to be
      // TOLD the duel's address by hand, and a typo is invisible until the
      // guest rejects the batch.
      ...(cardRoom ? { cardRoom: cardRoomDocument(cardRoom) } : {}),
      ...(erc7540Room ? { erc7540Room: erc7540RoomDocument(erc7540Room) } : {}),
      ...(erc4626Room ? { erc4626Room: erc4626RoomDocument(erc4626Room) } : {}),
    }
  }

  /**
   * The duel deployment a card template was prepared against.
   *
   * The cache is process memory; the published document is not. Reading the
   * code back off the chain is what lets a room outlive a coordinator restart,
   * which is the whole claim a long-lived room makes.
   */
  private async cardRoomFor(template: DemoTemplate): Promise<CardRoomDeployment | null> {
    const cached = this.cardRooms.get(template.id)
    if (cached) return cached
    const document = template.preparation?.cardRoom
    if (!document) return null
    const restored = await restoreCardRoom(document, { publicClient: this.publicClient })
    this.cardRooms.set(template.id, restored)
    return restored
  }

  private async erc7540RoomFor(template: DemoTemplate): Promise<Erc7540RoomDeployment | null> {
    const cached = this.erc7540Rooms.get(template.id)
    if (cached) return cached
    const document = template.preparation?.erc7540Room
    if (!document) return null
    const restored = await restoreErc7540Room(document, { publicClient: this.publicClient })
    this.erc7540Rooms.set(template.id, restored)
    return restored
  }

  private async erc4626RoomFor(template: DemoTemplate): Promise<Erc4626RoomDeployment | null> {
    const cached = this.erc4626Rooms.get(template.id)
    if (cached) return cached
    const document = template.preparation?.erc4626Room
    if (!document) return null
    const restored = await restoreErc4626Room(document, { publicClient: this.publicClient })
    this.erc4626Rooms.set(template.id, restored)
    return restored
  }

  async deployRoom(
    room: DemoRoom,
    template: DemoTemplate,
    onPhase: (phase: DemoPhase) => Promise<void>,
  ): Promise<{ chainRoomId: string; transaction: string }> {
    const evidence = await this.loadEvidence()
    const preparation = template.preparation!
    const managerAbi = await this.managerAbi()
    const manager = evidence.contracts!.manager
    const authorizationMode = template.authorizationMode === 'VALIDITY_ONLY' ? 1 : 0
    const productionConfirmations = assertProductionConfirmationDepth(
      DEFAULT_PRODUCTION_CONFIRMATIONS,
      'room L1 confirmations',
    )
    const config = {
      policyHash: preparation.policyHash,
      adapterPolicyRoot: keccak256(toBytes(`zkdeal/demo/${template.id}/adapter-policy`)),
      importPublisher: this.accounts.templateAdmin.address,
      minimumImportConfirmations: productionConfirmations,
      minimumDepositConfirmations: productionConfirmations,
      inactivityTimeout: 86_400n,
      authorizationMode,
      admissionSigner: authorizationMode === 1 ? this.accounts.service.address : zeroAddress,
      maximumAdmissionWindow: authorizationMode === 1 ? 50n : 0n,
      // `createRoom` requires `omissionPenalty <= minimumServiceBond /
      // MIN_SERVICE_BOND_MULTIPLE` (RoomManagerIntakeFacet.sol:118-124, and the
      // multiple is 4 in RoomManagerBase.sol:30). That division is integer, so a
      // bond of 1 makes the permitted penalty 0 and ANY non-zero penalty reverts
      // with BadInput() -- while a zero penalty is refused by the clause above
      // it. A VALIDITY_ONLY room therefore cannot be created with a bond below
      // the multiple, whatever the penalty is. Keep the bond at exactly the
      // multiple of the penalty so the smallest legal pair stays legal.
      minimumServiceBond: authorizationMode === 1 ? DEMO_MINIMUM_SERVICE_BOND : 0n,
      omissionPenalty: authorizationMode === 1 ? DEMO_OMISSION_PENALTY : 0n,
      participantCapacity: BigInt(template.participantCapacity),
    }
    await onPhase('DEPLOYED')
    const receipt = await this.sent(
      this.wallets.customer,
      manager,
      managerAbi,
      'createRoom',
      [
        config,
        preparation.templateId,
        preparation.initialApproverRoot,
        BigInt(preparation.initialActiveCount),
        preparation.initialParticipantRoot,
        BigInt(preparation.initialParticipantCount),
        preparation.canonicalColdTemplateData,
        [zeroAddress],
      ],
    )
    const events = parseEventLogs({
      abi: ROOM_CREATED_EVENT_ABI,
      logs: receipt.logs,
      eventName: 'RoomCreated',
      strict: false,
    })
    const roomId = (events[0]?.args as { roomId?: bigint } | undefined)?.roomId ?? null
    if (roomId === null || roomId === undefined) throw new Error('room deployment emitted no room identifier')
    return { chainRoomId: String(roomId), transaction: receipt.transactionHash }
  }

  /** The RoomManager's view of a room, in the shape a continuation needs. */
  private async readRoom(manager: Hex, managerAbi: Abi, chainRoomId: string): Promise<OnChainRoom> {
    const state = await this.publicClient.readContract({
      address: manager,
      abi: managerAbi,
      functionName: 'roomState',
      args: [BigInt(chainRoomId)],
    })
    // viem returns a named object for a named tuple and a positional array
    // otherwise; the indices are `IRoomManager.Room`'s field order.
    const named = state as Partial<Record<keyof OnChainRoom, unknown>>
    const at = (index: number, key: keyof OnChainRoom): unknown =>
      Array.isArray(state) ? state[index] : named[key]
    return {
      stateRoot: at(10, 'stateRoot') as Hex,
      participantRoot: at(11, 'participantRoot') as Hex,
      participantEpoch: Number(at(12, 'participantEpoch')),
      participantCount: Number(at(13, 'participantCount')),
      batchIndex: Number(at(18, 'batchIndex')),
      l2BlockHeight: Number(at(19, 'l2BlockHeight')),
      outboxEpoch: Number(at(29, 'outboxEpoch')),
    }
  }

  async checkpointRoom(
    room: DemoRoom,
    template: DemoTemplate,
    onPhase: (phase: DemoPhase) => Promise<void>,
    request?: DemoCheckpointRequest,
  ): Promise<DemoCheckpoint> {
    const evidence = await this.loadEvidence()
    const manager = evidence.contracts!.manager
    const managerAbi = await this.managerAbi()
    // The head is read AFTER the caller holds the proving slot, so a checkpoint
    // that queued behind another proof does not spend its inclusion window
    // waiting.
    const criticalRpcs = this.publicClients as unknown as readonly SettlementRpc[]
    const currentBlock = (await readAgreedBlock(criticalRpcs, { blockTag: 'latest' })).number!
    const deploymentDomain = (await this.publicClient.readContract({
      address: manager,
      abi: managerAbi,
      functionName: 'deploymentDomain',
    })) as Hex
    return runCheckpoint(
      {
        manager,
        managerAbi,
        deploymentDomain,
        currentBlock,
        cardRoom: await this.cardRoomFor(template),
        erc7540Room: await this.erc7540RoomFor(template),
        erc4626Room: await this.erc4626RoomFor(template),
        explorerUrl: this.options.explorerUrl ?? null,
        chainId: () => this.publicClient.getChainId(),
        post: (endpoint, body) => this.post(endpoint, body),
        readRoom: () => this.readRoom(manager, managerAbi, room.chainRoomId!),
        submit: async (args, lifecycle) => {
          const expectedCalldata = encodeFunctionData({
            abi: managerAbi,
            functionName: 'submitBatch',
            args,
          } as never)
          const broadcastIdenticalCalldata = () =>
            this.deployerWallet.writeContract({
              account: this.deployerWallet.account!,
              address: manager,
              abi: managerAbi,
              functionName: 'submitBatch',
              args,
              chain: null,
              gas: 8_000_000n,
            } as never)
          const initialHash = await broadcastIdenticalCalldata()
          // The gauge is the durable owner deadline contract
          // (zkdeal_deadline_risk_jobs in the deployment metric catalog); the
          // log line keeps the operator-facing margin context. Held in an
          // object so the closure assignment survives TS flow narrowing.
          const deadlineRisk: { release: (() => void) | null } = { release: null }
          try {
            const receipt = await watchSettlement({
              operation: 'submitBatch',
              rpcs: criticalRpcs,
              initialHash,
              expectedCalldata,
              broadcastIdenticalCalldata,
              l1InclusionDeadline: lifecycle.deadlineBlock,
              onAccepted: lifecycle.onAccepted,
              onRetracted: lifecycle.onRetracted,
              onDeadlineAlert: (remainingBlocks) => {
                deadlineRisk.release ??= trackDeadlineRiskJob('standard')
                console.warn(
                  `[zkdeal] submitBatch has ${remainingBlocks} L1 block(s) of inclusion margin left`,
                )
              },
            })
            return {
              transactionHash: receipt.transactionHash,
              blockNumber: receipt.blockNumber,
              blockHash: receipt.blockHash,
              finalizedBlockNumber: receipt.finalizedBlockNumber,
              finalizedBlockHash: receipt.finalizedBlockHash,
            }
          } finally {
            deadlineRisk.release?.()
          }
        },
      },
      room,
      template,
      onPhase,
      request,
    )
  }
}
