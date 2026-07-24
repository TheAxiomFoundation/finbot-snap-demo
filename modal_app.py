"""Modal deployment for the FinBot axiom-rules-engine engine.

Hosts the Rust ``axiom-rules-engine`` binary as an HTTP service, with every
compiled artifact from the pinned rulespec-us program-artifacts release baked
into the image. The Vercel-hosted Next.js app calls this service from its tool
layer (see src/lib/engine.ts).

The single pin lives in ``artifacts.lock.json`` — the same file the local
setup (scripts/setup-engine.sh) and catalog generator use. Bumping the pin and
redeploying picks up new/updated programs; no per-program configuration here.

Deploy with:
    modal deploy modal_app.py

Build cost: the first deploy compiles Rust (~3-4 min); subsequent deploys
reuse the cached layer unless the pin changes (the lock contents key the
layer cache).
"""

import json
from pathlib import Path

import modal

app = modal.App("axiom-engine")

LOCK = json.loads((Path(__file__).parent / "artifacts.lock.json").read_text())
ENGINE_REPO = LOCK["engine"]["repo"]
ENGINE_REF = LOCK["engine"]["ref"]
RELEASE_REPO = LOCK["repo"]
RELEASE_TAG = LOCK["release_tag"]
CORPUS_SHA = LOCK["corpus_sha"]

RELEASE_BASE = f"https://github.com/{RELEASE_REPO}/releases/download/{RELEASE_TAG}"

# Python one-liner-ish script run inside the image: download every compiled
# artifact listed in the release manifest and verify its sha256.
FETCH_ARTIFACTS_PY = f"""
import hashlib, json, urllib.request
base = {RELEASE_BASE!r}
manifest = json.load(urllib.request.urlopen(base + "/manifest.json"))
assert manifest["corpus"]["sha"] == {CORPUS_SHA!r}, "corpus sha mismatch vs artifacts.lock.json"
json.dump(manifest, open("/opt/artifacts/manifest.json", "w"))
for program in manifest["programs"]:
    name = program["artifact"]
    data = urllib.request.urlopen(base + "/" + name).read()
    digest = hashlib.sha256(data).hexdigest()
    assert digest == program["artifact_sha256"], f"sha256 mismatch for {{name}}"
    open("/opt/artifacts/" + name, "wb").write(data)
print(f"fetched {{len(manifest['programs'])}} artifacts")
"""

image = (
    modal.Image.debian_slim(python_version="3.13")
    .apt_install("git", "curl", "build-essential", "pkg-config", "libssl-dev", "ca-certificates")
    .run_commands(
        # Pinned Rust install — minimal profile, stable channel.
        "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs "
        "| sh -s -- -y --default-toolchain stable --profile minimal",
    )
    .run_commands(
        # Layer cache key: the pin itself.
        f"echo 'engine: {ENGINE_REF} release: {RELEASE_TAG}'",
        f"git clone https://github.com/{ENGINE_REPO}.git /opt/axiom-rules-engine",
        f"cd /opt/axiom-rules-engine && git checkout {ENGINE_REF}",
        ". $HOME/.cargo/env && cd /opt/axiom-rules-engine && cargo build --release",
        "mkdir -p /opt/artifacts",
        f"python3 -c {FETCH_ARTIFACTS_PY!r}",
    )
    .pip_install("fastapi>=0.109", "uvicorn>=0.27", "pydantic>=2.0")
)


@app.function(
    image=image,
    scaledown_window=300,  # keep warm 5 min after the last request
    timeout=60,
)
@modal.concurrent(max_inputs=10)
@modal.asgi_app(label="axiom-engine")
def web():
    """HTTP wrapper around the axiom-rules-engine binary.

    POST /run         {program, request}  → ExecutionResponse
    GET  /health      → {ok, programs, release}
    """
    import json
    import subprocess
    from pathlib import Path

    from fastapi import FastAPI, HTTPException, Request
    from fastapi.middleware.cors import CORSMiddleware

    BIN = "/opt/axiom-rules-engine/target/release/axiom-rules-engine"
    ARTIFACTS = {
        path.name.removesuffix(".compiled.json"): str(path)
        for path in sorted(Path("/opt/artifacts").glob("*.compiled.json"))
    }

    api = FastAPI(title="Axiom Engine", version="0.2.0")

    # Allow the Vercel app and any preview deploys to call us. The engine is
    # stateless and idempotent; tightening this to a specific origin list can
    # happen in a follow-up if we ever expose user-specific data.
    api.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )

    @api.get("/health")
    async def health():
        return {
            "ok": Path(BIN).exists(),
            "binary": BIN,
            "release": RELEASE_TAG,
            "engine_ref": ENGINE_REF,
            "programs": {
                slug: {"artifact": path, "exists": Path(path).exists()}
                for slug, path in ARTIFACTS.items()
            },
        }

    @api.post("/run")
    async def run(request: Request):
        body = await request.json()
        program = body.get("program")
        engine_request = body.get("request")
        if program not in ARTIFACTS:
            raise HTTPException(
                status_code=400,
                detail=f"unknown program: {program!r}; known: {list(ARTIFACTS)}",
            )
        if not isinstance(engine_request, dict):
            raise HTTPException(status_code=400, detail="missing or invalid `request` body")

        proc = subprocess.run(
            [BIN, "run-compiled", "--artifact", ARTIFACTS[program]],
            input=json.dumps(engine_request),
            text=True,
            capture_output=True,
            timeout=30,
        )
        if proc.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=f"axiom-rules-engine exited {proc.returncode}: {proc.stderr.strip()}",
            )
        try:
            return json.loads(proc.stdout)
        except json.JSONDecodeError as err:
            raise HTTPException(
                status_code=500,
                detail=f"could not parse engine output: {err}",
            )

    return api
