'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatEther,
  http,
  parseEventLogs,
  parseSignature,
  type Hex,
} from 'viem'
import {
  ArrowRight,
  Boxes,
  Check,
  Clock3,
  Cpu,
  ExternalLink,
  LoaderCircle,
  RefreshCcw,
  ShieldCheck,
  Wallet,
} from 'lucide-react'
import { buildRoomCreation, toParticipantCapacity } from '@/lib/room-pool-creation'
import {
  clampManagedRoomDeadline,
  MANAGED_ROOM_LIFECYCLE,
  validManagedRoomCapacity,
} from '@/lib/managed-room'

const zeroAddress = '0x0000000000000000000000000000000000000000'
const zeroHash = `0x${'0'.repeat(64)}` as Hex

const poolAbi = [
  {
    type: 'function',
    name: 'presets',
    stateMutability: 'view',
    inputs: [{ name: 'presetId', type: 'bytes32' }],
    outputs: [
      { name: 'coldTemplateId', type: 'bytes32' },
      { name: 'policyHash', type: 'bytes32' },
      { name: 'exists', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'nodeState',
    stateMutability: 'view',
    inputs: [{ name: 'nodeId', type: 'bytes32' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'serviceAccount', type: 'address' },
          { name: 'boundAccount', type: 'address' },
          { name: 'metadataHash', type: 'bytes32' },
          { name: 'pendingProfileHash', type: 'bytes32' },
          { name: 'status', type: 'uint8' },
          { name: 'heartbeatTimeoutBlocks', type: 'uint64' },
          { name: 'lastHealthyBlock', type: 'uint64' },
          { name: 'profileNonce', type: 'uint64' },
          { name: 'activeAllocations', type: 'uint64' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'slotState',
    stateMutability: 'view',
    inputs: [
      { name: 'nodeId', type: 'bytes32' },
      { name: 'slotId', type: 'bytes32' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'presetId', type: 'bytes32' },
          { name: 'minDeadlineBlocks', type: 'uint64' },
          { name: 'maxDeadlineBlocks', type: 'uint64' },
          { name: 'localProofTargetSeconds', type: 'uint64' },
          { name: 'capacityCap', type: 'uint32' },
          { name: 'readySlots', type: 'uint32' },
          { name: 'exists', type: 'bool' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'prices',
    stateMutability: 'view',
    inputs: [
      { name: 'nodeId', type: 'bytes32' },
      { name: 'slotId', type: 'bytes32' },
    ],
    outputs: [
      { name: 'epoch', type: 'uint64' },
      { name: 'validUntilBlock', type: 'uint64' },
      { name: 'accessPrice', type: 'uint128' },
      { name: 'coldPreparationPrice', type: 'uint128' },
      { name: 'pricePerDeadlineBlock', type: 'uint128' },
      { name: 'runningPricePerBlock', type: 'uint128' },
    ],
  },
  {
    type: 'function',
    name: 'quote',
    stateMutability: 'view',
    inputs: [
      { name: 'nodeId', type: 'bytes32' },
      { name: 'slotId', type: 'bytes32' },
      { name: 'deadlineBlocksFromStart', type: 'uint64' },
      { name: 'priceEpoch', type: 'uint64' },
    ],
    outputs: [
      { name: 'fixedCharge', type: 'uint256' },
      { name: 'runningEscrow', type: 'uint256' },
      { name: 'totalCharge', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'reserveAndStartWithPermit',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'request',
        type: 'tuple',
        components: [
          { name: 'nodeId', type: 'bytes32' },
          { name: 'slotId', type: 'bytes32' },
          { name: 'presetId', type: 'bytes32' },
          { name: 'deadlineBlocksFromStart', type: 'uint64' },
          { name: 'priceEpoch', type: 'uint64' },
          { name: 'maxTokenCharge', type: 'uint256' },
        ],
      },
      {
        name: 'creation',
        type: 'tuple',
        components: [
          {
            name: 'config',
            type: 'tuple',
            components: [
              { name: 'policyHash', type: 'bytes32' },
              { name: 'adapterPolicyRoot', type: 'bytes32' },
              { name: 'importPublisher', type: 'address' },
              { name: 'minimumImportConfirmations', type: 'uint64' },
              { name: 'minimumDepositConfirmations', type: 'uint64' },
              { name: 'inactivityTimeout', type: 'uint64' },
              { name: 'authorizationMode', type: 'uint8' },
              { name: 'admissionSigner', type: 'address' },
              { name: 'maximumAdmissionWindow', type: 'uint64' },
              { name: 'minimumServiceBond', type: 'uint96' },
              { name: 'omissionPenalty', type: 'uint96' },
              { name: 'participantCapacity', type: 'uint64' },
            ],
          },
          { name: 'coldTemplateId', type: 'bytes32' },
          { name: 'initialApproverRoot', type: 'bytes32' },
          { name: 'initialActiveApproverCount', type: 'uint64' },
          { name: 'initialParticipantRoot', type: 'bytes32' },
          { name: 'initialParticipantCount', type: 'uint64' },
          { name: 'canonicalColdTemplateData', type: 'bytes' },
          { name: 'supportedAssets', type: 'address[]' },
        ],
      },
      {
        name: 'permit',
        type: 'tuple',
        components: [
          { name: 'value', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'v', type: 'uint8' },
          { name: 'r', type: 'bytes32' },
          { name: 's', type: 'bytes32' },
        ],
      },
    ],
    outputs: [
      { name: 'allocationId', type: 'bytes32' },
      { name: 'roomId', type: 'uint64' },
    ],
  },
  {
    type: 'event',
    name: 'AllocationReserved',
    inputs: [
      { name: 'allocationId', type: 'bytes32', indexed: true },
      { name: 'user', type: 'address', indexed: true },
      { name: 'nodeId', type: 'bytes32', indexed: true },
      { name: 'slotId', type: 'bytes32', indexed: false },
      { name: 'deadlineBlocksFromStart', type: 'uint64', indexed: false },
      { name: 'tokenCharge', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AllocationUsed',
    inputs: [
      { name: 'allocationId', type: 'bytes32', indexed: true },
      { name: 'roomId', type: 'uint64', indexed: true },
      { name: 'startBlock', type: 'uint64', indexed: false },
      { name: 'proofDeadlineBlock', type: 'uint64', indexed: false },
    ],
  },
] as const

const tokenAbi = [
  {
    type: 'function',
    name: 'nonces',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

interface ManagedProfile {
  nodeId: Hex
  slotId: Hex
  presetId: Hex
  participantCapacity: number
  nodeLabel: string
  slotLabel: string
  presetLabel: string
}

interface PublicConfig {
  chainId: number
  rpcUrl?: string
  roomPool?: string
  accessToken?: string
  l1BlockTimeSec?: number
  managedRoomProfile?: ManagedProfile
}

interface PoolSession {
  chainId: number
  pool: Hex
  token: Hex
  rpcUrl: string
  explorerUrl: string | null
}

interface LivePool {
  nodeReady: boolean
  activeAllocations: number
  minDeadline: number
  maxDeadline: number
  localProofSeconds: number
  capacityCap: number
  readySlots: number
  priceEpoch: number
  priceValidUntil: number
  presetReady: boolean
}

interface Quote {
  fixed: bigint
  running: bigint
  total: bigint
  deadline: number
  participantCapacity: number
  profile: ManagedProfile
  session: PoolSession
  live: LivePool
}

interface StartedRoom {
  allocationId: Hex
  roomId: string
  transactionHash: Hex
  explorerUrl: string | null
}

const short = (value: string) =>
  value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value

function isBytes32(value: string): value is Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(value)
}

async function fetchPublicConfig(): Promise<PublicConfig> {
  const response = await fetch('/config', { cache: 'no-store' })
  if (!response.ok) throw new Error('The public managed-room configuration is unavailable.')
  return (await response.json()) as PublicConfig
}

async function fetchSystemRecommendation(): Promise<{
  blocks: number
  explorerUrl: string | null
}> {
  const response = await fetch('/demo/v1/system', { cache: 'no-store' })
  if (!response.ok) return { blocks: 1, explorerUrl: null }
  const system = (await response.json()) as {
    gpu?: { recommendedDeadlineBlocks?: number } | null
    checkpointPolicy?: { defaultDeadlineBlocks?: number } | null
    explorerUrl?: string | null
  }
  return {
    blocks:
      system.checkpointPolicy?.defaultDeadlineBlocks
      ?? system.gpu?.recommendedDeadlineBlocks
      ?? 1,
    explorerUrl: system.explorerUrl ?? null,
  }
}

function Stage({
  number,
  title,
  detail,
  active,
  complete,
}: {
  number: number
  title: string
  detail: string
  active: boolean
  complete: boolean
}) {
  return (
    <div
      className={`rounded-xl border p-3 ${
        active
          ? 'border-primary/60 bg-primary/10'
          : complete
            ? 'border-success/40 bg-success/5'
            : 'border-border bg-card/70'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`grid size-6 place-items-center rounded-full text-xs ${complete ? 'bg-success text-background' : 'bg-secondary'}`}>
          {complete ? <Check className="size-3.5" /> : number}
        </span>
        <strong className="text-sm">{title}</strong>
      </div>
      <p className="mt-1 pl-8 text-[0.68rem] leading-relaxed text-muted-foreground">{detail}</p>
    </div>
  )
}

export function RoomPoolConsole() {
  const [profile, setProfile] = useState<ManagedProfile>({
    nodeId: zeroHash,
    slotId: zeroHash,
    presetId: zeroHash,
    participantCapacity: 128,
    nodeLabel: 'Managed proof node',
    slotLabel: 'Managed proving slot',
    presetLabel: 'Ready room preset',
  })
  const [guided, setGuided] = useState(false)
  const [deadlineBlocks, setDeadlineBlocks] = useState(1)
  const [blockTime, setBlockTime] = useState(12)
  const [live, setLive] = useState<LivePool | null>(null)
  const [quote, setQuote] = useState<Quote | null>(null)
  const [status, setStatus] = useState('Reading managed proof capacity…')
  const [busyQuote, setBusyQuote] = useState(false)
  const [busyWallet, setBusyWallet] = useState(false)
  const [started, setStarted] = useState<StartedRoom | null>(null)
  const initialRecommendation = useRef(1)
  const quoteGeneration = useRef(0)

  const approximateSeconds = useMemo(
    () => Math.round(deadlineBlocks * blockTime),
    [deadlineBlocks, blockTime],
  )
  const profileValid =
    isBytes32(profile.nodeId) && isBytes32(profile.slotId) && isBytes32(profile.presetId)

  useEffect(() => {
    let alive = true
    void Promise.all([fetchPublicConfig(), fetchSystemRecommendation()])
      .then(([config, recommendation]) => {
        if (!alive) return
        setBlockTime(config.l1BlockTimeSec ?? 12)
        initialRecommendation.current = recommendation.blocks
        if (config.managedRoomProfile) {
          setProfile(config.managedRoomProfile)
          setGuided(true)
        } else {
          setStatus(
            'This deployment has no managed room profile. Open Advanced and enter the published node, slot and preset identifiers.',
          )
        }
      })
      .catch((error) => {
        if (alive) setStatus(error instanceof Error ? error.message : 'Managed capacity is unavailable.')
      })
    return () => {
      alive = false
    }
  }, [])

  async function readSession(): Promise<PoolSession> {
    const [config, recommendation] = await Promise.all([
      fetchPublicConfig(),
      fetchSystemRecommendation(),
    ])
    const pool = String(config.roomPool ?? zeroAddress) as Hex
    const token = String(config.accessToken ?? zeroAddress) as Hex
    if (pool.toLowerCase() === zeroAddress || token.toLowerCase() === zeroAddress) {
      throw new Error('The coordinator has not published the managed-room contracts.')
    }
    if (!Number.isSafeInteger(config.chainId) || config.chainId < 1) {
      throw new Error('The coordinator published no usable chain id.')
    }
    return {
      chainId: config.chainId,
      pool,
      token,
      rpcUrl: config.rpcUrl ?? '/rpc',
      explorerUrl: recommendation.explorerUrl,
    }
  }

  async function refreshQuote() {
    const generation = ++quoteGeneration.current
    if (!profileValid) {
      setQuote(null)
      setStatus('Enter valid 32-byte node, slot and preset identifiers in Advanced.')
      return
    }
    if (!validManagedRoomCapacity(profile.participantCapacity)) {
      setQuote(null)
      setStatus('Participant capacity must be a power of two from 128 through 32768.')
      return
    }
    setBusyQuote(true)
    setStarted(null)
    try {
      const session = await readSession()
      const publicClient = createPublicClient({ transport: http(session.rpcUrl) })
      const [node, slot, price, preset, head] = await Promise.all([
        publicClient.readContract({
          address: session.pool,
          abi: poolAbi,
          functionName: 'nodeState',
          args: [profile.nodeId],
        }),
        publicClient.readContract({
          address: session.pool,
          abi: poolAbi,
          functionName: 'slotState',
          args: [profile.nodeId, profile.slotId],
        }),
        publicClient.readContract({
          address: session.pool,
          abi: poolAbi,
          functionName: 'prices',
          args: [profile.nodeId, profile.slotId],
        }),
        publicClient.readContract({
          address: session.pool,
          abi: poolAbi,
          functionName: 'presets',
          args: [profile.presetId],
        }),
        publicClient.getBlockNumber(),
      ])
      if (generation !== quoteGeneration.current) return
      const nextLive: LivePool = {
        nodeReady: Number(node.status) === 2,
        activeAllocations: Number(node.activeAllocations),
        minDeadline: Number(slot.minDeadlineBlocks),
        maxDeadline: Number(slot.maxDeadlineBlocks),
        localProofSeconds: Number(slot.localProofTargetSeconds),
        capacityCap: Number(slot.capacityCap),
        readySlots: Number(slot.readySlots),
        priceEpoch: Number(price[0]),
        priceValidUntil: Number(price[1]),
        presetReady: Boolean(preset[2]) && slot.presetId.toLowerCase() === profile.presetId.toLowerCase(),
      }
      setLive(nextLive)
      if (!slot.exists) throw new Error('The selected managed proving slot is not published.')
      if (!nextLive.nodeReady) throw new Error('The selected proof node is not Ready.')
      if (nextLive.readySlots < 1) throw new Error('No prepared managed-room capacity is available.')
      if (!nextLive.presetReady) throw new Error('The selected ready-room preset is unavailable.')
      if (nextLive.priceEpoch < 1 || BigInt(nextLive.priceValidUntil) < head) {
        throw new Error('The published price has expired; the service account must publish a new epoch.')
      }
      const chosenDeadline = clampManagedRoomDeadline(
        deadlineBlocks === 1 ? initialRecommendation.current : deadlineBlocks,
        nextLive.minDeadline,
        nextLive.maxDeadline,
      )
      if (chosenDeadline !== deadlineBlocks) setDeadlineBlocks(chosenDeadline)
      const result = await publicClient.readContract({
        address: session.pool,
        abi: poolAbi,
        functionName: 'quote',
        args: [
          profile.nodeId,
          profile.slotId,
          BigInt(chosenDeadline),
          BigInt(nextLive.priceEpoch),
        ],
      })
      if (generation !== quoteGeneration.current) return
      setQuote({
        fixed: result[0],
        running: result[1],
        total: result[2],
        deadline: chosenDeadline,
        participantCapacity: profile.participantCapacity,
        profile: { ...profile },
        session,
        live: nextLive,
      })
      setStatus('Live capacity and price verified. No wallet connection was required.')
    } catch (error) {
      if (generation !== quoteGeneration.current) return
      setQuote(null)
      setStatus(error instanceof Error ? error.message : 'The live quote could not be loaded.')
    } finally {
      if (generation === quoteGeneration.current) setBusyQuote(false)
    }
  }

  useEffect(() => {
    quoteGeneration.current += 1
    if (!profileValid) return
    setQuote(null)
    const timer = window.setTimeout(() => void refreshQuote(), 350)
    return () => window.clearTimeout(timer)
    // Every guided or advanced change invalidates and then revalidates the quote.
  }, [
    profile.nodeId,
    profile.slotId,
    profile.presetId,
    profile.participantCapacity,
    deadlineBlocks,
    profileValid,
  ])

  function clients() {
    if (!window.ethereum) throw new Error('A Web3 wallet is required only for the confirmation step.')
    const transport = custom(window.ethereum)
    return {
      publicClient: createPublicClient({ transport }),
      walletClient: createWalletClient({ transport }),
    }
  }

  async function reserveAndStartDirectly() {
    if (!quote) return
    setBusyWallet(true)
    setStarted(null)
    try {
      const { publicClient, walletClient } = clients()
      const walletChainId = await publicClient.getChainId()
      if (walletChainId !== quote.session.chainId) {
        throw new Error(
          `Your wallet is on chain ${walletChainId}; this managed room is on chain ${quote.session.chainId}. Switch networks before signing.`,
        )
      }
      const account = (await walletClient.requestAddresses())[0]
      if (!account) throw new Error('The wallet did not expose an account.')
      const readClient = createPublicClient({ transport: http(quote.session.rpcUrl) })
      const [nonce, preset] = await Promise.all([
        readClient.readContract({
          address: quote.session.token,
          abi: tokenAbi,
          functionName: 'nonces',
          args: [account],
        }),
        readClient.readContract({
          address: quote.session.pool,
          abi: poolAbi,
          functionName: 'presets',
          args: [quote.profile.presetId],
        }),
      ])
      if (!preset[2]) throw new Error('The selected ready-room preset is no longer registered.')
      const creation = buildRoomCreation({
        account,
        coldTemplateId: preset[0],
        policyHash: preset[1],
        participantCapacity: toParticipantCapacity(quote.participantCapacity),
      })
      const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60)
      setStatus('Wallet step 1 of 2: approve the ERC-2612 permit signature. This is not a transaction.')
      const signature = await walletClient.signTypedData({
        account,
        domain: {
          name: 'zkdeal Access Token',
          version: '1',
          chainId: quote.session.chainId,
          verifyingContract: quote.session.token,
        },
        types: {
          Permit: [
            { name: 'owner', type: 'address' },
            { name: 'spender', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
          ],
        },
        primaryType: 'Permit',
        message: {
          owner: account,
          spender: quote.session.pool,
          value: quote.total,
          nonce,
          deadline: permitDeadline,
        },
      })
      const parsed = parseSignature(signature)
      setStatus('Wallet step 2 of 2: confirm one transaction to reserve capacity and start the room.')
      const hash = await walletClient.writeContract({
        account,
        chain: null,
        address: quote.session.pool,
        abi: poolAbi,
        functionName: 'reserveAndStartWithPermit',
        args: [
          {
            nodeId: quote.profile.nodeId,
            slotId: quote.profile.slotId,
            presetId: quote.profile.presetId,
            deadlineBlocksFromStart: BigInt(quote.deadline),
            priceEpoch: BigInt(quote.live.priceEpoch),
            maxTokenCharge: quote.total,
          },
          creation,
          {
            value: quote.total,
            deadline: permitDeadline,
            v: Number(parsed.v ?? parsed.yParity + 27),
            r: parsed.r,
            s: parsed.s,
          },
        ],
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') {
        throw new Error(`Transaction ${short(hash)} reverted. No room is presented as started.`)
      }
      const reserved = parseEventLogs({
        abi: poolAbi,
        logs: receipt.logs,
        eventName: 'AllocationReserved',
        strict: false,
      })[0]
      const used = parseEventLogs({
        abi: poolAbi,
        logs: receipt.logs,
        eventName: 'AllocationUsed',
        strict: false,
      })[0]
      const allocationId = reserved?.args.allocationId
      const roomId = used?.args.roomId
      if (!allocationId || roomId === undefined) {
        throw new Error('The successful receipt did not contain both allocation and room events.')
      }
      setStarted({
        allocationId,
        roomId: roomId.toString(),
        transactionHash: hash,
        explorerUrl: quote.session.explorerUrl,
      })
      setQuote(null)
      setStatus('Room started.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'The wallet confirmation failed.')
    } finally {
      setBusyWallet(false)
    }
  }

  const stage = started ? 4 : quote ? 3 : live ? 2 : 1

  return (
    <main className="grid-bg min-h-screen bg-background px-5 py-8 text-foreground">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="font-mono text-xs uppercase tracking-[0.22em] text-primary">
              Managed proof room
            </div>
            <h1 className="mt-2 text-3xl font-semibold">Start a managed room in four clear steps</h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Capacity, limits and the current price are read from the coordinator and contract
              before a wallet is needed.
            </p>
          </div>
          <a className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-secondary" href="/demo">
            Back to live demo
          </a>
        </div>

        <div className="mt-6 grid gap-3 md:grid-cols-4">
          <Stage number={1} title="Configuration" detail="Use the stand’s managed profile." active={stage === 1} complete={stage > 1} />
          <Stage number={2} title="Deadline" detail="Choose within the live slot limits." active={stage === 2} complete={stage > 2} />
          <Stage number={3} title="Price review" detail="Review fixed charge and escrow." active={stage === 3} complete={stage > 3} />
          <Stage number={4} title="Wallet confirmation" detail="One permit signature, then one transaction." active={stage === 4} complete={Boolean(started)} />
        </div>

        <section className="mt-4 grid gap-4 lg:grid-cols-[1.15fr_.85fr]">
          <div className="rounded-2xl border border-border bg-card/85 p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Boxes className="size-5 text-primary" />
                <div>
                  <strong>{guided ? profile.presetLabel : 'Manual managed profile'}</strong>
                  <p className="text-xs text-muted-foreground">
                    {profile.nodeLabel} · {profile.slotLabel}
                  </p>
                </div>
              </div>
              <span className={`rounded-full border px-2 py-1 font-mono text-[0.64rem] ${live?.nodeReady && live.readySlots > 0 ? 'border-success/40 bg-success/10 text-success' : 'border-border text-muted-foreground'}`}>
                {live?.nodeReady ? `${live.readySlots} ready` : 'checking'}
              </span>
            </div>

            <div className="mt-5 rounded-xl border border-primary/25 bg-primary/5 p-4">
              <div className="flex items-start gap-3">
                <Clock3 className="mt-0.5 size-5 text-primary" />
                <div className="flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <strong>Proof deadline: start + {deadlineBlocks} L1 blocks</strong>
                      <p className="text-xs text-muted-foreground">
                        Approximately {approximateSeconds} seconds at {blockTime}-second blocks.
                      </p>
                    </div>
                    {live ? (
                      <span className="font-mono text-[0.65rem] text-muted-foreground">
                        allowed {live.minDeadline}-{live.maxDeadline}
                      </span>
                    ) : null}
                  </div>
                  <input
                    className="mt-4 w-full accent-[var(--primary)]"
                    type="range"
                    min={live?.minDeadline ?? 1}
                    max={Math.min(live?.maxDeadline ?? 100, 100)}
                    value={Math.min(deadlineBlocks, 100)}
                    onChange={(event) => {
                      setDeadlineBlocks(Number(event.target.value))
                      setQuote(null)
                    }}
                  />
                  <label className="mt-3 block text-xs text-muted-foreground">
                    Exact blocks
                    <input
                      className="ml-2 w-24 rounded-md border border-border bg-background px-2 py-1 font-mono text-foreground"
                      type="number"
                      min={live?.minDeadline ?? 1}
                      max={live?.maxDeadline ?? 7_200}
                      value={deadlineBlocks}
                      onChange={(event) => {
                        setDeadlineBlocks(Number(event.target.value))
                        setQuote(null)
                      }}
                    />
                  </label>
                </div>
              </div>
            </div>

            <details className="mt-4 rounded-xl border border-border bg-background/45 p-4" open={!guided}>
              <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Changing an identifier invalidates the quote and checks the live contract again.
                The current price epoch is discovered automatically and remains read-only.
              </p>
              <div className="mt-3 grid gap-3">
                {[
                  ['Node hash', 'nodeId'],
                  ['Slot hash', 'slotId'],
                  ['Preset hash', 'presetId'],
                ].map(([label, key]) => (
                  <label key={key} className="text-xs text-muted-foreground">
                    {label}
                    <input
                      value={profile[key as 'nodeId' | 'slotId' | 'presetId']}
                      onChange={(event) => {
                        setProfile((current) => ({ ...current, [key]: event.target.value as Hex }))
                        setQuote(null)
                      }}
                      className="mt-1 w-full rounded-md border border-border bg-background px-2 py-2 font-mono text-[0.68rem] text-foreground"
                    />
                  </label>
                ))}
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-xs text-muted-foreground">
                    Participant capacity
                    <input
                      type="number"
                      min={128}
                      max={32_768}
                      value={profile.participantCapacity}
                      onChange={(event) => {
                        setProfile((current) => ({
                          ...current,
                          participantCapacity: Number(event.target.value),
                        }))
                        setQuote(null)
                      }}
                      className="mt-1 w-full rounded-md border border-border bg-background px-2 py-2 font-mono text-foreground"
                    />
                  </label>
                  <label className="text-xs text-muted-foreground">
                    Current price epoch (read-only)
                    <input
                      readOnly
                      value={live?.priceEpoch ?? 'discovering'}
                      className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-2 font-mono text-foreground"
                    />
                  </label>
                </div>
              </div>
            </details>

            <div className="mt-4 flex items-start gap-2 rounded-xl border border-border bg-background/40 p-3 text-xs text-muted-foreground">
              {busyQuote ? <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin" /> : <RefreshCcw className="mt-0.5 size-4 shrink-0" />}
              <span>{status}</span>
            </div>
          </div>

          <aside className="space-y-4">
            <div className="rounded-2xl border border-border bg-card/85 p-5">
              <div className="flex items-center gap-2 font-mono text-xs uppercase text-primary">
                <Cpu className="size-4" />
                Live price review
              </div>
              {quote ? (
                <div className="mt-4 space-y-3">
                  <PriceRow label="Fixed access + deadline charge" value={formatEther(quote.fixed)} />
                  <PriceRow label="Running service escrow" value={formatEther(quote.running)} />
                  <PriceRow label="Maximum wallet authorization" value={formatEther(quote.total)} strong />
                  <div className="rounded-lg border border-border bg-background/40 p-3 text-xs leading-relaxed text-muted-foreground">
                    The fixed charge pays for access and the selected deadline. Running escrow pays
                    proof service as blocks are used; unused running credit may be refunded when
                    capacity is released.
                  </div>
                  <div className="font-mono text-[0.65rem] text-muted-foreground">
                    epoch {quote.live.priceEpoch} · valid through block {quote.live.priceValidUntil}
                  </div>
                </div>
              ) : (
                <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                  The quote appears automatically after the node, slot, preset and deadline pass
                  live validation. Viewing it never connects a wallet.
                </p>
              )}
            </div>

            <div className="rounded-2xl border border-primary/30 bg-primary/5 p-5">
              <div className="flex items-center gap-2">
                <Wallet className="size-5 text-primary" />
                <strong>Wallet confirmation</strong>
              </div>
              <ol className="mt-3 space-y-2 text-xs text-muted-foreground">
                <li>1. Sign an ERC-2612 permit-no gas and no transaction.</li>
                <li>2. Confirm one transaction that reserves capacity and starts the room.</li>
              </ol>
              <button
                type="button"
                onClick={() => void reserveAndStartDirectly()}
                disabled={busyWallet || !quote}
                className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground disabled:opacity-50"
              >
                {busyWallet ? <LoaderCircle className="size-4 animate-spin" /> : <Wallet className="size-4" />}
                Sign permit and start room
              </button>
            </div>
          </aside>
        </section>

        {started ? (
          <section className="mt-4 rounded-2xl border border-success/40 bg-success/10 p-5">
            <div className="flex items-center gap-2 text-success">
              <ShieldCheck className="size-6" />
              <h2 className="text-xl font-semibold">Room started.</h2>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
              {MANAGED_ROOM_LIFECYCLE.map(
                (label, index) => (
                  <div key={label} className="contents">
                    <span className={`rounded-lg border px-3 py-2 ${index < 3 ? 'border-success/40 bg-background/30 text-success' : 'border-border text-muted-foreground'}`}>
                      {index < 3 ? <Check className="mr-1 inline size-3.5" /> : null}
                      {label}
                    </span>
                    {index < 3 ? <ArrowRight className="size-4 text-muted-foreground" /> : null}
                  </div>
                ),
              )}
            </div>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
              <div><dt className="text-muted-foreground">Allocation</dt><dd className="font-mono">{short(started.allocationId)}</dd></div>
              <div><dt className="text-muted-foreground">Room</dt><dd className="font-mono">#{started.roomId}</dd></div>
              <div>
                <dt className="text-muted-foreground">Transaction</dt>
                <dd>
                  {started.explorerUrl ? (
                    <a className="inline-flex items-center gap-1 font-mono text-primary" href={`${started.explorerUrl.replace(/\/$/, '')}/tx/${started.transactionHash}`} target="_blank" rel="noreferrer">
                      {short(started.transactionHash)} <ExternalLink className="size-3" />
                    </a>
                  ) : (
                    <span className="font-mono">{short(started.transactionHash)}</span>
                  )}
                </dd>
              </div>
            </dl>
            <details className="mt-3 text-xs text-muted-foreground">
              <summary className="cursor-pointer">Technical details</summary>
              <p className="mt-2">Contract allocation status: USED (enum value 2). Allocation id: {started.allocationId}</p>
            </details>
          </section>
        ) : null}
      </div>
    </main>
  )
}

function PriceRow({
  label,
  value,
  strong = false,
}: {
  label: string
  value: string
  strong?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border pb-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <strong className={strong ? 'text-primary' : ''}>{value} ZKDL</strong>
    </div>
  )
}
