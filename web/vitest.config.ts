import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/*
 * Unit tests for web's pure logic modules.
 *
 * Component/browser coverage would need a DOM harness that is not part of this
 * package's dependency set - which is why logic that ships on a route is
 * extracted into a React-free module rather than left inline in a component:
 * lib/room-pool-creation.ts (the RoomCreation payload), lib/kurtosis-stories.ts
 * (the imported-trace trust boundary), lib/demo-console.ts (formatting plus the
 * explorer-URL allowlist), lib/demo-system.ts (the coordinator reading every
 * page takes its explorer root from), lib/l1-receipt.ts (the rule that a hash
 * is either complete and linked or reported as unlookupable) and
 * lib/applications/* (the two application autoplays on /applications) are all routed
 * code covered here.
 *
 * lib/abi-encode.ts, lib/l1-errors.ts and lib/room-scope.ts are not currently
 * reachable from any route; their suites stay only while those modules do.
 * lib/shop-demo.ts joined them when /applications stopped modelling a shop and
 * started opening a real one.
 *
 * The `card-*` suites cover /card-duel, where that split is the design rather
 * than a convenience: the duel rules, the calldata encoding, the artifact gate
 * and the privacy boundary all live in React-free modules under lib/card/, so
 * a whole duel can be driven headless and the bytes it publishes audited
 * against real witness material. `card-privacy` and `card-vault-boundary` are
 * the two suites that would have to be weakened for hidden material to reach
 * the wire.
 */
export default defineConfig({
  // The `@/` alias tsconfig defines, so a routed module that reaches the demo
  // control plane can be imported here as it is rather than being duplicated
  // for testability. `card-room-settlement` uses it to drive the real
  // `lib/card/demo-room` transport against a stubbed `fetch` and audit the
  // exact request body a move produces.
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
