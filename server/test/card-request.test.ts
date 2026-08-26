/**
 * The card-duel prover request, checked against a TypeScript mirror of the
 * host's own parser.
 *
 * Every rule asserted below is transcribed from
 * `zkvm/crates/risc0/host/src/v5_fixture/`: `config.rs::parse_fixture_config`
 * and `check_ranges`, `contracts.rs::{parse_contracts, parse_call_rules,
 * parse_participant_registry}`, `card.rs::parse_card_duel_request`,
 * `policy.rs::{check_registry_namespace, check_call_rules, selector_allowed}`
 * and `blocks.rs::build_blocks`. The host cannot be compiled on every machine
 * that runs this suite, so mirroring it here is what turns "the request is
 * malformed" from a rejection minutes into a prepare into a unit-test failure.
 *
 * Before the request builder existed, `baseSpec` sent `workload: "card-duel"`
 * and none of the three objects the workload gate demands, so every assertion
 * in `the emitted card-duel request` fails without it.
 */

import {
  CARD_DUEL_ENTRY_POINT_SIGNATURES,
  CARD_PARTICIPANT_CAPACITY,
  CARD_STAKE_TOKEN_STORAGE_SLOTS,
  cardDuelStructBaseSlot,
} from '@zkdeal/protocol'
import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  toFunctionSelector,
  zeroAddress,
} from 'viem'
import { describe, expect, it } from 'vitest'
import {
  CARD_ROOM_PRESET_ID,
  CARD_ROOM_REQUIRED_CAPABILITIES,
  CARD_ROOM_TOUCHED_CONTRACTS,
} from '../src/card-room.js'
import {
  CARD_ROOM_DUELIST_OWNERS,
  CARD_ROOM_ENTRY_STAKE,
  CARD_ROOM_FUNDED_AMOUNT,
  buildCardRoomRequest,
  cardRoomFixtureSigner,
} from '../src/card-request.js'
import { baseSpec } from '../src/demo-runtime-spec.js'
import { validateTemplateRequest } from '../src/demo-validation.js'
import type { DemoTemplate } from '../src/demo-types.js'
import { cardRoomFixture } from './helpers/card-room-fixture.js'

const DOMAIN = `0x${'11'.repeat(32)}` as const

/** `v5_fixture/contracts.rs::CARD_ROOM_ROLES`. */
const CARD_ROOM_ROLES = ['duel', 'adapter', 'deckVerifier', 'handVerifier', 'stakeToken']

/** Caps from `v5_fixture/config.rs`. */
const MAX_TOUCHED_CONTRACTS = 32
const MAX_RESIDENT_ACCOUNTS = 127
const MAX_RESIDENT_STORAGE_SLOTS = 2_048
const MAX_TOUCHED_PARTICIPANTS = 128
const MAX_SIGNER_ACCOUNTS = 16

function template(overrides: Partial<DemoTemplate> = {}): DemoTemplate {
  const validated = validateTemplateRequest({ name: 'Hidden-card duel', presetId: CARD_ROOM_PRESET_ID })
  return {
    ...validated,
    id: 'tpl-card-request',
    phase: 'ROOM_READY',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
    ...overrides,
  }
}

function cardSpec(overrides: Parameters<typeof cardRoomFixture>[0] = {}): Record<string, unknown> {
  return baseSpec(template(), 7, 1_000, DOMAIN, undefined, null, cardRoomFixture(overrides))
}

interface SpecContract {
  role: string
  address: string
  runtimeCode: string
  writable: boolean
  prefixBits: number
  slotPrefix: string
  initialStorage: Array<{ slot: string; value: string }>
}

interface SpecRule {
  caller: string
  target: string
  selectors: string[]
  kinds: number[]
}

const contractsOf = (spec: Record<string, unknown>) => spec.contracts as SpecContract[]
const rulesOf = (spec: Record<string, unknown>) => spec.callRules as SpecRule[]
const registryOf = (spec: Record<string, unknown>) =>
  spec.participantRegistry as Record<string, string>
const duelOf = (spec: Record<string, unknown>) => spec.cardDuel as Record<string, unknown>

