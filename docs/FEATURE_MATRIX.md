# Feature matrix — platform functions and how to test them

Canonical inventory of frontend-visible Social Production flows for the Supabase backend.  
Oracle: FastAPI under `web-backend`. Implementation: `web-supabase` gateway + `_shared/*`.  
Automation: `npm run smoke` (API), Playwright E2E in `web` (browser), manual rows in [SIGNOFF.md](./SIGNOFF.md).

## Legend

| Column | Meaning |
|--------|---------|
| Journey | User-visible flow |
| Gateway / owner | Primary Supabase code |
| API smoke | Covered by `scripts/smoke.sh` |
| Browser E2E | Covered by Playwright |
| Manual | Needs human / SIGNOFF |

## Auth and shell

| Journey | Gateway / owner | API smoke | Browser E2E | Manual |
|---------|-----------------|-----------|--------------|--------|
| Sign up / sign in / sign out | Supabase Auth + `users` trigger | yes | yes | yes |
| Bootstrap / left rail membership | `handlers.handleBootstrap` | yes | yes | yes |
| Notifications read / read-all | `handlers` | yes | partial | yes |
| Search + map markers | `handlers` / `map` | yes | partial | yes |
| Profile + settings | `handlers` | yes | partial | yes |

## Scopes and platform board

| Journey | Gateway / owner | API smoke | Browser E2E | Manual |
|---------|-----------------|-----------|--------------|--------|
| Create/join channel or community | `mutations` + membership | yes | yes | yes |
| Closed community visibility | `access` + search | yes | partial | yes |
| Platform volunteer + moderator vote | `board.ts` | yes | yes | yes |
| Invites create/redeem | `mutations` | yes | partial | yes |

## Projects (all modes)

Modes: `productive`, `collective-service`, `personal-service`. Subtypes: `standard`, `software`.

| Journey | Gateway / owner | API smoke | Browser E2E | Manual |
|---------|-----------------|-----------|--------------|--------|
| Create project (each mode) | `POST /projects` | yes | yes | yes |
| Signals support/oppose + feed favorability | `mutations` + `feeds` | yes | yes | yes |
| Values + importance votes | `lifecycle` + `detail` | yes | yes | yes |
| Phase-change request + vote | `mutations` / `lifecycle` | yes | yes | yes |
| Phase advance / revert | `mutations.advanceProjectPhase` | yes | partial | yes |
| Close + convert execution | `conversion.ts` | yes | partial | yes |
| Production/distribution plans create | `mutations` | yes | yes | yes |
| Plan overall / value / criterion votes | `lifecycle` | yes | yes | yes |
| Updates + update-request votes | gateway + `lifecycle` | yes | yes | yes |
| Edit proposals + votes | gateway + `lifecycle` | yes | yes | yes |
| Activities commit/rate | `lifecycle` | yes | yes | yes |
| Manual links create/vote/sever | `lifecycle` | yes | partial | yes |
| Links frame + conversion lineage hydrate | `detail.buildLinksFrame` | yes | partial | yes |
| Software PR / merge-capability / repo replacement | `lifecycle` | yes | partial | yes |
| Service requests + settings-change + history completion | `lifecycle` | yes | partial | yes |

## Events

| Journey | Gateway / owner | API smoke | Browser E2E | Manual |
|---------|-----------------|-----------|--------------|--------|
| Public event create | `mutations.createEvent` | yes | yes | yes |
| Private / private-community / organizer-controlled | `mutations.createEvent` | yes | yes | yes |
| Invitees + editors hydrate | gateway GET event | yes | yes | yes |
| Signals + values + plans + votes | same as projects | yes | yes | yes |
| Phase change (collaborative + organizer auto-apply) | `mutations` / `lifecycle` | yes | yes | yes |
| Activities + history completion | `lifecycle.toggleEventHistoryCompletion` | yes | partial | yes |
| Manual links + sever | `lifecycle` | yes | partial | yes |

## Collaboration

| Journey | Gateway / owner | API smoke | Browser E2E | Manual |
|---------|-----------------|-----------|--------------|--------|
| Help request create + role commit/uncommit | gateway + `mutations` | yes | yes | yes |
| Direct messages | `mutations` | yes | yes | yes |
| Group chat create/rename/members | `mutations` | yes | yes | yes |
| Linked chats read | `handlers.handleLinkedChats` | yes | partial | yes |
| Content threads/posts + governance votes | `handlers` | yes | partial | yes |
| Reports create + vote | `moderation` | yes | yes | yes |

## Create-plan UX

| Journey | Owner | API smoke | Browser E2E | Manual |
|---------|-------|-----------|--------------|--------|
| Policy notice gap before first question | `PlanCreationWizard.svelte` | n/a | yes | yes |
| Location search visible without awkward desktop scroll | `LocationPicker` + `PlanWizardShell` | n/a | yes | yes |

## How to run the full automated suite

```bash
# Terminal 1 — Supabase
cd web-supabase && npm run start && npm run db:reset && npm run functions:serve

# Terminal 2 — API smoke
cd web-supabase && npm run smoke

# Terminal 3 — Frontend + browser E2E
cd web
# ensure .env.local points at local Supabase
npm run test:e2e
```

Hosted: `npm run hosted:rehearsal` then Playwright against the hosted Site URL (set `E2E_BASE_URL`).
