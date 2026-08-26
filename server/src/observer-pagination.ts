import type { FastifyReply } from 'fastify'

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

function positiveInt(value: unknown, fallback: number, maximum: number): number {
  if (typeof value !== 'string' || value === '') return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback
}

/** Raised for a syntactically valid cursor that no longer names a row. */
export class ObserverCursorError extends Error {}

function cursor(value: unknown, length: number): number {
  if (value === undefined) return 0
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ObserverCursorError('cursor must be a canonical non-negative integer')
  }
  const parsed = Number(value)
  // Silently resetting an out-of-range cursor to 0 handed a client that saved
  // `nextCursor` page 1 again with a forward-pointing cursor - an infinite
  // re-read that looks like fresh data. Make the stale cursor visible instead.
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > length) {
    throw new ObserverCursorError('cursor is beyond the end of this collection')
  }
  return parsed
}

export function page<T>(rows: T[], rawCursor: unknown, rawLimit: unknown): Page<T> {
  const start = cursor(rawCursor, rows.length)
  const limit = positiveInt(rawLimit, 25, 100)
  const items = rows.slice(start, start + limit)
  const next = start + items.length
  return { items, nextCursor: next < rows.length ? String(next) : null }
}

/**
 * Paginate, or answer 400 for a cursor that no longer names a row. Returns
 * null after having sent the response.
 */
export function pageOr400<T>(
  rows: T[],
  query: { cursor?: string; limit?: string },
  reply: FastifyReply,
): Page<T> | null {
  try {
    return page(rows, query.cursor, query.limit)
  } catch (error) {
    if (error instanceof ObserverCursorError) {
      void reply.code(400).send({
        decision: 'INVALID_CURSOR',
        reason: error.message,
        nextAction: 'Restart the listing without a cursor.',
      })
      return null
    }
    throw error
  }
}
