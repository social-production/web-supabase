# Parity audit snapshot

Local-first signoff pass (automated). Companion oracle: [FASTAPI_ORACLE.md](./FASTAPI_ORACLE.md).

## Closed for local beta (verified by automation)

- Differentiated feeds including region hard-clip (default 25 km)
- Access filtering on details, votes, comments, reports, search, memberships
- Private events blocked for anonymous + strangers
- Report create + second-account vote; voteSummary + resolution states
- Platform board volunteer + standing vote path
- Closed community invite/redeem; closed community hidden from non-member search
- Nested comments (3+ deep API); neutral content vote; follow approval
- Comment activity on personal + profile feeds
- Project/event action-style lifecycle aliases (plan vote, phase-change vote, activity commitment)
- Event plan overall-vote alias
- Help role commit/uncommit
- DM + follow-up message + group create/rename
- Notification mark-one + mark-all
- Locations create/search/reverse (DB + Nominatim typeahead)
- Tag persistence + scoped/platform feeds
- Pure math parity tests for `required_votes`, moderation floors/boosts, signal 66% gate, region clamp

## Local evidence (2026-08-09)

| Gate | Result |
|------|--------|
| `web-supabase` structure + vitest | Pass |
| Expanded `npm run smoke` | Pass |
| `web` check + vitest | Pass |
| FastAPI `pytest` baseline | **184 passed**, 4 skipped |

Browser rows in [SIGNOFF.md](./SIGNOFF.md) are for the human operator — required before hosted.

## Intentional divergences vs FastAPI (not blockers)

| Area | FastAPI | Supabase |
|------|---------|----------|
| Messaging at rest | Fernet possible | Plaintext (`encryption_version: 0`) |
| Niche software lifecycle | Full routes | Explicit **501** on some edge paths |
| Auth session | HttpOnly cookies + CSRF | JWT in `localStorage` (same-origin) |
| Weekly-active quorum N | Meaningful-actions cache | Membership / user-count fallback + early-platform floor (12) so reports stay active on tiny local installs |
| Map basemap tiles | Carto CDN (same frontend) | Same — external network dependency |
| Report same-request dismiss | May dismiss unreachable under_review immediately | Stays `under_review` on first open unless hide/remove is already met |

Location search is now Nominatim-backed with local DB preference (aligned with FastAPI for typeahead).

## Known remaining depth (document, track in browser/oracle)

- Full hybrid electorate sizing vs FastAPI exact participant math
- Proposal signal gate unlock enforcement on phase advance (counts exist; gate may still be partial)
- Board promote/demote/grace timing under real weekly-active populations (vote path smoked; long grace windows are browser/ops)
- Popularity score weighting differences for moderation boosts

Treat unexplained behavioral gaps outside the intentional table as blockers.

## Hosted gate
Local automated Pass **and** Local browser Pass → then [HOSTED.md](./HOSTED.md).
