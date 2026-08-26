import type { FastifyInstance, FastifyReply } from 'fastify'
import { RateLimiter } from './quota.js'
import { pageOr400 } from './observer-pagination.js'
import {
  MAX_STREAM_SUBSCRIBERS_PER_ROOM,
  ObserverStore,
} from './observer-store.js'
import type { ObservedRoom } from './observer-types.js'
import { canonicalRoomId } from './observer-validate.js'
import {
  publicBatch,
  publicBlock,
  publicRoom,
  publicTransaction,
  shortReference,
} from './observer-view.js'

export type {
  ObservedBatch,
  ObservedBlock,
  ObservedRoom,
  ObservedTransaction,
} from './observer-types.js'
export { canonicalRoomId } from './observer-validate.js'
export { shortReference } from './observer-view.js'
export { ObserverCursorError } from './observer-pagination.js'
export {
  MAX_STREAM_SUBSCRIBERS_PER_ROOM,
  ObserverFreshnessRegressionError,
  ObserverRevisionConflictError,
  ObserverStore,
} from './observer-store.js'

/**
 * Per-IP burst ceiling for the unauthenticated observer reads. Each read still
 * costs a stat plus (on a cache miss) a full parse and validation of the room
 * archive, so an anonymous polling loop must not be able to saturate the
 * event loop. Sized to fit a browser rendering every panel of a room page.
 */
const OBSERVER_IP_BURST = 120
const OBSERVER_IP_PER_SEC = 30
/** Comment frame interval. Idle streams die silently behind proxies without one. */
const STREAM_KEEP_ALIVE_MS = 15_000

/** Per-socket buffer a stalled reader may accumulate before it is dropped. */
const STREAM_MAX_BUFFERED_BYTES = 1024 * 1024

/**
 * Fastify does not run `onSend` for a hijacked reply, and `@fastify/cors` sets
 * its headers on the reply object that `writeHead` discards - so a hijacked SSE
 * response shipped none of the CORS/COOP headers every other response carries,
 * and a cross-origin `EventSource` could not consume it. Copied here from the
 * already-computed reply headers.
 */
function hijackedHeaders(reply: FastifyReply): Record<string, string> {
  const carried: Record<string, string> = {}
  for (const name of [
    'access-control-allow-origin',
    'access-control-allow-credentials',
    'access-control-expose-headers',
    'vary',
  ]) {
    const value = reply.getHeader(name)
    if (typeof value === 'string' || typeof value === 'number') carried[name] = String(value)
  }
  return {
    ...carried,
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-resource-policy': 'cross-origin',
  }
}

function found(
  store: ObserverStore,
  id: string,
  ip: string,
  limiter: RateLimiter | null,
  reply: FastifyReply,
): ObservedRoom | null {
  if (limiter && !limiter.take(ip)) {
    void reply
      .code(429)
      .send({ decision: 'RATE_LIMITED', reason: 'Slow down and retry this observer read.' })
    return null
  }
  if (!canonicalRoomId(id)) {
    void reply.code(400).send({ decision: 'INVALID_ROOM', reason: 'Use a positive room number.' })
    return null
  }
  // A malformed or unreadable archive is an operator fault, not a caller
  // fault: report a stable 503 rather than letting the raw store error (which
  // carries the archive path) escape into Fastify's default 500 body.
  let room: ObservedRoom | null
  try {
    room = store.get(id)
  } catch {
    void reply.code(503).send({
      decision: 'ARCHIVE_UNAVAILABLE',
      reason: 'The observation archive for this room cannot currently be read.',
    })
    return null
  }
  if (!room) {
    void reply.code(404).send({
      decision: 'ROOM_NOT_OBSERVED',
      reason: 'No accepted batch has been indexed for this room.',
    })
    return null
  }
  return room
}

