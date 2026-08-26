import { describe, expect, it } from 'vitest'
import { assertAttachedRoom, isAttachedToRoom, WrongRoomError } from '../lib/room-scope'

/**
 * H-03: room-scoped actions ignored their requested room and acted on the
 * singleton client's attachment. The two-room case is the whole point: view
 * room B while room A is attached and prove no B control can reach A.
 */
describe('attached-room guard', () => {
  it('accepts only when both markers equal the requested room', () => {
    expect(isAttachedToRoom('7', '7', '7')).toBe(true)
  })

  it('refuses when the client is attached to a DIFFERENT room (view B, attached A)', () => {
    expect(isAttachedToRoom('B', 'B', 'A')).toBe(false)
    expect(() => assertAttachedRoom('B', 'B', 'A')).toThrow(WrongRoomError)
    expect(() => assertAttachedRoom('B', 'B', 'A')).toThrow(/currently attached to A/)
  })

  it('refuses when the store marker and the client disagree in either direction', () => {
    expect(isAttachedToRoom('B', 'A', 'B')).toBe(false)
    expect(isAttachedToRoom('B', 'B', null)).toBe(false)
  })

  it('refuses when nothing is attached', () => {
    expect(isAttachedToRoom('7', null, null)).toBe(false)
    expect(() => assertAttachedRoom('7', null, null)).toThrow(/Not attached to channel 7/)
  })

  it('refuses an empty room id instead of matching two nulls-as-empty', () => {
    expect(isAttachedToRoom('', '', '')).toBe(false)
  })

  it('does not coerce numeric-vs-string ids', () => {
    // Ids cross the boundary as strings; a loose == would make 007 match 7.
    expect(isAttachedToRoom('7', '07', '7')).toBe(false)
  })

  it('exposes the attached room on the error for UI messaging', () => {
    try {
      assertAttachedRoom('B', 'B', 'A')
      throw new Error('expected throw')
    } catch (e) {
      expect((e as WrongRoomError).name).toBe('WrongRoomError')
      expect((e as WrongRoomError).requested).toBe('B')
      expect((e as WrongRoomError).attached).toBe('A')
    }
  })
})
