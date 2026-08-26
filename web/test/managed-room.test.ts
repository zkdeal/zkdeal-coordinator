import { describe, expect, it } from 'vitest'
import {
  clampManagedRoomDeadline,
  MANAGED_ROOM_LIFECYCLE,
  validManagedRoomCapacity,
} from '../lib/managed-room'

describe('the guided managed-room policy', () => {
  it('clamps the coordinator recommendation to the live slot range', () => {
    expect(clampManagedRoomDeadline(6, 8, 64)).toBe(8)
    expect(clampManagedRoomDeadline(24, 8, 64)).toBe(24)
    expect(clampManagedRoomDeadline(80, 8, 64)).toBe(64)
  })

  it('accepts only participant tree capacities the room contract supports', () => {
    expect(validManagedRoomCapacity(128)).toBe(true)
    expect(validManagedRoomCapacity(1_024)).toBe(true)
    expect(validManagedRoomCapacity(32_768)).toBe(true)
    expect(validManagedRoomCapacity(127)).toBe(false)
    expect(validManagedRoomCapacity(1_000)).toBe(false)
    expect(validManagedRoomCapacity(65_536)).toBe(false)
  })

  it('uses the public lifecycle rather than raw contract enums', () => {
    expect(MANAGED_ROOM_LIFECYCLE).toEqual([
      'Capacity reserved',
      'Room created',
      'Proof service active',
      'Capacity released',
    ])
  })
})
