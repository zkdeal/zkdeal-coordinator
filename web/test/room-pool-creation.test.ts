import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, keccak256 } from 'viem'
import {
  approverLeaf,
  assertProductionConfirmationDepth,
  assertParticipantCapacity,
  buildRoomCreation,
  emptyParticipantRoot,
  toParticipantCapacity,
} from '../lib/room-pool-creation'

/**
 * H1: `/room-pool` sent a fabricated `initialParticipantRoot`
 * (`keccak256(abi.encode('zkdeal/browser-participant/v5', account, 1))`) with
 * `initialParticipantCount: 1`. `RoomManagerIntakeFacet` stores both verbatim and
 * `RoomManagerValidationFacet._validateJournal` then requires every batch to match
 * them against what the guest reads from the deployed participant registry - a
 * fresh `MerkleParticipants` publishes `emptyParticipantRoot(capacity)` with
 * count 0. Every room the console created was therefore permanently unusable,
 * after the permit was consumed and the fixed charge taken.
 *
 * The expected roots below were produced outside this module, by iterating
 * `cast keccak` over `abi.encodePacked(root, root)` from bytes32(0) - the exact
 * loop of `MerkleParticipants.emptyParticipantRoot`. The approver leaf comes from
 * `cast abi-encode "f(uint64,address,uint64)" 0 <account> 1 | cast keccak`.
 */
const ACCOUNT = '0x1111111111111111111111111111111111111111' as const
const EMPTY_ROOT_128 = '0xffd70157e48063fc33c97a050f7f640233bf646cc98d9524c6b92bcf3ab56f83'
const EMPTY_ROOT_1024 = '0xf9dc3e7fe016e050eff260334f18a5d4fe391d82092319f5964f2e2eb7c1c3a5'
const EMPTY_ROOT_32768 = '0xda7bce9f4e8618b6bd2f4132ce798cdc7a60e7e1460a7299e3c6342a579626d2'
const APPROVER_LEAF = '0x73c50ac8e905613a83cad8d2191fac275dca299677db204d29879a76b5f9e356'

const input = {
  account: ACCOUNT,
  coldTemplateId: `0x${'aa'.repeat(32)}`,
  policyHash: `0x${'bb'.repeat(32)}`,
  participantCapacity: 128n,
} as const

describe('empty participant root', () => {
  it('reproduces MerkleParticipants.emptyParticipantRoot at each supported capacity', () => {
    expect(emptyParticipantRoot(128n)).toBe(EMPTY_ROOT_128)
    expect(emptyParticipantRoot(1024n)).toBe(EMPTY_ROOT_1024)
    expect(emptyParticipantRoot(32_768n)).toBe(EMPTY_ROOT_32768)
  })

  it('refuses capacities the intake facet would reject', () => {
    expect(() => assertParticipantCapacity(64n)).toThrow(/power of two/)
    expect(() => assertParticipantCapacity(65_536n)).toThrow(/power of two/)
    expect(() => assertParticipantCapacity(1000n)).toThrow(/power of two/)
    expect(() => assertParticipantCapacity(0n)).toThrow(/power of two/)
  })

  it('rejects a NaN capacity input instead of letting BigInt throw a raw RangeError', () => {
    expect(() => toParticipantCapacity(Number.NaN)).toThrow(/power of two/)
    expect(() => toParticipantCapacity(128.5)).toThrow(/power of two/)
    expect(toParticipantCapacity(256)).toBe(256n)
  })
})

describe('room creation payload', () => {
  it('commits the empty participant tree and a zero participant count', () => {
    const creation = buildRoomCreation(input)
    expect(creation.initialParticipantRoot).toBe(EMPTY_ROOT_128)
    expect(creation.initialParticipantCount).toBe(0n)
  })

  it('never emits the fabricated browser-participant commitment', () => {
    const fabricated = keccak256(
      encodeAbiParameters(
        [{ type: 'string' }, { type: 'address' }, { type: 'uint64' }],
        ['zkdeal/browser-participant/v5', ACCOUNT, 1n],
      ),
    )
    const creation = buildRoomCreation(input)
    expect(creation.initialParticipantRoot).not.toBe(fabricated)
    expect(creation.initialParticipantRoot).toBe(emptyParticipantRoot(128n))
  })

  it('binds the participant root to the capacity it declares', () => {
    const creation = buildRoomCreation({ ...input, participantCapacity: 1024n })
    expect(creation.config.participantCapacity).toBe(1024n)
    expect(creation.initialParticipantRoot).toBe(EMPTY_ROOT_1024)
    expect(creation.initialParticipantRoot).not.toBe(EMPTY_ROOT_128)
  })

  it('keeps the unanimous-approver leaf the contract verifies with an empty proof', () => {
    const creation = buildRoomCreation(input)
    expect(approverLeaf(0n, ACCOUNT, 1n)).toBe(APPROVER_LEAF)
    expect(creation.initialApproverRoot).toBe(APPROVER_LEAF)
    expect(creation.initialActiveApproverCount).toBe(1n)
    // UNANIMOUS_APPROVERS: the intake facet requires a non-zero approver root.
    expect(creation.config.authorizationMode).toBe(0)
  })

  it('passes the preset template through unchanged', () => {
    const creation = buildRoomCreation(input)
    expect(creation.coldTemplateId).toBe(input.coldTemplateId)
    expect(creation.config.policyHash).toBe(input.policyHash)
    expect(creation.config.importPublisher).toBe(ACCOUNT)
    expect(creation.config.minimumImportConfirmations).toBe(64n)
    expect(creation.config.minimumDepositConfirmations).toBe(64n)
    expect(() => assertProductionConfirmationDepth(11n)).toThrow(/at least 12/)
  })

  it('refuses to build a payload for an invalid capacity', () => {
    expect(() => buildRoomCreation({ ...input, participantCapacity: 100n })).toThrow(
      /power of two/,
    )
  })
})
