/**
 * The `card-duel` prover-request fragment: the three objects
 * `zkvm/crates/risc0/host/src/v5_fixture/config.rs` refuses the workload
 * without, plus the participant-registry binding that makes them coherent.
 *
 * WHY THIS EXISTS. `baseSpec` used to send `workload: "card-duel"` and nothing
 * else, so the host's own request parser bailed one step past the capability
 * gate with "the card-duel workload requires a `contracts` descriptor". A duel
 * room is five code-pinned accounts, each holding DIFFERENT runtime code, a
 * registry at slots 0..3, caller-specific STATICCALL rules and an escrow the
 * opening batch actually moves; none of that is expressible by the flat
 * `runtimeCode` + `touchedContracts` request shape.
 *
 * NOTHING HERE IS SYNTHESIZED. Runtime code arrives as the bytes a deployer
 * read back from the chain (`card-deployment.ts`), because
 * `HiddenCardDuelV5`, `CardProofVerifierAdapterV5` and `RoomToken` all carry
 * constructor immutables - the stake token, both verifiers, the entry stake and
 * the minter live in code, so an artifact's `deployedBytecode` has zeroes where
 * those addresses belong and a room built on it would call `address(0)`.
 *
 * Storage comes from `@zkdeal/protocol`'s cold-state builders, which mirror the
 * compiled `storageLayout`; selectors and call rules come from
 * `card-policy.ts`. No slot, selector or capacity is restated here.
 */

