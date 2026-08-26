/**
 * Strict ABI encoding for the contract explorer.
 *
 * The explorer used to send `fn()` for every function regardless of its
 * parameters - the wrong selector for anything with arguments, with the user's
 * inputs discarded entirely. This module builds the canonical signature from
 * the declared inputs and encodes the entered values against their declared
 * types, rejecting anything it cannot encode exactly.
 *
 * Unsupported shapes fail loudly rather than being coerced: a silently
 * mis-encoded call is a real transaction with the wrong meaning.
 */
import { encodeAbiParameters, isAddress, type AbiParameter } from 'viem'
import type { AbiFunction, AbiInput } from './types'

/** Canonical signature used for the 4-byte selector, e.g. `transfer(address,uint256)`. */
export function canonicalSignature(fn: AbiFunction): string {
  return `${fn.name}(${fn.inputs.map((i) => canonicalType(i.type)).join(',')})`
}

function canonicalType(type: string): string {
  const t = type.trim()
  if (t === 'uint') return 'uint256'
  if (t === 'int') return 'int256'
  if (t === 'uint[]') return 'uint256[]'
  if (t === 'int[]') return 'int256[]'
  return t
}

export class AbiEncodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AbiEncodeError'
  }
}

const UINT_RE = /^uint(\d*)$/
const INT_RE = /^int(\d*)$/
const FIXED_BYTES_RE = /^bytes(\d+)$/

/**
 * Encode the argument tuple for `fn` from raw text field values.
 * Throws AbiEncodeError with a precise reason for any value it cannot encode.
 */
export function encodeArgs(fn: AbiFunction, values: Record<string, string>): Uint8Array {
  if (fn.inputs.length === 0) return new Uint8Array(0)
  const params: AbiParameter[] = []
  const decoded: unknown[] = []
  fn.inputs.forEach((input, i) => {
    const key = input.name || `arg${i}`
    const type = canonicalType(input.type)
    params.push({ name: key, type })
    decoded.push(parseValue(type, values[key] ?? '', key, input))
  })
  const hex = encodeAbiParameters(params, decoded)
  return hexToBytes(hex)
}

function parseValue(type: string, raw: string, key: string, input: AbiInput): unknown {
  const v = raw.trim()
  if (v === '') throw new AbiEncodeError(`${key} (${input.type}) is required`)

  if (type === 'address') {
    if (!isAddress(v)) throw new AbiEncodeError(`${key}: "${v}" is not a checksum-valid address`)
    return v
  }
  if (type === 'bool') {
    const lower = v.toLowerCase()
    if (lower === 'true' || lower === '1') return true
    if (lower === 'false' || lower === '0') return false
    throw new AbiEncodeError(`${key}: expected true/false, got "${v}"`)
  }
  if (type === 'string') return v
  if (type === 'bytes' || FIXED_BYTES_RE.test(type)) {
    if (!/^0x([0-9a-fA-F]{2})*$/.test(v)) {
      throw new AbiEncodeError(`${key}: expected 0x-prefixed even-length hex, got "${v}"`)
    }
    const fixed = FIXED_BYTES_RE.exec(type)
    if (fixed) {
      const want = Number(fixed[1])
      const got = (v.length - 2) / 2
      if (got !== want) {
        throw new AbiEncodeError(`${key}: ${type} needs exactly ${want} bytes, got ${got}`)
      }
    }
    return v
  }
  const uint = UINT_RE.exec(type)
  const int = INT_RE.exec(type)
  if (uint || int) {
    if (!/^-?\d+$/.test(v)) {
      throw new AbiEncodeError(`${key}: expected a decimal integer, got "${v}"`)
    }
    const n = BigInt(v)
    if (uint && n < 0n) throw new AbiEncodeError(`${key}: ${type} cannot be negative`)
    const bits = BigInt(Number((uint ?? int)![1] || '256'))
    const limit = uint ? (1n << bits) - 1n : (1n << (bits - 1n)) - 1n
    const min = uint ? 0n : -(1n << (bits - 1n))
    if (n > limit || n < min) throw new AbiEncodeError(`${key}: ${v} does not fit in ${type}`)
    return n
  }
  // Arrays and tuples: the UI's ABI model carries no `components`, so a tuple
  // cannot be encoded correctly and an array's element parsing is ambiguous
  // from a single text field. Refuse instead of guessing.
  throw new AbiEncodeError(
    `${key}: type "${input.type}" is not supported by this explorer - call it from a script`,
  )
}

/** True when every input type of `fn` can be encoded from a text field. */
export function isEncodable(fn: AbiFunction): boolean {
  return fn.inputs.every((i) => {
    const t = canonicalType(i.type)
    return (
      t === 'address' ||
      t === 'bool' ||
      t === 'string' ||
      t === 'bytes' ||
      FIXED_BYTES_RE.test(t) ||
      UINT_RE.test(t) ||
      INT_RE.test(t)
    )
  })
}

function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(body.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16)
  return out
}
