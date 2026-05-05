#!/usr/bin/env bash
# One-shot: clone axiom repos, build the Rust binary, and compile the CO SNAP artifact.
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

clone_or_pull axiom-rules
clone_or_pull rules-us
clone_or_pull rules-us-co

if ! command -v cargo >/dev/null; then
  echo "cargo not found — install Rust first: https://rustup.rs"
  exit 1
fi

echo "==> building axiom-rules (release)"
( cd engine/axiom-rules && cargo build --release )

bash scripts/build-artifacts.sh
echo "==> done. binary: engine/axiom-rules/target/release/axiom-rules"
