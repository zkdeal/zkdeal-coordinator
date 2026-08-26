/**
 * `RoomCreation` payload construction for the direct room-pool allocation flow.
 *
 * H1: the console used to fabricate `initialParticipantRoot` as
 * `keccak256(abi.encode('zkdeal/browser-participant/v5', account, 1))` and to
 * send `initialParticipantCount: 1`. That root belongs to no participant Merkle
 * tree. `RoomManagerIntakeFacet._createRoom` rejects only a zero root and then
 * stores root/epoch/count/capacity verbatim, while every later batch must match
 * them exactly (`RoomManagerValidationFacet._validateJournal`) against the four
 * values the guest reads out of the deployed participant registry's storage
 * slots (`stf-core::participant_state_v5`). A freshly constructed
 * `MerkleParticipants` registry holds `emptyParticipantRoot(capacity)` with
 * `participantCount == 0`, so the fabricated commitment made the room unusable
 * the moment the permit was consumed and the fixed charge taken - with no
 * on-chain path to repair it.
 *
 * The encodings below mirror the contracts one-for-one:
 *   - `emptyParticipantRoot`  -> `contracts/src/l2/v5/MerkleParticipants.sol:98`
 *   - `approverLeaf`          -> `contracts/src/RoomManagerValidationFacet.sol:133`
 *   - capacity bounds         -> `RoomManagerIntakeFacet._validParticipantCapacity`
 *
 * Kept React-free so the payload is unit-testable without a DOM harness.
 */
import { concatHex, encodeAbiParameters, keccak256, stringToHex, type Hex } from 'viem'

const zeroAddress = '0x0000000000000000000000000000000000000000' as const
const zeroBytes32 = `0x${'00'.repeat(32)}` as Hex

/** `MerkleParticipants` refuses anything outside this band or not a power of two. */
export const MIN_PARTICIPANT_CAPACITY = 128n
export const MAX_PARTICIPANT_CAPACITY = 32_768n

const CAPACITY_MESSAGE =
  'Participant capacity must be a power of two between 128 and 32768, matching the preset template.'

export function assertParticipantCapacity(capacity: bigint): void {
  if (
    capacity < MIN_PARTICIPANT_CAPACITY ||
    capacity > MAX_PARTICIPANT_CAPACITY ||
    (capacity & (capacity - 1n)) !== 0n
  ) {
    throw new Error(CAPACITY_MESSAGE)
  }
}

/**
 * Converts a numeric input field to a validated capacity. `BigInt(NaN)` throws
 * a raw `RangeError`, so an emptied field must be caught before conversion.
 */
export function toParticipantCapacity(value: number): bigint {
  if (!Number.isSafeInteger(value)) throw new Error(CAPACITY_MESSAGE)
  const capacity = BigInt(value)
  assertParticipantCapacity(capacity)
  return capacity
}

/**
 * Root of an all-empty participant tree of `capacity` leaves - the value a
 * freshly deployed registry publishes in slot 0.
 */
export function emptyParticipantRoot(capacity: bigint): Hex {
  assertParticipantCapacity(capacity)
  let root: Hex = zeroBytes32
  for (let width = capacity; width > 1n; width >>= 1n) {
    root = keccak256(concatHex([root, root]))
  }
  return root
}

/** `keccak256(abi.encode(index, member, joinedEpoch))` - the approver-tree leaf. */
export function approverLeaf(index: bigint, member: Hex, joinedEpoch: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint64' }, { type: 'address' }, { type: 'uint64' }],
      [index, member, joinedEpoch],
    ),
  )
}

export interface RoomCreationInput {
  /** Sole initial approver and import publisher. */
  account: Hex
  /** `presets(presetId).coldTemplateId`. */
  coldTemplateId: Hex
  /** `presets(presetId).policyHash` - must equal the template's own policy hash. */
  policyHash: Hex
  /** Capacity the preset's cold template deployed its participant registry with. */
  participantCapacity: bigint
}

export const PRODUCTION_CONFIRMATION_FLOOR = 12n
export const DEFAULT_PRODUCTION_CONFIRMATIONS = 64n

export function assertProductionConfirmationDepth(value: bigint): bigint {
  if (value < PRODUCTION_CONFIRMATION_FLOOR) {
    throw new Error(
      `production room confirmations must be at least ${PRODUCTION_CONFIRMATION_FLOOR} blocks`,
    )
  }
  return value
}

export interface RoomCreation {
  config: {
    policyHash: Hex
    adapterPolicyRoot: Hex
    importPublisher: Hex
    minimumImportConfirmations: bigint
    minimumDepositConfirmations: bigint
    inactivityTimeout: bigint
    authorizationMode: number
    admissionSigner: Hex
    maximumAdmissionWindow: bigint
    minimumServiceBond: bigint
    omissionPenalty: bigint
    participantCapacity: bigint
  }
  coldTemplateId: Hex
  initialApproverRoot: Hex
  initialActiveApproverCount: bigint
  initialParticipantRoot: Hex
  initialParticipantCount: bigint
  canonicalColdTemplateData: Hex
  supportedAssets: readonly Hex[]
}

/**
 * Builds the unanimous-approver creation payload for a browser-created room.
 * The participant commitment is the empty tree with count 0, because the cold
 * template registers no participant before the room exists.
 */
export function buildRoomCreation(input: RoomCreationInput): RoomCreation {
  assertParticipantCapacity(input.participantCapacity)
  const confirmations = assertProductionConfirmationDepth(DEFAULT_PRODUCTION_CONFIRMATIONS)
  return {
    config: {
      policyHash: input.policyHash,
      adapterPolicyRoot: keccak256(stringToHex('zkdeal/browser/no-imports/v5')),
      importPublisher: input.account,
      minimumImportConfirmations: confirmations,
      minimumDepositConfirmations: confirmations,
      inactivityTimeout: 86_400n,
      // UNANIMOUS_APPROVERS: a non-zero approver root with one active approver.
      authorizationMode: 0,
      admissionSigner: zeroAddress,
      maximumAdmissionWindow: 0n,
      minimumServiceBond: 0n,
      omissionPenalty: 0n,
      participantCapacity: input.participantCapacity,
    },
    coldTemplateId: input.coldTemplateId,
    initialApproverRoot: approverLeaf(0n, input.account, 1n),
    initialActiveApproverCount: 1n,
    initialParticipantRoot: emptyParticipantRoot(input.participantCapacity),
    initialParticipantCount: 0n,
    canonicalColdTemplateData: '0x',
    supportedAssets: [zeroAddress],
  }
}
