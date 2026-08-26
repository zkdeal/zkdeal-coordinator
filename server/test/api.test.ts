import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type AppContext } from '../src/app.js'
import { loadConfig, type ServerConfig } from '../src/config.js'
import { buildContractsJson } from '../src/contracts-meta.js'

describe('@zkdeal/server REST', () => {
  let ctx: AppContext
  let config: ServerConfig
  let dataDir: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'zkdeal-server-'))
    config = loadConfig({
      dataDir,
      port: 0,
      roomManager: '0x0000000000000000000000000000000000000000',
      faucetKey: null,
      faucetEnabled: false,
      // Deterministic regardless of whether web/out has been built.
      webRoot: join(dataDir, 'no-web'),
    })
    ctx = await createApp({
      config,
      enableRelay: false,
      logger: false,
    })
    await ctx.app.listen({ port: 0, host: '127.0.0.1' })
  })

  afterAll(async () => {
    await ctx.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('GET /health', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body.protocolVersion).toBe(4)
    expect(body.coordinator).toEqual({
      id: 'standalone',
      role: 'standalone',
    })
    expect(String(body.framing)).toContain('experimental asynchronous zkVM receipts')
    expect(String(body.framing)).toContain('pre-release')
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin')
    expect(res.headers['cross-origin-embedder-policy']).toBe('require-corp')
  })

  it('GET /config', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/config' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.rpcUrl).toBe('/rpc')
    expect(body).not.toHaveProperty('roomManagerV4')
    expect(body).not.toHaveProperty('roomManagerV5')
    expect(body.roomManager).toMatch(/^0x[0-9a-f]{40}$/)
    expect(body).not.toHaveProperty('circuit')
    expect(body.l1BlockTimeSec).toBe(12)
    expect(body).not.toHaveProperty('dealExecutionWindowSec')
    expect(body).not.toHaveProperty('challengeWindowBlocks')
    expect(body.faucetEnabled).toBe(false)
    expect(body.protocolVersion).toBe(4)
    expect(body).not.toHaveProperty('v4')
    expect(body).not.toHaveProperty('v5')
    expect(body.proofStatus.proofBackedBatches).toBe('pre-release')
    expect(body.proofStatus.fullSettlementValidity).toBe(false)
    expect(body.proofStatus.blockers).toEqual(['gpu-l1-gate'])
    expect(body).not.toHaveProperty('allowUnsignedWrites')
    expect(body.relay).toMatchObject({ port: expect.any(Number), peerId: null, multiaddrs: [] })
    expect(String(body.framing)).toContain('pre-release')
  })

  it('GET /artifacts/contracts.json', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/artifacts/contracts.json' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('roomManagerAbi')
    expect(body).not.toHaveProperty('roomManagerV4Abi')
    expect(body).not.toHaveProperty('roomManagerV5Abi')
    expect(body).not.toHaveProperty('scenarios')
    expect(body).not.toHaveProperty('legacyV3RoomManager')
    expect(String(body.framing)).toContain('generic room-local EVM execution')
    expect(String(body.framing)).toContain('pinned presets')
  })

  // L21: Fastify runs neither `onSend` nor @fastify/cors's reply headers for a
  // hijacked reply, so a cross-origin EventSource could not read the SSE
  // stream at all. Asserted through the REAL app, where the cors plugin is
  // registered, not through a bare Fastify instance.
  it('carries the negotiated CORS headers onto the hijacked SSE stream', async () => {
    ctx.observer!.put({
      roomId: '4242',
      status: 'OPEN',
      authorizationMode: 'VALIDITY_ONLY',
      admissionSigner: null,
      serviceBond: '0',
      minimumServiceBond: '0',
      omissionPenalty: '0',
      bondEpoch: '1',
      maximumAdmissionWindow: '0',
      minimumDepositConfirmations: '0',
      latestObservedL1Block: '1',
      coldTemplateId: `0x${'1'.repeat(64)}`,
      coldTemplateDataHash: `0x${'2'.repeat(64)}`,
      policyHash: `0x${'3'.repeat(64)}`,
      participantRoot: `0x${'4'.repeat(64)}`,
      participantEpoch: '1',
      participantCount: '0',
      participantCapacity: '128',
      supportedAssets: [],
      approvers: [],
      liabilities: [],
      imports: [],
      deposits: [],
      withdrawals: [],
      admissions: [],
      forcedTransactions: [],
      applications: [],
      batches: [],
    })
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/rooms/4242/stream?once=1',
      headers: { origin: 'http://localhost:3001' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3001')
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin')
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin')
  })

  // The addresses file was copied allow-by-default onto an unauthenticated
  // route, so anything string-valued an operator's deploy tooling wrote there
  // - RPC URLs, deployer accounts, per-environment tokens - was republished.
  it('publishes only allowlisted, address-shaped keys from addresses.json', () => {
    const directory = mkdtempSync(join(tmpdir(), 'zkdeal-addresses-'))
    const addressesPath = join(directory, 'addresses.json')
    writeFileSync(
      addressesPath,
      JSON.stringify({
        roomManager: '0x2222222222222222222222222222222222222222',
        deployerPrivateKey: `0x${'ab'.repeat(32)}`,
        rpcUrl: 'https://mainnet.internal.example/v1/secret-key',
        etherscanApiToken: 'ETHERSCAN-SECRET',
        // An allowlisted key may not smuggle a non-address value either.
        roomPool: 'https://pool.internal.example',
      }),
    )
    try {
      const json = buildContractsJson(
        loadConfig({
          dataDir: directory,
          addressesPath,
          port: 0,
          roomManager: '0x0000000000000000000000000000000000000000',
          faucetKey: null,
          faucetEnabled: false,
        }),
      )
      expect(json.addresses.roomManager).toBe('0x2222222222222222222222222222222222222222')
      expect(json.addresses).not.toHaveProperty('deployerPrivateKey')
      expect(json.addresses).not.toHaveProperty('rpcUrl')
      expect(json.addresses).not.toHaveProperty('etherscanApiToken')
      expect(json.addresses).not.toHaveProperty('roomPool')
      expect(JSON.stringify(json.addresses)).not.toContain('secret')
      expect(JSON.stringify(json.addresses)).not.toContain('SECRET')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('permanently retires every v3 route with no environment escape hatch', async () => {
    process.env.ZKDEAL_ENABLE_LEGACY_V3 = '1'
    try {
      for (const url of [
        '/legacy/v3/rooms',
        '/legacy/v3/rooms/1/genesis',
        '/legacy/v3/zkvm/prove',
        '/legacy/v3/artifacts/settle.zkey',
      ]) {
        const response = await ctx.app.inject({ method: 'GET', url })
        expect(response.statusCode).toBe(410)
        expect(response.json().error).toMatch(/permanently retired/)
      }
      const config = (await ctx.app.inject({ method: 'GET', url: '/config' })).json()
      expect(config).not.toHaveProperty('legacyV3')
      expect(config).not.toHaveProperty('legacyV3Enabled')
    } finally {
      delete process.env.ZKDEAL_ENABLE_LEGACY_V3
    }
  })

  it('serves placeholder HTML when web/out missing', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('Build the static export')
  })
})
