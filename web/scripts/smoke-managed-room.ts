import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseEventLogs,
  parseSignature,
  toBytes,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { buildRoomCreation } from '../lib/room-pool-creation.js'

const baseUrl = (process.argv[2] ?? 'http://127.0.0.1:3100').replace(/\/$/, '')
const releaseAfterStart = process.argv.includes('--release')
const account = privateKeyToAccount(
  keccak256(toBytes('zkdeal/kurtosis/role/customer')),
)

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
    type: 'function',
    name: 'disposeRoom',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'allocationId', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'confirmCapacityProfile',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'nodeId', type: 'bytes32' },
      { name: 'profileHash', type: 'bytes32' },
      { name: 'slotIds', type: 'bytes32[]' },
      { name: 'readySlots', type: 'uint32[]' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'publishPriceEpoch',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'nodeId', type: 'bytes32' },
      { name: 'slotId', type: 'bytes32' },
      { name: 'validUntilBlock', type: 'uint64' },
      { name: 'accessPrice', type: 'uint128' },
      { name: 'coldPreparationPrice', type: 'uint128' },
      { name: 'pricePerDeadlineBlock', type: 'uint128' },
      { name: 'runningPricePerBlock', type: 'uint128' },
    ],
    outputs: [],
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

async function json(path: string) {
  const response = await fetch(`${baseUrl}${path}`)
  if (!response.ok) throw new Error(`${path} returned ${response.status}`)
  return response.json()
}

async function main() {
const [config, system] = await Promise.all([json('/config'), json('/demo/v1/system')])
const profile = config.managedRoomProfile as {
  nodeId: Hex
  slotId: Hex
  presetId: Hex
  participantCapacity: number
}
if (!profile) throw new Error('no managedRoomProfile is published')

const rpcUrl = new URL(config.rpcUrl ?? '/rpc', `${baseUrl}/`).toString()
const publicClient = createPublicClient({ transport: http(rpcUrl) })
const walletClient = createWalletClient({ account, transport: http(rpcUrl) })
const pool = config.roomPool as Hex
const token = config.accessToken as Hex

const [node, slot, price, preset, head] = await Promise.all([
  publicClient.readContract({
    address: pool,
    abi: poolAbi,
    functionName: 'nodeState',
    args: [profile.nodeId],
  }),
  publicClient.readContract({
    address: pool,
    abi: poolAbi,
    functionName: 'slotState',
    args: [profile.nodeId, profile.slotId],
  }),
  publicClient.readContract({
    address: pool,
    abi: poolAbi,
    functionName: 'prices',
    args: [profile.nodeId, profile.slotId],
  }),
  publicClient.readContract({
    address: pool,
    abi: poolAbi,
    functionName: 'presets',
    args: [profile.presetId],
  }),
  publicClient.getBlockNumber(),
])

if (Number(node.status) !== 2) throw new Error(`managed node status is ${node.status}, not Ready`)
if (!slot.exists || Number(slot.readySlots) < 1) throw new Error('no managed slot is ready')
if (!preset[2] || slot.presetId.toLowerCase() !== profile.presetId.toLowerCase()) {
  throw new Error('managed preset is unavailable')
}
if (BigInt(price[1]) < head) throw new Error('managed-room price is expired')
const recommendation =
  system.checkpointPolicy?.defaultDeadlineBlocks
  ?? system.gpu?.recommendedDeadlineBlocks
  ?? Number(slot.minDeadlineBlocks)
const deadline = Math.max(
  Number(slot.minDeadlineBlocks),
  Math.min(Number(slot.maxDeadlineBlocks), Math.round(recommendation)),
)
const quote = await publicClient.readContract({
  address: pool,
  abi: poolAbi,
  functionName: 'quote',
  args: [profile.nodeId, profile.slotId, BigInt(deadline), BigInt(price[0])],
})
if (quote[2] !== quote[0] + quote[1] || quote[2] === 0n) {
  throw new Error('managed-room quote is inconsistent')
}

const nonce = await publicClient.readContract({
  address: token,
  abi: tokenAbi,
  functionName: 'nonces',
  args: [account.address],
})
const creation = buildRoomCreation({
  account: account.address,
  coldTemplateId: preset[0],
  policyHash: preset[1],
  participantCapacity: BigInt(profile.participantCapacity),
})
const permitDeadline = BigInt(Math.floor(Date.now() / 1_000) + 20 * 60)
const signature = await walletClient.signTypedData({
  account,
  domain: {
    name: 'zkdeal Access Token',
    version: '1',
    chainId: config.chainId,
    verifyingContract: token,
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
    owner: account.address,
    spender: pool,
    value: quote[2],
    nonce,
    deadline: permitDeadline,
  },
})
const parsed = parseSignature(signature)
const transactionHash = await walletClient.writeContract({
  account,
  chain: null,
  address: pool,
  abi: poolAbi,
  functionName: 'reserveAndStartWithPermit',
  args: [
    {
      nodeId: profile.nodeId,
      slotId: profile.slotId,
      presetId: profile.presetId,
      deadlineBlocksFromStart: BigInt(deadline),
      priceEpoch: BigInt(price[0]),
      maxTokenCharge: quote[2],
    },
    creation,
    {
      value: quote[2],
      deadline: permitDeadline,
      v: Number(parsed.v),
      r: parsed.r,
      s: parsed.s,
    },
  ],
})
const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash })
if (receipt.status !== 'success') throw new Error('managed-room transaction reverted')
const logs = parseEventLogs({ abi: poolAbi, logs: receipt.logs, strict: false })
const reserved = logs.find((entry) => entry.eventName === 'AllocationReserved')
const used = logs.find((entry) => entry.eventName === 'AllocationUsed')
if (!reserved || !used) throw new Error('managed-room success events were not emitted')
const allocationId = reserved.args.allocationId
const roomId = used.args.roomId
if (!allocationId || roomId === undefined) {
  throw new Error('managed-room success events were incomplete')
}

