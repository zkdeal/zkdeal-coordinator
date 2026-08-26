# @zkdeal/server

The zkdeal **room observer and coordinator transport**, which also carries a
local-only demo control plane.

`/rooms/*` is the room surface (the retired `/v5/*` prefix answers 404). `/legacy/v3/*` is permanently `410`, and the
retired `/v4/*` proof, preset and recovery routes are gone entirely (`404`).

```text
# room observation (unauthenticated reads, per-IP metered)
GET  /rooms/:id                      GET  /rooms/:id/state
GET  /rooms/:id/latest               GET  /rooms/:id/machine
GET  /rooms/:id/approvers            GET  /rooms/:id/admissions
GET  /rooms/:id/forced-transactions  GET  /rooms/:id/applications
GET  /rooms/:id/imports              GET  /rooms/:id/deposits
GET  /rooms/:id/withdrawals          GET  /rooms/:id/batches
GET  /rooms/:id/blocks               GET  /rooms/:id/transactions
GET  /rooms/:id/stream               (SSE)

# admission (operator credential required - see "Admission")
POST /rooms/:id/transactions
POST /rooms/:id/pending-transactions

# generic
GET  /health   GET  /config   POST /rpc   POST /faucet
GET  /artifacts/contracts.json            GET  /artifacts/zkvm/*

# local demo control plane, only when DEMO_ENABLED=1 on loopback/dev chain
GET|POST /demo/v1/*                       GET /demo/v1/stream (SSE)
```

Observer reads take collections through `?cursor=&limit=` (limit default 25,
max 100). A cursor past the end of a collection answers `400 INVALID_CURSOR`
rather than silently restarting at page 0. Room ids must be canonical non-zero
uint64 decimals; anything else is `400 INVALID_ROOM`.

`/rooms/:id/stream` emits **one** event type, `event: room`, carrying the
same redacted object as `GET /rooms/:id`, plus `: keep-alive` comment frames.
It does **not** carry per-admission, forced-transaction, proof or claim events -
an admission receipt is returned in the `POST /rooms/:id/transactions`
response, not on the stream. Concurrent subscribers are capped per room
(`503 STREAM_SATURATED`) and a subscriber that stops draining is dropped rather
than buffered.

> `GET /health` and `GET /config` report `protocolVersion: 4` from
> `@zkdeal/protocol`, while `contracts/src/RoomTypes.sol` declares
> `PROTOCOL_VERSION = 6`. The `@zkdeal/protocol` constant is a **frozen signed-
> encoding generation** - a keccak preimage input to `deploymentDomainDigest` -
> not the batch-settlement protocol version. Current envelopes remain generation
> 4; batch journals and RoomManager EIP-712 signatures are version 6. Treat
> `/config.protocolVersion` as the encoding generation only.

The observation archive is a public index written by an external indexer; it
is not settlement authority. Consumers compare its commitments against
`RoomManager`. An archive may declare an `archiveFloor` so a long-lived room
can be trimmed or bootstrapped mid-life; contiguity is then validated from that
floor instead of from batch 1.

## Trust boundary

The coordinator relays public room traffic and publishes deployment metadata. It
does not hold member keys, does not prove, and is not trusted for execution
correctness. Public AMM/vault batch data is canonical calldata; this provides
delayed public disclosure, not confidentiality.

Proving is **not** part of this service. Rooms reach the RISC Zero prover
host (`zkvm/crates/risc0/host`) directly over HTTP; the coordinator never sees a
witness and never issues a receipt. Clients replay the witness locally, compare
the journal, and verify the receipt against their pinned program.

Full settlement validity is still pre-release: the updated witness transport
must land atomically, `openRoom` must bind the header-derived canonical L1
anchor, and the GPU-to-L1 gate must pass. `/config.proofStatus` exposes that status.

The `/config` zkVM section is published only from a `ZKVM_LOCK_PATH` whose
`journalVersion` matches the guest generation this service was built against
(`5`, mirroring `JOURNAL_VERSION` in `zkvm/lock-schema.mjs`). A stale lock omits
the section entirely rather than advertising retired program digests.

Hidden card seeds, salts, deck order, hand/deck witnesses, Merkle paths and
passwords must never reach this service. Only browser-generated card proofs and
public inputs belong in an outer room batch; the card artifact routes serve
read-only proving artifacts pinned by `circuits/card-artifacts.lock.json`.

