#!/usr/bin/env bash
# One-shot local setup: build the axiom-rules-engine binary at the pinned ref
# and fetch the pinned program-artifacts release. Idempotent — safe to re-run.
#
# The pin lives in artifacts.lock.json. Production (Vercel) never runs this;
# it talks to the Modal-hosted engine via AXIOM_ENGINE_URL instead.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p engine

ENGINE_REPO=$(python3 -c "import json; print(json.load(open('artifacts.lock.json'))['engine']['repo'])")
ENGINE_REF=$(python3 -c "import json; print(json.load(open('artifacts.lock.json'))['engine']['ref'])")

if [ -d engine/axiom-rules-engine/.git ]; then
  echo "==> updating axiom-rules-engine"
  git -C engine/axiom-rules-engine fetch origin
else
  echo "==> cloning axiom-rules-engine"
  git clone "https://github.com/${ENGINE_REPO}.git" engine/axiom-rules-engine
fi
git -C engine/axiom-rules-engine checkout --quiet "$ENGINE_REF"
echo "==> axiom-rules-engine @ $ENGINE_REF"

if ! command -v cargo >/dev/null; then
  echo "cargo not found — install Rust first: https://rustup.rs"
  exit 1
fi

echo "==> building axiom-rules-engine (release)"
( cd engine/axiom-rules-engine && cargo build --release )

echo "==> fetching program artifacts"
npx tsx scripts/fetch-artifacts.ts

echo "==> done. binary: engine/axiom-rules-engine/target/release/axiom-rules-engine"
