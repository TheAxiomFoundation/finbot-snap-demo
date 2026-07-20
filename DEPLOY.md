# Deploy

Two services, both under PolicyEngine accounts:

| Where | What | Why |
|---|---|---|
| **Modal** (`axiom-engine`) | The Rust `axiom-rules-engine` binary plus every compiled artifact from the pinned rulespec-us `program-artifacts` release. | Vercel cannot run native binaries; Modal containers can. |
| **Vercel** (`finbot-snap-demo`) | Next.js app: chat surface, side-by-side comparison, `/programs` browser, and all `/api/*` routes. | Standard Next.js deploy target with AI SDK streaming. |

The Vercel app calls the Modal endpoint through `AXIOM_ENGINE_URL`. Locally, when that env var is unset, the app spawns the binary directly.

Both services read the same pin: `artifacts.lock.json`.

## 1. Deploy the engine to Modal

```bash
# One-time: install + auth into PolicyEngine's Modal workspace.
pip install modal
modal token set --token-id <id> --token-secret <secret>

# Deploy. First build compiles Rust (~3-4 min) and downloads + sha256-verifies
# the release artifacts. Subsequent deploys reuse the cached layer unless
# artifacts.lock.json changes.
modal deploy modal_app.py
```

Modal prints a public URL like:

```text
https://policyengine--axiom-engine.modal.run
```

Verify it works:

```bash
curl https://policyengine--axiom-engine.modal.run/health
# -> { "ok": true, "release": "program-artifacts-…", "programs": { "us-co-snap": …, … } }
```

## 2. Deploy the frontend to Vercel

```bash
# One-time: link this repo to a Vercel project under the PolicyEngine team.
npm i -g vercel
vercel login
vercel link --scope policyengine
```

Set the env vars Vercel needs:

```bash
vercel env add OPENAI_API_KEY
vercel env add AXIOM_ENGINE_URL      # Modal URL from step 1
# Optional model override. Default is gpt-5.5; see src/lib/model.ts.
# vercel env add FINBOT_MODEL          # e.g. gpt-5.5-pro
```

Deploy:

```bash
vercel deploy --prod
```

## Pin-bump runbook

When rulespec-us publishes a new `program-artifacts-<sha>` release:

```bash
# 1. Edit artifacts.lock.json (release_tag, corpus_sha, engine.ref if moved)
bun run artifacts:fetch        # download + sha256-verify
bun run catalog:generate       # regenerate catalog.json — REVIEW the report + warnings
bun run test:smoke             # all programs must compute with defaults
bun run test:regression        # exact-value cases still hold (update if rules changed)
bun run typecheck && bun run build

# 2. Commit artifacts.lock.json + src/lib/generated/catalog.json
# 3. Deploy the engine, then the frontend
modal deploy modal_app.py
AXIOM_ENGINE_URL=https://policyengine--axiom-engine.modal.run bun run test:smoke   # against prod engine
vercel deploy --prod
```

## Local dev still works

If `AXIOM_ENGINE_URL` is not set, the chat tools spawn the local Rust binary instead. So `bun run dev` after `bun run engine:setup` works without deployed services.

## Troubleshooting

- **`/api/chat` returns "axiom-engine ..." errors** → the Modal service is down or unreachable. Hit `/health` directly to confirm.
- **`/api/chat` returns "axiom-rules-engine binary not found at..."** → `AXIOM_ENGINE_URL` is unset and the local binary is not built. Either set the env var or run `bun run engine:setup`.
- **"unknown program" from Modal** → the Modal image was built from an older pin. Redeploy `modal_app.py` after a pin bump.
- **Vercel function timeouts** → chat and raw comparison routes are configured for 300s in `vercel.json`, matching the route-level `maxDuration`. Check the Vercel plan limit if a deployment overrides that.
- **Modal cold starts** → `scaledown_window=300` keeps the container warm for 5 minutes after the last request.