/** `contracts.rs::slot_in_namespace`, the guest's `slot_has_prefix`. */
function slotInNamespace(slot: bigint, prefix: bigint, prefixBits: number): boolean {
  if (prefixBits === 0) return true
  if (prefixBits >= 256) return slot === prefix
  const shift = BigInt(256 - prefixBits)
  return slot >> shift === prefix >> shift
}

/** An independent Solidity mapping-slot implementation, via viem's ABI codec. */
function mappingSlot(key: bigint, slot: bigint): bigint {
  return BigInt(
    keccak256(encodeAbiParameters(parseAbiParameters('uint256, uint256'), [key, slot])),
  )
}

/**
 * Everything `parse_fixture_config` would refuse the request for. Throws with
 * the host's own wording so a failure names the rule that was broken.
 */
function assertHostWouldAccept(spec: Record<string, unknown>): void {
  // --- config.rs: the card-duel workload gate ------------------------------
  expect(spec.workload, 'workload').toBe('card-duel')
  expect(Array.isArray(spec.contracts), 'the card-duel workload requires a `contracts` descriptor').toBe(true)
  expect(spec.cardDuel, 'the card-duel workload requires a `cardDuel` object').toBeTruthy()
  expect(Array.isArray(spec.callRules), 'the card-duel workload requires `callRules`').toBe(true)

  const contracts = contractsOf(spec)
  const pinned = new Set(contracts.map((entry) => entry.address))
  // --- contracts.rs::parse_contracts ---------------------------------------
  expect(contracts.length).toBeGreaterThan(0)
  expect(contracts.length).toBeLessThanOrEqual(MAX_TOUCHED_CONTRACTS)
  expect(pinned.size, 'contracts contains a duplicate address').toBe(contracts.length)
  for (const entry of contracts) {
    expect(entry.role, 'contracts[].role may not be empty').toBeTruthy()
    expect(entry.address).toMatch(/^0x[0-9a-f]{40}$/)
    expect(BigInt(entry.address), 'contracts[].address may not be the zero address').not.toBe(0n)
    expect(entry.runtimeCode, 'contracts[].runtimeCode may not be empty').toMatch(
      /^0x([0-9a-fA-F]{2})+$/,
    )
    expect(entry.prefixBits, 'contracts[].prefixBits must be at most 256').toBeLessThanOrEqual(256)
    expect(entry.initialStorage.length).toBeLessThanOrEqual(MAX_RESIDENT_STORAGE_SLOTS)
    const slots = entry.initialStorage.map((word) => BigInt(word.slot))
    expect(new Set(slots.map(String)).size, 'initialStorage contains a duplicate slot').toBe(
      slots.length,
    )
    for (const slot of slots) {
      expect(
        slotInNamespace(slot, BigInt(entry.slotPrefix), entry.prefixBits),
        `contracts[${entry.role}].initialStorage slot ${slot} is outside the declared namespace`,
      ).toBe(true)
    }
  }
  // --- v5_fixture.rs::resolve_contracts: the five duel roles ---------------
  for (const role of CARD_ROOM_ROLES) {
    expect(
      contracts.some((entry) => entry.role === role),
      `the card-duel workload needs a contracts entry with role '${role}'`,
    ).toBe(true)
  }

  // --- contracts.rs::parse_participant_registry + policy.rs ----------------
  const registry = registryOf(spec)
  expect(pinned.has(registry.contract), 'participantRegistry.contract must be a room contract').toBe(true)
  const registrySlots = [registry.rootSlot, registry.epochSlot, registry.countSlot, registry.capacitySlot]
  expect(new Set(registrySlots).size, 'participantRegistry must name four distinct slots').toBe(4)
  const host = contracts.find((entry) => entry.address === registry.contract)!
  for (const slot of registrySlots) {
    expect(
      host.writable && slotInNamespace(BigInt(slot), BigInt(host.slotPrefix), host.prefixBits),
      `participant registry slot ${slot} is not inside a writable namespace`,
    ).toBe(true)
  }

  // --- contracts.rs::parse_call_rules + policy.rs::check_call_rules --------
  const rules = rulesOf(spec)
  expect(rules.length).toBeGreaterThan(0)
  expect(rules.length).toBeLessThanOrEqual(64)
  const pairs = new Set<string>()
  for (const rule of rules) {
    const key = `${rule.caller}:${rule.target}`
    expect(pairs.has(key), 'callRules contains a duplicate caller/target pair').toBe(false)
    pairs.add(key)
    expect(pinned.has(rule.target), 'call rule target is not one of the pinned contracts').toBe(true)
    expect(
      rule.caller === zeroAddress || pinned.has(rule.caller),
      'call rule caller is neither the active-member sentinel nor a pinned contract',
    ).toBe(true)
    expect(rule.selectors.length).toBeGreaterThan(0)
    expect(rule.selectors.length).toBeLessThanOrEqual(64)
    expect(new Set(rule.selectors).size, 'callRules selectors contains a duplicate').toBe(
      rule.selectors.length,
    )
    for (const selector of rule.selectors) expect(selector).toMatch(/^0x[0-9a-f]{8}$/)
    expect(rule.kinds.length).toBeGreaterThan(0)
    expect(new Set(rule.kinds).size).toBe(rule.kinds.length)
    for (const kind of rule.kinds) expect([0, 1, 2]).toContain(kind)
  }

  // --- card.rs::parse_card_duel_request ------------------------------------
  const duel = duelOf(spec)
  expect(BigInt(duel.entryStake as string), 'cardDuel.entryStake must be positive').toBeGreaterThan(0n)
  expect(
    BigInt(duel.fundedAmount as string),
    'cardDuel.fundedAmount must cover cardDuel.entryStake',
  ).toBeGreaterThanOrEqual(BigInt(duel.entryStake as string))
  const duelists = duel.duelists as Array<{ index: number; signerIndex: number }>
  expect(duelists, 'cardDuel.duelists must name exactly 2 seats').toHaveLength(2)
  expect(duelists[0]!.index, 'duelists must name distinct participant indices').not.toBe(
    duelists[1]!.index,
  )
  expect(duelists[0]!.signerIndex, 'duelists must name distinct signers').not.toBe(
    duelists[1]!.signerIndex,
  )
  for (const seat of duelists) {
    expect(seat.index).toBeLessThan(Number(spec.participantCapacity))
  }

  // --- config.rs::check_ranges ---------------------------------------------
  const capacity = Number(spec.participantCapacity)
  const signerAccounts = duelists.length
  const registered = Number(spec.registeredParticipants)
  const touchedParticipants = Number(spec.touchedParticipants)
  const touchedContracts = Number(spec.touchedContracts)
  expect(Number(spec.roomId)).toBeGreaterThan(0)
  expect(Number(spec.l1ChainId)).toBeGreaterThan(0)
  expect(Number(spec.l1InclusionDeadline)).toBeGreaterThan(0)
  expect(spec.authorizationMode).toBe('validity-only')
  expect(Number(spec.activeSigners), 'validity-only rooms carry no approver roster').toBe(0)
  expect(capacity).toBeGreaterThanOrEqual(128)
  expect(capacity).toBeLessThanOrEqual(32_768)
  expect(capacity & (capacity - 1)).toBe(0)
  expect(registered).toBeLessThanOrEqual(capacity)
  expect(touchedParticipants).toBeGreaterThan(0)
  expect(touchedParticipants).toBeLessThanOrEqual(registered === 0 ? capacity : registered)
  expect(touchedParticipants).toBeLessThanOrEqual(MAX_TOUCHED_PARTICIPANTS)
  expect(
    touchedContracts,
    'touchedContracts must agree with the contracts descriptor',
  ).toBe(contracts.length)
  expect(touchedContracts).toBeLessThanOrEqual(MAX_TOUCHED_CONTRACTS)
  expect(signerAccounts).toBeGreaterThan(0)
  expect(signerAccounts).toBeLessThanOrEqual(MAX_SIGNER_ACCOUNTS)
  const senderAccounts = ((spec.senderAccounts as string[]) ?? []).length
  expect(
    Number(spec.residentAccounts),
    'residentAccounts omits a touched account',
  ).toBeGreaterThanOrEqual(signerAccounts + senderAccounts + touchedContracts)
  expect(Number(spec.residentAccounts)).toBeLessThanOrEqual(MAX_RESIDENT_ACCOUNTS)
  expect(Number(spec.residentMirrorVariables)).toBeGreaterThan(0)
  expect(
    Number(spec.residentMirrorVariables) + Number(spec.importedVariables),
  ).toBeLessThanOrEqual(MAX_RESIDENT_STORAGE_SLOTS)

  // --- blocks.rs::build_blocks precedence ----------------------------------
  expect(
    spec.blockCalls,
    'blockCalls is consumed before the card plan and would replace the whole duel',
  ).toBeUndefined()
  expect(spec.rawTransactions).toBeUndefined()
  expect(
    spec.initialStorage,
    'a descriptor room states its storage per address, never flat beside it',
  ).toBeUndefined()
  expect(spec.runtimeCode, 'a duel room has no single cloned runtime').toBeUndefined()
  expect(spec.contractAddress).toBeUndefined()

  // --- v5_fixture.rs: every planned call must be inside the callRules -------
  const allowed = (target: string, selector: string) =>
    rules.some(
      (rule) =>
        rule.caller === zeroAddress &&
        rule.target === target &&
        rule.kinds.includes(0) &&
        rule.selectors.includes(selector),
    )
  for (const entry of ['registerDuelist', 'openDuel', 'joinDuel'] as const) {
    const selector = toFunctionSelector(CARD_DUEL_ENTRY_POINT_SIGNATURES[entry])
    expect(allowed(registry.contract, selector), `${entry} is outside the certified callRules`).toBe(
      true,
    )
  }
}

