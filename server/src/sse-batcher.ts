/**
 * Trailing-edge coalescing for the demo's SSE stream.
 *
 * A checkpoint emits a burst of phase/job events milliseconds apart, and every
 * one used to become its own SSE frame - which the only browser consumer
 * answers with a full state refetch. The batcher turns a burst into ONE frame:
 * the first push after an idle period schedules a single flush `intervalMs`
 * later, every push meanwhile joins the batch, and the flush writes
 *
 *   event: update
 *   data: {"events":[...]}            (plus `"dropped":N` when N > 0)
 *
 * Overflow beyond `limit` drops the OLDEST events (the browser refetches whole
 * state anyway, so the newest tail is the useful part) and reports the count in
 * the same frame. `close()` cancels the pending flush and drops the batch.
 */

/** Process-lifetime totals `/metrics` publishes; shared across stream routes. */
export interface SseBatchCounters {
  batchesFlushed: number
  eventsBatched: number
  eventsDropped: number
}

export function createSseBatchCounters(): SseBatchCounters {
  return { batchesFlushed: 0, eventsBatched: 0, eventsDropped: 0 }
}

export interface SseBatcherOptions {
  /** Trailing-edge delay between the first push and the flush. Default 500. */
  intervalMs?: number
  /** Most events one frame carries; older ones are dropped. Default 512. */
  limit?: number
  /** Writes one complete SSE frame (already `\n\n`-terminated). */
  write: (frame: string) => void
  /** Observability tap, called once per flush AFTER the frame is written. */
  onFlush?: (flushed: { events: number; dropped: number }) => void
}

export interface SseBatcher {
  push(event: unknown): void
  close(): void
}

export function createSseBatcher(options: SseBatcherOptions): SseBatcher {
  const intervalMs = options.intervalMs ?? 500
  const limit = options.limit ?? 512
  let batch: unknown[] = []
  let dropped = 0
  let timer: NodeJS.Timeout | null = null
  let closed = false

  const flush = (): void => {
    timer = null
    const events = batch
    const droppedNow = dropped
    batch = []
    dropped = 0
    const payload = droppedNow > 0 ? { events, dropped: droppedNow } : { events }
    options.write(`event: update\ndata: ${JSON.stringify(payload)}\n\n`)
    options.onFlush?.({ events: events.length, dropped: droppedNow })
  }

  return {
    push(event: unknown): void {
      if (closed) return
      batch.push(event)
      if (batch.length > limit) {
        batch.shift()
        dropped += 1
      }
      if (timer === null) {
        timer = setTimeout(flush, intervalMs)
        // The pending flush must never hold the process open on shutdown.
        timer.unref?.()
      }
    },
    close(): void {
      closed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      batch = []
      dropped = 0
    },
  }
}
