# Build from the umbrella root. Build-only dependencies never enter the final
# image; the runtime contains only the bundled coordinator entrypoints, their
# production dependency cone, static web export, contract ABIs and proof trust
# roots. TypeScript sources are build-stage inputs and never ship.
FROM node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a AS web-build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate
COPY app-node ./app-node
COPY apps-examples ./apps-examples
COPY web2-api ./web2-api
# Owner acceptance tests exercise the exact circuit trust roots and deployed
# contract ABIs shipped by the runtime. Keep them in the build/test stage so a
# candidate image cannot pass type-checking while omitting its release inputs.
COPY web3-protocol/circuits ./web3-protocol/circuits
COPY web3-protocol/contracts/out ./web3-protocol/contracts/out
RUN cd app-node && pnpm install --frozen-lockfile
RUN cd apps-examples && pnpm install --frozen-lockfile
RUN cd web2-api && pnpm install --frozen-lockfile
RUN cd web2-api && pnpm --filter @zkdeal/server build
RUN cd web2-api && pnpm --filter web build

# Acceptance-harness trees. kurtosis-testing/package/main.star runs the bench
# bootstrap runner, the example runner and the queue-pull prover agent inside
# this same image (build-docker-images.* tags it as `runner`), all via tsx over
# their own sources; they are test-harness code and are never bundled. The
# example cases also exercise the full app-node/apps-examples trees.
FROM web-build AS acceptance
WORKDIR /app
COPY kurtosis-testing/package.json kurtosis-testing/pnpm-workspace.yaml kurtosis-testing/pnpm-lock.yaml kurtosis-testing/tsconfig.base.json ./kurtosis-testing/
COPY kurtosis-testing/scripts ./kurtosis-testing/scripts
COPY kurtosis-testing/packages ./kurtosis-testing/packages
COPY prover-node/package.json prover-node/pnpm-workspace.yaml prover-node/pnpm-lock.yaml prover-node/tsconfig.base.json ./prover-node/
COPY prover-node/agent ./prover-node/agent
COPY prover-node/scripts ./prover-node/scripts
RUN cd kurtosis-testing && pnpm install --frozen-lockfile
RUN cd prover-node && pnpm install --frozen-lockfile

FROM node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a AS runtime-dependencies
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate
COPY app-node/package.json app-node/pnpm-workspace.yaml app-node/pnpm-lock.yaml app-node/tsconfig.base.json ./app-node/
COPY app-node/packages/p2p ./app-node/packages/p2p
COPY app-node/packages/protocol ./app-node/packages/protocol
COPY app-node/packages/zkvm ./app-node/packages/zkvm
COPY web2-api/package.json web2-api/pnpm-workspace.yaml web2-api/pnpm-lock.yaml web2-api/tsconfig.base.json ./web2-api/
COPY web2-api/server ./web2-api/server
RUN cd app-node && pnpm install --frozen-lockfile --prod --filter @zkdeal/p2p... --filter @zkdeal/zkvm...
RUN cd web2-api && pnpm install --frozen-lockfile --prod --filter @zkdeal/server

# Bundle every shipped entrypoint to plain JavaScript so the runtime never
# executes tsx over TypeScript sources. esbuild is locked transitively by the
# server's direct tsx dependency; invoke that exact installed artifact (the
# cloud-deployer-infra/agent image uses the same pattern). Third-party
# packages stay --external: node_modules remains the dependency source and
# only first-party TypeScript (@zkdeal/server, @zkdeal/p2p, @zkdeal/protocol)
# is inlined. dist/ mirrors src/ so relative path math (config.ts resolves
# FOLDER_ROOT/UMBRELLA_ROOT from import.meta.url) is unchanged.
FROM runtime-dependencies AS bundle
WORKDIR /app/web2-api/server
RUN esbuild_bin="$(find /app/web2-api/node_modules/.pnpm -path '*/node_modules/esbuild/bin/esbuild' -type f -print -quit)" \
 && test -n "$esbuild_bin" \
 && externals="$(node scripts/runtime-bundle-helper.mjs externals . ../../app-node/packages/p2p ../../app-node/packages/protocol)" \
 && "$esbuild_bin" \
      src/index.ts \
      src/hosted-worker.ts \
      src/hosted-publisher-worker.ts \
      src/hosted-withdrawal-worker.ts \
      src/hosted-capacity-worker.ts \
      src/prove-queue/standalone.ts \
      --bundle --platform=node --format=esm --target=node22 \
      --outbase=src --outdir=dist $externals
# The inlined @zkdeal/p2p and @zkdeal/protocol code now resolves third-party
# imports from dist/ instead of from its package directories; link each of
# their declared dependencies into the server node_modules (existing server
# pins win, preserving today's resolution order for server-owned imports).
RUN node scripts/runtime-bundle-helper.mjs link node_modules \
      ../../app-node/packages/p2p ../../app-node/packages/protocol

FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS runtime
# Preserve the notices for every first-party source tree copied into the
# distributed runtime. The service, room node and prover are BUSL-1.1; the
# examples, acceptance harness and protocol artifacts are MIT licensed.
COPY web2-api/LICENSE /zkdeal-BUSL-1.1-LICENSE
COPY web2-api/LICENSE /licenses/web2-api-BUSL-1.1.txt
COPY app-node/LICENSE /licenses/app-node-BUSL-1.1.txt
COPY prover-node/LICENSE /licenses/prover-node-BUSL-1.1.txt
COPY apps-examples/LICENSE /licenses/apps-examples-MIT.txt
COPY kurtosis-testing/LICENSE /licenses/kurtosis-testing-MIT.txt
COPY web3-protocol/LICENSE /licenses/web3-protocol-MIT.txt
LABEL org.opencontainers.image.licenses="BUSL-1.1 AND MIT"
WORKDIR /app
COPY --from=bundle /app/app-node/node_modules ./app-node/node_modules
# Workspace package identities keep the pnpm links valid; no src/ trees ship.
COPY --from=bundle /app/app-node/packages/p2p/package.json ./app-node/packages/p2p/package.json
COPY --from=bundle /app/app-node/packages/protocol/package.json ./app-node/packages/protocol/package.json
COPY --from=bundle /app/app-node/packages/zkvm/package.json ./app-node/packages/zkvm/package.json
COPY --from=bundle /app/web2-api/node_modules ./web2-api/node_modules
COPY --from=bundle /app/web2-api/server/node_modules ./web2-api/server/node_modules
COPY --from=bundle /app/web2-api/server/package.json ./web2-api/server/package.json
COPY --from=bundle /app/web2-api/server/capabilities ./web2-api/server/capabilities
COPY --from=bundle /app/web2-api/server/dist ./web2-api/server/dist
COPY --from=web-build /app/web2-api/web/out ./web2-api/web/out

# The kurtosis acceptance plane (package/main.star) execs the bench runners
# and the prover agent from these trees with `pnpm exec tsx` over their own
# sources; the server itself still runs only from dist/. pnpm is restored
# below for exactly that harness path.
COPY --from=acceptance /app/app-node ./app-node
COPY --from=acceptance /app/apps-examples ./apps-examples
COPY --from=acceptance /app/kurtosis-testing ./kurtosis-testing
COPY --from=acceptance /app/prover-node ./prover-node
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate

# kurtosis-testing's lockfile links web3-protocol/circuits by sibling path, so
# the link target's package.json must exist in the runtime layout.
COPY web3-protocol/circuits/package.json ./web3-protocol/circuits/package.json
COPY web3-protocol/circuits/build ./web3-protocol/circuits/build
COPY web3-protocol/circuits/card-artifacts.lock.json ./web3-protocol/circuits/card-artifacts.lock.json
COPY web3-protocol/circuits/card-vkeys ./web3-protocol/circuits/card-vkeys
COPY web3-protocol/contracts/out ./web3-protocol/contracts/out
COPY web3-protocol/contracts/scenarios.json ./web3-protocol/contracts/scenarios.json
COPY prover-node/zkvm/artifacts.lock.json ./prover-node/zkvm/artifacts.lock.json
COPY prover-node/zkvm/fixtures ./prover-node/zkvm/fixtures

ENV PORT=3000 \
    RELAY_PORT=9001 \
    WEB_ROOT=/app/web2-api/web/out \
    ARTIFACTS_ROOT=/app/web3-protocol/circuits/build \
    CIRCUITS_ROOT=/app/web3-protocol/circuits \
    CONTRACTS_ROOT=/app/web3-protocol/contracts \
    CONTRACTS_OUT=/app/web3-protocol/contracts/out \
    SCENARIOS_PATH=/app/web3-protocol/contracts/scenarios.json \
    DATA_DIR=/app/web2-api/server/data \
    CHAIN_ID=31337 \
    FAUCET_COOLDOWN_MS=1000 \
    HOST=0.0.0.0 \
    NODE_ENV=production
EXPOSE 3000 9001
RUN useradd --system --create-home --uid 10001 zkdeal \
 && mkdir -p /app/web2-api/server/data \
 && chown -R zkdeal:zkdeal /app/web2-api/server/data
USER zkdeal
WORKDIR /app/web2-api/server
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Fast fallback to tsx-over-src if a node-side gate rejects the bundles:
# replace the selective web2-api/server copies above with
#   COPY --from=runtime-dependencies /app/web2-api/server ./web2-api/server
# restore the full p2p/protocol/zkvm package copies, and use
#   CMD ["./node_modules/.bin/tsx", "src/index.ts"]
CMD ["node", "dist/index.js"]
