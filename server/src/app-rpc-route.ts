import type { FastifyInstance } from 'fastify'
import type { ServerConfig } from './config.js'
import type { RateLimiter } from './quota.js'
import {
  RPC_MAX_BODY_BYTES,
  RPC_MAX_RESPONSE_BYTES,
  RPC_TIMEOUT_MS,
  screenRpcBody,
} from './rpc-proxy.js'

/** Raised by `readCappedBody` when the upstream exceeds the byte ceiling. */
class UpstreamBodyTooLargeError extends Error {}

/**
 * Read an upstream response body with a running BYTE counter, aborting the
 * stream as soon as `maxBytes` is passed. `res.text()` materialises the whole
 * body first - the cap then bounded only what was returned, not what the
 * coordinator buffered - and `String.length` counts UTF-16 units, which
 * undercounts every non-ASCII byte.
 */
async function readCappedBody(res: Response, maxBytes: number): Promise<string> {
  const body = res.body
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) throw new UpstreamBodyTooLargeError('upstream response too large')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Resolve the head used to put an absolute span around tag/omitted log filters. */
async function resolvedLatestBlock(rpcUrl: string): Promise<bigint> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'zkdeal-log-range', method: 'eth_blockNumber', params: [] }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  })
  const text = await readCappedBody(response, 64 * 1024)
  if (!response.ok) throw new Error('head resolver upstream rejected the request')
  const body = JSON.parse(text) as { result?: unknown }
  if (typeof body.result !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(body.result)) {
    throw new Error('head resolver returned a malformed block number')
  }
  return BigInt(body.result)
}

/** Screened, metered JSON-RPC proxy in front of the configured L1 endpoint. */
export function registerRpcProxyRoute(
  app: FastifyInstance,
  cfg: ServerConfig,
  rpcLimiter: RateLimiter,
): void {
  app.post('/rpc', { bodyLimit: RPC_MAX_BODY_BYTES }, async (req, reply) => {
    if (!rpcLimiter.take(req.ip)) {
      return reply.code(429).send({ error: 'rate limited' })
    }
    let screened = screenRpcBody(req.body, cfg.chainId)
    if (!screened.ok && screened.status === 503) {
      try {
        const latestBlock = await resolvedLatestBlock(cfg.l1RpcUrl)
        screened = screenRpcBody(req.body, cfg.chainId, { latestBlock })
      } catch (error) {
        app.log.warn({ error }, 'rpc proxy could not resolve the canonical log-range head')
        return reply.code(502).send({ error: 'rpc upstream unavailable' })
      }
    }
    if (!screened.ok) {
      return reply.code(screened.status).send({ error: screened.error })
    }
    const forwarded = JSON.stringify(req.body)
    if (forwarded.length > RPC_MAX_BODY_BYTES) {
      return reply.code(413).send({ error: 'request too large' })
    }
    try {
      const res = await fetch(cfg.l1RpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: forwarded,
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      })
      // The 8 MiB cap must bound what is BUFFERED, not only what is returned,
      // and it must count bytes rather than UTF-16 units. Stream with a running
      // counter and abort the read as soon as the cap is exceeded.
      let text: string
      try {
        text = await readCappedBody(res, RPC_MAX_RESPONSE_BYTES)
      } catch (err) {
        if (err instanceof UpstreamBodyTooLargeError) {
          app.log.warn({ methods: screened.methods }, 'rpc response too large')
          return reply.code(502).send({ error: 'upstream response too large' })
        }
        throw err
      }
      if (!res.ok) {
        // A node error page or JSON-RPC error body can carry the internal RPC
        // URL, hostnames and node internals - the same disclosure the catch
        // below exists to prevent. Keep it server-side.
        app.log.warn(
          { status: res.status, methods: screened.methods, body: text.slice(0, 2048) },
          'rpc proxy upstream returned a non-2xx response',
        )
        return reply.code(502).send({ error: 'rpc upstream rejected the request' })
      }
      // Never reflect the upstream content-type: a compromised node could have
      // the coordinator serve text/html from the web app's own origin.
      reply.code(res.status).header('content-type', 'application/json')
      return text
    } catch (err) {
      // Upstream messages can disclose the internal RPC URL / node internals.
      app.log.warn({ err, methods: screened.methods }, 'rpc proxy upstream failure')
      return reply.code(502).send({ error: 'rpc upstream unavailable' })
    }
  })
}
