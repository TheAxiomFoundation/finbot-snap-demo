# Deploy

Two services, both under PolicyEngine accounts:

| Where | What | Why |
|---|---|---|
| **Modal** (`axiom-engine`) | The Rust `axiom-rules-engine` binary plus compiled artifacts for CO SNAP, UK personal allowance, and UK Universal Credit. | Vercel cannot run native binaries; Modal containers can. |
| **Vercel** (`finbot-snap-demo`) | Next.js app: chat surface, side-by-side comparison, and all `/api/*` routes. | Standard Next.js deploy target with AI SDK streaming. |

The Vercel app calls the Modal endpoint through `AXIOM_ENGINE_URL`. Locally, when that env var is unset, the app spawns the binary directly.

## 1. Deploy the engine to Modal

```bash
# One-time: install + auth into PolicyEngine's Modal workspace.
pip install modal
modal token set --token-id <id> --token-secret <secret>

# Deploy. First build compiles Rust (~3-4 min). Subsequent deploys reuse the
# cached layer unless ENGINE_VERSION in modal_app.py is bumped.
modal deploy modal_app.py
```

Modal prints a public URL like:

```text
https://policyengine--axiom-engine-web.modal.run
```

Copy it. Verify it works:

```bash
curl https://policyengine--axiom-engine-web.modal.run/health
# -> { "ok": true, "programs": { "co-snap": ..., "uk-personal-allowance": ..., "uk-uc": ... } }
```

To redeploy after rules content changes, update the pinned SHAs in `modal_app.py`, bump `ENGINE_VERSION`, regenerate matching local schemas/artifacts, run the engine tests, and then run `modal deploy modal_app.py`.

## 2. Deploy the frontend to Vercel

```bash
# One-time: link this repo to a Vercel project under the PolicyEngine team.
npm i -g vercel
vercel login
vercel link --scope policyengine
# -> creates .vercel/project.json with orgId team_xsyTmFLMLGbHH7Qxu70R5G4r
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
# -> https://finbot-snap-demo.vercel.app  (current project/domain)
```

## 3. Optional custom domain

In the Vercel dashboard for the project, **Settings -> Domains**. PE's pattern is `<app>.policyengine.org`; for Axiom-flavoured apps, `finbot.axiom-foundation.org` may make more sense.

## Redeploy cadence

- **Frontend changes** under `src/`, `package.json`, or `vercel.json`: `vercel deploy --prod` or merge to `main` if the Vercel project has production auto-deploy enabled.
- **Engine changes**: update pins and `ENGINE_VERSION` in `modal_app.py`, verify local artifacts/tests, then `modal deploy modal_app.py`. The frontend only needs redeploying if the TypeScript tool/schema surface changed.

## Local dev still works

If `AXIOM_ENGINE_URL` is not set, the chat tools spawn the local Rust binary instead. So `bun run dev` after `bun run engine:setup` works without deployed services.

## Troubleshooting

- **`/api/chat` returns "axiom-engine ..." errors** -> the Modal service is down or unreachable. Hit `/health` directly to confirm.
- **`/api/chat` returns "axiom-rules-engine binary not found at..."** -> `AXIOM_ENGINE_URL` is unset and the local binary is not built. Either set the env var or run `bun run engine:setup`.
- **Vercel function timeouts** -> chat and raw comparison routes are configured for 300s in `vercel.json`, matching the route-level `maxDuration`. Check the Vercel plan limit if a deployment overrides that.
- **Modal cold starts** -> `scaledown_window=300` in `modal_app.py` keeps the container warm for 5 minutes after the last request. First request after a cold period takes a few seconds; subsequent requests are faster.