describe('the emitted card-duel request', () => {
  it('satisfies every rule the prover host parser enforces', () => {
    assertHostWouldAccept(cardSpec())
  })

  it('names the five duel roles with per-address runtime code', () => {
    const fixture = cardRoomFixture()
    const contracts = contractsOf(cardSpec())
    expect(contracts).toHaveLength(CARD_ROOM_TOUCHED_CONTRACTS)
    const byRole = new Map(contracts.map((entry) => [entry.role, entry]))
    expect([...byRole.keys()].sort()).toEqual([...CARD_ROOM_ROLES].sort())
    for (const role of CARD_ROOM_ROLES) {
      const source = fixture[role as keyof typeof fixture] as { address: string; runtimeCode: string }
      expect(byRole.get(role)!.address).toBe(source.address.toLowerCase())
      // Verbatim: the host pins keccak256(runtimeCode) per address, so a single
      // re-encoding step here would be a different room.
      expect(byRole.get(role)!.runtimeCode).toBe(source.runtimeCode)
    }
    const codes = contracts.map((entry) => entry.runtimeCode)
    expect(new Set(codes).size, 'five clones cannot be a duel room').toBe(codes.length)
  })

  it('gives the duel and the token writable storage and the verifiers none', () => {
    const contracts = contractsOf(cardSpec())
    const byRole = new Map(contracts.map((entry) => [entry.role, entry]))
    for (const role of ['duel', 'stakeToken']) {
      expect(byRole.get(role)!.writable).toBe(true)
      expect(byRole.get(role)!.prefixBits).toBe(0)
      expect(byRole.get(role)!.initialStorage.length).toBeGreaterThan(0)
    }
    for (const role of ['adapter', 'deckVerifier', 'handVerifier']) {
      expect(byRole.get(role)!.writable).toBe(false)
      expect(byRole.get(role)!.prefixBits).toBe(256)
      expect(byRole.get(role)!.initialStorage).toEqual([])
    }
  })

  it('seeds the reentrancy lock and the whole opening duel struct', () => {
    const duel = contractsOf(cardSpec()).find((entry) => entry.role === 'duel')!
    const bySlot = new Map(duel.initialStorage.map((word) => [BigInt(word.slot), BigInt(word.value)]))
    // MerkleParticipants 0..3, roomApplicationDomain 4, proofDomain 5, duelCount 6.
    for (let slot = 0n; slot <= 6n; slot += 1n) expect(bySlot.has(slot), `slot ${slot}`).toBe(true)
    expect(bySlot.get(0n), 'the opening participant root is never zero').not.toBe(0n)
    expect(bySlot.get(1n), 'participantEpoch').toBe(1n)
    expect(bySlot.get(2n), 'an empty registry opens at count zero').toBe(0n)
    expect(bySlot.get(3n)).toBe(BigInt(CARD_PARTICIPANT_CAPACITY))
    expect(bySlot.get(5n), 'proofDomain is address-derived and never zero').not.toBe(0n)
    // `_locked` MUST open at 1 or every nonReentrant entry point reverts.
    expect(bySlot.get(8n), '_locked').toBe(1n)
    const base = mappingSlot(1n, 7n)
    expect(base, 'independent mapping-slot derivation').toBe(cardDuelStructBaseSlot(1n))
    for (let offset = 0n; offset < 18n; offset += 1n) {
      expect(bySlot.has(base + offset), `_duels[1] word ${offset}`).toBe(true)
    }
    expect(duel.initialStorage).toHaveLength(8 + 18)
  })

  it('funds the exact fixture keys the host signs the duel with', () => {
    const token = contractsOf(cardSpec()).find((entry) => entry.role === 'stakeToken')!
    const duelAddress = registryOf(cardSpec()).contract
    const bySlot = new Map(token.initialStorage.map((word) => [BigInt(word.slot), BigInt(word.value)]))
    const slots = CARD_STAKE_TOKEN_STORAGE_SLOTS
    // `signing.rs` derives fixture key `index` as SigningKey::from_bytes(index + 1).
    expect(cardRoomFixtureSigner(0)).toBe('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf')
    expect(cardRoomFixtureSigner(1)).toBe('0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF')
    for (const owner of CARD_ROOM_DUELIST_OWNERS) {
      const balance = mappingSlot(BigInt(owner), slots.balanceOf)
      const approval = mappingSlot(BigInt(duelAddress), mappingSlot(BigInt(owner), slots.allowance))
      expect(bySlot.get(balance), `balanceOf[${owner}]`).toBe(CARD_ROOM_FUNDED_AMOUNT)
      expect(bySlot.get(approval), `allowance[${owner}][duel]`).toBe(CARD_ROOM_FUNDED_AMOUNT)
    }
    // The escrow destination has to be named even though it opens at zero.
    expect(bySlot.get(mappingSlot(BigInt(duelAddress), slots.balanceOf))).toBe(0n)
    expect(bySlot.get(slots.totalSupply)).toBe(CARD_ROOM_FUNDED_AMOUNT * 2n)
    expect(BigInt(duelOf(cardSpec()).entryStake as string)).toBe(CARD_ROOM_ENTRY_STAKE)
    expect(CARD_ROOM_FUNDED_AMOUNT).toBeGreaterThanOrEqual(CARD_ROOM_ENTRY_STAKE)
  })

  it('routes the duel through the adapter and the adapter through both verifiers', () => {
    const spec = cardSpec()
    const fixture = cardRoomFixture()
    const rules = rulesOf(spec)
    const rule = (caller: string, target: string) =>
      rules.find((entry) => entry.caller === caller && entry.target === target)
    const lower = (value: string) => value.toLowerCase()
    expect(rule(lower(fixture.duel.address), lower(fixture.adapter.address))?.kinds).toEqual([1])
    expect(rule(lower(fixture.adapter.address), lower(fixture.deckVerifier.address))?.kinds).toEqual([1])
    expect(rule(lower(fixture.adapter.address), lower(fixture.handVerifier.address))?.kinds).toEqual([1])
    expect(rule(lower(fixture.duel.address), lower(fixture.stakeToken.address))?.kinds).toEqual([0])
    expect(rule(zeroAddress, lower(fixture.duel.address))?.kinds).toEqual([0])
    expect(rule(zeroAddress, lower(fixture.stakeToken.address))?.kinds).toEqual([0])
    expect(rules).toHaveLength(6)
  })

  it('pins the entry-point selectors the prover host hard-codes', () => {
    // `v5_fixture/card.rs` asserts these three byte strings; a rename on either
    // side stops the duel's calldata matching the certified allow-list.
    const rule = rulesOf(cardSpec()).find((entry) => entry.caller === zeroAddress)!
    expect(rule.selectors).toContain('0xe22b07a8')
    expect(rule.selectors).toContain('0xf2705975')
    expect(rule.selectors).toContain('0x3e2a7417')
  })

  it('refuses to build a duel request the host would reject', () => {
    expect(() => cardSpec({ duel: { address: zeroAddress, runtimeCode: '0x60' } })).toThrow(
      /may not be the zero address/,
    )
    expect(() =>
      cardSpec({ adapter: { address: `0x${'ab'.repeat(20)}`, runtimeCode: '0x' } }),
    ).toThrow(/non-empty runtime code/)
    const duplicate = cardRoomFixture()
    expect(() => cardSpec({ adapter: { ...duplicate.duel } })).toThrow(/five distinct addresses/)
    expect(() => cardSpec({ entryStake: 0n })).toThrow(/positive uint256/)
    expect(() => cardSpec({ fundedAmount: 1n })).toThrow(/at least one entry stake/)
    // The duel's capacity is written by its constructor and read back out of
    // proven state; a template that drifted from it can never open.
    expect(() => cardSpec({ participantCapacity: 256 })).toThrow(
      /deployed duel was built for a participant capacity of 256/,
    )
  })
})