let release: null | {
  disposeTransactionHash: Hex
  priceEpoch: number
  readySlots: number
} = null
if (releaseAfterStart) {
  const disposeTransactionHash = await walletClient.writeContract({
    account,
    chain: null,
    address: pool,
    abi: poolAbi,
    functionName: 'disposeRoom',
    args: [allocationId],
  })
  const disposeReceipt = await publicClient.waitForTransactionReceipt({
    hash: disposeTransactionHash,
  })
  if (disposeReceipt.status !== 'success') throw new Error('managed-room disposal reverted')

  const pendingNode = await publicClient.readContract({
    address: pool,
    abi: poolAbi,
    functionName: 'nodeState',
    args: [profile.nodeId],
  })
  if (Number(pendingNode.status) !== 3 || /^0x0{64}$/.test(pendingNode.pendingProfileHash)) {
    throw new Error('managed node did not retain a recoverable capacity profile')
  }
  const controller = privateKeyToAccount(
    keccak256(toBytes('zkdeal/kurtosis/role/pool-controller')),
  )
  const controllerClient = createWalletClient({
    account: controller,
    transport: http(rpcUrl),
  })
  const confirmationHash = await controllerClient.writeContract({
    account: controller,
    chain: null,
    address: pool,
    abi: poolAbi,
    functionName: 'confirmCapacityProfile',
    args: [
      profile.nodeId,
      pendingNode.pendingProfileHash,
      [profile.slotId],
      [1],
    ],
  })
  const confirmationReceipt = await publicClient.waitForTransactionReceipt({
    hash: confirmationHash,
  })
  if (confirmationReceipt.status !== 'success') {
    throw new Error('managed capacity restoration reverted')
  }

  const service = privateKeyToAccount(keccak256(toBytes('zkdeal/kurtosis/role/node-service')))
  const serviceClient = createWalletClient({ account: service, transport: http(rpcUrl) })
  const validUntilBlock = (await publicClient.getBlockNumber()) + 31_536_000n
  const priceHash = await serviceClient.writeContract({
    account: service,
    chain: null,
    address: pool,
    abi: poolAbi,
    functionName: 'publishPriceEpoch',
    args: [
      profile.nodeId,
      profile.slotId,
      validUntilBlock,
      price[2],
      price[3],
      price[4],
      price[5],
    ],
  })
  const priceReceipt = await publicClient.waitForTransactionReceipt({ hash: priceHash })
  if (priceReceipt.status !== 'success') throw new Error('managed price refresh reverted')

  const [releasedNode, releasedSlot, releasedPrice] = await Promise.all([
    publicClient.readContract({
      address: pool,
      abi: poolAbi,
      functionName: 'nodeState',
      args: [profile.nodeId],
    }),
    publicClient.readContract({
      address: pool,
      abi: poolAbi,
      functionName: 'slotState',
      args: [profile.nodeId, profile.slotId],
    }),
    publicClient.readContract({
      address: pool,
      abi: poolAbi,
      functionName: 'prices',
      args: [profile.nodeId, profile.slotId],
    }),
  ])
  if (Number(releasedNode.status) !== 2 || Number(releasedSlot.readySlots) !== 1) {
    throw new Error('managed capacity was not returned to Ready')
  }
  if (releasedPrice[0] !== price[0] + 1n || releasedPrice[1] !== validUntilBlock) {
    throw new Error('managed price epoch was not refreshed')
  }
  release = {
    disposeTransactionHash,
    priceEpoch: Number(releasedPrice[0]),
    readySlots: Number(releasedSlot.readySlots),
  }
}

console.log(
  JSON.stringify(
    {
      decision: 'MANAGED_ROOM_STARTED',
      deadlineBlocks: deadline,
      approximateSeconds: deadline * Number(config.l1BlockTimeSec ?? 12),
      priceEpoch: Number(price[0]),
      fixedCharge: quote[0].toString(),
      runningEscrow: quote[1].toString(),
      totalCharge: quote[2].toString(),
      allocationId,
      roomId: roomId.toString(),
      transactionHash,
      release,
      explorerUrl: system.explorerUrl
        ? `${system.explorerUrl}/tx/${transactionHash}`
        : null,
      lifecycle: [
        'Capacity reserved',
        'Room created',
        'Proof service active',
        'Capacity released',
      ],
    },
    null,
    2,
  ),
)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
