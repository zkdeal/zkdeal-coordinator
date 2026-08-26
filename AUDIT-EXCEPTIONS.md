# Dependency audit exceptions

Gate: `pnpm audit --prod --audit-level=high` (CI job `audit`, required).

Anything listed here is an advisory that is **known, reachable-unknown, and not
currently fixed**. An entry is not a dismissal - it is a dated debt with an
owner. CI does not read this file; it exists so a reviewer can tell "triaged"
from "ignored".

## Resolved via root `pnpm.overrides`

| Advisory | Package | Path | Override |
| --- | --- | --- | --- |
| [GHSA-qpx9-hpmf-5gmw](https://github.com/advisories/GHSA-qpx9-hpmf-5gmw) (high) | `underscore` | `circuits > snarkjs > bfj > jsonpath > underscore` | `underscore: ^1.13.8` |
| [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p) (high) | `ws` | `circuits > circomlibjs > ethers > @ethersproject/providers > ws` | `ws: ^8.21.0` |
| [GHSA-…](https://github.com/advisories) ws uninitialized memory (moderate) | `ws` | same path | covered by the same `ws: ^8.21.0` |
| PostCSS `</style>` XSS (moderate) | `postcss` | `web > next > postcss` | `postcss: ^8.5.10` |

> The lockfile was regenerated on 2026-07-25 (`pnpm install --lockfile-only`,
> also required by the removal of the `tests/e2e` workspace) and
> `pnpm install --frozen-lockfile` now succeeds. The four overrides above are
> resolved: none of `underscore`, `ws` or `postcss` appears in the current
> `--prod` advisory set.

## Closed 2026-07-26 - the eight high advisories that used to make `audit` RED

All eight are now **fixed**, not excepted, via root `pnpm.overrides` plus a
lockfile regeneration. None of them required editing a workspace
`package.json`. Versions below are the ones the lockfile now resolves.

| Advisory | Package | Was → now | Path root | Override added |
| --- | --- | --- | --- | --- |
| [GHSA-83w8-p2f5-377r](https://github.com/advisories/GHSA-83w8-p2f5-377r) (high, CVE-2026-15074) route guard bypass via path traversal | `@fastify/static` | 10.1.0 → 10.1.2 | `server` | `"@fastify/static": "^10.1.2"` |
| [GHSA-c96f-x56v-gq3h](https://github.com/advisories/GHSA-c96f-x56v-gq3h) (high) DDoS with HTTP/2 | `find-my-way` | 9.6.0 → 9.7.0 | `server > fastify` | `"find-my-way": "^9.7.0"` |
| [GHSA-89xv-2m56-2m9x](https://github.com/advisories/GHSA-89xv-2m56-2m9x) (high, CVE-2026-64649) SSRF in Server Actions on custom servers | `next` | 16.2.6 → 16.2.11 | `web` | `"next": "16.2.11"` |
| [GHSA-p9j2-gv94-2wf4](https://github.com/advisories/GHSA-p9j2-gv94-2wf4) (high, CVE-2026-64645) SSRF in rewrites | `next` | same | `web` | same |
| [GHSA-6gpp-xcg3-4w24](https://github.com/advisories/GHSA-6gpp-xcg3-4w24) (high, CVE-2026-64642) middleware / proxy bypass | `next` | same | `web` | same |
| [GHSA-m99w-x7hq-7vfj](https://github.com/advisories/GHSA-m99w-x7hq-7vfj) (high, CVE-2026-64641) DoS in App Router using Server Actions | `next` | same | `web` | same |
| [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj) (high) inherited libvips vulnerabilities | `sharp` | 0.34.5 → 0.35.3 | `web > next` (optional dep) | `"sharp": "^0.35.3"` |
| [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) (high, CVE-2026-14257) DoS via unbounded expansion | `brace-expansion` | 2.1.2 + 5.0.7 → 5.0.8 | `circuits/card/prover/web > snarkjs > ejs > jake > filelist > minimatch@5`; `server > @fastify/static > glob > minimatch@10` | `"brace-expansion@^5.0.0": "^5.0.8"` **and** `"minimatch@^5.0.0": "^10.2.5"` |

Notes a reviewer needs:

- The advisory range for `brace-expansion` is a bare `<=5.0.7`, so it covers the
  2.x line as well and **only 5.0.8 is clean** - there is no 2.x backport. The
  `brace-expansion` override is therefore range-scoped (`@^5.0.0`) so that the
  dev-only `eslint > minimatch@3 > brace-expansion@1.1.16` path keeps a v1 that
  it can still `require()` as a callable. `brace-expansion@5` is dual
  ESM/CJS and exports a *named* `expand`, so forcing it onto `minimatch@3`/`@5`
  would break them at runtime. The 2.x copy is instead removed from the graph by
  lifting its only consumer, `filelist`'s `minimatch@5.1.9`, to `minimatch@10`
  (which already consumes `brace-expansion@^5`); `filelist` only calls
  `minimatch.match`, which `minimatch@10` still exports.
- `next@16.2.11` declares `sharp@^0.34.5` as an optional dependency, so the
  `sharp: ^0.35.3` override deliberately steps outside that range. `sharp`'s
  public API is unchanged across 0.34 → 0.35; the change is the bundled libvips.
- `hono` was moved from `4.12.25` to `4.12.27` at the same time; it is not part
  of the high set, but the older pin had picked up three fresh moderates.

## Open, unfixed

### `elliptic` - "Uses a Cryptographic Primitive with a Risky Implementation" (low)

- Path: `circuits > circomlibjs > ethers > @ethersproject/signing-key > elliptic`
- Advisory patched versions: **none** (`<0.0.0`). There is no version of
  `elliptic` that resolves it, so no override can fix this.
- Only fix available: drop the ethers v5 dependency, i.e. upgrade or replace
  `circomlibjs`. That is a breaking change to `circuits/package.json`, which is
  owned elsewhere.
- Reachability: **not established**. `circomlibjs` is used for Poseidon/EdDSA in
  circuit fixture generation and build tooling; the `elliptic` code path arrives
  via `@ethersproject/signing-key`, which this repository does not knowingly
  call. This has not been proven, and the dependency is currently classified as
  a **production** dependency of the `circuits` workspace, so the classification
  itself is part of the problem.
- Required follow-up (other owners):
  1. `circuits/package.json` - move `snarkjs`/`circomlibjs` to
     `devDependencies` if they are build-time only, which removes four of the
     five advisories from the `--prod` graph outright.
  2. If they must stay production, upgrade `circomlibjs` past its ethers v5
     dependency and re-run the circuit/prover tests against the resolved graph.

### `@hono/node-server` - path traversal in `serve-static` on Windows (moderate)

- [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9),
  vulnerable `<2.0.5`, installed `1.19.14`.
- Path: `web > shadcn > @hono/node-server`.
- Below the `--audit-level=high` gate, so it does not fail CI; it is the only
  remaining moderate in the `--prod` set.
- Not fixed here because the only fix is a **major** bump (1.x → 2.x) of a
  transitive dependency of the `shadcn` CLI. That is not a same-class override:
  it changes the API `shadcn` compiles against. The real fix is to stop shipping
  the `shadcn` CLI as a production dependency of `web` - it is a scaffolding
  tool, not a runtime one - which is a `web/package.json` change.

## State of the gate on 2026-07-26

`--prod` advisory set after the overrides above: **0 critical, 0 high, 1
moderate** (`@hono/node-server`), **1 low** (`elliptic`). The required
`pnpm audit --prod --audit-level=high` job passes; the informational
`--audit-level=moderate` step reports the two entries above.
