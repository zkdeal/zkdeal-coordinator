import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig, type ServerConfig } from '../src/config.js'
import {
  CARD_ARTIFACT_LOCK_FILE,
  CARD_ARTIFACT_LOCK_FORMAT,
  CARD_ARTIFACT_ROUTE_PREFIX,
  buildCardCircuitsConfigSection,
  cardArtifactRoutes,
  registerCardArtifactRoutes,
} from '../src/card-artifacts.js'

const created: string[] = []
const apps: FastifyInstance[] = []

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true })
})

function circuitsRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'zkdeal-card-artifacts-'))
  created.push(path)
  return path
}

const WASM = Buffer.from('00610736demo-wasm-bytes', 'utf8')
const ZKEY = Buffer.from('demo-zkey-bytes-0123456789', 'utf8')
const VKEY = Buffer.from('{"protocol":"groth16"}', 'utf8')

function lockDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: CARD_ARTIFACT_LOCK_FORMAT,
    ceremony: 'uncontributed-demo-only',
    browser: { requires: ['wasm', 'zkey'], totalDownloadBytes: WASM.length + ZKEY.length },
    circuits: {
      'deck-init-v4': {
        wasmSha256: 'a'.repeat(64),
        demoZkeySha256: 'b'.repeat(64),
        demoVkeySha256: 'c'.repeat(64),
        distribution: {
          wasm: { path: 'build/card/deck-init-v4/deck-init-v4.wasm', bytes: WASM.length },
          zkey: { path: 'build/card/deck-init-v4/deck-init-v4.demo.zkey', bytes: ZKEY.length },
          vkey: { path: 'card-vkeys/deck-init-v4.demo.vkey.json', bytes: VKEY.length },
        },
      },
    },
    ...overrides,
  }
}