export function registerObserverRoutes(
  app: FastifyInstance,
  store: ObserverStore,
  limiter: RateLimiter | null = new RateLimiter(OBSERVER_IP_BURST, OBSERVER_IP_PER_SEC),
): void {
  app.get<{ Params: { id: string } }>('/rooms/:id', async (request, reply) => {
    const room = found(store, request.params.id, request.ip, limiter, reply)
    return room ? publicRoom(room) : reply
  })

  app.get<{ Params: { id: string } }>('/rooms/:id/state', async (request, reply) => {
    const room = found(store, request.params.id, request.ip, limiter, reply)
    if (!room) return reply
    return {
      ...publicRoom(room),
      liabilities: room.liabilities.map((value) => ({
        ...value,
        asset: shortReference(value.asset),
      })),
    }
  })

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
    '/rooms/:id/approvers',
    async (request, reply) => {
      const room = found(store, request.params.id, request.ip, limiter, reply)
      if (!room) return reply
      const result = pageOr400(room.approvers, request.query, reply)
      if (!result) return reply
      return {
        ...result,
        items: result.items.map((member) => ({
          ...member,
          member: shortReference(member.member),
        })),
      }
    },
  )

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
    '/rooms/:id/admissions',
    async (request, reply) => {
      const room = found(store, request.params.id, request.ip, limiter, reply)
      if (!room) return reply
      const result = pageOr400(room.admissions, request.query, reply)
      if (!result) return reply
      return {
        ...result,
        items: result.items.map((entry) => ({
          ...entry,
          transactionHash: shortReference(entry.transactionHash),
        })),
      }
    },
  )

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
    '/rooms/:id/forced-transactions',
    async (request, reply) => {
      const room = found(store, request.params.id, request.ip, limiter, reply)
      if (!room) return reply
      const result = pageOr400(room.forcedTransactions, request.query, reply)
      if (!result) return reply
      return {
        ...result,
        items: result.items.map((entry) => ({
          ...entry,
          transactionHash: shortReference(entry.transactionHash),
        })),
      }
    },
  )

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
    '/rooms/:id/applications',
    async (request, reply) => {
      const room = found(store, request.params.id, request.ip, limiter, reply)
      if (!room) return reply
      const result = pageOr400(room.applications, request.query, reply)
      if (!result) return reply
      return {
        ...result,
        items: result.items.map((entry) => ({
          ...entry,
          contract: shortReference(entry.contract),
          participantRoot: shortReference(entry.participantRoot),
        })),
      }
    },
  )

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
    '/rooms/:id/imports',
    async (request, reply) => {
      const room = found(store, request.params.id, request.ip, limiter, reply)
      if (!room) return reply
      const result = pageOr400(room.imports, request.query, reply)
      if (!result) return reply
      return {
        ...result,
        items: result.items.map((entry) => ({
          ...entry,
          source: shortReference(entry.source),
          adapterId: shortReference(entry.adapterId),
          stateRoot: shortReference(entry.stateRoot),
        })),
      }
    },
  )

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
    '/rooms/:id/deposits',
    async (request, reply) => {
      const room = found(store, request.params.id, request.ip, limiter, reply)
      if (!room) return reply
      const result = pageOr400(room.deposits, request.query, reply)
      if (!result) return reply
      return {
        ...result,
        items: result.items.map((entry) => ({
          ...entry,
          depositor: shortReference(entry.depositor),
          asset: shortReference(entry.asset),
          beneficiary: shortReference(entry.beneficiary),
          queuedAtBlockHash: shortReference(entry.queuedAtBlockHash),
        })),
      }
    },
  )

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
    '/rooms/:id/withdrawals',
    async (request, reply) => {
      const room = found(store, request.params.id, request.ip, limiter, reply)
      if (!room) return reply
      const result = pageOr400(room.withdrawals, request.query, reply)
      if (!result) return reply
      return {
        ...result,
        items: result.items.map((entry) => ({
          ...entry,
          asset: shortReference(entry.asset),
          recipient: shortReference(entry.recipient),
          claimedL1Transaction: shortReference(entry.claimedL1Transaction),
        })),
      }
    },
  )

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
    '/rooms/:id/batches',
    async (request, reply) => {
      const room = found(store, request.params.id, request.ip, limiter, reply)
      if (!room) return reply
      const result = pageOr400(room.batches, request.query, reply)
      if (!result) return reply
      return { ...result, items: result.items.map((batch) => publicBatch(batch)) }
    },
  )

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
    '/rooms/:id/blocks',
    async (request, reply) => {
      const room = found(store, request.params.id, request.ip, limiter, reply)
      if (!room) return reply
      const blocks = room.batches.flatMap((batch) => batch.blocks)
      const result = pageOr400(blocks, request.query, reply)
      if (!result) return reply
      return { ...result, items: result.items.map(publicBlock) }
    },
  )

  app.get<{
    Params: { id: string }
    Querystring: { cursor?: string; limit?: string; block?: string }
  }>('/rooms/:id/transactions', async (request, reply) => {
    const room = found(store, request.params.id, request.ip, limiter, reply)
    if (!room) return reply
    const blocks =
      request.query.block === undefined
        ? room.batches.flatMap((batch) => batch.blocks)
        : room.batches
            .flatMap((batch) => batch.blocks)
            .filter((block) => block.blockNumber === request.query.block)
    const transactions = blocks.flatMap((block) =>
      block.transactions.map((transaction) => ({
        blockNumber: block.blockNumber,
        ...publicTransaction(transaction),
      })),
    )
    return pageOr400(transactions, request.query, reply) ?? reply
  })

  app.get<{ Params: { id: string } }>('/rooms/:id/latest', async (request, reply) => {
    const room = found(store, request.params.id, request.ip, limiter, reply)
    if (!room) return reply
    const latest = room.batches.at(-1)
    return {
      room: publicRoom(room),
      latestBatch: latest ? publicBatch(latest, true) : null,
      liabilities: room.liabilities.map((value) => ({
        ...value,
        asset: shortReference(value.asset),
      })),
    }
  })

  // Reproducibility clients must opt into long machine identifiers. Normal
  // user-facing routes never expose full addresses or hashes.
  app.get<{ Params: { id: string } }>('/rooms/:id/machine', async (request, reply) => {
    const room = found(store, request.params.id, request.ip, limiter, reply)
    if (!room) return reply
    reply.header('cache-control', 'no-store')
    return room
  })

  app.get<{ Params: { id: string }; Querystring: { once?: string } }>(
    '/rooms/:id/stream',
    async (request, reply) => {
      const room = found(store, request.params.id, request.ip, limiter, reply)
      if (!room) return reply
      if (store.subscriberCount(room.roomId) >= MAX_STREAM_SUBSCRIBERS_PER_ROOM) {
        return reply.code(503).send({
          decision: 'STREAM_SATURATED',
          reason: 'This room already has the maximum number of live observers.',
        })
      }
      reply.hijack()
      reply.raw.writeHead(200, {
        ...hijackedHeaders(reply),
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })
      let detach: (() => void) | null = null
      /**
       * Returns false once the socket can no longer take a frame. A stalled
       * reader accumulated unbounded per-socket buffering while `write()`'s
       * backpressure signal was discarded, so a subscriber that stops draining
       * is dropped instead of buffered.
       */
      const write = (next: ObservedRoom): boolean => {
        if (reply.raw.destroyed || reply.raw.writableEnded) {
          detach?.()
          return false
        }
        const accepted = reply.raw.write(
          `event: room\ndata: ${JSON.stringify(publicRoom(next))}\n\n`,
        )
        if (!accepted && reply.raw.writableLength > STREAM_MAX_BUFFERED_BYTES) {
          detach?.()
          reply.raw.end()
          return false
        }
        return accepted
      }
      write(room)
      if (request.query.once === '1') {
        reply.raw.end()
        return reply
      }
      const unsubscribe = store.subscribe(room.roomId, write)
      const keepAlive = setInterval(() => {
        if (reply.raw.destroyed || reply.raw.writableEnded) detach?.()
        else reply.raw.write(': keep-alive\n\n')
      }, STREAM_KEEP_ALIVE_MS)
      keepAlive.unref?.()
      detach = () => {
        clearInterval(keepAlive)
        unsubscribe()
      }
      request.raw.once('close', () => detach?.())
      return reply
    },
  )
}
