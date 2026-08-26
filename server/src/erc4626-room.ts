import { encodeFunctionData, toFunctionSelector, type Abi, type Hex } from 'viem'
import { cardRoomFixtureSigner } from './card-request.js'
import type { DemoPreset } from './demo-types.js'

export const ERC4626_PRESET_ID = 'erc4626'
export const ERC4626_WORKLOAD = 'erc4626-progressive'
export const ERC4626_REQUIRED_CAPABILITIES = Object.freeze([
  'v5.coldState.perContractRuntime',
  'v5.policy.perContractCallRules',
  'v5.blockCalls.multiSigner',
])

const ERC4626_CAPABILITY_EXPLANATIONS: Readonly<Record<string, string>> = Object.freeze({
  'v5.coldState.perContractRuntime':
    'the ERC-4626 vault and its asset token have separate deployed runtime and storage',
  'v5.policy.perContractCallRules':
    'the vault calls and static-calls its asset token during deposit, donation and redemption',
  'v5.blockCalls.multiSigner':
    'the investor and the external liquidity provider use distinct deterministic fixture keys',
})

export function describeErc4626CapabilityGap(missing: readonly string[]): string {
  return (
    'the configured prover cannot prepare the progressive ERC-4626 room yet: '
    + missing
      .map((token) => `${token} (${ERC4626_CAPABILITY_EXPLANATIONS[token] ?? 'required'})`)
      .join('; ')
  )
}

export const ERC4626_INVESTOR = cardRoomFixtureSigner(0)
export const ERC4626_LIQUIDITY_PROVIDER = cardRoomFixtureSigner(1)

export const ERC4626_VAULT_ABI = [
  {
    type: 'function',
    name: 'previewDeposit',
    stateMutability: 'view',
    inputs: [{ name: 'assets', type: 'uint256' }],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'assets', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'donate',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'assets', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'previewRedeem',
    stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ name: 'assets', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'redeem',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'shares', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [{ name: 'assets', type: 'uint256' }],
  },
] as const satisfies Abi

function vaultCall(name: string, args: readonly unknown[]): Hex {
  return encodeFunctionData({
    abi: ERC4626_VAULT_ABI,
    functionName: name,
    args,
  } as never)
}

const actions: DemoPreset['actions'] = [
  {
    id: 'quote-share-issue',
    label: 'Quote 100 assets as 100 shares',
    actor: 'investor',
    calldata: vaultCall('previewDeposit', [100n]),
    recommendedBlock: 1,
    fixtureSignerIndex: 0,
    gasLimit: 120_000,
  },
  {
    id: 'issue-shares',
    label: 'Deposit 100 assets; issue 100 shares',
    actor: 'investor',
    calldata: vaultCall('deposit', [100n, ERC4626_INVESTOR]),
    recommendedBlock: 2,
    fixtureSignerIndex: 0,
    gasLimit: 500_000,
  },
  {
    id: 'observe-vault-liquidity',
    label: 'Observe 100 assets before liquidity arrives',
    actor: 'liquidity-provider',
    calldata: vaultCall('totalAssets', []),
    recommendedBlock: 1,
    fixtureSignerIndex: 1,
    gasLimit: 120_000,
  },
  {
    id: 'add-liquidity',
    label: 'Add 50 assets without issuing shares',
    actor: 'liquidity-provider',
    calldata: vaultCall('donate', [50n]),
    recommendedBlock: 2,
    fixtureSignerIndex: 1,
    gasLimit: 500_000,
  },
  {
    id: 'quote-redemption',
    label: 'Quote 100 shares at 149 assets',
    actor: 'investor',
    calldata: vaultCall('previewRedeem', [100n]),
    recommendedBlock: 1,
    fixtureSignerIndex: 0,
    gasLimit: 160_000,
  },
  {
    id: 'redeem-shares',
    label: 'Burn 100 shares; release 149 assets',
    actor: 'investor',
    calldata: vaultCall('redeem', [100n, ERC4626_INVESTOR, ERC4626_INVESTOR]),
    recommendedBlock: 2,
    fixtureSignerIndex: 0,
    gasLimit: 500_000,
  },
]

export function erc4626AllowedSelectors(): string[] {
  return [...new Set(actions.map((action) => action.calldata.slice(0, 10)))]
}

export const ERC4626_TOKEN_SELECTORS = Object.freeze([
  toFunctionSelector('balanceOf(address)'),
  toFunctionSelector('transfer(address,uint256)'),
  toFunctionSelector('transferFrom(address,address,uint256)'),
])

export function erc4626Preset(): DemoPreset {
  return {
    id: ERC4626_PRESET_ID,
    name: 'ERC-4626 progressive liquidity lifecycle',
    summary:
      'Three proof-backed checkpoints issue shares, add externally funded liquidity, then redeem the appreciated shares into liquid assets.',
    workload: ERC4626_WORKLOAD,
    authorizationMode: 'VALIDITY_ONLY',
    participantCapacity: 128,
    activeApprovers: 0,
    allowedSelectors: erc4626AllowedSelectors(),
    actions,
    peers: [
      {
        id: 'investor',
        label: 'Investor',
        description: 'Deposits 100 assets for 100 shares, then redeems those shares after liquidity arrives.',
        fixtureSignerIndex: 0,
      },
      {
        id: 'liquidity-provider',
        label: 'Liquidity provider',
        description: 'Adds 50 funded assets without receiving new shares, increasing assets per share.',
        fixtureSignerIndex: 1,
      },
    ],
    initialStorage: [],
    registeredParticipants: 0,
    touchedParticipants: 1,
    touchedContracts: 2,
    residentAccounts: 4,
    proverCapabilities: ERC4626_REQUIRED_CAPABILITIES,
  }
}
