/**
 * Read-only distribution of the card proving artifacts.
 *
 * A browser cannot produce an inner Groth16 proof without ~25.6 MB of circom
 * wasm and zkey, and `circuits/build/**` is gitignored, so nothing in the repo
 * served them. The wildcard-over-a-build-directory route that used to exist here
 * was deliberately deleted (see `registerArtifactRoutes`), so this module
 * re-derives a strict ALLOW-LIST from the one file that is already the trust
 * root: `circuits/card-artifacts.lock.json`.
 *
 * Consequences of deriving rather than restating:
 *   - a path can only be wrong in one place, and it is the same place the
 *     browser checks its sha256 against;
 *   - a circuit added to the lock is served automatically;
 *   - a lock that names a path outside `circuits/` is refused at startup rather
 *     than silently turning into a file-read primitive.
 *
 * These are GET routes for public, uncontributed demo keys. They are not a
 * mutation surface and carry no credential, exactly like the two zkVM verifier
 * files beside them.
 */

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ServerConfig } from './config.js'

/** URL prefix. `${prefix}/${lockPath}` is exactly the lock's own path. */
export const CARD_ARTIFACT_ROUTE_PREFIX = '/artifacts/circuits'

/** Lock file name, relative to `circuitsRoot`. */
export const CARD_ARTIFACT_LOCK_FILE = 'card-artifacts.lock.json'

export const CARD_ARTIFACT_LOCK_FORMAT = 'zkdeal/card-artifacts-lock/v4'

/** Every kind the lock can distribute. `vkey` is tracked; the rest are built. */
const SERVED_KINDS = ['wasm', 'zkey', 'vkey'] as const
type ServedKind = (typeof SERVED_KINDS)[number]

export interface CardArtifactRoute {
  circuit: string
  kind: ServedKind
  /** Path relative to `circuitsRoot`, taken verbatim from the lock. */
  path: string
  bytes: number
  sha256: string
}

const DIGEST_FIELD: Record<ServedKind, string> = {
  wasm: 'wasmSha256',
  zkey: 'demoZkeySha256',
  vkey: 'demoVkeySha256',
}

/**
 * A lock path is DATA, not a route. Reject anything that could escape
 * `circuitsRoot` before it is ever turned into a filesystem read.
 */
function safeRelativePath(candidate: unknown, circuitsRoot: string): string {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 256) {
    throw new Error('card artifact lock contains an unusable distribution path')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(candidate) || candidate.includes('..')) {
    throw new Error(`card artifact lock path '${candidate}' is not a plain relative path`)
  }
  const resolved = join(circuitsRoot, candidate)
  const inside = relative(circuitsRoot, resolved)
  if (inside.startsWith('..') || isAbsolute(inside) || inside.split(/[/\\]/).includes('..')) {
    throw new Error(`card artifact lock path '${candidate}' escapes the circuits root`)
  }
  // `join` normalises separators; the served URL must still be the lock's own
  // forward-slash path so a client can concatenate it without translating.
  if (inside.split(sep).join('/') !== candidate) {
    throw new Error(`card artifact lock path '${candidate}' is not already normalised`)
  }
  return candidate
}

/**
 * Parse the lock into the exact route table to register. Returns an empty list
 * when the lock is absent - a clean clone has neither the lock's build outputs
 * nor, in some deployments, the lock - and throws when the lock is present but
 * malformed, because a wrong trust root must not degrade into "serve nothing".
 */
