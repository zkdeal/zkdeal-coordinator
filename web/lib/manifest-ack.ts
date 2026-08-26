'use client'

/**
 * Per-room manifest acknowledgement - a tiny client-side store shared by the
 * joiner review panel (checkbox), the settle panel (Approve-genesis gate) and
 * the Playwright test hooks (acknowledgeManifest). Session-scoped on purpose:
 * a reload requires re-acknowledging unaudited custom bytecode.
 */

import { useSyncExternalStore } from 'react'

const acked = new Set<string>()
const listeners = new Set<() => void>()

export function acknowledgeManifest(roomId: string): void {
  if (!roomId || acked.has(roomId)) return
  acked.add(roomId)
  for (const fn of listeners) fn()
}

export function isManifestAcknowledged(roomId: string | null | undefined): boolean {
  return !!roomId && acked.has(roomId)
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** React binding: acknowledged flag + acknowledge action for one room. */
export function useManifestAck(roomId: string | null | undefined): {
  acknowledged: boolean
  acknowledge: () => void
} {
  const acknowledged = useSyncExternalStore(
    subscribe,
    () => isManifestAcknowledged(roomId),
    () => false,
  )
  return {
    acknowledged,
    acknowledge: () => {
      if (roomId) acknowledgeManifest(roomId)
    },
  }
}