## Admission

`POST /rooms/:id/transactions` makes the operator key sign an EIP-712
`AdmissionReceipt` that is slashable against the room service bond, so it is
never anonymous: every call - and the operator drain `POST
/rooms/:id/pending-transactions` - requires
`Authorization: Bearer $ADMISSION_TOKEN`. Startup aborts when
`ADMISSION_KEY` is configured without a token of at least 16 characters.

Receipts are refused unless the request clears server-side policy rather than
caller-supplied values: `admissionFee` must reach
`MIN_ADMISSION_FEE_WEI` (default `0`), `deadlineBlock` must leave at least
`MIN_DEADLINE_LEAD_BLOCKS` (default `8`) over the **live** L1 head, and a
non-zero `depositInboxId` must name a pending, unreserved deposit whose
beneficiary is the recovered transaction sender. The head is read from
`L1_RPC_URL` before every signature; the coordinator fails closed with `503`
when that read is unavailable or when the observer archive trails the head by
more than `MAX_ARCHIVE_LAG_BLOCKS` (default `8`).

Admitted transactions are held in a bounded per-room queue that the batch
coordinator drains over the same credential. A saturated queue is reported as
`503` rather than accumulating receipts nothing can fulfil.

`RoomManagerValidationFacet` requires `admissionId == admissionCursor + i + 1`,
so admission ids are strictly sequential and may never be re-issued. The next id
is derived from the greater of the archive's admissions and the chain-observed
`admissionCursor`, and is recorded in an operator-owned
`$DATA_DIR/admission-issued-ids.json` - deliberately outside the public
archive the indexer rewrites. An archive that has rolled back behind an
already-issued id is refused with `503` rather than re-issuing it.

Rejection reasons on `POST /rooms/:id/transactions` are drawn from a fixed
set this service authors; an internal failure answers a generic reason and is
logged server-side, so the route cannot be used to probe the archive layout.

The libp2p relay, RPC proxy, and development faucet remain generic bootstrap
utilities. The old signed manifest/genesis/snapshot store is legacy-gated and is
not a room state source. Relay metadata and public payloads are visible to the
coordinator.

## Deployment addresses

`ROOM_MANAGER` (or `roomManager` in `ADDRESSES_PATH`) selects the long-lived
room manager; `ROOM_POOL` and `ACCESS_TOKEN` select the managed room pool and
its access token. `GET /artifacts/contracts.json` republishes those addresses
together with the `RoomManager` ABI from `CONTRACTS_OUT`.

Retired `ROOM_MANAGER`, `ROOM_MANAGER_V3`, `ROOM_MANAGER_V4`, and every
`V4_PROOF_*` / `V4_RECOVERY_*` variable have no effect: the surfaces they
configured no longer exist.

## Retired surfaces

Every `/legacy/v3/*` request returns `410`. The v4 preset catalog, hosted proof
service and recovery snapshot transport were deleted with the v4 protocol, so
every `/v4/*` path is an ordinary `404`; `test/manifest.test.ts` pins that so the
routes cannot be re-registered by accident.

Obsolete environment switches are ignored; the old watcher, prove-assist, Circom
settlement artifacts, and v3 contract metadata are never loaded by the current
process. Historical source may remain for audit context, but there is no runtime
compatibility mode.

Because the 410 hook precedes every `/legacy/v3/*` registration, the manifest,
genesis, snapshot, bus and rooms-list routes in `src/app.ts` - and the
`auth.ts` / `roster.ts` / `registry.ts` / `manifest.ts` / `genesis-builder.ts` /
`serialize.ts` modules that exist only to serve them - are unreachable. The
`[archived v3]` suites in `test/security.test.ts` and `test/manifest.test.ts`
are skipped for the same reason. They are retained as the specification that
layer must satisfy if it is re-enabled, not as executing coverage.

## Development

```text
pnpm --filter @zkdeal/server build
pnpm --filter @zkdeal/server test
pnpm --filter @zkdeal/server start
```

The checked-in Dockerfile runs unprivileged. Production/Kurtosis image
references must be immutable `@sha256` references; a local mutable tag is not
benchmark provenance.
