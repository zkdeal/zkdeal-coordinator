/**
 * Attached-room identity guard.
 *
 * The browser owns ONE RoomClient with one attached room, but the UI can
 * display any room from the registry. RoomClient's lifecycle methods
 * (openRoom, abortRoom, finalizeRoom, claim, loadAndApproveGenesis,
 * restoreFromCoordinator, callL2) all act on the client's own `roomId`, not on
 * an argument - so an action requested for room B while room A is attached
 * mutates A. Abort/open/approve are irreversible L1 lifecycle changes.
 *
 * Kept in a plain module (no React) so it is directly unit-testable.
 */

export class WrongRoomError extends Error {
  readonly requested: string
  readonly attached: string | null
  constructor(requested: string, attached: string | null) {
    super(
      attached
        ? `Not attached to channel ${requested} (currently attached to ${attached}). Join this channel first.`
        : `Not attached to channel ${requested}. Join this channel first.`,
    )
    this.name = 'WrongRoomError'
    this.requested = requested
    this.attached = attached
  }
}

/**
 * True only when both the store's joined marker and the client's own
 * attachment equal `requested`. Fails closed on null/empty/mismatch - a
 * disagreement between the two is itself a reason to refuse.
 */
export function isAttachedToRoom(
  requested: string,
  joinedRoomId: string | null,
  clientRoomId: string | null,
): boolean {
  if (!requested) return false
  return joinedRoomId === requested && clientRoomId === requested
}

/** Throws WrongRoomError unless the client is attached to exactly `requested`. */
export function assertAttachedRoom(
  requested: string,
  joinedRoomId: string | null,
  clientRoomId: string | null,
): void {
  if (!isAttachedToRoom(requested, joinedRoomId, clientRoomId)) {
    throw new WrongRoomError(requested, clientRoomId)
  }
}
