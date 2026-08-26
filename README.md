# web2-api

This folder is every HTTP surface a browser or operator touches. The Fastify
coordinator (`server/`) exposes the read-only room observer API - latest
state, batches, blocks, transactions, approvers, deposits, withdrawals, and a
live stream, all reconstructed from proven room history (`/rooms/*`
today). It never invents data: if a public batch envelope is unavailable, the
API reports `L1_COMMITMENTS_ONLY` rather than synthesizing transactions from
an accepted root. Alongside observation it carries the operator admission
API (signing an admission receipt commits the room service bond, so the route
authenticates every caller and refuses to start half-configured), a
local-only demo control plane under `/demo/v1/*`, and lock-allow-listed
artifact serving for the card circuits and zkVM outputs. A shared prove-queue
service, letting multiple provers pull work from one coordinator, is planned
and being added.

The console (`web/`) is a statically exported Next.js app: the room-pool
journey that opens a managed room through the customer's wallet, the
presentation demo views, and the hidden-card duel - which proves deck
initialization and every hand action in the browser, so this server never
sees a deck order, a salt, or a hand. The build asserts its own bundle
hygiene: test hooks are compile-time-eliminated and a script verifies the
emitted output.

The server is deliberately conservative at the edges: fail-closed config
validation at startup, an exposure guard that refuses to bind a non-loopback
interface with dev-only features (faucet, unsigned writes, permissive CORS)
enabled on a real chain, and per-IP metering on public reads.

## L1 finality and coordinator recovery

`L1_ACCEPTED` means included, not final. A checkpoint becomes final settlement
only after its receipt's block number and hash still match the canonical block
at or below Ethereum's `finalized` checkpoint. Until then the room is labelled
provisional/reorgable and no external settlement may depend on it.

The coordinator retains the exact calldata for its settlement and import
transactions, re-checks provisional receipts, and resubmits unchanged calldata
if an inclusion disappears while the proved deadline remains open. Reorg
handling may retract a provisional status and un-stamp its moves so the same
checkpoint can be recovered. Deposit-indexer facts must include block number
and block hash; the coordinator verifies those facts against its own L1 view
before signing an admission receipt.

## Quickstart

Docker Desktop must be running. No host toolchain is needed.

```bash
cd web2-api
docker compose run --rm build   # server typecheck + web lint/typecheck/next build + bundle assertions
docker compose run --rm test    # server and web vitest suites
docker compose run --rm run     # coordinator + console on :3000, libp2p relay on :9001
```

`run` serves the console from `web/out` and expects sibling artifacts for
full functionality (see below); every sibling path can be redirected by
environment variable.

## How it connects

Consumes, via `link:` dependencies:

- `server/package.json`: `@zkdeal/p2p`, `@zkdeal/protocol`, `@zkdeal/zkvm`
  from `../app-node/packages/*`;
- `web/package.json`: those plus `@zkdeal/l2-engine`, `@zkdeal/prover`,
  `@zkdeal/room-client` from `app-node`, and `@zkdeal/card` from
  `../apps-examples/packages/card`.

Consumes, via path defaults in `server/src/config.ts` (each relative to
`UMBRELLA_ROOT`, the parent of this folder, and each overridable by the env
var named):

- `web3-protocol/contracts` - `CONTRACTS_ROOT`, `CONTRACTS_OUT`,
  `SCENARIOS_PATH`;
- `web3-protocol/circuits` - `CIRCUITS_ROOT`, `ARTIFACTS_ROOT` (served card
  artifacts, allow-listed against `card-artifacts.lock.json`);
- `prover-node/zkvm` - `ZKVM_ARTIFACTS_ROOT` (served under
  `/artifacts/zkvm/`), `ZKVM_LOCK_PATH` (source of program digests for
  `/config`).

Produced for siblings: the coordinator container image
(`server/Dockerfile`, built with the umbrella root as context) is what
`kurtosis-testing` runs as the control plane of the acceptance stack; the
demo control plane it exposes is what the bench runner drives.

## Layout

| Path | Contents |
| --- | --- |
| `server/` | Fastify coordinator: route modules under `src/` (observer, admission, demo control plane, artifact and RPC surfaces), `src/config.ts` (fail-closed config + exposure guard), `data/` runtime state, `Dockerfile`, vitest suites. See `server/README.md` for the full route list. |
| `web/` | Next.js console: `app/` routes, `components/`, static export to `out/`, `scripts/` build assertions (`smoke-import`, `assert-bundle`, `serve-out`), vitest suites. |
| `AUDIT-EXCEPTIONS.md` | Triaged dependency-advisory ledger for this folder's lockfile. |
