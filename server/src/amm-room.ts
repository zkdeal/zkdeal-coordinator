import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  toBytes,
  type Abi,
  type Hex,
} from 'viem'
import { cardRoomFixtureSigner } from './card-request.js'
import type { DemoPreset } from './demo-types.js'

export const AMM_PRESET_ID = 'amm'
export const AMM_WORKLOAD = 'amm-commit-reveal'
export const AMM_MULTI_SIGNER_CAPABILITY = 'v5.blockCalls.multiSigner'
export const AMM_REQUIRED_CAPABILITIES = Object.freeze([AMM_MULTI_SIGNER_CAPABILITY])

export const AMM_COORDINATOR = cardRoomFixtureSigner(0)
export const AMM_VICTIM = cardRoomFixtureSigner(1)
export const AMM_ATTACKER = cardRoomFixtureSigner(2)
export const AMM_ROUND_ID = keccak256(toBytes('zkdeal/demo/amm/mev-round/v1'))
export const AMM_VICTIM_SALT = keccak256(toBytes('zkdeal/demo/amm/victim/salt/v1'))
export const AMM_ATTACKER_SALT = keccak256(toBytes('zkdeal/demo/amm/attacker/salt/v1'))

export const AMM_RESERVE_0 = 1_000_000n
export const AMM_RESERVE_1 = 1_000_000n
export const AMM_TRADER_BALANCE_0 = 250_000n
export const AMM_TRADER_BALANCE_1 = 250_000n
export const AMM_VICTIM_AMOUNT_IN = 100_000n
export const AMM_VICTIM_MIN_OUT = 90_000n
export const AMM_ATTACKER_AMOUNT_IN = 5_000n
export const AMM_ATTACKER_MIN_OUT = 1n

const AMM_COMMITMENT_DOMAIN = keccak256(toBytes('zkdeal/amm/commitment/v1'))

export const COMMIT_REVEAL_AMM_ABI = [
  {
    type: 'function',
    name: 'initialize',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'roundId_', type: 'bytes32' },
      { name: 'victim_', type: 'address' },
      { name: 'attacker_', type: 'address' },
      { name: 'reserve0_', type: 'uint256' },
      { name: 'reserve1_', type: 'uint256' },
      { name: 'traderBalance0_', type: 'uint256' },
      { name: 'traderBalance1_', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'commitSwap',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'commitment', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'closeCommitPhase',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'swapExactInput',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'zeroForOne', type: 'bool' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'minAmountOut', type: 'uint256' },
    ],
    outputs: [
      { name: 'accepted', type: 'bool' },
      { name: 'amountOut', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'revealSwap',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'zeroForOne', type: 'bool' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'minAmountOut', type: 'uint256' },
      { name: 'salt', type: 'bytes32' },
    ],
    outputs: [
      { name: 'accepted', type: 'bool' },
      { name: 'amountOut', type: 'uint256' },
    ],
  },
] as const satisfies Abi

function commitment(
  owner: Hex,
  zeroForOne: boolean,
  amountIn: bigint,
  minAmountOut: bigint,
  salt: Hex,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'bool' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'bytes32' },
      ],
      [AMM_COMMITMENT_DOMAIN, AMM_ROUND_ID, owner, zeroForOne, amountIn, minAmountOut, salt],
    ),
  )
}

export const AMM_VICTIM_COMMITMENT = commitment(
  AMM_VICTIM,
  true,
  AMM_VICTIM_AMOUNT_IN,
  AMM_VICTIM_MIN_OUT,
  AMM_VICTIM_SALT,
)
export const AMM_ATTACKER_COMMITMENT = commitment(
  AMM_ATTACKER,
  false,
  AMM_ATTACKER_AMOUNT_IN,
  AMM_ATTACKER_MIN_OUT,
  AMM_ATTACKER_SALT,
)

function call(name: string, args: readonly unknown[] = []): Hex {
  return encodeFunctionData({
    abi: COMMIT_REVEAL_AMM_ABI,
    functionName: name,
    args,
  } as never)
}

