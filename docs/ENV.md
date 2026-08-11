# Environment contract — web-supabase

## Local (Supabase CLI)

After `npm run start` in this workspace, print JWT keys with:

```bash
npm run status:env
# equivalent: npm run status -- -o env
```

Use the `ANON_KEY` / `SERVICE_ROLE_KEY` lines (`eyJ…`). Do **not** paste the Publishable/Secret `sb_…` values into app env files.

For a human-readable overview (not for env files):

```bash
npm run status:pretty
```

| Variable | Where used | Notes |
|----------|------------|-------|
| `API_URL` | `VITE_SUPABASE_URL` in `web` | e.g. `http://127.0.0.1:54321` |
| `ANON_KEY` | `VITE_SUPABASE_ANON_KEY` in `web` | Public JWT client key |
| `SERVICE_ROLE_KEY` | Edge Functions / seed only | Never expose to browser |
| `DB_URL` | migrations / psql | Local Postgres |

Copy into `web/.env.local` (no quotes, no angle brackets):

```bash
VITE_BACKEND=supabase
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0
VITE_SUPABASE_FUNCTIONS_URL=http://127.0.0.1:54321/functions/v1
VITE_USE_DEV_PROXY=false
```

Copy into `web-supabase/.env.local` for function serve / seed **before** `npm run functions:serve`:

```bash
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU
```

Those demo JWT values match the default local Supabase stack. Prefer copying from `status:env` if yours differ.

Canonical frontend URL for local Supabase: `http://localhost:5173` (not the LAN Network URL).

## Hosted Supabase project

Same variable names; use the project URL and JWT anon / service_role keys from the Supabase dashboard (not publishable/secret `sb_…` unless you have confirmed the client accepts them).
Site URL / redirect URLs must include the frontend origin.

Committed template: [`.env.example`](../.env.example). Copy to `.env.local` for local serve/seed; never commit real tokens.

### GitHub Actions secrets (deploy on `main`)

| Secret | Used by |
|--------|---------|
| `SUPABASE_ACCESS_TOKEN` | CLI `link` / `db push` / `functions deploy` |
| `SUPABASE_PROJECT_REF` | Hosted project ref |
| `SUPABASE_ANON_KEY` | Hosted smoke JWT anon key |

See [DEPLOYMENT.md](./DEPLOYMENT.md).

## Frontend build switch

```bash
VITE_BACKEND=supabase npm run build
```

Only when the **frontend provider registry** marks `supabase` as `ready` (see `web/src/lib/api/drivers/registry.ts`), not based on `supabase status`.
