import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type AppContext } from '../src/app.js'
import { loadConfig } from '../src/config.js'

/**
 * Regression: a web rebuild changes content-hashed chunk names. With a route
 * table enumerated once at registration, the new names 404'd into the SPA
 * fallback and the browser got index.html (text/html, 200) where a .js chunk
 * was expected - an opaque ChunkLoadError that needed a coordinator restart
 * to clear.
 */
describe('static web serving', () => {
  let ctx: AppContext
  let dataDir: string
  let webRoot: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'zkdeal-static-'))
    webRoot = join(dataDir, 'web-out')
    mkdirSync(join(webRoot, '_next', 'static', 'chunks'), { recursive: true })
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>app</title>')
    writeFileSync(join(webRoot, 'demo.html'), '<!doctype html><title>demo app</title>')
    writeFileSync(join(webRoot, 'applications.html'), '<!doctype html><title>applications app</title>')
    writeFileSync(join(webRoot, '_next', 'static', 'chunks', 'boot-aaaa.js'), 'export const a=1')

    ctx = await createApp({
      config: loadConfig({
        dataDir,
        port: 0,
        roomManager: '0x0000000000000000000000000000000000000000',
        faucetKey: null,
        faucetEnabled: false,
        webRoot,
      }),
      enableRelay: false,
      logger: false,
    })
  })

  afterAll(async () => {
    await ctx.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('serves a chunk that existed at startup', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/_next/static/chunks/boot-aaaa.js' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('export const a=1')
  })

  it('serves a chunk written AFTER startup with its real bytes and type', async () => {
    // This is the exact production failure: `next build` emits new
    // content-hashed names while the coordinator keeps running.
    const body = 'export const b=2\n'.repeat(64)
    writeFileSync(join(webRoot, '_next', 'static', 'chunks', 'boot-bbbb.js'), body)
    const res = await ctx.app.inject({ method: 'GET', url: '/_next/static/chunks/boot-bbbb.js' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(body)
    expect(res.body.length).toBe(body.length)
    expect(res.headers['content-type']).toMatch(/javascript/)
    expect(res.headers['content-type']).not.toMatch(/text\/html/)
  })

  it('serves other post-registration asset types with correct content-types', async () => {
    writeFileSync(join(webRoot, '_next', 'static', 'late.css'), '.a{color:red}')
    writeFileSync(join(webRoot, '_next', 'static', 'late.json'), '{"a":1}')
    writeFileSync(join(webRoot, '_next', 'static', 'late.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]))

    const css = await ctx.app.inject({ method: 'GET', url: '/_next/static/late.css' })
    expect(css.statusCode).toBe(200)
    expect(css.headers['content-type']).toMatch(/text\/css/)

    const json = await ctx.app.inject({ method: 'GET', url: '/_next/static/late.json' })
    expect(json.statusCode).toBe(200)
    expect(json.headers['content-type']).toMatch(/application\/json/)

    const wasm = await ctx.app.inject({ method: 'GET', url: '/_next/static/late.wasm' })
    expect(wasm.statusCode).toBe(200)
    expect(wasm.headers['content-type']).toMatch(/wasm/)
  })

  it('404s a MISSING chunk instead of returning the SPA shell', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/_next/static/chunks/nope.js' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).not.toMatch(/text\/html/)
    expect(res.body).not.toContain('<!doctype html')
  })

  it('404s any missing path with a file extension (no content-type confusion)', async () => {
    for (const url of ['/nope.css', '/nope.map', '/nope.wasm', '/nope.json', '/a/b/nope.js']) {
      const res = await ctx.app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(404)
      expect(res.headers['content-type'], url).not.toMatch(/text\/html/)
    }
  })

  it('still serves the SPA shell for client-side routes', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/room' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.body).toContain('<title>app</title>')
  })

  it('serves exact Next.js static-export pages with and without a trailing slash', async () => {
    for (const url of ['/demo', '/demo/']) {
      const res = await ctx.app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(200)
      expect(res.headers['content-type'], url).toMatch(/text\/html/)
      expect(res.body, url).toContain('<title>demo app</title>')
      expect(res.body, url).not.toContain('<title>app</title>')
    }

    for (const url of ['/applications', '/applications/']) {
      const res = await ctx.app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(200)
      expect(res.headers['content-type'], url).toMatch(/text\/html/)
      expect(res.body, url).toContain('<title>applications app</title>')
      expect(res.body, url).not.toContain('<title>app</title>')
    }
  })

  it('does not hijack API paths', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)
  })

  // The SPA predicate once listed every API prefix EXCEPT the room surface,
  // so an unmatched room GET answered 200 text/html with the shell and a JSON
  // client saw `SyntaxError: Unexpected token '<'`. The retired /v5 prefix
  // stays classified as API so a stale client gets the same clean 404.
  it('404s an unmatched room route instead of returning the SPA shell', async () => {
    for (const url of ['/rooms/7/typo', '/v5', '/v5/anything']) {
      const res = await ctx.app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(404)
      expect(res.headers['content-type'], url).not.toMatch(/text\/html/)
      expect(res.body, url).not.toContain('<title>app</title>')
    }
    // A registered room route is unaffected.
    const observed = await ctx.app.inject({ method: 'GET', url: '/rooms/7' })
    expect(observed.statusCode).toBe(404)
    expect(observed.json().decision).toBe('ROOM_NOT_OBSERVED')
  })
})