function write(root: string, relative: string, body: Buffer | string): void {
  const path = join(root, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

function seed(root: string, lock: Record<string, unknown> = lockDocument()): void {
  write(root, CARD_ARTIFACT_LOCK_FILE, JSON.stringify(lock, null, 2))
}

function config(root: string): ServerConfig {
  return loadConfig({
    dataDir: root,
    port: 0,
    faucetKey: null,
    faucetEnabled: false,
    circuitsRoot: root,
  })
}

async function serve(root: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  registerCardArtifactRoutes(app, config(root))
  await app.ready()
  apps.push(app)
  return app
}

describe('card artifact allow-list derivation', () => {
  it('serves nothing at all when the lock is absent', () => {
    expect(cardArtifactRoutes(circuitsRoot())).toEqual([])
  })

  it('derives one route per distributed file, digests included', () => {
    const root = circuitsRoot()
    seed(root)
    const routes = cardArtifactRoutes(root)
    expect(routes.map((route) => route.kind)).toEqual(['wasm', 'zkey', 'vkey'])
    expect(routes[0]?.path).toBe('build/card/deck-init-v4/deck-init-v4.wasm')
    expect(routes[0]?.sha256).toBe('a'.repeat(64))
    expect(routes[2]?.sha256).toBe('c'.repeat(64))
  })

  it('refuses a lock whose format is not the pinned one', () => {
    const root = circuitsRoot()
    seed(root, lockDocument({ format: 'something-else' }))
    expect(() => cardArtifactRoutes(root)).toThrow(/unexpected card artifact lock format/)
  })

  it('refuses a lock entry with no usable digest', () => {
    const root = circuitsRoot()
    const lock = lockDocument()
    ;(lock.circuits as Record<string, Record<string, unknown>>)['deck-init-v4']!.wasmSha256 = 'short'
    seed(root, lock)
    expect(() => cardArtifactRoutes(root)).toThrow(/no usable wasmSha256/)
  })

  it('refuses a lock path that tries to escape the circuits root', () => {
    for (const path of ['../secrets/key.pem', '/etc/passwd', 'build/../../out', 'build//x']) {
      const root = circuitsRoot()
      const lock = lockDocument()
      const circuit = (lock.circuits as Record<string, Record<string, unknown>>)['deck-init-v4']!
      ;(circuit.distribution as Record<string, { path: string; bytes: number }>).wasm = {
        path,
        bytes: 1,
      }
      seed(root, lock)
      expect(() => cardArtifactRoutes(root), path).toThrow(
        /plain relative path|escapes the circuits root|already normalised/,
      )
    }
  })
})

describe('card artifact routes', () => {
  it('registers no route when the coordinator has no lock', async () => {
    const root = circuitsRoot()
    const app = await serve(root)
    const response = await app.inject({
      method: 'GET',
      url: `${CARD_ARTIFACT_ROUTE_PREFIX}/${CARD_ARTIFACT_LOCK_FILE}`,
    })
    expect(response.statusCode).toBe(404)
  })

  it('serves nothing, and still boots, when the lock is unusable', async () => {
    const root = circuitsRoot()
    seed(root, lockDocument({ format: 'wrong' }))
    write(root, 'build/card/deck-init-v4/deck-init-v4.wasm', WASM)
    const app = await serve(root)
    const response = await app.inject({
      method: 'GET',
      url: `${CARD_ARTIFACT_ROUTE_PREFIX}/build/card/deck-init-v4/deck-init-v4.wasm`,
    })
    expect(response.statusCode).toBe(404)
  })

  it('serves the lock and each allow-listed artifact byte for byte', async () => {
    const root = circuitsRoot()
    seed(root)
    write(root, 'build/card/deck-init-v4/deck-init-v4.wasm', WASM)
    write(root, 'build/card/deck-init-v4/deck-init-v4.demo.zkey', ZKEY)
    write(root, 'card-vkeys/deck-init-v4.demo.vkey.json', VKEY)
    const app = await serve(root)

    const lock = await app.inject({
      method: 'GET',
      url: `${CARD_ARTIFACT_ROUTE_PREFIX}/${CARD_ARTIFACT_LOCK_FILE}`,
    })
    expect(lock.statusCode).toBe(200)
    expect(lock.json().format).toBe(CARD_ARTIFACT_LOCK_FORMAT)

    const wasm = await app.inject({
      method: 'GET',
      url: `${CARD_ARTIFACT_ROUTE_PREFIX}/build/card/deck-init-v4/deck-init-v4.wasm`,
    })
    expect(wasm.statusCode).toBe(200)
    expect(wasm.headers['content-type']).toContain('application/wasm')
    expect(wasm.headers['content-length']).toBe(String(WASM.length))
    expect(wasm.rawPayload.equals(WASM)).toBe(true)

    const zkey = await app.inject({
      method: 'GET',
      url: `${CARD_ARTIFACT_ROUTE_PREFIX}/build/card/deck-init-v4/deck-init-v4.demo.zkey`,
    })
    expect(zkey.statusCode).toBe(200)
    expect(zkey.rawPayload.equals(ZKEY)).toBe(true)
  })

  it('answers 404 for an artifact the lock names but this machine has not built', async () => {
    const root = circuitsRoot()
    seed(root)
    const app = await serve(root)
    const response = await app.inject({
      method: 'GET',
      url: `${CARD_ARTIFACT_ROUTE_PREFIX}/build/card/deck-init-v4/deck-init-v4.wasm`,
    })
    expect(response.statusCode).toBe(404)
    expect(response.json().remedy).toContain('build:card')
  })

  it('refuses an artifact whose length contradicts the trust root', async () => {
    const root = circuitsRoot()
    seed(root)
    write(root, 'build/card/deck-init-v4/deck-init-v4.wasm', Buffer.concat([WASM, WASM]))
    const app = await serve(root)
    const response = await app.inject({
      method: 'GET',
      url: `${CARD_ARTIFACT_ROUTE_PREFIX}/build/card/deck-init-v4/deck-init-v4.wasm`,
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().expectedBytes).toBe(WASM.length)
  })

  it('exposes nothing outside the allow-list', async () => {
    const root = circuitsRoot()
    seed(root)
    write(root, 'secret.txt', 'do not serve me')
    write(root, 'build/card/deck-init-v4/CardDeckInit.r1cs', 'not distributed')
    const app = await serve(root)
    for (const url of [
      `${CARD_ARTIFACT_ROUTE_PREFIX}/secret.txt`,
      `${CARD_ARTIFACT_ROUTE_PREFIX}/build/card/deck-init-v4/CardDeckInit.r1cs`,
      `${CARD_ARTIFACT_ROUTE_PREFIX}/../../../package.json`,
      `${CARD_ARTIFACT_ROUTE_PREFIX}/build/card/deck-init-v4/deck-init-v4.demo.zkey.provenance.json`,
    ]) {
      const response = await app.inject({ method: 'GET', url })
      expect(response.statusCode, url).toBe(404)
    }
  })

  it('rejects a write to an artifact route', async () => {
    const root = circuitsRoot()
    seed(root)
    write(root, 'build/card/deck-init-v4/deck-init-v4.wasm', WASM)
    const app = await serve(root)
    const response = await app.inject({
      method: 'POST',
      url: `${CARD_ARTIFACT_ROUTE_PREFIX}/build/card/deck-init-v4/deck-init-v4.wasm`,
      payload: {},
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('card circuit discovery on /config', () => {
  it('is omitted when the coordinator publishes no lock', () => {
    expect(buildCardCircuitsConfigSection(config(circuitsRoot()))).toBeNull()
  })

  it('publishes a url, a length and a digest per file, and says what is missing', () => {
    const root = circuitsRoot()
    seed(root)
    write(root, 'card-vkeys/deck-init-v4.demo.vkey.json', VKEY)
    const section = buildCardCircuitsConfigSection(config(root))!
    expect(section.lockUrl).toBe(`${CARD_ARTIFACT_ROUTE_PREFIX}/${CARD_ARTIFACT_LOCK_FILE}`)
    expect(section.ceremony).toBe('uncontributed-demo-only')
    // Neither the wasm nor the zkey was built here, so a browser is told not to
    // start a 25 MB download it cannot finish.
    expect(section.provingArtifactsAvailable).toBe(false)
    const files = section.files as Array<Record<string, unknown>>
    expect(files).toHaveLength(3)
    expect(files.find((file) => file.kind === 'vkey')?.available).toBe(true)
    expect(files.find((file) => file.kind === 'zkey')?.available).toBe(false)
    expect(files.every((file) => String(file.url).startsWith(CARD_ARTIFACT_ROUTE_PREFIX))).toBe(true)
    expect(files.every((file) => /^[0-9a-f]{64}$/.test(String(file.sha256)))).toBe(true)
  })

  it('reports the proving set available once every non-vkey file exists', () => {
    const root = circuitsRoot()
    seed(root)
    write(root, 'build/card/deck-init-v4/deck-init-v4.wasm', WASM)
    write(root, 'build/card/deck-init-v4/deck-init-v4.demo.zkey', ZKEY)
    expect(buildCardCircuitsConfigSection(config(root))!.provingArtifactsAvailable).toBe(true)
  })

  it('does not take /config down when the lock is malformed', () => {
    const root = circuitsRoot()
    seed(root, lockDocument({ format: 'wrong' }))
    expect(buildCardCircuitsConfigSection(config(root))).toBeNull()
  })
})

describe('the repository lock is servable as published', () => {
  it('derives exactly the four proving files plus two verifying keys', () => {
    const routes = cardArtifactRoutes(fileURLToPath(new URL('../../../web3-protocol/circuits/', import.meta.url)))
    expect(routes.map((route) => `${route.circuit}:${route.kind}`).sort()).toEqual([
      'deck-init-v4:vkey',
      'deck-init-v4:wasm',
      'deck-init-v4:zkey',
      'hand-action-v4:vkey',
      'hand-action-v4:wasm',
      'hand-action-v4:zkey',
    ])
    const total = routes
      .filter((route) => route.kind !== 'vkey')
      .reduce((sum, route) => sum + route.bytes, 0)
    expect(total).toBe(25_559_618)
  })

  /**
   * Every other case here serves synthetic bytes out of a temporary directory.
   * This one serves the REAL artifacts out of the repository, so the whole
   * distribution chain - lock, allow-list, route, byte-length gate, digest - is
   * exercised against the files a browser will actually receive.
   *
   * `circuits/build/card/**` is gitignored, so it runs only where
   * `pnpm --filter @zkdeal/circuits build:card` has run (a developer machine and
   * the coordinator image, which copies `circuits/build`). It skips elsewhere
   * rather than degrading into a weaker assertion.
   */
  const repository = fileURLToPath(new URL('../../../web3-protocol/circuits/', import.meta.url))
  const repositoryRoutes = cardArtifactRoutes(repository)
  const builtHere = repositoryRoutes.every((route) =>
    existsSync(join(repository, route.path)),
  )

  it.skipIf(!builtHere)('serves the real artifacts byte for byte at their pinned digest', async () => {
    const app = await serve(repository)
    for (const route of repositoryRoutes) {
      const response = await app.inject({
        method: 'GET',
        url: `${CARD_ARTIFACT_ROUTE_PREFIX}/${route.path}`,
      })
      expect(response.statusCode, route.path).toBe(200)
      const body = response.rawPayload
      expect(body.length, route.path).toBe(route.bytes)
      expect(createHash('sha256').update(body).digest('hex'), route.path).toBe(route.sha256)
    }
    // And the trust root itself, which the browser fetches before anything else.
    const lock = await app.inject({
      method: 'GET',
      url: `${CARD_ARTIFACT_ROUTE_PREFIX}/${CARD_ARTIFACT_LOCK_FILE}`,
    })
    expect(lock.statusCode).toBe(200)
    expect((lock.json() as { format: string }).format).toBe(CARD_ARTIFACT_LOCK_FORMAT)
    expect(buildCardCircuitsConfigSection(config(repository))?.provingArtifactsAvailable).toBe(true)
  })

  it.skipIf(builtHere)('reports which artifact is unbuilt instead of pretending', async () => {
    // Reached on a clean clone or CI runner. `provingArtifactsAvailable` must be
    // false there, so a browser is told before it starts a 25 MB download.
    expect(buildCardCircuitsConfigSection(config(repository))?.provingArtifactsAvailable).toBe(false)
    const app = await serve(repository)
    const absent = repositoryRoutes.find((route) => !existsSync(join(repository, route.path)))!
    const response = await app.inject({
      method: 'GET',
      url: `${CARD_ARTIFACT_ROUTE_PREFIX}/${absent.path}`,
    })
    expect(response.statusCode).toBe(404)
    expect((response.json() as { remedy: string }).remedy).toContain('build:card')
  })
})
