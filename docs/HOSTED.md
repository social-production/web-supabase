# Hosted Supabase (simple beginner guide)

**Stop.** Only do this after:
1. Local smoke passed (`cd web-supabase && npm run smoke`)
2. You finished the manual browser walkthrough in [SIGNOFF.md](./SIGNOFF.md) and marked **Local browser** as Pass

Local setup: [LOCAL_DEV.md](./LOCAL_DEV.md).

---

## What you will do
1. Create a Supabase cloud project
2. Push the database schema + deploy the `gateway` function
3. Point your frontend at the cloud keys
4. Run smoke + the same browser checklist on cloud

Keep FastAPI available as a rollback (see [CUTOVER.md](./CUTOVER.md)).

---

## Step 1 — Create the cloud project
1. Go to https://supabase.com and sign in
2. Create a new project (save the database password)
3. Wait until it is healthy
4. Open **Project Settings → API** and copy:
   - Project URL → `https://YOUR_REF.supabase.co`
   - **Legacy JWT anon key** (`eyJ…`) — not the `sb_publishable_…` key
5. Also create a **CLI access token** (Account → Access Tokens → `sbp_…`)

## Step 2 — Push schema + deploy gateway
From `web-supabase`:

```bash
export SUPABASE_ACCESS_TOKEN=sbp_YOUR_TOKEN
export PROJECT_REF=YOUR_REF
export SUPABASE_ANON_KEY=eyJ_YOUR_HOSTED_ANON_KEY
npm run hosted:rehearsal
```

That one command:
- links the project
- runs `db push`
- deploys `gateway`
- runs smoke against the cloud API

If it fails, fix the error before continuing.

## Step 3 — Auth URLs
In Supabase Dashboard → Authentication → URL configuration:
- **Site URL** = the exact site you will open (for local-against-cloud testing: `http://localhost:5173`)
- **Redirect URLs** = include that same origin
- For early beta you may disable email confirmations

## Step 4 — Point the frontend at cloud
Edit `web/.env.local`:

```bash
VITE_BACKEND=supabase
VITE_SUPABASE_URL=https://YOUR_REF.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ_YOUR_HOSTED_ANON_KEY
VITE_SUPABASE_FUNCTIONS_URL=https://YOUR_REF.supabase.co/functions/v1
VITE_USE_DEV_PROXY=false
```

Restart `npm run dev` (env changes need a restart). Open the Site URL you configured. Sign up a fresh account (cloud data is empty).

## Step 5 — Prove hosted works
1. Smoke should already have passed in Step 2
2. Walk [SIGNOFF.md](./SIGNOFF.md) manual browser rows again against hosted
3. Fill the **Hosted** result row

Only then invite testers.

## Rollback (if hosted breaks)
1. Keep FastAPI running somewhere healthy
2. Change frontend env back to FastAPI and **rebuild/redeploy** (Vite bakes env at build time)
3. Details: [CUTOVER.md](./CUTOVER.md)

## Do not
- Skip local browser signoff
- Use Publishable `sb_…` keys in the frontend
- Invite testers before the Hosted row is Pass