describe('the card room preset and the prover request agree', () => {
  it('refuses to emit a duel request without a deployment', () => {
    expect(() => baseSpec(template(), 1, 1_000, DOMAIN)).toThrow(/card-duel room request needs/)
  })

  it('leaves every other preset on the historical clone-shaped request', () => {
    const spec = baseSpec(template({ presetId: 'shop' }), 1, 1_000, DOMAIN)
    expect(spec.workload).toBe('shop-demo')
    expect(spec.contracts).toBeUndefined()
    expect(spec.callRules).toBeUndefined()
    expect(spec.cardDuel).toBeUndefined()
    expect(spec.participantRegistry).toBeUndefined()
    expect(Array.isArray(spec.blockCalls)).toBe(true)
  })

  /**
   * Each capability the preset demands of the host must actually be EXERCISED
   * by the request the server sends. A token that is required but never used
   * would gate preparation on a feature the room does not need; a request that
   * used a feature outside the list would be refused by a host that honestly
   * reports a shorter list.
   */
  it('exercises exactly the capabilities the preset requires of the host', () => {
    const spec = cardSpec()
    const exercised: Record<string, (value: Record<string, unknown>) => boolean> = {
      'v5.workload.card-duel': (value) => value.workload === 'card-duel' && Boolean(value.cardDuel),
      'v5.coldState.perContractRuntime': (value) => {
        const contracts = contractsOf(value)
        return (
          new Set(contracts.map((entry) => entry.runtimeCode)).size === contracts.length &&
          contracts.some((entry) => entry.initialStorage.length > 0)
        )
      },
      'v5.participantRegistry.configurableSlots': (value) => {
        const registry = registryOf(value)
        return (
          Boolean(registry?.contract) &&
          [registry.rootSlot, registry.epochSlot, registry.countSlot, registry.capacitySlot].join(
            ',',
          ) === '0,1,2,3'
        )
      },
      'v5.participantRegistry.emptyOpen': (value) => Number(value.registeredParticipants) === 0,
      'v5.participants.multiTouch': (value) => Number(value.touchedParticipants) > 1,
      'v5.policy.perContractCallRules': (value) =>
        rulesOf(value).some((rule) => rule.caller !== zeroAddress && rule.kinds.includes(1)),
    }
    expect(Object.keys(exercised).sort()).toEqual([...CARD_ROOM_REQUIRED_CAPABILITIES].sort())
    for (const [token, holds] of Object.entries(exercised)) {
      expect(holds(spec), `${token} is required but never exercised`).toBe(true)
    }
  })
})
