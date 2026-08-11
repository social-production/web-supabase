# Supabase signoff matrix

Do **local** first. Do **hosted** only after Local is Pass.

Automated half = `npm run smoke` (+ unit tests).
Manual half = browser walkthrough below (beginner-friendly).

## Automated (`npm run smoke` + tests)

- [x] Health
- [x] Anonymous bootstrap + public/region feeds + map markers
- [x] Sign-up (two users) + wrong-password failure
- [x] Authenticated bootstrap + settings profile fields
- [x] Thread create, upvote, downvote, **clear/neutral vote**, nested comments (3 deep) + **comment activity** on personal/profile
- [x] Report create + **second-account report vote** + **detail/feed rehydration**
- [x] Follow approval (pending → accept) + unfollow + follow
- [x] Project create, membership, signal (**add/remove toggle + FastAPI-shaped response**), values, production plan, activity, detail lifecycle
- [x] Project aliases: `plans/overall-vote`, `phase-change/vote`, `activities/commitment` (not 501)
- [x] Public event + event signal + event `plans/overall-vote` alias
- [x] Private event (owner + invitee ok; anonymous blocked; organizer-controlled seeds activity + plan)
- [x] Plan detail contract: `overallApproval`, `planPhases`, `criterionAssessments`; distribution plans bucket to phaseThree
- [x] Activity create with roles + commitment hydration
- [x] Help request role commit / uncommit
- [x] Scoped channel feed + platform feed include tagged content
- [x] Personal feed + profile shapes
- [x] DM + reply into existing conversation + mark read
- [x] Group chat create/rename
- [x] Notifications list + mark-one (when present) + mark-all-read
- [x] Channel + closed community create
- [x] Platform join + volunteer + **moderator standing vote**
- [x] Closed community invite + redeem
- [x] Locations create + search + reverse (+ Nominatim typeahead fill)
- [x] Search results structure + closed community hidden from non-member
- [x] Home feed contains created thread
- [x] Lifecycle phase **mechanics** present on project/event detail
- [x] Direct `phase/advance` uses FastAPI next-phase order (not stubbed phase-1→2→3→closed)
- [x] Close + **convert** creates successor + conversion lineage on detail
- [x] Manual link sever / service settings-change / history completion are **not 501**
- [x] Detail hydrates `updateRequests`, `editRequests`, `linksFrame`, `history`
- [x] Feature inventory documented in [FEATURE_MATRIX.md](./FEATURE_MATRIX.md)
- [x] GitHub Actions CI + deploy-on-`main` workflows present (see [DEPLOYMENT.md](./DEPLOYMENT.md))

Local automated run: **2026-08-11 — Pass** (release-readiness smoke + unit tests).

Also green the same day:
| Gate | Result |
|------|--------|
| `web-supabase` `check:structure` + `npm test` | **Pass** (9 tests) |
| `web-supabase` `npm run smoke` | **Pass** (includes convert/advance/sever/hydration) |
| `web` Playwright `npm run test:e2e` | **Pass** (5 browser tests) |
| `web-backend` `pytest` (FastAPI baseline) | **184 passed**, 4 skipped |

Reference rules: [FASTAPI_ORACLE.md](./FASTAPI_ORACLE.md).

---

## Manual browser pass (beginner walkthrough)

