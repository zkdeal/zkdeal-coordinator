import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertCardVaultResponse } from '../lib/card/vault-messages'

/**
 * The boundary the witness never crosses.
 *
 * Two independent checks, because either one alone is weak:
 *
 *   1. The response allow-list. Every message the vault worker sends is
 *      re-validated on the page with an EXACT key list, so a future edit that
 *      widened a reply - the obvious way deck order would end up in React state
 *      - fails on arrival rather than landing silently.
 *   2. A source scan of the worker module. The allow-list stops material from
 *      reaching the page; it does nothing about material leaving the worker by
 *      another route, so the worker is asserted to contain no network,
 *      storage or console primitive at all. That is why the proving artifacts
 *      are handed in as bytes instead of fetched there.
 */
const VIEW = {
  deckCursor: 1,
  handCount: 1,
  boardCount: 0,
  actionCursor: '1',
  deckRoot: '12345',
  handRoot: '67890',
  handCards: [3, 0, 0, 0, 0, 0, 0, 0],
  staged: false,
}

describe('vault response allow-list', () => {
  it('accepts the view the worker builds', () => {
    const response = assertCardVaultResponse({ id: 1, ok: true, kind: 'view', seat: 0, view: VIEW })
    expect(response.kind).toBe('view')
  })

  it('refuses a reply that smuggles witness material alongside the view', () => {
    expect(() =>
      assertCardVaultResponse({
        id: 1,
        ok: true,
        kind: 'view',
        seat: 0,
        view: VIEW,
        bundle: { deckSalts: ['1', '2'] },
      }),
    ).toThrow(/not part of the vault response contract/)
  })

  it('refuses witness material hidden inside the view object', () => {
    expect(() =>
      assertCardVaultResponse({
        id: 1,
        ok: true,
        kind: 'view',
        seat: 0,
        view: { ...VIEW, deckCards: [1, 2, 3] },
      }),
    ).toThrow(/not part of the vault response contract/)
  })

  it('refuses a proof whose public-input count does not match its circuit', () => {
    expect(() =>
      assertCardVaultResponse({
        id: 2,
        ok: true,
        kind: 'proof',
        seat: 0,
        circuit: 'deck-init-v4',
        publicInputs: ['1', '2', '3'],
        innerProof: `0x${'11'.repeat(256)}`,
        provingMs: 10,
        verified: true,
        view: VIEW,
      }),
    ).toThrow(/publicInputs must hold 5/)
  })

  it('refuses a proof the vault did not verify', () => {
    expect(() =>
      assertCardVaultResponse({
        id: 3,
        ok: true,
        kind: 'proof',
        seat: 1,
        circuit: 'deck-init-v4',
        publicInputs: ['1', '2', '3', '4', '5'],
        innerProof: `0x${'11'.repeat(256)}`,
        provingMs: 10,
        verified: false,
        view: VIEW,
      }),
    ).toThrow(/releases no unverified proof/)
  })

  it('refuses an audit verdict that is not a clearance', () => {
    expect(() =>
      assertCardVaultResponse({ id: 4, ok: true, kind: 'audit', seat: 0, cleared: false }),
    ).toThrow(/cleared must be true/)
  })
})

describe('the vault worker has no way to transmit or persist a bundle', () => {
  const source = readFileSync(join(__dirname, '..', 'lib', 'card', 'vault-worker.ts'), 'utf8')
  // Comments describe the primitives that are deliberately absent, so they are
  // stripped before the scan; otherwise the documentation would fail the test
  // it documents.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  it.each([
    'fetch(',
    'XMLHttpRequest',
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'sendBeacon',
    'console.',
    'importScripts',
    'WebSocket',
    'EventSource',
  ])('does not use %s', (primitive) => {
    expect(code).not.toContain(primitive)
  })

  it('only ever posts through the single response constructor path', () => {
    // Two call sites: the resolved response, and the error envelope. A third
    // would be a channel that never passed through `handle`.
    expect(code.match(/scope\.postMessage\(/g)).toHaveLength(2)
  })
})
