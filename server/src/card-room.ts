/**
 * The hidden-card duel as a room preset, plus the honest statement of what
 * the prover host still has to gain before such a room can be prepared.
 *
 * Everything the preset declares is derived from `@zkdeal/protocol`'s
 * `card-application` / `card-policy` modules, which are in turn pinned to
 * `contracts/src/l2/v5/HiddenCardDuel.sol`. No selector, slot or capacity is
 * restated here.
 *
 * WHY A CAPABILITY GATE. The preset that shipped before this one claimed to be
 * a card game while running the generic `storage` workload with dummy
 * `0x12345678` calldata. A card room is a five-contract room whose participant
 * registry lives at slots 0-3 and whose duel STATICCALLs a Groth16 adapter -
 * a shape only some prover images can express. Rather than ship another
 * placeholder, the preset declares exactly which host capabilities it needs and
 * template preparation refuses, naming them, until the prover reports them.
 * The gate is a property of the CONFIGURED host, not of the repository: the
 * fixture in `zkvm/crates/risc0/host/src/v5_fixture` derives its reported
 * `roomCapabilities` by running its own request parser, so an older or degraded
 * binary reports a shorter list and is refused here by name.
 */

import {
  CARD_PARTICIPANT_CAPACITY,
  CARD_ROOM_PLAYERS,
  cardDuelAllowedSelectors,
  cardStakeTokenMemberSelectors,
  emptyParticipantRoot,
  CARD_APPLICATION_DOMAIN,
  CARD_DUEL_STORAGE_SLOTS,
} from '@zkdeal/protocol'
import type { DemoPreset } from './demo-types.js'

export const CARD_ROOM_PRESET_ID = 'card-game'

/** Fixture workload id the prover host must implement for a duel room. */
export const CARD_ROOM_WORKLOAD = 'card-duel'

/** Pinned code accounts: duel, proof adapter, two verifiers, stake token. */
export const CARD_ROOM_TOUCHED_CONTRACTS = 5

/**
 * Prover-host capabilities a card room needs, each with what the room requires
 * of the host's `v5_fixture` request surface. The tokens are compared against
 * the `roomCapabilities` array of the host's `/v5/capabilities` document; an
 * absent array means none. A token listed as missing says the CONFIGURED
 * binary does not derive it, not that the repository lacks the feature.
 */
export const CARD_ROOM_PROVER_CAPABILITIES: Readonly<Record<string, string>> = Object.freeze({
  'v5.workload.card-duel':
    'the host must accept the v5_fixture card-duel workload and build real registerDuelist/openDuel/joinDuel calldata against the deployed duel runtime; a host that does not name the workload rejects the request outright',
  'v5.coldState.perContractRuntime':
    'the host must accept a v5_fixture `contracts` descriptor giving each pinned address its OWN runtime code and opening storage; a duel plus an adapter plus two verifiers plus a stake token cannot be expressed by one cloned runtime',
  'v5.participantRegistry.configurableSlots':
    'the host must accept a v5_fixture `participantRegistry` object; MerkleParticipants keeps root/epoch/count/capacity at slots 0..3, not at the historic 1_000_000_000..3 default',
  'v5.participantRegistry.emptyOpen':
    'the host must accept registeredParticipants = 0: a duel room opens with an empty registry and both players register in-room through registerDuelist',
  'v5.participants.multiTouch':
    'the host must accept touchedParticipants > 1 outside the participant-merkle sweep; every duel move touches two participant leaves',
  'v5.policy.perContractCallRules':
    'the host must accept v5_fixture `callRules` with caller-specific permissions including STATICCALL, for duel -> stake token, duel -> adapter and adapter -> verifier; a flat ACTIVE_MEMBER rule per address cannot express them',
})

export const CARD_ROOM_REQUIRED_CAPABILITIES: readonly string[] = Object.freeze(
  Object.keys(CARD_ROOM_PROVER_CAPABILITIES),
)

/**
 * Capability tokens the host does not report. An unreadable or absent
 * capability document means every capability is missing: a card room is never
 * prepared on an assumption.
 */
