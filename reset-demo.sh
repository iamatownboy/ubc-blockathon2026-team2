#!/usr/bin/env bash
# Demo reset. Restarts the service for a clean state before you present.
#
#   ./reset-demo.sh          in-memory ledger (default — nothing can be down)
#   ./reset-demo.sh chain    fresh Hardhat chain + redeploy + LEDGER=chain
#
# Learners are cleared on restart (state is in memory). To become a fresh
# learner in the browser, use "Forget this device" at the bottom of the
# learner app, or clear the site's data.
set -euo pipefail
cd "$(dirname "$0")"
MODE="${1:-memory}"

echo "→ stopping old service…"
pkill -f "server/server.js" 2>/dev/null || true
sleep 1

if [[ "$MODE" == "chain" ]]; then
  echo "→ stopping old chain…"
  pkill -f "hardhat node" 2>/dev/null || true
  sleep 2
  echo "→ starting fresh chain…"
  (cd contracts && CHOKIDAR_USEPOLLING=1 nohup ./node_modules/.bin/hardhat node > /tmp/languagetoken-hardhat.log 2>&1 &)
  sleep 5
  echo "→ deploying contract, roles, missions and catalog…"
  (cd contracts && ./node_modules/.bin/hardhat run scripts/deploy.js --network localhost)
  export LEDGER=chain
fi

echo "→ starting service (ledger=${LEDGER:-memory})…"
nohup node server/server.js > /tmp/languagetoken-service.log 2>&1 &
sleep 1
echo "✓ demo reset complete."
echo "  learner   http://localhost:8787/learner/"
echo "  verifier  http://localhost:8787/verifier/   (token: verifier-demo)"
echo "  admin     http://localhost:8787/admin/      (token: admin-demo)"
echo "  logs      /tmp/languagetoken-service.log${LEDGER:+  /tmp/languagetoken-hardhat.log}"
