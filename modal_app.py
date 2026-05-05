"""Modal deployment for the FinBot axiom-rules engine.

Hosts the Rust ``axiom-rules`` binary as an HTTP service, with the compiled
CO SNAP artifact baked into the image. The Vercel-hosted Next.js app calls
this service from its tool layer (see src/lib/engine.ts).

Deploy with:
    modal deploy modal_app.py

Build cost: the first deploy compiles Rust (~3-4 min); subsequent deploys
reuse the cached layer unless ``ENGINE_VERSION`` below is bumped.

The deployed URL prints as ``https://policyengine--axiom-engine-web.modal.run``
(or similar). Set that as ``AXIOM_ENGINE_URL`` on the Vercel project.
"""

import modal

app = modal.App("axiom-engine")

# Bump when source repos change to bust the layer cache and re-build.
ENGINE_VERSION = "v1"

# Rules content baked into the image. Each entry: (slug, rules-co-repo path).
# Add a new line + a matching artifact below to expose another program.
PROGRAMS = [
    ("co-snap", "rules-us-co/policies/cdhs/snap/fy-2026-benefit-calculation.yaml"),
]

image = (
    modal.Image.debian_slim(python_version="3.13")
    .apt_install("git", "curl", "build-essential", "pkg-config", "libssl-dev", "ca-certificates")
    .run_commands(
        # Pinned Rust install — minimal profile, stable channel.
        "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs "
        "| sh -s -- -y --default-toolchain stable --profile minimal",
    )
    .run_commands(
        # Layer cache key for the source-repo + binary layer.
        f"echo 'engine: {ENGINE_VERSION}'",
        "git clone --depth 1 https://github.com/TheAxiomFoundation/axiom-rules.git /opt/axiom-rules",
        "git clone --depth 1 https://github.com/TheAxiomFoundation/rules-us.git /opt/rules-us",
        "git clone --depth 1 https://github.com/TheAxiomFoundation/rules-us-co.git /opt/rules-us-co",
        ". $HOME/.cargo/env && cd /opt/axiom-rules && cargo build --release",
        "mkdir -p /opt/artifacts",
        # Compile each program to a JSON artifact. Path uses /opt/<repo>/<rulespec_path>.
        *[
            f"/opt/axiom-rules/target/release/axiom-rules compile "
            f"--program /opt/{path} "
            f"--output /opt/artifacts/{slug}.compiled.json"
            for slug, path in PROGRAMS
        ],
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
    """HTTP wrapper around the axiom-rules binary.

    POST /run         {program, request}  → ExecutionResponse
    GET  /health      → {ok, programs, binary_version}
    """
    import json
    import subprocess
    from pathlib import Path

    from fastapi import FastAPI, HTTPException, Request
    from fastapi.middleware.cors import CORSMiddleware

    BIN = "/opt/axiom-rules/target/release/axiom-rules"
    ARTIFACTS = {slug: f"/opt/artifacts/{slug}.compiled.json" for slug, _ in PROGRAMS}

    api = FastAPI(title="Axiom Engine", version="0.1.0")

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
            "programs": {
                slug: {"artifact": path, "exists": Path(path).exists()}
                for slug, path in ARTIFACTS.items()
            },
            "engine_version": ENGINE_VERSION,
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
                detail=f"axiom-rules exited {proc.returncode}: {proc.stderr.strip()}",
            )
        try:
            return json.loads(proc.stdout)
        except json.JSONDecodeError as err:
            raise HTTPException(
                status_code=500,
                detail=f"could not parse engine output: {err}",
            )

    return api
