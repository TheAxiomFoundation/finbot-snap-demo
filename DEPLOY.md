# Deploy

Two services, both under PolicyEngine accounts:

| Where | What | Why |
|---|---|---|
| **Modal** (`axiom-engine`) | The Rust `axiom-rules` binary + compiled CO SNAP artifact, exposed as an HTTP endpoint. | Vercel can't run native binaries; Modal containers can. |
| **Vercel** (`finbot-snap-demo`) | Next.js app — chat surface, side-by-side, walkthrough, all `/api/*` routes. | Standard Next.js deploy target; native streaming for the AI SDK. |

The Vercel app calls the Modal endpoint through `AXIOM_ENGINE_URL`. Locally, when that env var is unset, the app spawns the binary directly — so dev still works without Modal.

## 1. Deploy the engine to Modal

```bash
# One-time: install + auth into PolicyEngine's Modal workspace.
pip install modal
modal token set --token-id <id> --token-secret <secret>   # PolicyEngine workspace

# Deploy. First build compiles Rust (~3-4 min). Subsequent deploys reuse the
# cached layer unless ENGINE_VERSION in modal_app.py is bumped.
modal deploy modal_app.py
```

Modal prints a public URL like:

```
https://policyengine--axiom-engine-web.modal.run
```

Copy it. Verify it works:

```bash
curl https://policyengine--axiom-engine-web.modal.run/health
# → { "ok": true, "binary": "...", "programs": { "co-snap": { "exists": true } } }
```

To re-deploy after a rules-us-co change, bump `ENGINE_VERSION` in `modal_app.py` and run `modal deploy` again.

## 2. Deploy the frontend to Vercel

```bash
# One-time: link this repo to a Vercel project under the PolicyEngine team.
npm i -g vercel
vercel login
vercel link --scope policyengine
# → creates .vercel/project.json with orgId team_xsyTmFLMLGbHH7Qxu70R5G4r
```

Set the two env vars Vercel needs:

```bash
vercel env add OPENAI_API_KEY        # paste the key when prompted, all envs
vercel env add AXIOM_ENGINE_URL      # paste the Modal URL from step 1
# Optional: override the OpenAI model (default is gpt-5.4-mini, see lib/model.ts).
# vercel env add FINBOT_MODEL          # e.g. gpt-5.5, gpt-5.4, gpt-5.1
```

Deploy:

```bash
vercel deploy --prod
# → https://finbot-snap-demo.vercel.app  (or PE's chosen domain)
```

## 3. (Optional) Custom domain

In the Vercel dashboard for the project, **Settings → Domains**. PE's pattern is `<app>.policyengine.org` — for axiom-flavored apps something like `finbot.axiom-foundation.org` may make more sense. Add the CNAME record in the relevant DNS provider.

## Re-deploy cadence

- **Frontend changes** (any code under `src/`): `vercel deploy --prod` (or push to `main` if you wire up auto-deploy in the Vercel project settings — recommended).
- **Engine changes** (new program, `axiom-rules` upgrade, rules content update): bump `ENGINE_VERSION` in `modal_app.py` and run `modal deploy modal_app.py`. The frontend is unaffected; no Vercel redeploy needed.

## Local dev still works

If `AXIOM_ENGINE_URL` is not set, the chat tools spawn the local Rust binary instead. So `bun run dev` after `bun run engine:setup` works without any deployed services.

## Troubleshooting

- **`/api/chat` returns "axiom-engine ..." errors** → the Modal service is down or unreachable. Hit `/health` directly to confirm.
- **`/api/chat` returns "axiom-rules binary not found at..."** → `AXIOM_ENGINE_URL` is unset *and* the local binary isn't built. Either set the env var or run `bun run engine:setup`.
- **Vercel function timeouts** → the chat route is set to 60s, compare to 90s in `vercel.json`. PE's Vercel plan allows up to 300s; bump the values there if you hit a ceiling.
- **Modal cold starts** → `scaledown_window=300` in `modal_app.py` keeps the container warm for 5 min after the last request. First request after a cold period takes ~2-3s; subsequent requests are ~150ms.
