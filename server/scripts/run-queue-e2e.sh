#!/usr/bin/env bash
# The prove-queue e2e stand, all in one container: the standalone queue, one
# take-and-die agent, and - only AFTER the doomed agent has leased a job - two
# healthy ok:2000 stubs. The ordering is the determinism: the dying agent is
# the only worker when the first job arrives, so "its" job provably exists and
# must be re-leased and finished by somebody else.
#
# Run by the `queue-test` service in web2-api/docker-compose.yml. Assumes the
# umbrella tree is installed (web2-api and prover-node pnpm workspaces).
set -euo pipefail

UMBRELLA="$(cd "$(dirname "$0")/../../.." && pwd)"
export ZKDEAL_QUEUE_SUBMIT_TOKEN="${ZKDEAL_QUEUE_SUBMIT_TOKEN:-queue-e2e-submit-token}"
export ZKDEAL_QUEUE_NODE_TOKEN="${ZKDEAL_QUEUE_NODE_TOKEN:-queue-e2e-node-token}"
QUEUE_PORT="${QUEUE_PORT:-3005}"
QUEUE_URL="http://127.0.0.1:${QUEUE_PORT}"
DATA_DIR="$(mktemp -d)"

cleanup() {
  # shellcheck disable=SC2046
  kill $(jobs -p) 2>/dev/null || true
}
trap cleanup EXIT

# --- the queue, with a lease TTL short enough to watch a death recover ---
(
  cd "$UMBRELLA/web2-api/server" &&
  QUEUE_PORT="$QUEUE_PORT" DATA_DIR="$DATA_DIR" QUEUE_LEASE_TTL_MS=3000 \
    pnpm exec tsx src/prove-queue/standalone.ts
) &

node -e '
  const url = process.argv[1] + "/health";
  const deadline = Date.now() + 30_000;
  const tick = async () => {
    try { if ((await fetch(url)).ok) process.exit(0); } catch {}
    if (Date.now() > deadline) { console.error("queue never became healthy"); process.exit(1); }
    setTimeout(tick, 250);
  };
  tick();
' "$QUEUE_URL"
echo "Progress: the standalone queue is answering on ${QUEUE_URL}."

agent() { # name, stub-mode
  # HEARTBEAT_INTERVAL_MS well under the 3s lease TTL: a healthy agent's job
  # must never expire under it on a slow machine - only the dead agent's may.
  (
    cd "$UMBRELLA/prover-node/agent" &&
    NODE_ID="$1" ZKDEAL_AGENT_STUB="$2" QUEUE_URL="$QUEUE_URL" \
    POLL_INTERVAL_MS=100 HEARTBEAT_INTERVAL_MS=1000 pnpm exec tsx src/agent.ts
  ) &
}

# --- the doomed agent first, alone ---
agent stub-dead take-and-die

# --- healthy agents join only once the doomed agent holds a lease ---
(
  node -e '
    const url = process.argv[1] + "/queue/v1/status";
    const tick = async () => {
      try {
        const status = await (await fetch(url)).json();
        if ((status.nodes ?? []).some((n) => n.nodeId === "stub-dead" && n.lastLeaseAt)) {
          process.exit(0);
        }
      } catch {}
      setTimeout(tick, 200);
    };
    tick();
  ' "$QUEUE_URL"
  echo "Progress: stub-dead leased a job and died; starting the healthy agents."
  agent stub-a ok:2000
  agent stub-b ok:2000
  wait
) &

# --- the assertions ---
cd "$UMBRELLA/web2-api/server"
QUEUE_E2E_URL="$QUEUE_URL" pnpm exec vitest run test/prove-queue-e2e.test.ts
