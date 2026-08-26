import { describe, expect, it } from 'vitest'
import { concatHex, keccak256, stringToHex, type Hex } from 'viem'
import {
  canonicalExecutionPolicyV5,
  executionPolicyHashV5,
} from '../src/execution-policy-v5.js'

const address = (byte: string) => `0x${byte.repeat(20)}` as Hex
const word = (byte: string) => `0x${byte.repeat(32)}` as Hex
const uint = (value: bigint, bytes: number) =>
  `0x${value.toString(16).padStart(bytes * 2, '0')}` as Hex

/**
 * Golden vectors computed with the pre-exit implementation of
 * `executionPolicyHashV5`. The minimal value is additionally pinned against
 * Rust `execution_policy_hash_v5` by the hosted API catalog suite, so a drift
 * here is a drift against the guest, not just against an old TS build.
 */
const MINIMAL_LEGACY_HASH = '0x19e8cd5b38fc34be9aa28be1460d33c3c1e7083da85c70646f4a6ca95216375a'
const RICH_LEGACY_HASH = '0x7b6ffa712f541d68720dfa846211712a65870376dabf4f0bc99ec08d1226c8d0'

const minimalPolicy = {
  state_commitment: 1, max_blocks_per_batch: 8, max_transactions_per_block: 1024,
  max_gas_per_block: 30_000_000, max_memory_bytes: 268_435_456,
  allow_contract_creation: false, allow_self_destruct: false,
  code: [], calls: [], storage: [], imports: [], participant_registry: null,
}

const richPolicy = {
  state_commitment: 1, max_blocks_per_batch: 8, max_transactions_per_block: 1024,
  max_gas_per_block: 30_000_000, max_memory_bytes: 268_435_456,
  allow_contract_creation: false, allow_self_destruct: true,
  code: [{ address: address('11'), runtime_code_hash: word('22') }],
  calls: [{ caller: address('33'), target: address('44'), selectors: ['0xaabbccdd'], kinds: [1] }],
  storage: [{ contract: address('55'), slot_prefix: '3', prefix_bits: 16, writable: true }],
  imports: [{
    adapter_id: word('66'), adapter_version: word('77'), source: address('88'),
    source_key: '9', room_contract: address('99'), room_slot: '4',
  }],
  participant_registry: {
    contract: address('aa'), root_slot: '1', epoch_slot: '2', count_slot: '3', capacity_slot: '4',
  },
}

const exitBinding = {
  queue_contract: address('ee'),
  count_slot: '5',
  records_base_slot: '6',
  assets: [
    { asset: address('00'), kind: 0, token: address('00'), balance_slot: '7' },
    { asset: address('cc'), kind: 1, token: address('cc'), balance_slot: '8' },
  ],
  fallback_recipient: address('fb'),
}

describe('execution policy v5 hashing', () => {
  it('legacy_policy_hash_is_unchanged', () => {
    // A policy without an exit binding hashes byte-identically to the
    // pre-exit implementation, whether the key is absent or explicit null.
    expect(executionPolicyHashV5(canonicalExecutionPolicyV5(minimalPolicy)))
      .toBe(MINIMAL_LEGACY_HASH)
    expect(executionPolicyHashV5(canonicalExecutionPolicyV5(richPolicy)))
      .toBe(RICH_LEGACY_HASH)
    expect(executionPolicyHashV5(canonicalExecutionPolicyV5({ ...minimalPolicy, exit: null })))
      .toBe(MINIMAL_LEGACY_HASH)
    expect(executionPolicyHashV5(canonicalExecutionPolicyV5({ ...richPolicy, exit: null })))
      .toBe(RICH_LEGACY_HASH)
    // The canonical wire form omits the key entirely, so serialized legacy
    // policies round-trip without gaining a field the Rust side would reject.
    expect('exit' in canonicalExecutionPolicyV5(minimalPolicy)).toBe(false)
    expect('exit' in canonicalExecutionPolicyV5({ ...minimalPolicy, exit: null })).toBe(false)
  })

  it('policy_hash_with_exit_binding_matches_the_documented_tail', () => {
    const canonical = canonicalExecutionPolicyV5({ ...minimalPolicy, exit: exitBinding })
    expect(canonical.exit).toEqual({
      queue_contract: address('ee'),
      count_slot: uint(5n, 32),
      records_base_slot: uint(6n, 32),
      assets: [
        { asset: address('00'), kind: 0, token: address('00'), balance_slot: uint(7n, 32) },
        { asset: address('cc'), kind: 1, token: address('cc'), balance_slot: uint(8n, 32) },
      ],
      fallback_recipient: address('fb'),
    })
    // The full preimage, spelled out byte-for-byte: the unchanged legacy head
    // followed by 0x01 and the fixed-width exit fields (addresses 20 bytes,
    // slots 32-byte words, u64 length prefix, one kind byte per asset row).
    const expected = keccak256(concatHex([
      stringToHex('zkdeal/execution-policy/v5'),
      uint(1n, 1),               // state_commitment
      uint(8n, 8),               // max_blocks_per_batch
      uint(1024n, 8),            // max_transactions_per_block
      uint(30_000_000n, 8),      // max_gas_per_block
      uint(268_435_456n, 8),     // max_memory_bytes
      uint(0n, 1),               // allow_contract_creation
      uint(0n, 1),               // allow_self_destruct
      uint(0n, 8),               // code length
      uint(0n, 8),               // calls length
      uint(0n, 8),               // storage length
      uint(0n, 8),               // imports length
      uint(0n, 1),               // participant_registry: None
      uint(1n, 1),               // exit binding present
      address('ee'),             // queue_contract
      uint(5n, 32),              // count_slot
      uint(6n, 32),              // records_base_slot
      uint(2n, 8),               // assets length
      address('00'), uint(0n, 1), address('00'), uint(7n, 32),
      address('cc'), uint(1n, 1), address('cc'), uint(8n, 32),
      address('fb'),             // fallback_recipient
    ]))
    expect(executionPolicyHashV5(canonical)).toBe(expected)
    // Injective against every no-exit policy: even an empty binding differs.
    expect(executionPolicyHashV5(canonical)).not.toBe(MINIMAL_LEGACY_HASH)
    expect(executionPolicyHashV5(canonicalExecutionPolicyV5({
      ...minimalPolicy,
      exit: { ...exitBinding, assets: [] },
    }))).not.toBe(MINIMAL_LEGACY_HASH)
  })

  it('rejects malformed exit bindings while keeping the key optional', () => {
    expect(() => canonicalExecutionPolicyV5({
      ...minimalPolicy,
      exit: { ...exitBinding, extra: true },
    })).toThrow('policy.exit has unsupported or missing fields')
    expect(() => canonicalExecutionPolicyV5({
      ...minimalPolicy,
      exit: { ...exitBinding, assets: [{ asset: address('00'), kind: 0, token: address('00') }] },
    })).toThrow('policy.exit.assets[0] has unsupported or missing fields')
    expect(() => canonicalExecutionPolicyV5({
      ...minimalPolicy,
      exit: { ...exitBinding, queue_contract: word('ee') },
    })).toThrow('policy.exit.queue_contract is malformed')
    expect(() => canonicalExecutionPolicyV5({
      ...minimalPolicy,
      exit: { ...exitBinding, assets: [{ asset: address('00'), kind: 256, token: address('00'), balance_slot: '7' }] },
    })).toThrow('policy.exit.assets[0].kind exceeds uint8')
  })
})
