import { encodeFunctionData, toFunctionSelector, type Abi, type Hex } from 'viem'
import { cardRoomFixtureSigner } from './card-request.js'
import type { DemoPreset } from './demo-types.js'

export const ERC7540_PRESET_ID = 'erc7540'
export const ERC7540_WORKLOAD = 'erc7540-demo'
export const ERC7540_MULTI_SIGNER_CAPABILITY = 'v5.blockCalls.multiSigner'
export const ERC7540_REQUIRED_CAPABILITIES = Object.freeze([
  'v5.coldState.perContractRuntime',
  'v5.policy.perContractCallRules',
  ERC7540_MULTI_SIGNER_CAPABILITY,
])

const ERC7540_CAPABILITY_EXPLANATIONS: Readonly<Record<string, string>> = Object.freeze({
  'v5.coldState.perContractRuntime':
    'the vault and asset token have different deployed runtime code and separate storage',
  'v5.policy.perContractCallRules':
    'the vault calls and static-calls the asset token during request and claim execution',
  [ERC7540_MULTI_SIGNER_CAPABILITY]:
    'Alice, Bob and the manager must sign with three distinct deterministic fixture keys',
})

export function describeErc7540CapabilityGap(missing: readonly string[]): string {
  return (
    'the configured prover cannot prepare the ERC-7540 room yet: '
    + missing
      .map((token) => `${token} (${ERC7540_CAPABILITY_EXPLANATIONS[token] ?? 'required'})`)
      .join('; ')
  )
}

export const ERC7540_ALICE = cardRoomFixtureSigner(0)
export const ERC7540_BOB = cardRoomFixtureSigner(1)
export const ERC7540_MANAGER = cardRoomFixtureSigner(2)

