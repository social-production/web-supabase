# Deploy web-supabase from GitHub `main`

This workspace is the Supabase backend for Social Production. Keep hosted Supabase aligned with the tip of GitHub `main` on the dedicated `web-supabase` repository.

## Topology

| Piece | Home |
|-------|------|
| Schema + Edge `gateway` | This repo (`web-supabase`) → hosted Supabase project |
| Frontend | [`social-production/web`](https://github.com/social-production/web) with `VITE_BACKEND=supabase` |
| FastAPI rollback | [`social-production/web-backend`](https://github.com/social-production/web-backend) on Railway (keep warm) |

## One-time GitHub setup

1. Create a new empty GitHub repo (recommended name: `social-production/web-supabase`).
2. From this directory:

```bash
cd web-supabase
git remote add origin git@github.com:social-production/web-supabase.git
git add -A
git commit -m "Initial web-supabase backend"
git push -u origin main
```

3. In the GitHub repo → **Settings → Secrets and variables → Actions**, add:

| Secret | Value |
|--------|--------|
| `SUPABASE_ACCESS_TOKEN` | Account access token (`sbp_…`) |
| `SUPABASE_PROJECT_REF` | Hosted project ref (`https://<ref>.supabase.co`) |
| `SUPABASE_ANON_KEY` | Hosted **JWT** anon key (`eyJ…`) |

4. Create a GitHub Environment named `hosted` (used by `.github/workflows/deploy.yml`).  
   **Important:** put the three secrets on that **Environment** (Settings → Environments → `hosted`), not only as repository secrets — the deploy job reads `environment: hosted`.
5. Create the hosted Supabase project and configure Auth **Site URL** / **Redirect URLs** for the frontend origin (see [HOSTED.md](./HOSTED.md)).

## Keep frontend auto-updated (Vercel)

The public site is Vercel (`social-production-web`). Link it to GitHub once:

1. Open [Vercel Dashboard](https://vercel.com/dashboard) → project `social-production-web`
2. **Settings → Git** → Connect → `social-production/web` (install the Vercel GitHub App on the org if prompted)
3. Confirm Production Branch = `main`
4. **Settings → Environment Variables** (Production) must include:

```bash
VITE_BACKEND=supabase
VITE_SUPABASE_URL=https://YOUR_REF.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ_YOUR_HOSTED_ANON_KEY
VITE_SUPABASE_FUNCTIONS_URL=https://YOUR_REF.supabase.co/functions/v1
VITE_USE_DEV_PROXY=false
```

After that, every push to `web` `main` rebuilds https://social-production-web.vercel.app automatically.

## What auto-deploys on `main`

[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) on every push to `main`:

1. Structure check + unit tests
2. `supabase link` → `db push` → `functions deploy gateway`

Hosted smoke is **off by default** so production/beta data is not polluted. CI still runs full local smoke. For an intentional hosted dress rehearsal:

```bash
HOSTED_SMOKE=1 npm run hosted:rehearsal
```

## Frontend production build against Supabase

In the `web` repo / Railway service, set **build-time** args:

```bash
VITE_BACKEND=supabase
VITE_SUPABASE_URL=https://YOUR_REF.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ_YOUR_HOSTED_ANON_KEY
VITE_SUPABASE_FUNCTIONS_URL=https://YOUR_REF.supabase.co/functions/v1
```

The `web` Dockerfile accepts those `ARG`s. Rebuild the frontend after any Supabase URL/key change (Vite bakes env at build time).

## Staging vs production

Recommended pattern:

| Environment | Supabase project | GitHub |
|-------------|------------------|--------|
| Staging | Separate project ref | `hosted` environment secrets for staging |
| Production | Separate project ref | Promote by updating production secrets / second environment |

Keep FastAPI Railway deploy warm until hosted browser signoff in [SIGNOFF.md](./SIGNOFF.md) is Pass. Rollback: [CUTOVER.md](./CUTOVER.md).

## Local verification before you trust auto-deploy

```bash
npm run check:structure
npm run test
npm run start && npm run db:reset
# terminal 2
npm run functions:serve
# terminal 3
npm run smoke
```

Then walk the browser matrix in [SIGNOFF.md](./SIGNOFF.md) (or run Playwright E2E from `web`).

## Manual hosted rehearsal (without waiting for Actions)

```bash
export SUPABASE_ACCESS_TOKEN=sbp_...
export PROJECT_REF=YOUR_REF
export SUPABASE_ANON_KEY=eyJ...
npm run hosted:rehearsal
```

## Do not

- Commit `.env.local` or real access tokens
- Deploy to production before local + hosted smoke and browser signoff pass
- Point the production frontend at Supabase while FastAPI is still the intended production backend
