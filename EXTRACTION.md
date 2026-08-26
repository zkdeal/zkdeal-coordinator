# Extracting `web2-api/` into its own repository

## 1. Carve out the history

```bash
git filter-repo --subdirectory-filter web2-api
# or: git subtree split -P web2-api -b web2-api-only
```

The folder already carries its own `package.json`, `pnpm-workspace.yaml`
(members: `server`, `web`), `pnpm-lock.yaml`, `tsconfig.base.json`,
`.gitattributes`, `.gitignore` and `AUDIT-EXCEPTIONS.md`.

## 2. Sibling references to resolve

Outgoing `link:` dependencies (ten in total) that must become published npm
packages or explicit side-by-side checkouts:

| Package | `link:` deps |
| --- | --- |
| `server/package.json` | `@zkdeal/p2p`, `@zkdeal/protocol`, `@zkdeal/zkvm` → `../../app-node/packages/*` |
| `web/package.json` | `@zkdeal/card` → `../../apps-examples/packages/card`; `@zkdeal/l2-engine`, `@zkdeal/p2p`, `@zkdeal/protocol`, `@zkdeal/prover`, `@zkdeal/room-client`, `@zkdeal/zkvm` → `../../app-node/packages/*` |

All linked packages export TypeScript source (`"main": "./src/index.ts"`);
the console lists every one in `next.config.mjs` `transpilePackages` and the
server runs them through `tsx`/vitest. Publishing them to npm requires a
build step upstream in `app-node`/`apps-examples` first; a pinned-commit
checkout beside this repo preserves the current arrangement unchanged.

Outgoing path defaults - `server/src/config.ts` resolves cross-folder
defaults against `UMBRELLA_ROOT` (the parent directory of this folder).
**Every one is env-overridable**, so a standalone deployment redirects them
without code changes:

| Env var | Default (relative to the umbrella) |
| --- | --- |
| `CONTRACTS_ROOT` | `web3-protocol/contracts` |
| `CONTRACTS_OUT` | `web3-protocol/contracts/out` |
| `SCENARIOS_PATH` | `web3-protocol/contracts/scenarios.json` |
| `CIRCUITS_ROOT` | `web3-protocol/circuits` |
| `ARTIFACTS_ROOT` | `web3-protocol/circuits/build` |
| `ZKVM_ARTIFACTS_ROOT` | `prover-node/zkvm/build` |
| `ZKVM_LOCK_PATH` | `prover-node/zkvm/artifacts.lock.json` |

In-folder paths (`DATA_DIR`, `ADDRESSES_PATH`, `WEB_ROOT`) resolve against
the folder itself and need no change.

Incoming couplings to keep working:

- `kurtosis-testing/scripts/build-docker-images.*` builds the coordinator
  image from `web2-api/server/Dockerfile` **with the umbrella root as build
  context** - the Dockerfile COPYs sibling folders' artifacts into the image.
  A standalone repo must either keep a side-by-side checkout for image
  builds, or rework the Dockerfile to consume published packages and a
  fetched artifact bundle.
- `apps-examples/smoke-erc7540-demo.mjs` drives a running coordinator purely
  over HTTP (base URL argument); no checkout coupling.

## 3. Files that must ride along

- `.gitattributes` - the LF policy. The server hashes and serves lock-pinned
  artifacts; the lock files it *reads* live in sibling repos, but its own
  test fixtures and the audit gate assume LF.
- `pnpm-lock.yaml` + `AUDIT-EXCEPTIONS.md` + the `pnpm.overrides` /
  `onlyBuiltDependencies` blocks in `package.json` - the audit gate and its
  triage ledger travel together.
- `server/Dockerfile` and `server/data/` seed layout - the kurtosis stack's
  expectations about the image are documented against these.

## 4. CI the standalone repo needs

| Job | Command | Notes |
| --- | --- | --- |
| build | `docker compose run --rm build` | server `tsc --noEmit`; web `eslint` + `tsc` + `next build --webpack` + `assert-bundle` (the `--webpack` pin is deliberate - see `next.config.mjs`) |
| test | `docker compose run --rm test` | server + web vitest |
| run smoke | `docker compose run --rm run` (+ probe) | optional: boot and hit `/config`; full function needs sibling artifacts or env overrides |
| audit | `pnpm audit --prod --audit-level=high` | pair with `AUDIT-EXCEPTIONS.md` |

No GPU required. Integration against a real prover and L1 belongs to the
`kurtosis-testing` repo, not here.