import {
  ACTIVE_MEMBER_CALLER,
  CARD_ADAPTER_VERIFY_SIGNATURE,
  CARD_APPLICATION_DOMAIN,
  CARD_CALL_KIND,
  CARD_DECK_VERIFIER_SIGNATURE,
  CARD_HAND_VERIFIER_SIGNATURE,
  CARD_PARTICIPANT_CAPACITY,
  CARD_PARTICIPANT_REGISTRY_SLOTS,
  CARD_ROOM_PLAYERS,
  assertCardParticipantCapacity,
  buildCardDuelStorage,
  buildCardStakeTokenStorage,
  cardDuelAllowedSelectors,
  cardSelector,
  cardStakeTokenContractSelectors,
  cardStakeTokenMemberSelectors,
  emptyParticipantRoot,
} from '@zkdeal/protocol'
import { numberToHex, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

/** `RoomToken` units each seat stakes; the pot is twice this. */
export const CARD_ROOM_ENTRY_STAKE = 10n ** 18n

/**
 * Escrow each duelist funds. Four stakes leaves headroom for a full duel plus
 * `withdrawUnspent`, and `CardDuelBaseV5._stake` refuses a move whose running
 * `paymentSpent` would pass this.
 */
export const CARD_ROOM_FUNDED_AMOUNT = 4n * CARD_ROOM_ENTRY_STAKE

/**
 * Session-key expiry for the opening batch. `_registerParticipant` refuses an
 * expiry at or before `block.timestamp`, and the fixture's block environment
 * (`v5_fixture/signing.rs`) stamps 1_900_000_001 and 1_900_000_002.
 */
export const CARD_ROOM_SESSION_EXPIRY = 2_000_000_000

/** Gas each opening transaction is signed for; a block may spend 5,000,000. */
export const CARD_ROOM_REGISTER_GAS = 700_000
export const CARD_ROOM_MOVE_GAS = 600_000

/** One pinned room account: its address and the runtime code read off-chain. */
export interface CardRoomAccount {
  address: Hex
  runtimeCode: Hex
}

/** The five accounts a duel room pins, plus the escrow terms they were built for. */
export interface CardRoomDeployment {
  duel: CardRoomAccount
  adapter: CardRoomAccount
  deckVerifier: CardRoomAccount
  handVerifier: CardRoomAccount
  stakeToken: CardRoomAccount
  /** Must equal `HiddenCardDuelV5.entryStake`, an immutable baked into the code. */
  entryStake: bigint
  fundedAmount: bigint
  participantCapacity: number
  sessionExpiry: number
  roomApplicationDomain: Hex
}

const ROLES = ['duel', 'adapter', 'deckVerifier', 'handVerifier', 'stakeToken'] as const
type CardRoomRole = (typeof ROLES)[number]

/**
 * The externally-owned account the prover host signs seat `index`'s
 * transactions with.
 *
 * `v5_fixture/signing.rs` derives its keys as `SigningKey::from_bytes(index +
 * 1)`, so seat zero is the well-known private key 1 and seat one private key 2.
 * The room's opening stake-token balances have to sit on exactly these
 * addresses or `registerDuelist`'s `transferFrom` reverts, which is why they are
 * DERIVED here rather than pasted.
 */
export function cardRoomFixtureSigner(index: number): Hex {
  if (!Number.isSafeInteger(index) || index < 0 || index > 15) {
    throw new Error('the prover fixture names at most sixteen signer keys')
  }
  return privateKeyToAccount(numberToHex(BigInt(index) + 1n, { size: 32 })).address
}

/** Seat owners, in participant-index order. */
export const CARD_ROOM_DUELIST_OWNERS: readonly Hex[] = Object.freeze(
  Array.from({ length: CARD_ROOM_PLAYERS }, (_unused, seat) => cardRoomFixtureSigner(seat)),
)

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const RUNTIME_CODE = /^0x[0-9a-fA-F]*$/

function account(deployment: CardRoomDeployment, role: CardRoomRole): CardRoomAccount {
  const entry = deployment[role]
  if (!entry || !ADDRESS.test(entry.address ?? '')) {
    throw new Error(`the card room's '${role}' account needs a 20-byte address`)
  }
  if (BigInt(entry.address) === 0n) {
    throw new Error(`the card room's '${role}' account may not be the zero address`)
  }
  if (
    typeof entry.runtimeCode !== 'string' ||
    !RUNTIME_CODE.test(entry.runtimeCode) ||
    entry.runtimeCode.length <= 2 ||
    entry.runtimeCode.length % 2 !== 0
  ) {
    throw new Error(
      `the card room's '${role}' account needs non-empty runtime code read back from a deployment`,
    )
  }
  return { address: entry.address.toLowerCase() as Hex, runtimeCode: entry.runtimeCode as Hex }
}

/** Every role resolved and checked, with the whole-room uniqueness rule applied. */
function accounts(deployment: CardRoomDeployment): Record<CardRoomRole, CardRoomAccount> {
  const resolved = Object.fromEntries(
    ROLES.map((role) => [role, account(deployment, role)]),
  ) as Record<CardRoomRole, CardRoomAccount>
  const addresses = ROLES.map((role) => resolved[role].address)
  if (new Set(addresses).size !== addresses.length) {
    throw new Error('a card room pins five distinct addresses; the host refuses a duplicate')
  }
  return resolved
}

function contract(
  role: CardRoomRole,
  entry: CardRoomAccount,
  storage: readonly { slot: string; value: string }[],
  writable: boolean,
): Record<string, unknown> {
  return {
    role,
    address: entry.address,
    runtimeCode: entry.runtimeCode,
    // A stateless verifier gets an exactly-slot-zero read-only namespace, so a
    // stray write is a refusal rather than silently accepted state.
    writable,
    prefixBits: writable ? 0 : 256,
    slotPrefix: '0',
    initialStorage: storage.map((word) => ({ slot: word.slot, value: word.value })),
  }
}

/**
 * The `contracts`, `callRules`, `participantRegistry` and `cardDuel` objects a
 * `card-duel` request must carry, ready to be spread into the room spec.
 */
export function buildCardRoomRequest(
  deployment: CardRoomDeployment,
): Record<string, unknown> {
  const room = accounts(deployment)
  const capacity = assertCardParticipantCapacity(
    deployment.participantCapacity ?? CARD_PARTICIPANT_CAPACITY,
  )
  const entryStake = deployment.entryStake
  const fundedAmount = deployment.fundedAmount
  if (typeof entryStake !== 'bigint' || entryStake <= 0n) {
    throw new Error('the duel entry stake must be a positive uint256')
  }
  if (typeof fundedAmount !== 'bigint' || fundedAmount < entryStake) {
    throw new Error('each duelist must fund at least one entry stake')
  }
  const sessionExpiry = deployment.sessionExpiry
  if (!Number.isSafeInteger(sessionExpiry) || sessionExpiry <= 0) {
    throw new Error('the duel session expiry must be a positive uint64')
  }
  const domain = deployment.roomApplicationDomain ?? CARD_APPLICATION_DOMAIN
  const duelStorage = buildCardDuelStorage({
    duelAddress: room.duel.address,
    participantRoot: emptyParticipantRoot(capacity),
    participantCount: 0,
    participantCapacity: capacity,
    roomApplicationDomain: domain,
    duelCount: 0,
  })
  const tokenStorage = buildCardStakeTokenStorage({
    duelAddress: room.duel.address,
    duelistOwners: CARD_ROOM_DUELIST_OWNERS,
    fundedAmount,
  })
  const registry = CARD_PARTICIPANT_REGISTRY_SLOTS
  return {
    contracts: [
      contract('duel', room.duel, duelStorage, true),
      contract('stakeToken', room.stakeToken, tokenStorage, true),
      contract('adapter', room.adapter, [], false),
      contract('deckVerifier', room.deckVerifier, [], false),
      contract('handVerifier', room.handVerifier, [], false),
    ],
    callRules: [
      // Any authenticated signed caller reaches the duel's entry points; in a
      // VALIDITY_ONLY room that is every customer whose transaction is batched.
      {
        caller: ACTIVE_MEMBER_CALLER,
        target: room.duel.address,
        selectors: cardDuelAllowedSelectors(),
        kinds: [CARD_CALL_KIND.call],
      },
      {
        caller: ACTIVE_MEMBER_CALLER,
        target: room.stakeToken.address,
        selectors: cardStakeTokenMemberSelectors(),
        kinds: [CARD_CALL_KIND.call],
      },
      {
        caller: room.duel.address,
        target: room.stakeToken.address,
        selectors: cardStakeTokenContractSelectors(),
        kinds: [CARD_CALL_KIND.call],
      },
      {
        caller: room.duel.address,
        target: room.adapter.address,
        selectors: [cardSelector(CARD_ADAPTER_VERIFY_SIGNATURE)],
        kinds: [CARD_CALL_KIND.staticcall],
      },
      {
        caller: room.adapter.address,
        target: room.deckVerifier.address,
        selectors: [cardSelector(CARD_DECK_VERIFIER_SIGNATURE)],
        kinds: [CARD_CALL_KIND.staticcall],
      },
      {
        caller: room.adapter.address,
        target: room.handVerifier.address,
        selectors: [cardSelector(CARD_HAND_VERIFIER_SIGNATURE)],
        kinds: [CARD_CALL_KIND.staticcall],
      },
    ],
    participantRegistry: {
      contract: room.duel.address,
      rootSlot: registry.rootSlot.toString(),
      epochSlot: registry.epochSlot.toString(),
      countSlot: registry.countSlot.toString(),
      capacitySlot: registry.capacitySlot.toString(),
    },
    cardDuel: {
      entryStake: entryStake.toString(),
      fundedAmount: fundedAmount.toString(),
      sessionExpiry,
      registerGasLimit: CARD_ROOM_REGISTER_GAS,
      moveGasLimit: CARD_ROOM_MOVE_GAS,
      // Distinct seats AND distinct keys: `CardDuelBase.joinDuel` rejects a
      // second seat whose owner equals the first's.
      duelists: Array.from({ length: CARD_ROOM_PLAYERS }, (_unused, seat) => ({
        index: seat,
        signerIndex: seat,
      })),
    },
  }
}
