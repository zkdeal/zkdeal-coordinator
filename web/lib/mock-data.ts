/**
 * Fallback ABI snippets + address helpers for UI when coordinator
 * /artifacts/contracts.json is unavailable. Live mode does NOT seed rooms
 * from this file - registry comes from GET /rooms.
 */

import type { AbiFunction } from './types'

export { shortAddr } from './keys'

/*
 * `randomHex` used to live here and was used by the ABI explorer to invent
 * transaction hashes and return values. It is deliberately gone: no UI path
 * may render a synthetic hash, root or address that could be mistaken for
 * chain data. Do not reintroduce it.
 */

export const ERC4626_ABI: AbiFunction[] = [
  {
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
    description: 'Mint vault shares by depositing underlying assets.',
  },
  {
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
    description: 'Burn shares to withdraw underlying assets.',
  },
  {
    name: 'accrueYield',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'assets', type: 'uint256' }],
    outputs: [],
    description:
      'DEMO ONLY: pulls caller-funded WNative into the vault - not organic yield.',
  },
  {
    name: 'totalAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
]

export const DVP_ABI: AbiFunction[] = [
  {
    name: 'openTrade',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'counterparty', type: 'address' },
      { name: 'securityToken', type: 'address' },
      { name: 'securityAmount', type: 'uint256' },
      { name: 'cashToken', type: 'address' },
      { name: 'cashAmount', type: 'uint256' },
      { name: 'settlementDate', type: 'uint256' },
    ],
    outputs: [{ name: 'tradeId', type: 'bytes32' }],
  },
  {
    name: 'affirm',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'tradeId', type: 'bytes32' }],
    outputs: [{ name: 'ok', type: 'bool' }],
  },
  {
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'tradeId', type: 'bytes32' }],
    outputs: [{ name: 'settled', type: 'bool' }],
  },
]
