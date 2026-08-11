# Local development guide (beginner)

This guide gets Social Production running on your computer against **local Supabase**.
You do **not** need a cloud account for this.

When local tests pass, you can later follow [HOSTED.md](./HOSTED.md). Do hosted only after local is green.

## What you need
- Docker running
- Node.js 20+ and npm
- `curl` and `python3` (for smoke tests)
- About 4 GB free RAM

## Folders (from the repo root)
| Folder | Role |
|--------|------|
| `web-supabase/` | Local Auth + Postgres + gateway |
| `web/` | Frontend (the app you open in the browser) |
| `web-backend/` | FastAPI (optional second backend you can switch to) |

## Quick path (copy/paste)

Open **three terminals**. Order matters.

### Terminal 1 — Supabase database

Create `web-supabase/.env.local` **first** (paste exactly; no quotes):

```bash
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU
```

Then:

```bash
cd web-supabase
npm install
npm run start
npm run db:reset
```

### Terminal 2 — Gateway (must stay running)

```bash
cd web-supabase
npm run functions:serve
```

Leave this open. Warnings like `Env name cannot start with SUPABASE_, skipping` are normal.

### Terminal 3 — Frontend

Create `web/.env.local`:

```bash
VITE_BACKEND=supabase
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0
VITE_SUPABASE_FUNCTIONS_URL=http://127.0.0.1:54321/functions/v1
VITE_USE_DEV_PROXY=false
```

Then:

```bash
cd web
npm install
npm run dev
```

**Any time you edit `web/.env.local`, restart `npm run dev`.** Vite reads env only at startup.

In Supabase DEV, the browser talks to **same-origin** `http://localhost:5173/functions/v1/...` (and `/auth/v1/...`). Vite proxies those to `127.0.0.1:54321`. Direct browser → `:54321` is what previously caused “always 503” on some browsers / LAN origins.

`npm run dev` now **fails fast** if `VITE_BACKEND=supabase` and the gateway health check fails — fix Terminal 2 before the browser shows a 503.

