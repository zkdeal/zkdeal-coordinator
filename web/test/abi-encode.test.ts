import { describe, expect, it } from 'vitest'
import { encodeFunctionData, parseAbiItem, toBytes, keccak256 } from 'viem'
import { AbiEncodeError, canonicalSignature, encodeArgs, isEncodable } from '../lib/abi-encode'
import type { AbiFunction } from '../lib/types'

const transfer: AbiFunction = {
  name: 'transfer',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  outputs: [{ name: '', type: 'bool' }],
}

const bytes32Fn: AbiFunction = {
  name: 'affirm',
  stateMutability: 'nonpayable',
  inputs: [{ name: 'tradeId', type: 'bytes32' }],
  outputs: [],
}

function hex(b: Uint8Array): string {
  return '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

/**
 * H-01: the explorer hard-coded every signature to `fn()` and discarded the
 * user's inputs, so a parameterised write was sent with the wrong selector
 * and no arguments - then reported as a success with a random tx hash.
 */
describe('canonical signature', () => {
  it('includes the declared parameter types', () => {
    expect(canonicalSignature(transfer)).toBe('transfer(address,uint256)')
  })

  it('is NOT the old fn() form', () => {
    expect(canonicalSignature(transfer)).not.toBe('transfer()')
  })

  it('normalises uint/int aliases the way solidity does', () => {
    expect(
      canonicalSignature({
        name: 'f',
        stateMutability: 'nonpayable',
        inputs: [{ name: 'a', type: 'uint' }],
        outputs: [],
      }),
    ).toBe('f(uint256)')
  })

  it('produces the same selector viem derives from the real ABI item', () => {
    const mine = keccak256(toBytes(canonicalSignature(transfer))).slice(0, 10)
    const viemSelector = encodeFunctionData({
      abi: [parseAbiItem('function transfer(address to, uint256 amount) returns (bool)')],
      functionName: 'transfer',
      args: ['0x1111111111111111111111111111111111111111', 1n],
    }).slice(0, 10)
    expect(mine).toBe(viemSelector)
  })
})

describe('argument encoding', () => {
  it('encodes the entered values, matching viem byte for byte', () => {
    const encoded = encodeArgs(transfer, {
      to: '0x1111111111111111111111111111111111111111',
      amount: '1000000000000000000',
    })
    const viemFull = encodeFunctionData({
      abi: [parseAbiItem('function transfer(address to, uint256 amount) returns (bool)')],
      functionName: 'transfer',
      args: ['0x1111111111111111111111111111111111111111', 1000000000000000000n],
    })
    // encodeArgs returns the tuple only; the selector is added by callL2.
    expect(hex(encoded)).toBe('0x' + viemFull.slice(10))
  })

  it('returns an empty payload for a no-argument function', () => {
    expect(
      encodeArgs({ name: 'seal', stateMutability: 'nonpayable', inputs: [], outputs: [] }, {}),
    ).toHaveLength(0)
  })

  /* ---- hostile / malformed input must fail closed, never be coerced ---- */

  it('rejects a missing value instead of sending a zero', () => {
    expect(() => encodeArgs(transfer, {})).toThrow(AbiEncodeError)
  })

  it('rejects a non-address for an address parameter', () => {
    expect(() =>
      encodeArgs(transfer, { to: '0xdeadbeef', amount: '1' }),
    ).toThrow(/not a checksum-valid address/)
  })

  it('rejects a non-numeric amount', () => {
    expect(() =>
      encodeArgs(transfer, { to: '0x1111111111111111111111111111111111111111', amount: '1e18' }),
    ).toThrow(/decimal integer/)
  })

  it('rejects a negative uint', () => {
    expect(() =>
      encodeArgs(transfer, { to: '0x1111111111111111111111111111111111111111', amount: '-1' }),
    ).toThrow(/cannot be negative/)
  })

  it('rejects a uint that overflows its declared width', () => {
    const u8: AbiFunction = {
      name: 'f',
      stateMutability: 'nonpayable',
      inputs: [{ name: 'a', type: 'uint8' }],
      outputs: [],
    }
    expect(() => encodeArgs(u8, { a: '256' })).toThrow(/does not fit in uint8/)
    expect(hex(encodeArgs(u8, { a: '255' }))).toMatch(/ff$/)
  })

  it('rejects fixed-bytes of the wrong length', () => {
    expect(() => encodeArgs(bytes32Fn, { tradeId: '0x1234' })).toThrow(/needs exactly 32 bytes/)
    expect(() => encodeArgs(bytes32Fn, { tradeId: 'not-hex' })).toThrow(/0x-prefixed/)
  })

  it('rejects odd-length hex', () => {
    expect(() => encodeArgs(bytes32Fn, { tradeId: '0x123' })).toThrow(/0x-prefixed/)
  })

  it('rejects an unencodable tuple/array rather than guessing', () => {
    const tupleFn: AbiFunction = {
      name: 'f',
      stateMutability: 'nonpayable',
      inputs: [{ name: 'a', type: 'uint256[]' }],
      outputs: [],
    }
    expect(isEncodable(tupleFn)).toBe(false)
    expect(() => encodeArgs(tupleFn, { a: '[1,2]' })).toThrow(/not supported by this explorer/)
  })

  it('accepts bool as true/false and 1/0 only', () => {
    const boolFn: AbiFunction = {
      name: 'f',
      stateMutability: 'nonpayable',
      inputs: [{ name: 'a', type: 'bool' }],
      outputs: [],
    }
    expect(hex(encodeArgs(boolFn, { a: 'true' })).endsWith('01')).toBe(true)
    expect(hex(encodeArgs(boolFn, { a: '0' })).endsWith('00')).toBe(true)
    expect(() => encodeArgs(boolFn, { a: 'yes' })).toThrow(/expected true\/false/)
  })
})
