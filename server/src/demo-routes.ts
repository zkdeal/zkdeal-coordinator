import type { FastifyInstance, FastifyReply } from 'fastify'
import type { DemoController } from './demo-controller.js'
import { createSseBatcher, type SseBatchCounters } from './sse-batcher.js'
import { now, safeFailure } from './demo-validation.js'
import type { DemoRoomRequest, DemoTemplateRequest } from './demo-types.js'

function idempotencyKey(headers: Record<string, unknown>): string {
  const raw = headers['idempotency-key']
  if (typeof raw !== 'string' || !/^[a-zA-Z0-9._:-]{8,128}$/.test(raw)) {
    throw new Error('Idempotency-Key header must contain 8 to 128 safe characters')
  }
  return raw
}

/**
 * CORS/COOP headers already computed on the reply, carried onto the raw
 * response that `reply.hijack()` takes over. See the identical helper in
 * observer.ts.
 */
function hijackedDemoHeaders(reply: FastifyReply): Record<string, string> {
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

export interface DemoRouteOptions {
  /** Shared `/metrics` totals for the stream batcher; absent in most tests. */
  sseCounters?: SseBatchCounters
}

export function registerDemoRoutes(
  app: FastifyInstance,
  controller: DemoController,
  options: DemoRouteOptions = {},
): void {
  app.get('/demo/v1/system', async () => publicDemoView(await controller.system()))
  app.get('/demo/v1/l1/blocks', async () => publicDemoView({ blocks: await controller.recentBlocks() }))
  app.get('/demo/v1/presets', () => ({ presets: controller.presets() }))
  // The bounds and per-preset defaults for everything a client may set on a
  // room. Published so a console offers a legal value with the arithmetic
  // behind it instead of restating a block count that drifts from the policy.
  app.get('/demo/v1/room-settings', () => publicDemoView(controller.roomSettings()))
  app.get('/demo/v1/templates', () => publicDemoView({ templates: controller.listTemplates() }))
  app.get<{ Params: { id: string } }>('/demo/v1/templates/:id', async (request, reply) => {
    const found = controller.template(request.params.id)
    return found ? publicDemoView(found) : reply.code(404).send({ error: 'template not found' })
  })
  app.post<{ Body: DemoTemplateRequest }>('/demo/v1/templates', async (request, reply) => {
    try {
      return reply.code(202).send(
        publicDemoView(await controller.createTemplate(request.body, idempotencyKey(request.headers))),
      )
    } catch (error) {
      return reply.code(400).send({ error: safeFailure(error) })
    }
  })
  app.get('/demo/v1/rooms', () => publicDemoView({ rooms: controller.listRooms() }))
  app.post<{ Body: DemoRoomRequest }>('/demo/v1/rooms', async (request, reply) => {
    try {
      return reply.code(201).send(
        publicDemoView(await controller.createRoom(request.body, idempotencyKey(request.headers))),
      )
    } catch (error) {
      return reply.code(400).send({ error: safeFailure(error) })
    }
  })
  app.get<{ Params: { id: string } }>('/demo/v1/rooms/:id', async (request, reply) => {
    const found = controller.room(request.params.id)
    return found ? publicDemoView(found) : reply.code(404).send({ error: 'room not found' })
  })
  app.post<{ Params: { id: string } }>('/demo/v1/rooms/:id/close', async (request, reply) => {
    try {
      return reply.code(200).send(
        publicDemoView(await controller.closeRoom(request.params.id, idempotencyKey(request.headers))),
      )
    } catch (error) {
      return reply.code(400).send({ error: safeFailure(error) })
    }
  })
  app.post<{ Params: { id: string } }>('/demo/v1/rooms/:id/deploy', async (request, reply) => {
    try {
      return reply.code(202).send(
        publicDemoView(await controller.deployRoom(request.params.id, idempotencyKey(request.headers))),
      )
    } catch (error) {
      return reply.code(400).send({ error: safeFailure(error) })
    }
  })
  app.post<{
    Params: { id: string }
    Body: {
      actionId: string
      actorId: string
      calldata?: string
      block?: 1 | 2
      /** The browser's own EIP-2718 envelope carrying `calldata`. */
      signedTransaction?: string
    }
  }>('/demo/v1/rooms/:id/actions', async (request, reply) => {
    try {
      return reply.code(202).send(
        publicDemoView(
          await controller.addAction(request.params.id, request.body, idempotencyKey(request.headers)),
        ),
      )
    } catch (error) {
      return reply.code(400).send({ error: safeFailure(error) })
    }
  })
  // Checkpoint history, the current policy decision, the GPU queue and the
  // policy's own constants. This is what a client reads to say "settled in
  // 0x…, next checkpoint in four moves" or "waiting for the GPU".
  app.get<{ Params: { id: string } }>('/demo/v1/rooms/:id/checkpoints', async (request, reply) => {
    const room = controller.room(request.params.id)
    if (!room) return reply.code(404).send({ error: 'room not found' })
    // The chain head is only read for a room that actually carries an absolute
    // proof deadline; otherwise the deadline arm has nothing to compare and a
    // read per poll would be pure cost.
    let head: number | null = null
    if (room.proofDeadlineBlock !== null) {
      try {
        const latest = Number((await controller.recentBlocks())[0]?.number)
        head = Number.isFinite(latest) ? latest : null
      } catch {
        head = null
      }
    }
    return publicDemoView(controller.checkpointStatus(request.params.id, head)!)
  })
  app.post<{ Params: { id: string }; Body?: { force?: boolean } }>(
    '/demo/v1/rooms/:id/checkpoints',
    async (request, reply) => {
      try {
        // `force` defaults to true so an explicit POST stays the operator's
        // button. `force: false` asks the policy first and refuses, with the
        // arithmetic, when a checkpoint is not due - that is the call a client
        // polling for progressive checkpoints makes.
        return reply.code(202).send(
          publicDemoView(
            await controller.checkpointRoom(request.params.id, idempotencyKey(request.headers), {
              force: request.body?.force ?? true,
            }),
          ),
        )
      } catch (error) {
        return reply.code(400).send({ error: safeFailure(error) })
      }
    },
  )
  app.get<{ Params: { id: string } }>('/demo/v1/jobs/:id', async (request, reply) => {
    const found = controller.job(request.params.id)
    return found ? publicDemoView(found) : reply.code(404).send({ error: 'job not found' })
  })
  app.get<{ Params: { kind: string; id: string } }>(
    '/demo/v1/machine/:kind/:id',
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      const found =
        request.params.kind === 'templates'
          ? controller.template(request.params.id)
          : request.params.kind === 'rooms'
            ? controller.room(request.params.id)
            : request.params.kind === 'jobs'
              ? controller.job(request.params.id)
              : undefined
      return found ?? reply.code(404).send({ error: 'reproducibility artifact not found' })
    },
  )
  app.get('/demo/v1/stream', async (request, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, {
      // Fastify runs neither `onSend` nor the CORS plugin's reply headers for
      // a hijacked reply, so a cross-origin EventSource could not read this
      // stream and the COOP/COEP-on-every-response property had a hole.
      ...hijackedDemoHeaders(reply),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ at: now() })}\n\n`)
    // Updates are BATCHED: a burst of controller events becomes one frame,
    // flushed 500 ms after the first event of the burst, whose data is
    // `{"events":[...redacted events, oldest first...]}` plus `"dropped":N`
    // when overflow discarded the N oldest. The only browser consumer
    // (web/components/long-running-demo.tsx) treats any `update` as a refetch
    // tick and never reads the payload, so the array shape is additive.
    const batcher = createSseBatcher({
      write: (frame) => reply.raw.write(frame),
      onFlush: ({ events, dropped }) => {
        const counters = options.sseCounters
        if (!counters) return
        counters.batchesFlushed += 1
        counters.eventsBatched += events
        counters.eventsDropped += dropped
      },
    })
    const unsubscribe = controller.subscribe((event) => {
      batcher.push(publicDemoView(event))
    })
    const keepAlive = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15_000)
    request.raw.on('close', () => {
      clearInterval(keepAlive)
      unsubscribe()
      batcher.close()
    })
  })
}

/**
 * Fields whose full value is published deliberately.
 *
 * `publicDemoView` truncates every long hex string, which is right for state
 * roots, template ids and journal hashes - and wrong for exactly two things.
 * `l1TransactionHash` is the merged room transaction: it is already public on
 * the chain, it is what `explorerUrl` links to, and a player who is told a
 * checkpoint settled has to be able to look it up. `deploymentDomain` is a
 * deployment-wide constant a browser needs in full to compute the room chain id
 * it signs against; truncated, every envelope it signs is refused.
 *
 * Anything not named here stays redacted. `transaction` deliberately is not:
 * it keeps the historical redacted shape so no existing reader changes meaning.
 */
/**
 * Keys whose values are published whole rather than truncated for display.
 *
 * The card-room addresses are here because a browser has to ADDRESS them, not
 * merely show them: `duelAddress` is the `to` of every signed duel move and,
 * with `roomApplicationDomain`, the preimage of `proofDomain` - public input 0
 * of every card circuit. `0x5FbDB2...0aa3` is a fine thing to print and a
 * useless thing to sign for. `duelistOwners` is the seat list the room's cold
 * state funds, and a console needs it to say which seat it is playing.
 */
/**
 * `deploymentTransaction`, `address` and `contractAddress` join them for the
 * same reason from the other direction: a transaction or account a viewer is
 * told about has to be one they can OPEN. `0x05d3ac...ce78` is not a link, and
 * a room whose creation transaction cannot be looked up is a claim rather than
 * a receipt.
 */
const PUBLISHED_IN_FULL = new Set([
  'l1TransactionHash',
  'l1BlockHash',
  'finalizedL1BlockHash',
  'deploymentTransaction',
  'blockHash',
  'address',
  'contractAddress',
  'deploymentDomain',
  'duelAddress',
  'stakeTokenAddress',
  'proofAdapterAddress',
  'deckVerifierAddress',
  'handVerifierAddress',
  'roomApplicationDomain',
  'duelistOwners',
  'vaultAddress',
  'assetTokenAddress',
  'aliceAddress',
  'bobAddress',
  'managerAddress',
  'investorAddress',
  'liquidityProviderAddress',
])

export function publicDemoView<T>(value: T): T {
  const walk = (item: unknown, key?: string): unknown => {
    if (typeof item === 'string' && /^0x[0-9a-fA-F]{40,}$/.test(item)) {
      return key !== undefined && PUBLISHED_IN_FULL.has(key)
        ? item
        : `${item.slice(0, 8)}...${item.slice(-4)}`
    }
    if (Array.isArray(item)) return item.map((entry) => walk(entry, key))
    // A Promise has no own enumerable properties, so redacting one silently
    // produced `{}` and a route that forgot to await returned an empty body.
    if (item && typeof (item as { then?: unknown }).then === 'function') {
      throw new Error('publicDemoView requires a resolved value; await the controller call')
    }
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item).map(([nestedKey, nested]) => [nestedKey, walk(nested, nestedKey)]),
      )
    }
    return item
  }
  return walk(value) as T
}