export function reportedRoomCapabilities(capabilities: unknown): ReadonlySet<string> {
  const reported = new Set<string>()
  if (capabilities && typeof capabilities === 'object') {
    const raw = (capabilities as { roomCapabilities?: unknown }).roomCapabilities
    if (Array.isArray(raw)) {
      for (const entry of raw) if (typeof entry === 'string') reported.add(entry)
    }
  }
  return reported
}

export function missingCardRoomCapabilities(capabilities: unknown): string[] {
  const reported = reportedRoomCapabilities(capabilities)
  return CARD_ROOM_REQUIRED_CAPABILITIES.filter((token) => !reported.has(token))
}

/** Caller-safe explanation naming every capability and why it is needed. */
export function describeCardRoomCapabilityGap(missing: readonly string[]): string {
  const reasons = missing
    .map((token) => `${token} (${CARD_ROOM_PROVER_CAPABILITIES[token] ?? 'unspecified'})`)
    .join('; ')
  return `the configured prover cannot prepare this room yet: ${reasons}`
}

/**
 * Duel-room cold-state slots that are the same for every deployment.
 *
 * `proofDomain` (slot 5) is deliberately absent: it is
 * `keccak256(abi.encode(roomApplicationDomain, duelAddress)) % p` and is not
 * knowable before the duel contract has an address. The preparation step must
 * add it with `buildCardColdStateSeed`, which is why
 * `v5.coldState.perContractRuntime` is a required capability.
 */
function cardRoomInitialStorage(): DemoPreset['initialStorage'] {
  const slots = CARD_DUEL_STORAGE_SLOTS
  return [
    {
      label: 'participant root (empty registry, capacity 128)',
      slot: slots.participantRoot.toString(),
      value: BigInt(emptyParticipantRoot(CARD_PARTICIPANT_CAPACITY)).toString(),
      mode: 'INITIAL_WITNESS',
    },
    { label: 'participant epoch', slot: slots.participantEpoch.toString(), value: '1', mode: 'ROOM_LOCAL' },
    { label: 'registered duelists', slot: slots.participantCount.toString(), value: '0', mode: 'ROOM_LOCAL' },
    {
      label: 'participant capacity',
      slot: slots.participantCapacity.toString(),
      value: String(CARD_PARTICIPANT_CAPACITY),
      mode: 'INITIAL_WITNESS',
    },
    {
      label: 'room application domain',
      slot: slots.roomApplicationDomain.toString(),
      value: BigInt(CARD_APPLICATION_DOMAIN).toString(),
      mode: 'INITIAL_WITNESS',
    },
    { label: 'open duels', slot: slots.duelCount.toString(), value: '0', mode: 'ROOM_LOCAL' },
  ]
}

/**
 * The preset a demo stand selects to spawn a card room.
 *
 * `actions` is empty ON PURPOSE. Every duel move carries a participant tuple, a
 * seven-deep Merkle proof and, for four of them, a 256-byte inner Groth16
 * proof; none of that can be canned in a preset, and a canned move would be a
 * lie about what the room does. The browser client builds each move itself and
 * submits it as client calldata, which `addAction` already accepts and checks
 * against `allowedSelectors`.
 */
export function cardRoomPreset(): DemoPreset {
  return {
    id: CARD_ROOM_PRESET_ID,
    name: 'Hidden-card duel',
    summary:
      'Two players register, prove their deck and every hand transition in the browser, and settle a duel whose deck order, salts and hands never leave the device.',
    workload: CARD_ROOM_WORKLOAD,
    // Both duelists sign their own moves; there is no checkpoint consensus.
    authorizationMode: 'VALIDITY_ONLY',
    participantCapacity: CARD_PARTICIPANT_CAPACITY,
    activeApprovers: 0,
    allowedSelectors: [...cardDuelAllowedSelectors(), ...cardStakeTokenMemberSelectors()],
    actions: [],
    initialStorage: cardRoomInitialStorage(),
    registeredParticipants: 0,
    touchedParticipants: CARD_ROOM_PLAYERS,
    touchedContracts: CARD_ROOM_TOUCHED_CONTRACTS,
    residentAccounts: CARD_ROOM_TOUCHED_CONTRACTS + 3,
    proverCapabilities: CARD_ROOM_REQUIRED_CAPABILITIES,
  }
}
