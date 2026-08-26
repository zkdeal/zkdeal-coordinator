import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'
import type { ServerConfig } from './config.js'
import { buildContractsJson } from './contracts-meta.js'
import { registerCardArtifactRoutes } from './card-artifacts.js'

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>zkdeal coordinator</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 3rem; max-width: 40rem; line-height: 1.5; }
    code { background: #f2f2f2; padding: 0.1em 0.35em; }
  </style>
</head>
<body>
  <h1>zkdeal coordinator</h1>
  <p>Web app not found. Build the static export first:</p>
  <pre>pnpm --filter web build</pre>
  <p>Then restart the server (expects <code>web/out</code> or <code>WEB_ROOT</code>).</p>
  <p>API: <a href="/health">/health</a> · <a href="/config">/config</a></p>
</body>
</html>`

/** Published deployment metadata and the RISC Zero verifier assets. */
export function registerArtifactRoutes(app: FastifyInstance, cfg: ServerConfig): void {
  const contractsJson = buildContractsJson(cfg)

  app.get('/artifacts/contracts.json', async (_req, reply) => {
    reply.header('content-type', 'application/json')
    return contractsJson
  })

  // Expose only the RISC Zero verifier assets. A wildcard over zkvm/build
  // also exposed retired stf-wasm, Ligetron, and stale receipt fixtures.
  const zkvmArtifactFiles = [
    'risc0/verifier/r0_wasm_verifier.js',
    'risc0/verifier/r0_wasm_verifier_bg.wasm',
  ] as const
  for (const relative of zkvmArtifactFiles) {
    app.get(`/artifacts/zkvm/${relative}`, async (_req, reply) => {
      const path = join(cfg.zkvmArtifactsRoot, relative)
      let stat
      try {
        stat = statSync(path)
      } catch {
        return reply.code(404).send({ error: 'verifier artifact not found' })
      }
      const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
      const type = relative.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'
      return reply
        .type(type)
        .header('etag', etag)
        .header('cache-control', 'public, max-age=300')
        .header('content-length', String(stat.size))
        .send(createReadStream(path))
    })
  }

  // Card proving artifacts (browser-side inner Groth16 proofs). The allow-list
  // is derived from circuits/card-artifacts.lock.json, which is the same file
  // the client hashes each download against.
  registerCardArtifactRoutes(app, cfg)

  // The retired `/legacy/v3/artifacts/*` Circom artifact routes lived here
  // behind `if (false)`. The 410 hook in createApp already made them
  // unreachable, so the block only obscured which artifact routes are live.
}

/** Static web export, or a build-instruction placeholder when it is absent. */
export async function registerStaticWeb(app: FastifyInstance, cfg: ServerConfig): Promise<void> {
  const hasWeb = existsSync(join(cfg.webRoot, 'index.html'))
  if (!hasWeb) {
    app.get('/', async (_req, reply) => reply.type('text/html').send(PLACEHOLDER_HTML))
    return
  }
  await app.register(fastifyStatic, {
    root: cfg.webRoot,
    prefix: '/',
    decorateReply: false,
    // Serve by request path, NOT by a route table enumerated once at
    // registration. With `wildcard: false` a web rebuild produces new
    // content-hashed chunk names that were never registered, so they fell
    // through to the SPA fallback below and the browser received
    // index.html - as text/html, with status 200 - in place of a .js
    // chunk. That surfaces as an opaque `ChunkLoadError` / bare
    // `SyntaxError: Unexpected token '<'` and needed a coordinator restart
    // after every `next build`.
    wildcard: true,
  })
  app.setNotFoundHandler(async (req, reply) => {
    const url = req.url.split('?')[0] ?? ''
    const isApi =
      url.startsWith('/api') ||
      url === '/rooms' ||
      url.startsWith('/rooms/') ||
      url.startsWith('/artifacts') ||
      url.startsWith('/rpc') ||
      url.startsWith('/faucet') ||
      url.startsWith('/health') ||
      url.startsWith('/config') ||
      url.startsWith('/bus') ||
      // /rooms is the service's primary surface (it also carried the retired
      // /v5 prefix, kept here so a stale client's misspelled or
      // not-yet-implemented room route answers 404 JSON, not 200 text/html
      // with the SPA shell that a JSON client reports as
      // `SyntaxError: Unexpected token '<'`).
      // `/applications` is a static-exported page. Keep the API namespace exact
      // so the page is not mistaken for a missing JSON route.
      url === '/v5' ||
      url.startsWith('/v5/') ||
      url.startsWith('/demo/v1') ||
      url.startsWith('/legacy')
    // A missing ASSET must 404. Returning the SPA shell for /_next/* or for
    // any path with a file extension turns a deploy/caching fault into a
    // confusing parse error inside the browser instead of a clear miss.
    const isAsset = url.startsWith('/_next/') || /\.[a-z0-9]+$/i.test(url)
    if (req.method === 'GET' && !isApi && !isAsset) {
      // Next.js static exports emit route.html plus an RSC data directory,
      // not route/index.html. Serve the exact exported page before the SPA
      // fallback so `/demo` and `/demo/` cannot silently render `/`.
      const route = url.replace(/\/+$/, '')
      if (route && /^\/[a-zA-Z0-9/_-]+$/.test(route) && !route.includes('..')) {
        const exportedPage = join(cfg.webRoot, `${route.slice(1)}.html`)
        if (existsSync(exportedPage)) {
          return reply.type('text/html').send(readFileSync(exportedPage, 'utf8'))
        }
      }
      const index = join(cfg.webRoot, 'index.html')
      if (existsSync(index)) {
        return reply.type('text/html').send(readFileSync(index, 'utf8'))
      }
    }
    return reply.code(404).send({ error: 'not found' })
  })
}
