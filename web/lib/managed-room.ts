export const MANAGED_ROOM_LIFECYCLE = Object.freeze([
  'Capacity reserved',
  'Room created',
  'Proof service active',
  'Capacity released',
] as const)

export function clampManagedRoomDeadline(
  value: number,
  minimum: number,
  maximum: number,
): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)))
}

export function validManagedRoomCapacity(value: number): boolean {
  return Number.isSafeInteger(value)
    && value >= 128
    && value <= 32_768
    && (value & (value - 1)) === 0
}
