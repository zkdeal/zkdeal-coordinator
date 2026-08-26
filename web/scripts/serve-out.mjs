#!/usr/bin/env node
/**
 * Static server for the `output: 'export'` build (web/out).
 *
 * `next start` cannot serve an exported build ("next start does not work with
 * output: export"), so the package's own `start` script was unusable after a
 * successful `build`. This is a dependency-free replacement so
 * build -> start -> HTTP smoke works locally and in CI.
 *
 * Binds loopback by default; set HOST=0.0.0.0 deliberately to expose it.
 */
import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(process.argv[2] ?? fileURLToPath(new URL('../out', import.meta.url)))
const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '127.0.0.1'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * Strip query/hash and percent-decode. Returns null for malformed encoding
 * (`/%`, `/%zz`, a lone `%FF`): `decodeURIComponent` throws `URIError`, and an
 * exception out of a `request` listener is an uncaught exception that kills the
 * process - one unauthenticated request would take the server down.
 */
export function decodeRequestPath(urlPath) {
  try {
    return decodeURIComponent(urlPath.split('?')[0].split('#')[0])
  } catch {
    return null
  }
}

export function resolveFile(decodedPath, base = root) {
  // Confine to `base` (no ../ escapes).
  const candidate = resolve(join(base, normalize(decodedPath)))
  if (candidate !== base && !candidate.startsWith(base + sep)) return null
  for (const p of [candidate, `${candidate}.html`, join(candidate, 'index.html')]) {
    try {
      if (statSync(p).isFile()) return p
    } catch {
      /* try next */
    }
  }
  return null
}

const server = createServer((req, res) => {
  const decoded = decodeRequestPath(req.url ?? '/')
  if (decoded === null) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('400')
    return
  }
  const file = resolveFile(decoded)
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('404')
    return
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    // Matches the production coordinator headers so SharedArrayBuffer
    // multithreaded proving behaves the same when served locally.
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
  })
  createReadStream(file).pipe(res)
})

// Only listen when run as a script: the unit test imports `decodeRequestPath`
// and `resolveFile` and must not bind a port.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(port, host, () => {
    console.log(`serve-out: http://${host}:${port} -> ${root}`)
  })
}
