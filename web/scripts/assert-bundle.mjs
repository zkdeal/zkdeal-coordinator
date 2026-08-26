#!/usr/bin/env node
/**
 * Build-output assertion: the shipped static export must contain no test /
 * debug surface.
 *
 * `window.__zkdeal` is a live privileged RoomClient (L1 lifecycle,
 * checkpoint signing, raw client). Historically it - and a `getBurnerKey`
 * getter returning the plaintext localStorage private key - survived into the
 * optimized production bundle, giving any same-origin script a stable
 * key-exfiltration and control API.
 *
 * The hooks are now behind a build-time flag whose dynamic import is
 * dead-code-eliminated. This script proves that elimination actually happened
 * instead of trusting the bundler, and is wired into `pnpm --filter web build`.
 *
 * Contract:
 *   always                                 -> FORBIDDEN_CLAIMS must be absent
 *                                             from the output AND from tracked
 *                                             source (see below)
 *   NEXT_PUBLIC_ENABLE_TEST_HOOKS !== '1'  -> FORBIDDEN_SYMBOLS must be absent
 *                                             and REQUIRED_CLAIMS[set] present
 *   NEXT_PUBLIC_ENABLE_TEST_HOOKS === '1'  -> REQUIRED symbols must be present
 *                                             (so e2e cannot silently lose them)
 *
 * Usage: node scripts/assert-bundle.mjs [outDir]
 * Env:   ZKDEAL_WEB_CLAIM_SET selects the required-claim list (default room-studio).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const outDir = process.argv[2] ? join(process.cwd(), process.argv[2]) : join(webRoot, 'out')

/**
 * Test/debug symbols that must never exist in a shipped bundle.
 *
 * These legitimately exist in tracked source (`lib/test-hooks.ts` and the
 * flag-gated import that reaches it), so they are asserted on the emitted
 * output only - that is exactly what the kill switch is being measured on.
 */
const FORBIDDEN_SYMBOLS = ['__zkdeal', 'getBurnerKey', 'installZkdealTestHooks']
/**
 * Retired claims that must exist NOWHERE: neither in the emitted output nor
 * in tracked source.
 *
 * Scanning only the output made this half of the gate a statement about which
 * modules happen to be reachable rather than about the repository - all of
 * these still existed verbatim in web/ source and passed purely because their
 * modules were never emitted, so restoring any orphaned route would have
 * failed the build on copy nobody had removed. Compared case-insensitively:
 * the marker was written as 'Deal channels' while every occurrence of the copy
 * it targets is lower-case, so it could never match and printed "absent"
 * either way.
 */
const FORBIDDEN_CLAIMS = [
  'SNARK settlement certificate',
  'Groth16 settlement',
  'deal channels',
  '≤16×500ms',
]
/** Symbols e2e depends on; must exist when the flag is on. */
const REQUIRED = ['__zkdeal']
/**
 * Honest framing that must survive into the public production export, keyed by
 * the generation the landing page presents.
 *
 * A single hard-coded list meant replacing the landing page was a build
 * failure, so a content gate structurally blocked a generation change. A new
 * landing page adds its own key here and sets ZKDEAL_WEB_CLAIM_SET, which
 * makes the swap a declaration instead of a deletion.
 *
 * The retired v4 list was removed with the v4 landing page it described: a
 * claim set nothing can select is not a gate, and leaving it would let a
 * stale ZKDEAL_WEB_CLAIM_SET=v4 pass a build whose copy no longer exists.
 */
const REQUIRED_CLAIMS = {
  'room-studio': [
    'proof-backed long-lived rooms',
    'CURRENT OPERATIONAL CLAIM',
    'validity-only authorization',
    'GPU / L1 LATENCY GATE',
    'NOT REQUALIFIED',
  ],
}
const claimSet = process.env.ZKDEAL_WEB_CLAIM_SET ?? 'room-studio'

const hooksEnabled = process.env.NEXT_PUBLIC_ENABLE_TEST_HOOKS === '1'

/** Text assets that can carry emitted JavaScript. */
const SCAN_EXT = ['.js', '.mjs', '.cjs', '.html', '.json', '.txt', '.map']
/** Tracked source that can carry user-visible copy. */
const SOURCE_EXT = ['.ts', '.tsx', '.js', '.mjs', '.css', '.json', '.md']
/** Never walked as source: build output, dependencies and this file itself. */
const SOURCE_SKIP_DIRS = new Set(['node_modules', '.next', 'out', 'coverage'])
const SELF = fileURLToPath(import.meta.url)

