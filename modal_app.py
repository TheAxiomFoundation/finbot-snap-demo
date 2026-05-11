"""Modal deployment for the FinBot axiom-rules-engine engine.

Hosts the Rust ``axiom-rules-engine`` binary as an HTTP service, with the compiled
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
ENGINE_VERSION = "v3-pinned-shas"

# Pinned commit SHAs for the upstream repos. The compiled artifact's input
# slots have to match what src/lib/programs/co-snap-base.ts (auto-generated
# from the local artifact) declares — drifting from these SHAs without
# regenerating the local schema will cause "unknown input slot" errors at
# request time. To upgrade: pull the repos locally, run
# `bash scripts/build-artifacts.sh && python3 scripts/regenerate-co-snap-base.py`,
# verify `bun run engine:test` still passes, then update these SHAs and bump
# ENGINE_VERSION.
AXIOM_RULES_ENGINE_SHA = "9106f44e34ec3eae92a1adf2246560c5eac00094"
RULESPEC_US_SHA = "2f3a30991e1f8279c2fa664e51f068a63d905591"
RULESPEC_US_CO_SHA = "ba00673d73c19f262d542cfa597b0b365a1313b7"

# RuleSpec content baked into the image. Each entry: (slug, rulespec repo path).
# Add a new line + a matching artifact below to expose another program.
PROGRAMS = [
    ("co-snap", "rulespec-us-co/policies/cdhs/snap/fy-2026-benefit-calculation.yaml"),
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
        # Pinned SHAs — see top of file for the upgrade procedure.
        "git clone https://github.com/TheAxiomFoundation/axiom-rules-engine.git /opt/axiom-rules-engine",
        f"cd /opt/axiom-rules-engine && git checkout {AXIOM_RULES_ENGINE_SHA}",
        "git clone https://github.com/TheAxiomFoundation/rulespec-us.git /opt/rulespec-us",
        f"cd /opt/rulespec-us && git checkout {RULESPEC_US_SHA}",
        "git clone https://github.com/TheAxiomFoundation/rulespec-us-co.git /opt/rulespec-us-co",
        f"cd /opt/rulespec-us-co && git checkout {RULESPEC_US_CO_SHA}",
        ". $HOME/.cargo/env && cd /opt/axiom-rules-engine && cargo build --release",
        "mkdir -p /opt/artifacts",
        # Compile each program to a JSON artifact. Path uses /opt/<repo>/<rulespec_path>.
        *[
            f"/opt/axiom-rules-engine/target/release/axiom-rules-engine compile "
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
    """HTTP wrapper around the axiom-rules-engine binary.

    POST /run         {program, request}  → ExecutionResponse
    GET  /health      → {ok, programs, binary_version}
    """
    import json
    import subprocess
    from pathlib import Path

    from fastapi import FastAPI, HTTPException, Request
    from fastapi.middleware.cors import CORSMiddleware

    BIN = "/opt/axiom-rules-engine/target/release/axiom-rules-engine"
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
