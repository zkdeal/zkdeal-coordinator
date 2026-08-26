/**
 * Hostile-input coverage for the coordinator's live security boundary
 * (review/server.md: unrestricted RPC proxy, raceable faucet, public binding).
 * Every suite here fails against the pre-fix server.
 *
 * The archived `[archived v3]` write-authorization suites live in
 * security-legacy-v3.test.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION, type Hex } from '@zkdeal/protocol'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { exposureViolation, loadConfig, type ServerConfig } from '../src/config.js'
import { FaucetService } from '../src/faucet.js'
import { RateLimiter } from '../src/quota.js'
import { isRpcMethodAllowed, RPC_MAX_LOG_BLOCK_SPAN, screenRpcBody } from '../src/rpc-proxy.js'

describe('JSON-RPC proxy allowlist', () => {
  it('screens methods, batches and params', () => {
    expect(screenRpcBody({ method: 'eth_chainId', params: [] }, 1).ok).toBe(true)
    expect(screenRpcBody({ method: 'debug_traceTransaction', params: [] }, 31337)).toMatchObject({
      ok: false,
      status: 403,
    })
    expect(screenRpcBody({ method: 'admin_nodeInfo' }, 31337)).toMatchObject({ status: 403 })
    expect(screenRpcBody({ method: 'personal_unlockAccount' }, 31337)).toMatchObject({ status: 403 })
    // anvil cheats: dev chains only.
    expect(isRpcMethodAllowed('anvil_setBalance', 31337)).toBe(true)
    expect(isRpcMethodAllowed('anvil_setBalance', 1)).toBe(false)
    expect(isRpcMethodAllowed('evm_mine', 1337)).toBe(true)
    expect(isRpcMethodAllowed('evm_mine', 8453)).toBe(false)
    // Batch + params caps.
    const batch = Array.from({ length: 20 }, () => ({ method: 'eth_chainId' }))
    expect(screenRpcBody(batch, 31337)).toMatchObject({ status: 413 })
    expect(
      screenRpcBody({ method: 'eth_call', params: Array.from({ length: 100 }, () => 0) }, 31337),
    ).toMatchObject({ status: 413 })
    expect(screenRpcBody([], 31337)).toMatchObject({ status: 400 })
    expect(screenRpcBody({ notAMethod: 1 }, 31337)).toMatchObject({ status: 400 })
  })

  // eth_getLogs was the one allowlisted method whose cost is unbounded by its
  // own shape: the screen checked the name and the params count, nothing else.
  it('bounds the shape and numeric block range of eth_getLogs', () => {
    const span = Number(RPC_MAX_LOG_BLOCK_SPAN)
    expect(
      screenRpcBody(
        { method: 'eth_getLogs', params: [{ fromBlock: '0x0', toBlock: `0x${span.toString(16)}` }] },
        31337,
      ).ok,
    ).toBe(true)
    expect(
      screenRpcBody(
        {
          method: 'eth_getLogs',
          params: [{ fromBlock: '0x0', toBlock: `0x${(span + 1).toString(16)}` }],
        },
        31337,
      ),
    ).toMatchObject({ status: 413 })
    // Tags and omitted endpoints must not bypass the span bound. The HTTP
    // route first resolves a canonical head and passes it into the screen.
    expect(
      screenRpcBody({ method: 'eth_getLogs', params: [{ fromBlock: '0x0', toBlock: 'latest' }] }, 31337),
    ).toMatchObject({ status: 503 })
    expect(
      screenRpcBody(
        { method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: 'latest' }] },
        31337,
        { latestBlock: 10n },
      ).ok,
    ).toBe(true)
    expect(screenRpcBody({ method: 'eth_getLogs', params: [] }, 31337)).toMatchObject({ status: 400 })
    expect(screenRpcBody({ method: 'eth_getLogs', params: ['x'] }, 31337)).toMatchObject({
      status: 400,
    })
    expect(
      screenRpcBody(
        { method: 'eth_getLogs', params: [{ topics: [1, 2, 3, 4, 5] }] },
        31337,
      ),
    ).toMatchObject({ status: 400 })
    // Other methods are untouched by the filter screen.
    expect(screenRpcBody({ method: 'eth_call', params: [{}, 'latest'] }, 31337).ok).toBe(true)
  })

  it('/rpc rejects disallowed methods and does not leak upstream detail', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zkdeal-rpc-'))
    const config = loadConfig({
      dataDir,
      port: 0,
      chainId: 1,
      // Unroutable upstream: exercises the error-sanitisation path.
      l1RpcUrl: 'http://127.0.0.1:1',
      roomManager: '0x0000000000000000000000000000000000000000',
      faucetKey: null,
      faucetEnabled: false,
      webRoot: join(dataDir, 'no-web'),
    })
    const ctx = await createApp({
      config,
      enableRelay: false,
      logger: false,
    })
    try {
      const denied = await ctx.app.inject({
        method: 'POST',
        url: '/rpc',
        payload: { jsonrpc: '2.0', id: 1, method: 'anvil_setBalance', params: [] },
      })
      expect(denied.statusCode).toBe(403)

      const up = await ctx.app.inject({
        method: 'POST',
        url: '/rpc',
        payload: { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
      })
      expect(up.statusCode).toBe(502)
      expect(up.json().error).toBe('rpc upstream unavailable')
      expect(up.body).not.toContain('127.0.0.1')
    } finally {
      await ctx.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  // The catch below the fetch existed to stop upstream detail reaching the
  // caller, but it covered transport failures only: a node ERROR RESPONSE was
  // relayed verbatim, with the upstream's content-type - text/html included,
  // from the same origin as the web app.
  it('/rpc withholds non-2xx upstream bodies and pins its own content-type', async () => {
    const upstream = Fastify({ logger: false })
    upstream.post('/', async (req, reply) => {
      const method = (req.body as { method?: string }).method
      if (method === 'eth_blockNumber') {
        return reply
          .code(500)
          .type('text/html')
          .send('<h1>geth 1.13.0 at rpc-internal.zkdeal.example</h1>')
      }
      return reply.type('text/html; charset=utf-8').send(JSON.stringify({ result: '0x7a69' }))
    })
    await upstream.listen({ port: 0, host: '127.0.0.1' })
    const upstreamUrl = `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}`
    const dataDir = mkdtempSync(join(tmpdir(), 'zkdeal-rpc-upstream-'))
    const ctx = await createApp({
      config: loadConfig({
        dataDir,
        port: 0,
        chainId: 31337,
        l1RpcUrl: upstreamUrl,
        roomManager: '0x0000000000000000000000000000000000000000',
        faucetKey: null,
        faucetEnabled: false,
        webRoot: join(dataDir, 'no-web'),
      }),
      enableRelay: false,
      logger: false,
    })
    try {
      const failed = await ctx.app.inject({
        method: 'POST',
        url: '/rpc',
        payload: { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
      })
      expect(failed.statusCode).toBe(502)
      expect(failed.json().error).toBe('rpc upstream rejected the request')
      expect(failed.body).not.toContain('geth')
      expect(failed.body).not.toContain('rpc-internal')
      expect(failed.headers['content-type']).not.toMatch(/text\/html/)

      // A successful response is forwarded, but never with the upstream's type.
      const ok = await ctx.app.inject({
        method: 'POST',
        url: '/rpc',
        payload: { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
      })
      expect(ok.statusCode).toBe(200)
      expect(ok.json().result).toBe('0x7a69')
      expect(ok.headers['content-type']).toMatch(/application\/json/)
      expect(ok.headers['content-type']).not.toMatch(/text\/html/)
    } finally {
      await ctx.close()
      await upstream.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('faucet quotas', () => {
  function fakeFaucet(cfg: ServerConfig, onSend: () => Promise<Hex>): FaucetService {
    const f = new FaucetService(cfg)
    // The real wallet needs a live node; swap in a stub to exercise the
    // reservation logic (private fields are test-visible at runtime).
    Object.assign(f as unknown as Record<string, unknown>, {
      wallet: { sendTransaction: () => onSend() },
      account: { address: '0x0000000000000000000000000000000000000001' },
      rpc: null,
    })
    return f
  }

  const baseCfg = (over: Partial<ServerConfig> = {}) =>
    loadConfig({
      dataDir: mkdtempSync(join(tmpdir(), 'zkdeal-faucet-')),
      port: 0,
      roomManager: '0x0000000000000000000000000000000000000000',
      faucetKey: `0x${'11'.repeat(32)}` as `0x${string}`,
      faucetEnabled: true,
      ...over,
    })

  it('concurrent drips for one address do not both pass the cooldown', async () => {
    let sends = 0
    const f = fakeFaucet(baseCfg(), async () => {
      sends++
      await new Promise((r) => setTimeout(r, 20))
      return `0x${'ab'.repeat(32)}` as `0x${string}`
    })
    const addr = '0x1111111111111111111111111111111111111111' as `0x${string}`
    const [r1, r2, r3] = await Promise.all([f.drip(addr), f.drip(addr), f.drip(addr)])
    const okCount = [r1, r2, r3].filter((r) => r.ok).length
    expect(okCount).toBe(1)
    expect(sends).toBe(1)
  })

  it('a global hourly budget bounds unique-address floods', async () => {
    const f = fakeFaucet(baseCfg({ faucetMaxDripsPerHour: 3 }), async () => `0x${'cd'.repeat(32)}` as `0x${string}`)
    const results = []
    for (let i = 0; i < 6; i++) {
      results.push(await f.drip(`0x${(i + 1).toString(16).padStart(40, '0')}` as `0x${string}`))
    }
    expect(results.filter((r) => r.ok).length).toBe(3)
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.status === 429)).toBe(true)
  })

  it('does not surface upstream node errors to callers', async () => {
    const f = fakeFaucet(baseCfg(), async () => {
      throw new Error('connect ECONNREFUSED http://secret-node.internal:8545')
    })
    const res = await f.drip('0x2222222222222222222222222222222222222222' as `0x${string}`)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toBe('faucet transaction failed')
      expect(res.error).not.toContain('secret-node')
    }
  })
})

describe('exposure guard', () => {
  const cfg = (over: Partial<ServerConfig>): ServerConfig =>
    loadConfig({
      dataDir: mkdtempSync(join(tmpdir(), 'zkdeal-exp-')),
      port: 0,
      roomManager: '0x0000000000000000000000000000000000000000',
      faucetKey: null,
      faucetEnabled: false,
      ...over,
    })

  it('defaults to loopback', () => {
    expect(cfg({}).bindHost).toBe('127.0.0.1')
  })

  it('allows loopback with dev features, and dev chains anywhere', () => {
    expect(exposureViolation(cfg({ faucetEnabled: true, allowUnsignedWrites: true }))).toBeNull()
    expect(
      exposureViolation(cfg({ bindHost: '0.0.0.0', chainId: 31337, faucetEnabled: true })),
    ).toBeNull()
  })

  it('refuses public binding with dev-only features on a non-dev chain', () => {
    const faucet = exposureViolation(cfg({ bindHost: '0.0.0.0', chainId: 1, faucetEnabled: true }))
    expect(faucet).toMatch(/faucet/)
    const unsigned = exposureViolation(
      cfg({ bindHost: '0.0.0.0', chainId: 1, allowUnsignedWrites: true, corsOrigins: ['https://x.io'] }),
    )
    expect(unsigned).toMatch(/unsigned room writes/)
    const cors = exposureViolation(cfg({ bindHost: '0.0.0.0', chainId: 1 }))
    expect(cors).toMatch(/CORS/)
    // Fully locked down: allowed.
    expect(
      exposureViolation(cfg({ bindHost: '0.0.0.0', chainId: 1, corsOrigins: ['https://app.example'] })),
    ).toBeNull()
  })

  it('validates configuration at load time', () => {
    expect(() => loadConfig({ port: -1 })).toThrow(/invalid server config/)
    expect(() => loadConfig({ chainId: 0 })).toThrow(/chainId/)
    expect(() => loadConfig({ roomManager: '0xnope' as `0x${string}` })).toThrow(/roomManager/)
    expect(() => loadConfig({ corsOrigins: ['*'] })).toThrow(/\*/)
    expect(() => loadConfig({ roomManager: '0xnope' as `0x${string}` })).toThrow(
      /roomManager/,
    )
    // Frozen ENCODING generation (see packages/protocol constants.ts), not the
    // room protocol version - rooms still sign under this preimage tag.
    expect(PROTOCOL_VERSION).toBe(4)
  })

  // FAUCET_IP_PER_SEC was the one numeric env not routed through a validator:
  // any typo became NaN, which RateLimiter accepted and which then made
  // `tokens < cost` false forever - a silently disabled per-IP faucet limiter.
  it('refuses a non-numeric faucet rate instead of disabling the limiter', () => {
    const priorRate = process.env.FAUCET_IP_PER_SEC
    const priorDir = process.env.DATA_DIR
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'zkdeal-faucet-rate-'))
    try {
      process.env.FAUCET_IP_PER_SEC = 'auto'
      expect(() => loadConfig()).toThrow(/FAUCET_IP_PER_SEC must be a positive number/)
      process.env.FAUCET_IP_PER_SEC = '0'
      expect(() => loadConfig()).toThrow(/FAUCET_IP_PER_SEC/)
      process.env.FAUCET_IP_PER_SEC = '0.5'
      expect(loadConfig().faucetIpPerSec).toBe(0.5)
    } finally {
      if (priorRate === undefined) delete process.env.FAUCET_IP_PER_SEC
      else process.env.FAUCET_IP_PER_SEC = priorRate
      if (priorDir === undefined) delete process.env.DATA_DIR
      else process.env.DATA_DIR = priorDir
    }
    // A NaN rate must not construct a limiter that admits everything.
    expect(() => new RateLimiter(60, Number.NaN)).toThrow(/positive finite/)
    expect(() => new RateLimiter(Number.NaN, 1)).toThrow(/positive finite/)
    const real = new RateLimiter(1, 0.001)
    expect(real.take('ip')).toBe(true)
    expect(real.take('ip')).toBe(false)
  })
})
