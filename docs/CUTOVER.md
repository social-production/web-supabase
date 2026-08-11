# Production cutover checklist (Supabase)

Use this only after **Hosted** in [SIGNOFF.md](./SIGNOFF.md) is green.

Keep FastAPI deploy config warm the whole time — cutover is a **frontend env flip**, not a delete of `web-backend`.

## Preconditions
- [ ] Local automated gate green (`check:structure`, `web` tests, `web-supabase` tests, expanded smoke)
- [ ] FastAPI baseline still healthy (`docker compose up` + `pytest` when comparing)
- [ ] Hosted schema pushed (`npx supabase db push`)
- [ ] Hosted `gateway` function deployed
- [ ] Hosted Auth Site URL + Redirect URLs match the production frontend origin
- [ ] Hosted smoke passed against `https://<project-ref>.supabase.co`
- [ ] Hosted browser signoff row filled in [SIGNOFF.md](./SIGNOFF.md)

## Frontend production env (build-time)

Set these on the frontend host (Railway / static host / CI secrets). Vite inlines them at **build** time — changing them requires a rebuild/redeploy.

```bash
VITE_BACKEND=supabase
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<hosted JWT anon eyJ… key>
VITE_SUPABASE_FUNCTIONS_URL=https://<project-ref>.supabase.co/functions/v1
```

Do **not** ship `service_role` / `sb_secret_…` to the browser.

Optional: leave FastAPI URL vars unused but present in the host so rollback does not require rediscovering them.

## Immediate post-deploy proof (production URL)
1. `curl` hosted `…/functions/v1/gateway/healthz` with the hosted anon key → `{ ok: true }`
2. Sign up / sign in on the production origin
3. Create thread → vote → nested reply
4. Create private event → confirm logged-out cannot open it
5. Follow + DM between two accounts
6. Help role commit / uncommit
7. Open map / region feed (tile failures are external Carto, not cutover blockers)

Record pass/fail under Hosted / Production notes in [SIGNOFF.md](./SIGNOFF.md).

## Rollback (fast)
1. Set frontend build env back to FastAPI:

```bash
VITE_BACKEND=fastapi
VITE_API_URL=https://<fastapi-production-host>
VITE_USE_DEV_PROXY=false
```

2. Rebuild and redeploy the frontend (required — Vite envs are compile-time).
3. Confirm FastAPI `/healthz` and `/readyz` are healthy before announcing rollback complete.
4. Leave the hosted Supabase project intact for diagnosis; do not delete it during an incident.

## Auth / origin checklist
- Production Site URL in Supabase Auth matches the exact production origin (scheme + host, no trailing slash mismatch).
- Redirect allow-list includes that origin and any preview URLs you still use.
- Remind testers that sessions are **per-origin**; switching between preview and production looks like a logout.

## Related
- Hosted setup: [HOSTED.md](./HOSTED.md)
- Local dual-backend: [LOCAL_DEV.md](./LOCAL_DEV.md)
- Parity notes: [PARITY_AUDIT.md](./PARITY_AUDIT.md)
