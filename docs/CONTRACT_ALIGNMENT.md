# Contract alignment

This workspace implements the frontend provider contract via Supabase Auth + Postgres + the `gateway` Edge Function.

## Frontend seams that must stay stable

| Seam | Path in `web` |
|------|----------------|
| `AppAdapter` | `src/lib/services/adapters/types.ts` |
| Session transport | `src/lib/services/sessionTransport.ts` |
| Error transport | `src/lib/services/errorTransport.ts` |
| Shared product types | `src/lib/types/*` |
| Supabase driver package | `src/lib/api/drivers/supabase/` |

## Runtime mapping

| Concern | Implementation |
|---------|----------------|
| Session | Supabase Auth JWT (`access_token` / `refresh_token` in browser storage) |
| Orchestration | `supabase/functions/gateway` |
| Data | `supabase/migrations/*` Postgres schema |
| Access control | RLS policies + service-role orchestration in gateway |
| Wire shape | camelCase AppAdapter payloads from gateway |

## Smoke checklist (from PROVIDER_CONTRACTS.md)

A Supabase backend is ready for frontend `status: ready` only when it can:

1. Restore authenticated session (or clearly report anonymous)
2. Load bootstrap + unread counts
3. Paginate public / home / personal feeds (`FeedPageResult`)
4. Enforce closed-community / private-event visibility
5. Surface moderation states
6. Search with access filtering
7. Messaging + linked-chat comments
8. Notification mark-read coherence
9. Explicit governance entity types on vote / comment / report

## Domain map

| Backend ownership | Frontend driver domain | Gateway routes |
|-------------------|------------------------|----------------|
| `src/auth` | `domains/auth.ts` | Auth REST `/auth/v1/*` |
| `src/bootstrap` | `domains/bootstrap.ts` | `/bootstrap`, `/bootstrap/summary` |
| `src/feeds` | `domains/feeds.ts` | `/feeds/*`, `/map/markers` |
| `src/content` | `domains/content.ts` | `/content/*`, `/governance/*` |
| `src/projects` | `domains/projects.ts` | `/projects/*` |
| `src/events` | `domains/events.ts` | `/events/*` |
| `src/helpRequests` | `domains/helpRequests.ts` | `/help-requests/*` |
| `src/messages` | `domains/messages.ts` | `/messages/*` |
| `src/notifications` | `domains/notifications.ts` | `/notifications/*` |
| `src/scopes` | `domains/scopes.ts` | `/scopes/*` |
| `src/users` | `domains/users.ts` | `/users/*` |
| `src/search` | `domains/search.ts` | `/search` |
| `src/locations` | `domains/locations.ts` | `/locations/*` |

Validate with `web` contract tests and local smoke (`npm run start` + `functions:serve` + `VITE_BACKEND=supabase`).
