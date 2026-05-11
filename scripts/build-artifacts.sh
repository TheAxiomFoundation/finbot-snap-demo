#!/usr/bin/env bash
# Compile RuleSpec YAMLs to JSON artifacts.
# Add a new program by appending another `compile` invocation here.
set -euo pipefail

cd "$(dirname "$0")/.."
BIN="engine/axiom-rules-engine/target/release/axiom-rules-engine"
mkdir -p engine/artifacts

if [ ! -x "$BIN" ]; then
  echo "binary missing: $BIN — run scripts/setup-engine.sh first"
  exit 1
fi

compile() {
  local slug="$1" rulespec="$2"
  echo "==> compiling $slug"
  "$BIN" compile --program "$rulespec" --output "engine/artifacts/${slug}.compiled.json" >/dev/null
}

compile co-snap engine/rulespec-us-co/policies/cdhs/snap/fy-2026-benefit-calculation.yaml

echo "==> artifacts:"
ls -lh engine/artifacts/