Do this on [http://localhost:5173](http://localhost:5173) with Supabase mode on.
Use **two browsers** (or one normal + one private window):

- Browser A = user A
- Browser B = user B

Tick each box as you go. If something fails, write a short note.

### 0. Setup
- [ ] Terminals running: Supabase start, `functions:serve`, `npm run dev`
- [ ] You are on `http://localhost:5173` (not a LAN IP)
- [ ] Smoke already passed today

### 1. Auth (Browser A)
- [ ] Open **Sign in / Sign up** → create user A
- [ ] Sign out
- [ ] Sign in again
- [ ] Refresh the page — you stay signed in

### 2. Basic feeds + create (Browser A)
- [ ] Public feed loads
- [ ] Create a **thread** with a channel tag
- [ ] Home feed shows it
- [ ] Open the thread detail
- [ ] Upvote, downvote, then clear vote (neutral) — counts look sane
- [ ] Add a comment, then a **reply to that comment**
- [ ] Reply again **under that reply** (third level) — must succeed, not silently fail
- [ ] Open your **profile** and **Personal** feed — you should see comment activity (not only “started a thread”)
- [ ] Open a **channel** feed, scroll — the create FAB stays usable as chrome collapses
- [ ] Left rail **Networks**: Platform always shown; only channels/communities you joined appear (not every public scope)

### 3. Second user social (Browser B)
- [ ] Sign up as user B
- [ ] Follow user A (if A requires approval: approve from A, then continue)
- [ ] As A, create a **followers-only post** — B (following) can see it; a logged-out window cannot

### 4. Private event privacy (high risk)
- [ ] As A, create a **private invite-only** event and invite B
- [ ] As A, open it — OK; invited usernames hydrate
- [ ] As B (invited) — can open it
- [ ] Logged out — cannot open it (404 / not found), and it does not appear in public feed
- [ ] As A, create an **organizer-controlled** private event with schedule + plan stages — detail opens in **Activity** with a seeded leading plan
- [ ] Organizer phase change applies immediately (no member vote required)

### 5. Project + event lifecycle (high risk)
- [ ] As A, create a **productive** project, join it, signal demand — feed card shows a **support %** (not `—`)
- [ ] Also create **personal-service** and **collective-service** projects — detail pages load
- [ ] Add a value and **rate importance** (1–10) — refresh detail; your rating still shows
- [ ] Open **create plan** wizard: Direct Use notice has clear gap before “What is this plan called…”; location step shows the search input without awkward desktop scrolling
- [ ] Add a production plan — it appears under the planning phase with vote controls; cast overall vote — refresh; vote still shows; clearing vote works
- [ ] In plan assessment, cast a value vote and a criterion rating — no 501
- [ ] Add a **distribution** plan — it appears under distribution (phase 3), not production
- [ ] Create an activity with roles, commit to a role — detail shows filled role / committed state
- [ ] Request **advance** to the next phase and cast yes — request appears with your vote; second member yes advances the phase
- [ ] Request **return** to an earlier phase (`phase/revert`) and vote it through — phase returns; revert history updates
- [ ] Request **close + convert** — after electorate passes, predecessor is closed and successor project + conversion lineage appear on Links
- [ ] Propose a **manual link**, vote it through, then **sever** — sever is not 501; open sever request appears
- [ ] As A, create a **public event**, add a value + plan, rate importance, vote overall — votes stick after refresh
- [ ] Event phase advance + return requests hydrate and pass when members vote yes
- [ ] As A, create a **private** event and confirm lifecycle still loads for the creator
- [ ] Software project (optional): software governance panel loads; merge-capability / repository-replacement are not 501
- [ ] Personal/collective service: settings-change and service-history completion are not 501
### 6. Help requests
- [ ] As A, create a help request with a role
- [ ] As B, commit to the role, then uncommit

### 7. Moderation (high risk)
- [ ] As A, report a thread as spam
- [ ] As B, open the report / moderation UI and vote **yes**
- [ ] Resolution moves at least to `under_review` (or further) and vote summary updates
- [ ] If content becomes hidden/removed, feed/detail show a moderated state (not a crash)

### 8. Platform board (high risk)
- [ ] As A, open Platform, join if needed, **volunteer** for the board
- [ ] As B, cast a **moderator standing vote** on A
- [ ] Platform page still loads; A appears as candidate or moderator with vote counts

### 9. Scopes / invites
- [ ] Create/browse a channel
- [ ] Create a **closed** community
- [ ] Invite B (invite link/code) and redeem as B
- [ ] As a third signed-out or non-member user, search does **not** reveal the closed community

### 10. Messaging + notifications
- [ ] A starts a DM to B; B replies
- [ ] Create a group chat, rename it
- [ ] A notification appears for some action; mark one read; mark all read; unread badge drops

### 11. Search + locations + map
- [ ] Search finds your Smoke / created titles
- [ ] On a create form or map Place box, type 3+ letters — suggestions appear (needs internet for Nominatim)
- [ ] Pick a suggestion / reverse / attach location on a create form
- [ ] Region/map opens; if map **tiles** fail, that is external Carto — not a backend fail (search can still work)

### 12. Backend switch sanity (optional but recommended)
- [ ] Flip `web/.env.local` to FastAPI, restart Vite, confirm FastAPI feed loads (separate data)
- [ ] Flip back to Supabase, restart Vite, confirm Supabase data is still there

---

## Result
| Environment | Date | Operator | Pass? | Notes |
|-------------|------|----------|-------|-------|
| Local automated | 2026-08-11 | agent | **Pass** | Release-readiness: convert/advance/sever/hydration + Playwright harness |
| Local browser | | **you** | | Walk the beginner section above; also `cd web && npm run test:e2e` |
| Hosted | | | | Only after Local browser Pass — see [HOSTED.md](./HOSTED.md) and [DEPLOYMENT.md](./DEPLOYMENT.md) |

Do not invite beta testers until **Hosted** is Pass.
