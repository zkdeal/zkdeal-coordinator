import { encodeFunctionData, type Abi, type Hex } from 'viem'
import { cardRoomFixtureSigner } from './card-request.js'
import { AMM_MULTI_SIGNER_CAPABILITY } from './amm-room.js'
import type { DemoPreset } from './demo-types.js'

/**
 * The `amm-naive` preset: the same market as the commit-reveal AMM, run without
 * the commit-reveal envelope, so submission order IS execution order. It scripts
 * a profitable sandwich (searcher front-run, victim buy, searcher back-run) and
 * lands it on L1 under proof - the honest, undefended counterpart to the
 * commit-reveal room, showing what ordering power is worth when nothing takes it
 * away. See apps-examples/mev for the policy-swap harness and the arithmetic.
 */
export const NAIVE_AMM_PRESET_ID = 'amm-naive'
export const NAIVE_AMM_WORKLOAD = 'amm-sequenced'
export const NAIVE_AMM_REQUIRED_CAPABILITIES = Object.freeze([AMM_MULTI_SIGNER_CAPABILITY])

export const NAIVE_AMM_COORDINATOR = cardRoomFixtureSigner(0)
export const NAIVE_AMM_VICTIM = cardRoomFixtureSigner(1)
export const NAIVE_AMM_ATTACKER = cardRoomFixtureSigner(2)

export const NAIVE_AMM_RESERVE_0 = 1_000_000n
export const NAIVE_AMM_RESERVE_1 = 1_000_000n
export const NAIVE_AMM_TRADER_BALANCE_0 = 250_000n
export const NAIVE_AMM_SWAP_IN = 100_000n

export const SEQUENCED_AMM_ABI = [
  {
    type: 'function',
    name: 'initialize',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'reserve0_', type: 'uint256' },
      { name: 'reserve1_', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'trader', type: 'address' },
      { name: 'startBalance0', type: 'uint256' },
      { name: 'startBalance1', type: 'uint256' },
    ],
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
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'swapMax',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'zeroForOne', type: 'bool' },
      { name: 'minAmountOut', type: 'uint256' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const satisfies Abi

function call(name: string, args: readonly unknown[] = []): Hex {
  return encodeFunctionData({
    abi: SEQUENCED_AMM_ABI,
    functionName: name,
    args,
  } as never)
}

const actions: DemoPreset['actions'] = [
  {
    id: 'initialize-pool',
    label: 'Initialize 1:1 unprotected pool',
    actor: 'coordinator',
    calldata: call('initialize', [NAIVE_AMM_RESERVE_0, NAIVE_AMM_RESERVE_1]),
    recommendedBlock: 1,
    fixtureSignerIndex: 0,
    gasLimit: 400_000,
  },
  {
    id: 'register-searcher',
    label: 'Register searcher seat',
    actor: 'coordinator',
    calldata: call('register', [NAIVE_AMM_ATTACKER, NAIVE_AMM_TRADER_BALANCE_0, 0n]),
    recommendedBlock: 1,
    fixtureSignerIndex: 0,
    gasLimit: 200_000,
  },
  {
    id: 'register-victim',
    label: 'Register victim seat',
    actor: 'coordinator',
    calldata: call('register', [NAIVE_AMM_VICTIM, NAIVE_AMM_TRADER_BALANCE_0, 0n]),
    recommendedBlock: 1,
    fixtureSignerIndex: 0,
    gasLimit: 200_000,
  },
  {
    id: 'searcher-front-run',
    label: 'Searcher front-runs the victim',
    actor: 'searcher',
    calldata: call('swapExactInput', [true, NAIVE_AMM_SWAP_IN, 1n]),
    recommendedBlock: 2,
    fixtureSignerIndex: 2,
    gasLimit: 260_000,
  },
  {
    id: 'victim-buy',
    label: 'Victim buys at the worsened price',
    actor: 'victim',
    calldata: call('swapExactInput', [true, NAIVE_AMM_SWAP_IN, 1n]),
    recommendedBlock: 2,
    fixtureSignerIndex: 1,
    gasLimit: 260_000,
  },
  {
    id: 'searcher-back-run',
    label: 'Searcher unwinds for a profit',
    actor: 'searcher',
    calldata: call('swapMax', [false, 1n]),
    recommendedBlock: 2,
    fixtureSignerIndex: 2,
    gasLimit: 260_000,
  },
]

const storageLabels = [
  'initialized flag',
  'reserve token 0',
  'reserve token 1',
  'conserved token 0 total',
  'conserved token 1 total',
  'registered trader count',
  'executed swaps',
  'coordinator',
  'trader slot 0 account',
  'trader slot 1 account',
  'trader slot 2 account',
  'trader slot 3 account',
  'trader slot 0 token 0 balance',
  'trader slot 1 token 0 balance',
  'trader slot 2 token 0 balance',
  'trader slot 3 token 0 balance',
  'trader slot 0 token 1 balance',
  'trader slot 1 token 1 balance',
  'trader slot 2 token 1 balance',
  'trader slot 3 token 1 balance',
] as const

export function naiveAmmAllowedSelectors(): string[] {
  return [...new Set(actions.map((action) => action.calldata.slice(0, 10)))]
}

export function naiveAmmPreset(): DemoPreset {
  return {
    id: NAIVE_AMM_PRESET_ID,
    name: 'Sequenced AMM (MEV sandwich)',
    summary:
      'Run the same market without commit-reveal: submission order is execution order, so a searcher '
      + 'front-run/back-run sandwiches the victim for a provable profit - the undefended baseline.',
    workload: NAIVE_AMM_WORKLOAD,
    authorizationMode: 'VALIDITY_ONLY',
    participantCapacity: 1_024,
    activeApprovers: 0,
    allowedSelectors: naiveAmmAllowedSelectors(),
    actions,
    peers: [
      {
        id: 'coordinator',
        label: 'Batch coordinator',
        description: 'Funds the pool reserves and opens the searcher and victim seats.',
        fixtureSignerIndex: 0,
      },
      {
        id: 'victim',
        label: 'Victim trader',
        description: 'Buys 100,000 token 0 and is sandwiched between the searcher legs.',
        fixtureSignerIndex: 1,
      },
      {
        id: 'searcher',
        label: 'MEV searcher',
        description: 'Front-runs the victim and unwinds the whole position for a token-0 profit.',
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
    proverCapabilities: NAIVE_AMM_REQUIRED_CAPABILITIES,
  }
}
