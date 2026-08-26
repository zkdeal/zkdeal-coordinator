/**
 * Browser key material: ECDSA burner (localStorage) + room-scoped EdDSA.
 * MetaMask may replace the ECDSA signer; EdDSA still derives from burner seed
 * (or personal_sign) via protocol.deriveEddsaPrivFromSecret, deployment-scoped.
 */

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import {
  hexToBytes,
  bytesToHex0x,
  type EddsaPublicKey,
} from '@zkdeal/protocol'
import { roomEddsaKeysFromSeed } from '@zkdeal/room-client'

const BURNER_KEY = 'zkdeal.burner.ecdsa.v1'
const BURNER_SEED = 'zkdeal.burner.eddsa-seed.v1'

function randomBytes32(): Uint8Array {
  const out = new Uint8Array(32)
  crypto.getRandomValues(out)
  return out
}

export function loadOrCreateBurnerPrivateKey(): Hex {
  if (typeof window === 'undefined') {
    throw new Error('burner key only available in browser')
  }
  try {
    const existing = window.localStorage.getItem(BURNER_KEY)
    if (existing && /^0x[0-9a-fA-F]{64}$/.test(existing)) {
      return existing.toLowerCase() as Hex
    }
  } catch {
    /* ignore */
  }
  const pk = generatePrivateKey()
  try {
    window.localStorage.setItem(BURNER_KEY, pk)
  } catch {
    /* ignore quota */
  }
  return pk
}

/** 32-byte seed for EdDSA derivation (separate from ECDSA priv for clarity). */
export function loadOrCreateEddsaSeed(): Uint8Array {
  if (typeof window === 'undefined') {
    throw new Error('eddsa seed only available in browser')
  }
  try {
    const existing = window.localStorage.getItem(BURNER_SEED)
    if (existing && /^0x[0-9a-fA-F]{64}$/.test(existing)) {
      return hexToBytes(existing)
    }
  } catch {
    /* ignore */
  }
  const seed = randomBytes32()
  try {
    window.localStorage.setItem(BURNER_SEED, bytesToHex0x(seed))
  } catch {
    /* ignore */
  }
  return seed
}

/**
 * Erase the persisted burner identity from this browser.
 *
 * Destructive and irreversible: any L1 deposit or L2 balance controlled by
 * that key becomes unreachable from this device. Only call it from an
 * explicit, confirmed user action.
 */
export function forgetBurnerIdentity(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(BURNER_KEY)
    window.localStorage.removeItem(BURNER_SEED)
  } catch {
    /* ignore */
  }
}

/** True when a burner private key is currently persisted in this browser. */
export function hasStoredBurnerKey(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return !!window.localStorage.getItem(BURNER_KEY)
  } catch {
    return false
  }
}

export function burnerAccount() {
  const pk = loadOrCreateBurnerPrivateKey()
  return privateKeyToAccount(pk)
}

/**
 * Room-scoped EdDSA keys for this browser identity.
 *
 * `domain` is the deployment domain field element (protocol
 * `deploymentDomainField`) of the L1 RoomManager the room lives on: keys are
 * DEPLOYMENT-scoped, so the same burner seed yields different room keys on a
 * different chain/manager (review/circuits.md H-01). In the app the RoomClient
 * derives this itself from the coordinator /config; this helper is for
 * standalone/tooling use and requires the caller to pass the same value.
 */
export async function roomEddsaKeys(
  roomId: bigint,
  domain: bigint,
): Promise<{
  priv: Uint8Array
  pub: EddsaPublicKey
}> {
  // Derivation math is shared with the headless agent (@zkdeal/room-client);
  // only the seed storage stays browser-specific.
  return roomEddsaKeysFromSeed(loadOrCreateEddsaSeed(), roomId, domain)
}

export function shortAddr(a: string): string {
  if (!a) return ''
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}
