#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.happier/tools/js-runtime/current/runtime/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:---all}"

echo "=== [Tier 0] Google agy CLI baseline ==="
agy --version
MODELS_OUT="$(agy models)"
echo "$MODELS_OUT" | grep -q "gemini-4-neon-high" || { echo "FAIL: gemini-4-neon-high missing from agy models"; exit 1; }
SCRATCH="$(mktemp -d /tmp/agy-tier0-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT
PRINT_OUT="$(cd "$SCRATCH" && agy --model gemini-4-neon-high --print 'Reply with OK.')"
echo "$PRINT_OUT" | grep -q "OK" || { echo "FAIL: headless print unexpected output: $PRINT_OUT"; exit 1; }
echo "Tier 0 PASS"

echo "=== [Tier 1] Unit & contract tests (packages/agents + apps/cli) ==="
(cd "$REPO_ROOT" && yarn workspace @happier-dev/agents test src/agy.test.ts src/acp.test.ts src/manifest.cloudConnectStatus.test.ts)
(cd "$REPO_ROOT/apps/cli" && ../../node_modules/.bin/vitest run \
  src/backends/agy/ \
  src/agent/acp/__tests__/AcpBackend.providerTurns.test.ts \
  src/agent/acp/__tests__/AcpBackend.spawnEnv.test.ts \
  src/agent/acp/updates/toolCalls/__tests__/AcpToolCallTracker.test.ts \
  src/capabilities/probes/probeAcpCatalogs.readiness.test.ts \
  src/rpc/handlers/capabilities.agyConnectedAuth.test.ts)
echo "Tier 1 PASS"

echo "=== [Tier 2] Direct Happier ACP adapter harness against live agy ==="
(cd "$REPO_ROOT/apps/cli" && HAPPIER_LIVE_AGY_TIER2=1 ../../node_modules/.bin/vitest run src/backends/agy/acp/liveAgyAdapter.tier2.test.ts)
echo "Tier 2 PASS"

if [[ "$MODE" == "--fast" ]]; then
  echo "Done (--fast: Tiers 0-2 passed)."
  exit 0
fi

echo "=== [Tier 3] Full-stack isolated relay + daemon + CLI E2E ==="
(cd "$REPO_ROOT/packages/tests" && \
  HAPPIER_LIVE_AGY_TIER3=1 \
  HAPPIER_E2E_DB_PROVIDER=sqlite \
  HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD=1 \
  HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD=1 \
  ../../node_modules/.bin/vitest run --config vitest.core.slow.config.ts \
    suites/core-e2e/agy.native.daemon.live.slow.e2e.test.ts \
    suites/core-e2e/agy.native.edgeCases.live.slow.e2e.test.ts)
echo "Tier 3 PASS"

echo "=== [Tier 4] Playwright Web UI E2E against isolated 0.2.16 server+UI + forked daemon ==="
(cd "$REPO_ROOT/packages/tests" && \
  HAPPIER_LIVE_AGY_TIER4=1 \
  ../../node_modules/.bin/playwright test --config playwright.ui.config.mjs \
    suites/ui-e2e/agy.prodServerCompat.live.spec.ts --reporter=list)
echo "Tier 4 PASS"

echo "ALL TIERS (0-4) PASSED!"
