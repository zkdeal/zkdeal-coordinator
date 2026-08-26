/**
 * The SSE batcher's contract: trailing-edge coalescing (the first push after
 * idle schedules exactly ONE flush 500 ms later), order preserved inside the
 * frame, overflow dropping the OLDEST events with an honest count, and a
 * closed batcher writing nothing ever again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSseBatcher, createSseBatchCounters } from '../src/sse-batcher.js'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** One complete frame back into its JSON payload. */
function payloadOf(frame: string): { events: unknown[]; dropped?: number } {
  expect(frame.startsWith('event: update\ndata: ')).toBe(true)
  expect(frame.endsWith('\n\n')).toBe(true)
  return JSON.parse(frame.slice('event: update\ndata: '.length, -2))
}

describe('the SSE batcher', () => {
  it('coalesces a burst into exactly one ordered frame after the interval', () => {
    const writes: string[] = []
    const batcher = createSseBatcher({ write: (frame) => writes.push(frame) })
    batcher.push({ n: 1 })
    batcher.push({ n: 2 })
    batcher.push({ n: 3 })
    expect(writes).toHaveLength(0)
    vi.advanceTimersByTime(499)
    expect(writes).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(writes).toHaveLength(1)
    const payload = payloadOf(writes[0]!)
    expect(payload.events).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
    // The chosen shape: `dropped` is OMITTED when nothing was dropped.
    expect(payload).not.toHaveProperty('dropped')
    // Trailing edge: an empty batch schedules nothing.
    vi.advanceTimersByTime(5_000)
    expect(writes).toHaveLength(1)
  })

  it('writes nothing while idle', () => {
    const writes: string[] = []
    createSseBatcher({ write: (frame) => writes.push(frame) })
    vi.advanceTimersByTime(60_000)
    expect(writes).toHaveLength(0)
  })

  it('starts a NEW interval for a push after a flush', () => {
    const writes: string[] = []
    const batcher = createSseBatcher({ write: (frame) => writes.push(frame) })
    batcher.push('first')
    vi.advanceTimersByTime(500)
    expect(writes).toHaveLength(1)
    batcher.push('second')
    vi.advanceTimersByTime(499)
    expect(writes).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(writes).toHaveLength(2)
    expect(payloadOf(writes[1]!).events).toEqual(['second'])
  })

  it('drops the oldest beyond the limit and reports the count in the frame', () => {
    const writes: string[] = []
    const counters = createSseBatchCounters()
    const batcher = createSseBatcher({
      limit: 3,
      write: (frame) => writes.push(frame),
      onFlush: ({ events, dropped }) => {
        counters.batchesFlushed += 1
        counters.eventsBatched += events
        counters.eventsDropped += dropped
      },
    })
    for (const item of ['a', 'b', 'c', 'd', 'e']) batcher.push(item)
    vi.advanceTimersByTime(500)
    expect(writes).toHaveLength(1)
    const payload = payloadOf(writes[0]!)
    expect(payload.events).toEqual(['c', 'd', 'e'])
    expect(payload.dropped).toBe(2)
    expect(counters).toEqual({ batchesFlushed: 1, eventsBatched: 3, eventsDropped: 2 })
  })

  it('close cancels the pending flush and refuses later pushes', () => {
    const writes: string[] = []
    const batcher = createSseBatcher({ write: (frame) => writes.push(frame) })
    batcher.push('doomed')
    batcher.close()
    vi.advanceTimersByTime(10_000)
    expect(writes).toHaveLength(0)
    batcher.push('after close')
    vi.advanceTimersByTime(10_000)
    expect(writes).toHaveLength(0)
  })
})