function walk(dir, extensions = SCAN_EXT, skipDirs = null) {
  let files = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return files
  }
  for (const name of entries) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (skipDirs?.has(name)) continue
      files = files.concat(walk(full, extensions, skipDirs))
    } else if (extensions.some((e) => name.endsWith(e)) && full !== SELF) {
      files.push(full)
    }
  }
  return files
}

let ok = true
try {
  if (!statSync(outDir).isDirectory()) throw new Error('not a directory')
} catch {
  console.error(`assert-bundle: FAIL - build output not found at ${outDir}`)
  console.error('  run `next build --webpack` first (output: export writes web/out)')
  process.exit(1)
}

const files = walk(outDir)
if (files.length === 0) {
  console.error(`assert-bundle: FAIL - no scannable files under ${outDir}`)
  process.exit(1)
}

const requiredClaims = REQUIRED_CLAIMS[claimSet]
if (!requiredClaims) {
  console.error(
    `assert-bundle: FAIL - unknown ZKDEAL_WEB_CLAIM_SET "${claimSet}" ` +
      `(known: ${Object.keys(REQUIRED_CLAIMS).join(', ')})`,
  )
  process.exit(1)
}

const sourceFiles = walk(webRoot, SOURCE_EXT, SOURCE_SKIP_DIRS)
const markers = [...FORBIDDEN_SYMBOLS, ...FORBIDDEN_CLAIMS, ...requiredClaims]
const hits = new Map(markers.map((s) => [s, []]))
const sourceHits = new Map(FORBIDDEN_CLAIMS.map((s) => [s, []]))

/** One read per file: every marker is matched from the same buffer. */
function scan(fileList, syms, sink, base) {
  for (const file of fileList) {
    const text = readFileSync(file, 'utf8')
    const lower = text.toLowerCase()
    for (const sym of syms) {
      // Claims are copy, so they are matched case-insensitively; symbols are
      // identifiers and must be matched exactly.
      const found = FORBIDDEN_CLAIMS.includes(sym)
        ? lower.includes(sym.toLowerCase())
        : text.includes(sym)
      if (found) sink.get(sym).push(relative(base, file))
    }
  }
}

scan(files, markers, hits, outDir)
scan(sourceFiles, FORBIDDEN_CLAIMS, sourceHits, webRoot)

console.log(
  `assert-bundle: scanned ${files.length} files in ${relative(webRoot, outDir) || outDir} ` +
    `plus ${sourceFiles.length} tracked source files ` +
    `(NEXT_PUBLIC_ENABLE_TEST_HOOKS=${process.env.NEXT_PUBLIC_ENABLE_TEST_HOOKS ?? '<unset>'}, ` +
    `ZKDEAL_WEB_CLAIM_SET=${claimSet})`,
)

/** Retired claims are forbidden in every build, hooks or not. */
for (const sym of FORBIDDEN_CLAIMS) {
  const where = [...hits.get(sym), ...sourceHits.get(sym).map((f) => `source: ${f}`)]
  if (where.length) {
    console.error(`assert-bundle: FAIL - retired claim "${sym}" found in ${where.length} file(s):`)
    for (const f of where.slice(0, 10)) console.error(`    ${f}`)
    ok = false
  } else {
    console.log(`  ok: "${sym}" absent from bundle and source`)
  }
}

if (hooksEnabled) {
  for (const sym of REQUIRED) {
    if (!hits.get(sym).length) {
      console.error(`assert-bundle: FAIL - test-hook build is missing required symbol "${sym}"`)
      ok = false
    } else {
      console.log(`  ok: "${sym}" present (test-hook build)`)
    }
  }
} else {
  for (const sym of FORBIDDEN_SYMBOLS) {
    const where = hits.get(sym)
    if (where.length) {
      console.error(
        `assert-bundle: FAIL - forbidden symbol "${sym}" found in ${where.length} file(s):`,
      )
      for (const f of where.slice(0, 10)) console.error(`    ${f}`)
      ok = false
    } else {
      console.log(`  ok: "${sym}" absent`)
    }
  }
  for (const marker of requiredClaims) {
    if (!hits.get(marker).length) {
      console.error(`assert-bundle: FAIL - ${claimSet} marker "${marker}" is missing`)
      ok = false
    } else {
      console.log(`  ok: ${claimSet} marker "${marker}" present`)
    }
  }
}

if (!ok) {
  console.error('assert-bundle: production bundle assertion FAILED')
  process.exit(1)
}
console.log('assert-bundle: OK')