export const ERC7540_VAULT_ABI = [
  {
    type: 'function',
    name: 'requestDeposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'controller', type: 'address' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [{ name: 'requestId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'fulfillDeposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'controller', type: 'address' },
      { name: 'assets', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'controller', type: 'address' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'requestRedeem',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'shares', type: 'uint256' },
      { name: 'controller', type: 'address' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [{ name: 'requestId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'fulfillRedeem',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'controller', type: 'address' },
      { name: 'shares', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'redeem',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'shares', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'controller', type: 'address' },
    ],
    outputs: [{ name: 'assets', type: 'uint256' }],
  },
] as const satisfies Abi

function call(name: string, args: readonly unknown[]): Hex {
  return encodeFunctionData({
    abi: ERC7540_VAULT_ABI,
    functionName: name,
    args,
  } as never)
}

const actions: DemoPreset['actions'] = [
  {
    id: 'alice-request-deposit',
    label: 'Alice requests 100 assets',
    actor: 'alice',
    calldata: call('requestDeposit', [100n, ERC7540_ALICE, ERC7540_ALICE]),
    recommendedBlock: 1,
    fixtureSignerIndex: 0,
    gasLimit: 400_000,
  },
  {
    id: 'bob-request-deposit',
    label: 'Bob requests 60 assets',
    actor: 'bob',
    calldata: call('requestDeposit', [60n, ERC7540_BOB, ERC7540_BOB]),
    recommendedBlock: 1,
    fixtureSignerIndex: 1,
    gasLimit: 400_000,
  },
  {
    id: 'manager-fulfill-alice-deposit',
    label: 'Manager makes Alice claimable',
    actor: 'manager',
    calldata: call('fulfillDeposit', [ERC7540_ALICE, 100n]),
    recommendedBlock: 1,
    fixtureSignerIndex: 2,
    gasLimit: 200_000,
  },
  {
    id: 'manager-fulfill-bob-deposit',
    label: 'Manager makes Bob claimable',
    actor: 'manager',
    calldata: call('fulfillDeposit', [ERC7540_BOB, 60n]),
    recommendedBlock: 1,
    fixtureSignerIndex: 2,
    gasLimit: 200_000,
  },
  {
    id: 'alice-claim-deposit',
    label: 'Alice claims 100 shares',
    actor: 'alice',
    calldata: call('deposit', [100n, ERC7540_ALICE, ERC7540_ALICE]),
    recommendedBlock: 1,
    fixtureSignerIndex: 0,
    gasLimit: 300_000,
  },
  {
    id: 'bob-claim-deposit',
    label: 'Bob claims 60 shares',
    actor: 'bob',
    calldata: call('deposit', [60n, ERC7540_BOB, ERC7540_BOB]),
    recommendedBlock: 1,
    fixtureSignerIndex: 1,
    gasLimit: 300_000,
  },
  {
    id: 'alice-request-redeem',
    label: 'Alice requests redemption of 40 shares',
    actor: 'alice',
    calldata: call('requestRedeem', [40n, ERC7540_ALICE, ERC7540_ALICE]),
    recommendedBlock: 2,
    fixtureSignerIndex: 0,
    gasLimit: 300_000,
  },
  {
    id: 'bob-request-redeem',
    label: 'Bob requests redemption of 20 shares',
    actor: 'bob',
    calldata: call('requestRedeem', [20n, ERC7540_BOB, ERC7540_BOB]),
    recommendedBlock: 2,
    fixtureSignerIndex: 1,
    gasLimit: 300_000,
  },
  {
    id: 'manager-fulfill-alice-redeem',
    label: 'Manager makes Alice redemption claimable',
    actor: 'manager',
    calldata: call('fulfillRedeem', [ERC7540_ALICE, 40n]),
    recommendedBlock: 2,
    fixtureSignerIndex: 2,
    gasLimit: 200_000,
  },
  {
    id: 'manager-fulfill-bob-redeem',
    label: 'Manager makes Bob redemption claimable',
    actor: 'manager',
    calldata: call('fulfillRedeem', [ERC7540_BOB, 20n]),
    recommendedBlock: 2,
    fixtureSignerIndex: 2,
    gasLimit: 200_000,
  },
  {
    id: 'alice-claim-redeem',
    label: 'Alice claims 40 assets',
    actor: 'alice',
    calldata: call('redeem', [40n, ERC7540_ALICE, ERC7540_ALICE]),
    recommendedBlock: 2,
    fixtureSignerIndex: 0,
    gasLimit: 400_000,
  },
  {
    id: 'bob-claim-redeem',
    label: 'Bob claims 20 assets',
    actor: 'bob',
    calldata: call('redeem', [20n, ERC7540_BOB, ERC7540_BOB]),
    recommendedBlock: 2,
    fixtureSignerIndex: 1,
    gasLimit: 400_000,
  },
]

export function erc7540AllowedSelectors(): string[] {
  return [...new Set(actions.map((action) => action.calldata.slice(0, 10)))]
}

export function erc7540Preset(): DemoPreset {
  return {
    id: ERC7540_PRESET_ID,
    name: 'ERC-7540 asynchronous vault',
    summary:
      'Alice, Bob and a vault manager prove a complete asynchronous deposit and redemption round trip without skipping the claimable state.',
    workload: ERC7540_WORKLOAD,
    authorizationMode: 'VALIDITY_ONLY',
    participantCapacity: 128,
    activeApprovers: 0,
    allowedSelectors: erc7540AllowedSelectors(),
    actions,
    peers: [
      {
        id: 'alice',
        label: 'Alice',
        description: 'Requests 100 assets, claims shares, then redeems 40.',
        fixtureSignerIndex: 0,
      },
      {
        id: 'bob',
        label: 'Bob',
        description: 'Requests 60 assets, claims shares, then redeems 20.',
        fixtureSignerIndex: 1,
      },
      {
        id: 'manager',
        label: 'Vault Manager',
        description: 'Moves each request from Pending to Claimable; never claims for users.',
        fixtureSignerIndex: 2,
      },
    ],
    initialStorage: [],
    registeredParticipants: 0,
    touchedParticipants: 1,
    touchedContracts: 2,
    residentAccounts: 5,
    proverCapabilities: ERC7540_REQUIRED_CAPABILITIES,
  }
}

export const ERC7540_TOKEN_SELECTORS = Object.freeze([
  toFunctionSelector('balanceOf(address)'),
  toFunctionSelector('transfer(address,uint256)'),
  toFunctionSelector('transferFrom(address,address,uint256)'),
])
