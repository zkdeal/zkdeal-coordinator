/**
 * A duel-room deployment for tests: five distinct addresses, each carrying its
 * OWN runtime code.
 *
 * Runtime code is the compiled `deployedBytecode` from `contracts/out` whenever
 * the Foundry build output is present, because that is the only way to exercise
 * the real multi-kilobyte hex the request actually carries. `contracts/out` is
 * a build directory and a clean clone does not have it, so an absent artifact
 * degrades to a short, still DISTINCT and still non-empty body - every
 * assertion in the suite is about the request's shape, and none of them changes
 * with the length of the code.
 *
 * The production path never uses either: `card-deployment.ts` deploys the
 * five accounts and reads their runtime back off the chain, because the duel,
 * the adapter and the token all carry constructor immutables that a static
 * artifact leaves zeroed.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Hex } from 'viem'
import {
  CARD_ROOM_ENTRY_STAKE,
  CARD_ROOM_FUNDED_AMOUNT,
  CARD_ROOM_SESSION_EXPIRY,
  type CardRoomDeployment,
} from '../../src/card-request.js'
import { CARD_APPLICATION_DOMAIN, CARD_PARTICIPANT_CAPACITY } from '@zkdeal/protocol'

const OUT = fileURLToPath(new URL('../../../../web3-protocol/contracts/out/', import.meta.url))

/** `deployedBytecode.object` from a Foundry artifact, or null when unbuilt. */
export function compiledRuntimeCode(file: string, contract: string): Hex | null {
  try {
    const artifact = JSON.parse(readFileSync(`${OUT}${file}/${contract}.json`, 'utf8')) as {
      deployedBytecode?: { object?: string } | string
    }
    const value = artifact.deployedBytecode
    const object = typeof value === 'string' ? value : value?.object
    return object && /^0x[0-9a-fA-F]{2,}$/.test(object) ? (object as Hex) : null
  } catch {
    return null
  }
}

function runtimeCode(file: string, contract: string, fallback: string): Hex {
  return compiledRuntimeCode(file, contract) ?? (fallback as Hex)
}

/** Distinct 20-byte addresses in the shape a local deployment produces. */
function address(seed: number): Hex {
  return `0x${seed.toString(16).padStart(40, '0')}` as Hex
}

export function cardRoomFixture(
  overrides: Partial<CardRoomDeployment> = {},
): CardRoomDeployment {
  return {
    duel: {
      address: address(0xd0e1),
      runtimeCode: runtimeCode('HiddenCardDuel.sol', 'HiddenCardDuelV5', '0x6001600055'),
    },
    adapter: {
      address: address(0xa0d2),
      runtimeCode: runtimeCode(
        'CardProofVerifierAdapter.sol',
        'CardProofVerifierAdapterV5',
        '0x6002600055',
      ),
    },
    deckVerifier: {
      address: address(0xdec3),
      runtimeCode: runtimeCode(
        'CardDeckInitGroth16VerifierV5.sol',
        'CardDeckInitGroth16VerifierV5',
        '0x6003600055',
      ),
    },
    handVerifier: {
      address: address(0x4a04),
      runtimeCode: runtimeCode(
        'CardHandActionGroth16VerifierV5.sol',
        'CardHandActionGroth16VerifierV5',
        '0x6004600055',
      ),
    },
    stakeToken: {
      address: address(0x70c5),
      runtimeCode: runtimeCode('RoomToken.sol', 'RoomToken', '0x6005600055'),
    },
    entryStake: CARD_ROOM_ENTRY_STAKE,
    fundedAmount: CARD_ROOM_FUNDED_AMOUNT,
    participantCapacity: CARD_PARTICIPANT_CAPACITY,
    sessionExpiry: CARD_ROOM_SESSION_EXPIRY,
    roomApplicationDomain: CARD_APPLICATION_DOMAIN as Hex,
    ...overrides,
  }
}
