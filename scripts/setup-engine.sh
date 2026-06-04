#!/usr/bin/env bash
# One-shot: clone axiom repos, build the Rust binary, and compile/copy artifacts.
# Idempotent — safe to re-run.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p engine

clone_or_pull() {
  local repo="$1" dest="engine/$1"
  if [ -d "$dest/.git" ]; then
    echo "==> updating $repo"
    git -C "$dest" pull --ff-only
  else
    echo "==> cloning $repo"
    git clone --depth 1 "https://github.com/TheAxiomFoundation/$repo.git" "$dest"
  fi
}

clone_or_pull axiom-rules-engine
clone_or_pull rulespec-us
clone_or_pull rulespec-us-co
clone_or_pull rulespec-uk
clone_or_pull axiom-programs

git -C engine/axiom-programs fetch origin codex/uk-uc-compose-housing-schedules-20260604
git -C engine/axiom-programs checkout 762a1666c77f6643590ce2bc97e3c8263dd22879

if ! command -v cargo >/dev/null; then
  echo "cargo not found — install Rust first: https://rustup.rs"
  exit 1
fi

echo "==> building axiom-rules-engine (release)"
( cd engine/axiom-rules-engine && cargo build --release )

bash scripts/build-artifacts.sh
echo "==> done. binary: engine/axiom-rules-engine/target/release/axiom-rules-engine"
