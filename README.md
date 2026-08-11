# web-supabase

Supabase backend for Social Production — **Auth + Postgres + RLS + Edge Functions gateway**.

Status: **local parity signoff automated gate green**; hosted dress rehearsal via `npm run hosted:rehearsal`. Use with:


```bash
# web-supabase
npm run start
npm run db:reset
npm run functions:serve

# web/.env.local — JWT anon key from `npm run status:env` (not Publishable/Secret)
VITE_BACKEND=supabase
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<ANON_KEY eyJ… from status:env>
VITE_SUPABASE_FUNCTIONS_URL=http://127.0.0.1:54321/functions/v1
VITE_USE_DEV_PROXY=false
```

Beginner walkthrough: [`docs/LOCAL_DEV.md`](docs/LOCAL_DEV.md) (includes stop / clean-slate wipe).

## Architecture

```
web (VITE_BACKEND=supabase)
  → src/lib/api/drivers/supabase/*
      → Supabase Auth (session)
      → Edge Function `gateway` (BFF / AppAdapter orchestration)
          → Postgres + RLS
```

Edge Functions are the canonical orchestration surface for parity-critical flows (feeds, governance, messaging, lifecycle mutations, unread counts, invites, etc.). The frontend does not query raw tables.

## Contracts (do not fork)

| Doc | Location |
|-----|----------|
| Product contract | [`../web/docs/PROVIDER_CONTRACTS.md`](../web/docs/PROVIDER_CONTRACTS.md) |
| Implementation checklist | [`../web/docs/PROVIDER_IMPLEMENTATION_CHECKLIST.md`](../web/docs/PROVIDER_IMPLEMENTATION_CHECKLIST.md) |
| Frontend driver | [`../web/src/lib/api/drivers/supabase/`](../web/src/lib/api/drivers/supabase/) |
| Env contract | [`docs/ENV.md`](docs/ENV.md) |
| Local dev | [`docs/LOCAL_DEV.md`](docs/LOCAL_DEV.md) |
| Alignment notes | [`docs/CONTRACT_ALIGNMENT.md`](docs/CONTRACT_ALIGNMENT.md) |

## Layout

```
web-supabase/
  package.json
  supabase/
    config.toml
    migrations/          # canonical relational schema
    functions/
      gateway/           # single BFF entrypoint
      _shared/           # handlers + http helpers
  scripts/
    seed.mjs
    check-structure.mjs
  docs/
  src/<domain>/README.md # domain ownership notes
```

## Scripts

```bash
npm run start            # supabase start
npm run stop             # stop stack, keep DB volumes
npm run stop:clean       # stop stack and delete DB volumes
npm run status:env       # JWT keys for .env files
npm run status:pretty    # human-readable status
npm run db:reset         # apply migrations (does not seed demo users)
npm run functions:serve  # serve all Edge Functions (app uses gateway)
npm run seed             # optional demo data (requires .env.local)
npm run check:structure
npm run smoke
npm run hosted:rehearsal # needs SUPABASE_ACCESS_TOKEN + PROJECT_REF + SUPABASE_ANON_KEY
```

Docs: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) (GitHub `main` → hosted Supabase), [`docs/HOSTED.md`](docs/HOSTED.md), [`docs/CUTOVER.md`](docs/CUTOVER.md), [`docs/SIGNOFF.md`](docs/SIGNOFF.md), [`docs/PARITY_AUDIT.md`](docs/PARITY_AUDIT.md), [`docs/FEATURE_MATRIX.md`](docs/FEATURE_MATRIX.md).

## GitHub + auto-deploy

This directory is its own git repository. Push to `main` on the dedicated GitHub remote to:

1. Run CI (structure + unit + local smoke) via [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
2. Deploy migrations + `gateway` and run hosted smoke via [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)

Full setup (remote, secrets, frontend build args): [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Auth mapping

App usernames map to synthetic emails `username@users.socialproduction.com` for Supabase Auth (hosted Auth rejects `.local` addresses). A trigger `handle_new_auth_user` creates the `public.users` row **and** a default `public.user_settings` row with the same UUID as `auth.users.id`. The special `platform` channel is seeded by migration `20260806000005_seed_platform_channel.sql`.