Open **only**: [http://localhost:5173](http://localhost:5173)

Do **not** use `127.0.0.1:5173` or a LAN IP for daily Supabase testing. Auth is stored per website address; mixing addresses looks like you are “randomly logged out.”

## Preflight (do this before blaming the app)

If the browser shows `503 Could not reach the server`, run these in order:

```bash
# 1) Is Supabase Docker up?
cd web-supabase && npm run status:env

# 2) Is the gateway answering?
curl -fsS \
  -H "apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0" \
  http://127.0.0.1:54321/functions/v1/gateway/healthz
```

You want: `{"ok":true,"provider":"supabase","service":"gateway"}`.

| Preflight result | What to do |
|------------------|------------|
| `status:env` fails / Docker down | Terminal 1: `npm run start` then `npm run db:reset` |
| `healthz` connection refused / 503 | Terminal 2 must be running: `npm run functions:serve` |
| `healthz` flaky / intermittent 503 | Likely **two** gateways — follow **Clean restart** below |
| `healthz` OK but browser still 503 | Confirm `web/.env.local` has `VITE_BACKEND=supabase` and **restart** Terminal 3; use only `http://localhost:5173` |
| Browser Network tab hits `/bootstrap` on `:5173` | Still on FastAPI mode — fix env + restart Vite |

## Automated check (still with Terminal 2 running)

```bash
cd web-supabase
npm run check:structure
npm run test
npm run smoke
```

You want: `Smoke OK — full signoff matrix passed`.

Then:

```bash
cd web
npm run check
npm run test
```

## Your manual browser test (do this after smoke passes)

Follow the step-by-step list in [SIGNOFF.md](./SIGNOFF.md) → **Manual browser pass (beginner walkthrough)**.

Use **two browsers** (or one normal + one private window) so you can be two users (A and B).

High-risk things you must personally click:
- private event is hidden when logged out / as a stranger
- plan vote and phase-change vote do not show errors
- spam report + second user votes on the report
- Platform page: volunteer + moderator standing vote
- help role commit / uncommit
- DM + group chat
- **reply chains** (comment → reply → reply-to-reply)
- profile / personal feed show **comment activity**, not only “started a thread”
- map place search suggestions while typing (needs internet for Nominatim)
- create FAB visible when scrolling channel/community feeds

## Switching to FastAPI (optional)

Edit `web/.env.local` to:

```bash
VITE_BACKEND=fastapi
VITE_USE_DEV_PROXY=true
```

Start FastAPI if needed:

```bash
cd web-backend
docker compose up -d
```

**Restart** `npm run dev`. Data on FastAPI is **separate** from Supabase.

To switch back to Supabase, put the Supabase block from Terminal 3 back into `web/.env.local` and restart Vite again.

More detail: [`../../web/docs/BACKEND_SWITCHING.md`](../../web/docs/BACKEND_SWITCHING.md)

## Stopping

| What | How |
|------|-----|
| Frontend | `Ctrl+C` in the `web` terminal |
| Gateway | `Ctrl+C` in the `functions:serve` terminal |
| Supabase Docker | `cd web-supabase && npm run stop` |
| FastAPI | `cd web-backend && docker compose down` |

## Clean restart (kill duplicate gateways)

Running **two** `npm run functions:serve` at once (or restarting one while another is still dying) is the usual cause of “always 503” on localhost. The browser hits `gateway/bootstrap` while edge runtimes race over the `supabase_edge_runtime_web-supabase` container.

Keep `web/scripts/dev.sh` gateway preflight (it refuses to start Vite if `healthz` fails). When the stack feels stuck, stop Vite and every serve, remove the leftover edge container, then bring **one** gateway and **one** Vite back up:

```bash
# From repo root — stop frontend + all gateway serves, then clear leftover edge runtime
pkill -f 'vite dev --port 5173' 2>/dev/null || true
pkill -f 'supabase@latest functions serve' 2>/dev/null || true
docker rm -f supabase_edge_runtime_web-supabase 2>/dev/null || true

# Confirm idle (both should fail to connect)
curl -fsS --connect-timeout 2 http://localhost:5173/ && echo 'vite still up' || echo 'vite down OK'
curl -fsS --connect-timeout 2 \
  -H "apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0" \
  http://127.0.0.1:54321/functions/v1/gateway/healthz \
  && echo 'gateway still up' || echo 'gateway down OK'

# Terminal A — start exactly one gateway and wait until it prints “Serving functions”
cd web-supabase && npm run functions:serve

# Terminal B — only after healthz is OK
cd web && npm run dev
```

Then open **only** [http://localhost:5173](http://localhost:5173) and hard-refresh once. Do not start a second `functions:serve` while the first is still running.

## Clean slate (wipe local Supabase data)

```bash
# stop frontend + gateway first (Ctrl+C)
cd web-supabase
npm run stop:clean
docker rm -f supabase_edge_runtime_web-supabase 2>/dev/null || true
npm run start
npm run db:reset
# recreate .env.local if missing, then:
npm run functions:serve
```

Then restart `cd web && npm run dev`, clear browser site data for localhost, and sign up again.

## Common failures

| Symptom | Fix |
|---------|-----|
| `./.env.local: not found` | Create `web-supabase/.env.local` **before** `functions:serve` |
| Gateway / browser `503` | Run the **Preflight** section above |
| “Always 503” / flaky bootstrap while curls sometimes work | Duplicate `functions:serve` — use **Clean restart** above |
| Auth weird / blank settings | Stay on `http://localhost:5173`; clear site data; restart Vite |
| Pasted `sb_…` key | Wrong key — use the long `eyJ…` JWT anon key |
| Edge runtime name conflict | `docker rm -f supabase_edge_runtime_web-supabase` then **one** `functions:serve` |
| Map tiles error | External Carto basemap network issue — app auth still works |
| Place search empty / no suggestions | Needs internet for Nominatim; tiles and search are separate |
| Still talking to FastAPI | Confirm `VITE_BACKEND=supabase` and restart Vite |
| Deep replies fail after first reply | Fixed by passing `subjectType` in nested comment UI — restart Vite after pull |

## Maps note (two different things)

1. **Basemap tiles** come from Carto on the public internet. If DNS/firewall/VPN blocks them, you see a tile warning. Feeds/auth can still work.
2. **Place typeahead** uses Nominatim (same idea as FastAPI). Local DB matches are preferred first; external results fill gaps. Offline, only previously saved places appear.

## Keys note
`npm run status:pretty` shows Publishable/Secret `sb_…` values — **do not** put those in the app.
Use `npm run status:env` and copy `ANON_KEY` / `SERVICE_ROLE_KEY` (`eyJ…`).

## Next docs
- Manual + automated checklist: [SIGNOFF.md](./SIGNOFF.md)
- FastAPI math/rules oracle: [FASTAPI_ORACLE.md](./FASTAPI_ORACLE.md)
- Parity notes: [PARITY_AUDIT.md](./PARITY_AUDIT.md)
- Hosted (only after local pass): [HOSTED.md](./HOSTED.md)
- Production flip: [CUTOVER.md](./CUTOVER.md)