export function cardArtifactRoutes(circuitsRoot: string): CardArtifactRoute[] {
  let raw: string
  try {
    raw = readFileSync(join(circuitsRoot, CARD_ARTIFACT_LOCK_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const lock = JSON.parse(raw) as Record<string, unknown>
  if (lock.format !== CARD_ARTIFACT_LOCK_FORMAT) {
    throw new Error(`unexpected card artifact lock format ${String(lock.format)}`)
  }
  const circuits = lock.circuits
  if (!circuits || typeof circuits !== 'object') {
    throw new Error('card artifact lock declares no circuits')
  }
  const routes: CardArtifactRoute[] = []
  for (const [circuit, value] of Object.entries(circuits as Record<string, unknown>)) {
    const entry = value as Record<string, unknown>
    const distribution = (entry.distribution ?? {}) as Record<string, { path?: unknown; bytes?: unknown }>
    for (const kind of SERVED_KINDS) {
      const file = distribution[kind]
      if (!file) continue
      const sha256 = entry[DIGEST_FIELD[kind]]
      if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
        throw new Error(`card artifact lock ${circuit} has no usable ${DIGEST_FIELD[kind]}`)
      }
      if (typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes <= 0) {
        throw new Error(`card artifact lock ${circuit} ${kind} has no usable byte length`)
      }
      routes.push({
        circuit,
        kind,
        path: safeRelativePath(file.path, circuitsRoot),
        bytes: file.bytes,
        sha256,
      })
    }
  }
  if (routes.length === 0) throw new Error('card artifact lock distributes no files')
  return routes
}

function contentType(path: string): string {
  if (path.endsWith('.wasm')) return 'application/wasm'
  if (path.endsWith('.json')) return 'application/json'
  return 'application/octet-stream'
}

/**
 * Register the lock itself plus one literal GET per allow-listed artifact.
 *
 * Every route is a fixed string, so no request path is ever concatenated into a
 * filesystem path. A missing file answers 404 rather than 500: on a clean clone
 * the lock is tracked but `build/card/**` is not, and a client that fetched the
 * plan needs to distinguish "not built here" from "server broken".
 */
export function registerCardArtifactRoutes(app: FastifyInstance, cfg: ServerConfig): CardArtifactRoute[] {
  let routes: CardArtifactRoute[]
  try {
    routes = cardArtifactRoutes(cfg.circuitsRoot)
  } catch (error) {
    // Fail closed on the ALLOW-LIST, not on the coordinator: a corrupt demo
    // artifact lock must not make the room service unbootable. Nothing is
    // served, and the reason is logged rather than swallowed.
    app.log.error(
      { error: error instanceof Error ? error.message : String(error) },
      'card artifact lock is unusable; no card proving artifact is served',
    )
    return []
  }
  if (routes.length === 0) return routes

  const send =
    (relativePath: string, expectedBytes: number | null) =>
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const absolute = join(cfg.circuitsRoot, relativePath)
      let stat
      try {
        stat = statSync(absolute)
        if (!stat.isFile()) throw new Error('not a regular file')
      } catch {
        return reply.code(404).send({
          error: 'card proving artifact not built on this coordinator',
          artifact: relativePath,
          remedy: 'run `pnpm --filter @zkdeal/circuits build:card` where the coordinator runs',
        })
      }
      if (expectedBytes !== null && stat.size !== expectedBytes) {
        // The client checks sha256 anyway, but answering 200 with a length the
        // trust root contradicts wastes a multi-megabyte download first.
        return reply.code(409).send({
          error: 'card proving artifact does not match the pinned length',
          artifact: relativePath,
          expectedBytes,
          actualBytes: stat.size,
        })
      }
      const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
      return reply
        .type(contentType(relativePath))
        .header('etag', etag)
        .header('cache-control', 'public, max-age=300')
        .header('content-length', String(stat.size))
        .send(createReadStream(absolute))
    }

  app.get(`${CARD_ARTIFACT_ROUTE_PREFIX}/${CARD_ARTIFACT_LOCK_FILE}`, send(CARD_ARTIFACT_LOCK_FILE, null))
  for (const route of routes) {
    app.get(`${CARD_ARTIFACT_ROUTE_PREFIX}/${route.path}`, send(route.path, route.bytes))
  }
  return routes
}

/**
 * `/config` section describing where the card proving artifacts live and
 * whether this coordinator actually has them, so a browser can decide between
 * "prove locally" and "this stand cannot prove" WITHOUT starting a 25 MB
 * download. Null when the coordinator publishes no lock, exactly as the zkVM
 * section is omitted when its lock is absent.
 *
 * `sha256` is repeated here only as a convenience: a client must still fetch
 * the lock and check every download against it, because that file - not this
 * response - is the trust root.
 */
export function buildCardCircuitsConfigSection(cfg: ServerConfig): Record<string, unknown> | null {
  let routes: CardArtifactRoute[]
  try {
    routes = cardArtifactRoutes(cfg.circuitsRoot)
  } catch {
    // A malformed lock must not take down /config; it already fails loudly at
    // startup where `registerCardArtifactRoutes` reads it.
    return null
  }
  if (routes.length === 0) return null
  const available = (path: string) => existsSync(join(cfg.circuitsRoot, path))
  return {
    lockUrl: `${CARD_ARTIFACT_ROUTE_PREFIX}/${CARD_ARTIFACT_LOCK_FILE}`,
    // The keys are uncontributed demo keys; anyone holding a zkey can forge a
    // proof of any statement of the circuit. Every UI claiming confidentiality
    // has to repeat this.
    ceremony: 'uncontributed-demo-only',
    provingArtifactsAvailable: routes
      .filter((route) => route.kind !== 'vkey')
      .every((route) => available(route.path)),
    files: routes.map((route) => ({
      circuit: route.circuit,
      kind: route.kind,
      url: `${CARD_ARTIFACT_ROUTE_PREFIX}/${route.path}`,
      bytes: route.bytes,
      sha256: route.sha256,
      available: available(route.path),
    })),
  }
}
