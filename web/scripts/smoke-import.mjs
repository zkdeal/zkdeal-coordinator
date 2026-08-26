/**
 * Source-level regression guards for prior review findings.
 *
 * These are cheap greps and deliberately weaker than the real gates - the
 * authoritative checks are `scripts/assert-bundle.mjs` (built output) and
 * `vitest run` (behaviour). They exist to catch an obvious re-introduction
 * early, and they run as the first step of `pnpm --filter web build` so a
 * failure is visible instead of theoretical.
 *
 * Run: node scripts/smoke-import.mjs  (from web/)
 */
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

const clientSrc = read('../lib/room-client.ts')
for (const sym of [
  'createBrowserNode',
  'RoomChannel',
  'CheckpointCollector',
  'startSequencer',
  'electSequencer',
  'buildWitnessInput',
  'formatForSolidity',
  'approveGenesis',
  'submitCheckpoint',
  'finalize',
  'claim',
  'restoreFromCoordinator',
]) {
  if (!clientSrc.includes(sym)) throw new Error(`RoomClient missing ${sym}`)
}

const storeSrc = read('../lib/rooms-store.tsx')
if (storeSrc.includes('makeSeedRooms') || storeSrc.includes('BroadcastChannel')) {
  throw new Error('rooms-store still uses mock seed / BroadcastChannel')
}
if (!storeSrc.includes('fetchRooms')) throw new Error('rooms-store must list via fetchRooms')

// C-01: the test-hook module must only be reachable through the flag-gated
// dynamic import, never a static one, and must expose no private-key getter.
if (/^\s*import\s+\{[^}]*installZkdealTestHooks/m.test(storeSrc)) {
  throw new Error('rooms-store statically imports test-hooks - it must be a flag-gated import()')
}
if (!storeSrc.includes('__ZKDEAL_TEST_HOOKS__')) {
  throw new Error('rooms-store must gate test hooks on the __ZKDEAL_TEST_HOOKS__ build constant')
}
const hooksSrc = read('../lib/test-hooks.ts')
if (/getBurnerKey|loadOrCreateBurnerPrivateKey/.test(hooksSrc)) {
  throw new Error('test-hooks must not expose any private-key read-back path')
}

// H-01: no fabricated ABI results, no hard-coded `fn()` signature.
const abiCardSrc = read('../components/room/abi-function.tsx')
if (/randomHex|mockOutput|Math\.random/.test(abiCardSrc)) {
  throw new Error('abi-function must not synthesise outputs or transaction hashes')
}
if (/`\$\{fn\}\(\)`/.test(storeSrc)) {
  throw new Error('submitCall must use the canonical ABI signature, not fn()')
}

/*
 * H-03: every room-scoped wrapper must go through the attachment guard.
 *
 * The previous form searched for `async (_id: string` and could never match -
 * the only underscore-prefixed callback in the store (`addLiquidity`) is a
 * deliberate no-op and is not async. Assert the invariant positively instead:
 * each room-scoped wrapper opens with `requireAttachedRoom(id)`.
 */
if (!storeSrc.includes('requireAttachedRoom')) {
  throw new Error('rooms-store must assert attached-room identity before room-scoped actions')
}
for (const name of [
  'sealRoom',
  'finalizeRoom',
  'claimRoom',
  'abortRoom',
  'approveGenesis',
  'openRoom',
  'restoreSnapshot',
  'submitCall',
]) {
  const guarded = new RegExp(
    `const ${name} = useCallback\\(\\s*async \\(id: string[^)]*\\) => \\{\\s*requireAttachedRoom\\(id\\)`,
  )
  if (!guarded.test(storeSrc)) {
    throw new Error(`rooms-store.${name} must call requireAttachedRoom(id) before acting`)
  }
}

/*
 * H1 / L2 (web review): the only shipped route that moves value. The room
 * creation payload must come from the tested pure module - the console once
 * fabricated `initialParticipantRoot` inline and bricked every room it paid
 * for - and a reverted receipt must never be reported as a started room.
 */
const poolSrc = read('../components/room-pool-console.tsx')
if (!poolSrc.includes("from '@/lib/room-pool-creation'")) {
  throw new Error('room-pool-console must build RoomCreation via lib/room-pool-creation')
}
if (/initialParticipantRoot\s*:/.test(poolSrc)) {
  throw new Error('room-pool-console must not construct the participant commitment inline')
}
if (!poolSrc.includes("receipt.status !== 'success'")) {
  throw new Error('room-pool-console must reject a reverted receipt instead of reporting success')
}

console.log('smoke-import: OK')
console.log('  RoomClient wires p2p + engine + prover + L1 claim path')
console.log('  rooms-store: live coordinator registry (no mock seeds)')
console.log('  test hooks: flag-gated dynamic import, no key getter')
console.log('  abi explorer: no synthesised results; room-scoped actions guarded')
console.log('  room-pool console: derived creation payload, receipt status checked')
