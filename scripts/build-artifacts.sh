#!/usr/bin/env bash
# Compile RuleSpec YAMLs to JSON artifacts.
# Add a new program by appending another `compile` invocation here.
set -euo pipefail

cd "$(dirname "$0")/.."
BIN="${AXIOM_RULES_ENGINE_BINARY:-engine/axiom-rules-engine/target/release/axiom-rules-engine}"
mkdir -p engine/artifacts

if [ ! -x "$BIN" ]; then
  echo "binary missing: $BIN — run scripts/setup-engine.sh first"
  exit 1
fi

compile() {
  local slug="$1" rulespec="$2"
  echo "==> compiling $slug"
  AXIOM_RULESPEC_REPO_ROOTS="$PWD/engine" "$BIN" compile --program "$rulespec" --output "engine/artifacts/${slug}.compiled.json" >/dev/null
}

compile co-snap engine/rulespec-us-co/policies/cdhs/snap/fy-2026-benefit-calculation.yaml
compile uk-personal-allowance engine/rulespec-uk/statutes/ukpga/2007/3/35.yaml

echo "==> copying uk-uc"
cp engine/axiom-programs/artifacts/uk/universal-credit/fy-2026-27.compiled.json \
  engine/artifacts/uk-uc.compiled.json

echo "==> artifacts:"
ls -lh engine/artifacts/
