/**
 * Shared fixtures for the progressive-settlement tests.
 *
 * Extracted from `card-room-settlement.test.ts` when that file outgrew the
 * repository's 500-line limit and was split into a cadence half and a
 * receipts/wire half. Nothing here is a stub of production behaviour: `viewOf`
 * projects a REAL `CardWitnessBundle` into the public view the vault worker
 * would emit for it, so the wire test still compares request bytes against real
 * secret values rather than against invented ones.
 */
import type { CardWitnessBundle } from '@zkdeal/card'
import type { CardSessionEntry } from '../../lib/card/session'
import type { CardVaultView } from '../../lib/card/vault-messages'

/** A Groth16-shaped 256-byte blob; the vault's real proof bytes in tests. */
export const FAKE_PROOF = `0x${'ef'.repeat(256)}` as const

/** The public view of a seat, exactly as the vault worker projects a bundle. */
export function viewOf(bundle: CardWitnessBundle): CardVaultView {
  return {
    deckCursor: bundle.deckCursor,
    handCount: bundle.handCards.filter((card) => card !== 0).length,
    boardCount: bundle.boardCount,
    actionCursor: bundle.actionCursor,
    deckRoot: bundle.deckRoot,
    handRoot: bundle.handRoot,
    handCards: [...bundle.handCards],
    staged: false,
  }
}

/** A move-log entry with every field defaulted, so a test states only its point. */
export function entry(
  patch: Partial<CardSessionEntry> & { sequence: number },
): CardSessionEntry {
  return {
    seat: 0,
    move: 'draw',
    calldata: {
      move: 'draw',
      signature: 'draw()',
      selector: '0x00000000',
      args: '0x',
      calldata: '0x00000000',
      bytes: 4,
      published: [],
    },
    provingMs: null,
    publicInputs: null,
    status: 'rehearsed',
    actionId: null,
    block: null,
    checkpointIndex: null,
    error: null,
    at: 1_000,
    ...patch,
  } as CardSessionEntry
}

/** A move the room has accepted but no checkpoint has proved yet. */
export function submitted(sequence: number, block: 1 | 2, at = 1_000): CardSessionEntry {
  return entry({ sequence, status: 'submitted', actionId: `act-${sequence}`, block, at })
}
