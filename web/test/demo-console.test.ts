import { describe, expect, it } from 'vitest'
import {
  formatSeconds,
  httpLink,
  idempotencyKey,
  parseConstructorArgs,
  phaseLabel,
  roomProgress,
  shortReference,
} from '../lib/demo-console.js'

describe('long-running demo console helpers', () => {
  it('formats phases and proof timings for people', () => {
    expect(phaseLabel('L1_ACCEPTED')).toBe('Included on Ethereum · finality pending')
    expect(phaseLabel('L1_FINALIZED')).toBe('Finalized on Ethereum')
    expect(formatSeconds(11_586)).toBe('11.6 s')
    expect(formatSeconds(900)).toBe('0.90 s')
  })

  it('shortens machine identifiers without changing small labels', () => {
    expect(shortReference('Room 3')).toBe('Room 3')
    expect(shortReference(`0x${'ab'.repeat(32)}`)).toBe('0xabab…abab')
  })

  it('parses constructor arrays and rejects an object', () => {
    expect(parseConstructorArgs('["name", 7, true]')).toEqual(['name', 7, true])
    expect(() => parseConstructorArgs('{"value":7}')).toThrow(/array/)
  })

  /* I1: explorer URLs come from the demo service and become anchor hrefs. */
  it('only accepts http(s) explorer URLs as links', () => {
    expect(httpLink('https://blockscout.local/tx/0x1')).toBe('https://blockscout.local/tx/0x1')
    expect(httpLink('http://127.0.0.1:4000/block/7')).toBe('http://127.0.0.1:4000/block/7')
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,<script>0</script>',
      'file:///etc/passwd',
      '/relative/path',
      '',
      null,
      undefined,
      42,
    ]) {
      expect(httpLink(value)).toBeNull()
    }
  })

  it('creates safe idempotency keys and bounded progress', () => {
    expect(idempotencyKey('create room')).toMatch(/^create-room:/)
    expect(roomProgress('ROOM_READY')).toBe(0)
    expect(roomProgress('L1_ACCEPTED')).toBeLessThan(100)
    expect(roomProgress('L1_FINALIZED')).toBe(100)
    expect(phaseLabel('CLOSED')).toBe('Closed')
    expect(roomProgress('CLOSED')).toBe(100)
    expect(roomProgress('FAILED')).toBe(0)
  })
})