const actions: DemoPreset['actions'] = [
  {
    id: 'initialize-pool',
    label: 'Initialize 1:1 protected pool',
    actor: 'coordinator',
    calldata: call('initialize', [
      AMM_ROUND_ID,
      AMM_VICTIM,
      AMM_ATTACKER,
      AMM_RESERVE_0,
      AMM_RESERVE_1,
      AMM_TRADER_BALANCE_0,
      AMM_TRADER_BALANCE_1,
    ]),
    recommendedBlock: 1,
    fixtureSignerIndex: 0,
    gasLimit: 500_000,
  },
  {
    id: 'victim-commit',
    label: 'Victim commits hidden swap',
    actor: 'victim',
    calldata: call('commitSwap', [AMM_VICTIM_COMMITMENT]),
    recommendedBlock: 1,
    fixtureSignerIndex: 1,
    gasLimit: 180_000,
  },
  {
    id: 'attacker-commit',
    label: 'Search bot commits blind order',
    actor: 'searcher',
    calldata: call('commitSwap', [AMM_ATTACKER_COMMITMENT]),
    recommendedBlock: 1,
    fixtureSignerIndex: 2,
    gasLimit: 180_000,
  },
  {
    id: 'seal-order',
    label: 'Seal commitment order',
    actor: 'coordinator',
    calldata: call('closeCommitPhase'),
    recommendedBlock: 1,
    fixtureSignerIndex: 0,
    gasLimit: 140_000,
  },
  {
    id: 'reactive-front-run-blocked',
    label: 'Block reactive front-run',
    actor: 'searcher',
    calldata: call('swapExactInput', [true, 20_000n, 1n]),
    recommendedBlock: 2,
    fixtureSignerIndex: 2,
    gasLimit: 180_000,
  },
  {
    id: 'out-of-order-reveal-blocked',
    label: 'Reject early searcher reveal',
    actor: 'searcher',
    calldata: call('revealSwap', [
      false,
      AMM_ATTACKER_AMOUNT_IN,
      AMM_ATTACKER_MIN_OUT,
      AMM_ATTACKER_SALT,
    ]),
    recommendedBlock: 2,
    fixtureSignerIndex: 2,
    gasLimit: 220_000,
  },
  {
    id: 'victim-reveal',
    label: 'Execute victim reveal first',
    actor: 'victim',
    calldata: call('revealSwap', [
      true,
      AMM_VICTIM_AMOUNT_IN,
      AMM_VICTIM_MIN_OUT,
      AMM_VICTIM_SALT,
    ]),
    recommendedBlock: 2,
    fixtureSignerIndex: 1,
    gasLimit: 300_000,
  },
  {
    id: 'blind-order-reveal',
    label: 'Execute precommitted searcher order',
    actor: 'searcher',
    calldata: call('revealSwap', [
      false,
      AMM_ATTACKER_AMOUNT_IN,
      AMM_ATTACKER_MIN_OUT,
      AMM_ATTACKER_SALT,
    ]),
    recommendedBlock: 2,
    fixtureSignerIndex: 2,
    gasLimit: 300_000,
  },
]

const storageLabels = [
  'initialized flag',
  'commit/reveal phase',
  'coordinator',
  'round id',
  'reserve token 0',
  'reserve token 1',
  'conserved token 0 total',
  'conserved token 1 total',
  'victim account',
  'victim token 0 balance',
  'victim token 1 balance',
  'searcher account',
  'searcher token 0 balance',
  'searcher token 1 balance',
  'first committer',
  'first opaque commitment',
  'second committer',
  'second opaque commitment',
  'next reveal index',
  'blocked reactive attempts',
  'blocked out-of-order reveals',
  'executed swaps',
] as const

export function ammAllowedSelectors(): string[] {
  return [...new Set(actions.map((action) => action.calldata.slice(0, 10)))]
}

export function ammPreset(): DemoPreset {
  return {
    id: AMM_PRESET_ID,
    name: 'Commit-reveal MEV-resistant AMM',
    summary:
      'Hide order direction and size until ordering is sealed, then prove that reactive and out-of-order sandwich legs had no price effect.',
    workload: AMM_WORKLOAD,
    authorizationMode: 'VALIDITY_ONLY',
    participantCapacity: 1_024,
    activeApprovers: 0,
    allowedSelectors: ammAllowedSelectors(),
    actions,
    peers: [
      {
        id: 'coordinator',
        label: 'Batch coordinator',
        description: 'Initializes the bounded market and seals two commitments before reveal.',
        fixtureSignerIndex: 0,
      },
      {
        id: 'victim',
        label: 'Victim trader',
        description: 'Commits a hidden 100,000 token-0 order with a 90,000 minimum output.',
        fixtureSignerIndex: 1,
      },
      {
        id: 'searcher',
        label: 'MEV searcher',
        description: 'Tries a reactive front-run and an early reveal; only its blind commitment executes.',
        fixtureSignerIndex: 2,
      },
    ],
    initialStorage: storageLabels.map((label, slot) => ({
      label,
      slot: String(slot),
      value: '0',
      mode: 'ROOM_LOCAL' as const,
    })),
    registeredParticipants: 0,
    touchedParticipants: 1,
    touchedContracts: 1,
    residentAccounts: 4,
    proverCapabilities: AMM_REQUIRED_CAPABILITIES,
  }
}

export function describeAmmCapabilityGap(missing: readonly string[]): string {
  return (
    'the configured prover cannot prepare the MEV-resistant AMM yet: '
    + missing
      .map((token) =>
        token === AMM_MULTI_SIGNER_CAPABILITY
          ? `${token} (the coordinator, victim and searcher must sign distinct transactions)`
          : `${token} (required)`,
      )
      .join('; ')
  )
}
