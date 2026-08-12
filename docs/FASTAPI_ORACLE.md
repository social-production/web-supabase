# FastAPI Behavioral Oracle

Source of truth for governance / moderation / lifecycle math. FastAPI paths are authoritative; Supabase `_shared` ports are compared for parity. Numbers quoted from code as of the local-first signoff pass.

Companion: [PARITY_AUDIT.md](./PARITY_AUDIT.md). Use this doc when extending smoke or deciding whether a Supabase divergence is a blocker.

---

## 1. Required votes (`required_votes`)

| | FastAPI | Supabase |
|---|---|---|
| Path | `web-backend/app/utils/votes.py` | `web-supabase/supabase/functions/_shared/votes.ts` → `requiredVotes` |
| Status | **Oracle** | Formula match |

```
if n <= 0: return 0
if n < 100:   error_margin = 0.10 - (0.03 * (n - 1) / 99)
elif n < 500: error_margin = 0.07 - (0.02 * (n - 100) / 400)
else:         error_margin = max(0.02, 0.05 - 0.03 * log10(n / 500) / log10(2000))

base_sample_size = 0.9604 / (error_margin ** 2)
cochran = ceil(base_sample_size / (1 + (base_sample_size - 1) / n))
return min(ceil(0.75 * n), cochran)
```

**Population N (governance / plans / board):**
- Platform-tagged project/event → global weekly actives (`meaningful_actions` last 7 days).
- Else project → weekly-active **project members**; event → weekly-active **event members**.
- Platform channel slug: `"platform"`.

**Vote eligibility:** platform-tagged → any signed-in user; else membership required.

**Approval rule everywhere:** `voteCount >= requiredVotes(N)` **and** `approvalRatio >= 0.66`.

**Supabase note:** ordinary project/event quorum uses N = weekly actives within membership, then `requiredVotes(N)`. Platform-tagged items use platform weekly actives as N.

---

## 2. Moderation thresholds

| | FastAPI | Supabase |
|---|---|---|
| Path | `web-backend/app/services/moderation/thresholds.py` | `web-supabase/supabase/functions/_shared/moderation.ts` |
| Status | **Oracle** | Threshold math match; audience sizing may differ |

### Floors / caps

| Constant | Value |
|---|---|
| `MIN_NON_DM_DELETE_QUORUM` | `3` |
| `MIN_SERIOUS_HARM_HIDE_QUORUM` | `3` |
| `MIN_SERIOUS_HARM_DELETE_QUORUM` | `5` |
| `MIN_APPROVAL_SHARE` | `0.66` |
| Tiny private DM | `target_type == "message"` **and** `audience_size <= 1` → quorum `1` |
| Spam delete yes-share cap | `min(0.90, …)` |
| Serious-harm delete yes-share cap | `min(0.85, …)` |
| Serious-harm hide yes-share cap | `min(0.80, …)` |

### Age boost (`age_boost_percent`) — percentage points above 66%

| `age_days` | Boost |
|---|---|
| `< 1` | `0` |
| `< 7` | `10` |
| `< 30` | `20` |
| `< 180` | `30` |
| else | `35` |

### Popularity boost (`popularity_boost_percent`)

| `score` | Boost |
|---|---|
| `< 2` | `0` |
| `< 8` | `5` |
| `< 20` | `10` |
| `< 50` | `15` |
| else | `20` |

### Yes-share formulas

- **Delete (spam):** `min(0.90, 0.66 + (age + popularity) / 100)`
- **Delete (serious-harm):** `boost = (age + popularity) // 2`; `min(0.85, 0.66 + boost / 100)`
- **Hide (serious-harm only):** `boost = (age + popularity) // 4`; `min(0.80, 0.66 + boost / 100)`

### Pass predicates

- Deletion ready: `total >= delete_quorum` **and** `yes / total >= delete_share`
- Hide ready: reason is `serious-harm` **and** `total >= hide_quorum` **and** `yes / total >= hide_share`

### State machine

`open` → first eligible **yes** → `under_review` → (serious-harm) `hidden` → `removed` / `dismissed`.

---

## 3. Hybrid electorates

| | FastAPI | Supabase |
|---|---|---|
| Path | `web-backend/app/services/moderation/electorates.py` | Approximated in `moderation.ts` |
| Status | **Oracle** | Simplified audience sizing |

- `MIN_ENGAGED_PUBLIC_FLOOR = 3`
- Hybrid size: `engaged = max(member_population, participant_count, voter_count)`; if `public_surface and engaged > 1` → `max(engaged, 3)`
- Exclude reported author from electorate size when present
- Popularity score (FastAPI): `unique_voters + unique_commenters * 2`

---

## 4. Platform board

| | FastAPI | Supabase |
|---|---|---|
| Path | `web-backend/app/services/board.py` | `web-supabase/supabase/functions/_shared/board.ts` |
| Status | **Oracle** | Standing / grace / promote / demote ported |

| Constant | Value |
|---|---|
| `MIN_APPROVAL_RATIO` | `0.66` |
| `GRACE_PERIOD_DAYS` | `7` |
| Quorum | `required_votes(weekly_active_users)` |

- **Volunteer:** upsert as `candidate`
- **Meets threshold:** `vote_count >= quorum` and (`vote_count == 0` or `approval_ratio >= 0.66`)
- **Promote:** candidate meeting threshold → `member`
- **Demote:** approval ratio `< 0.66` → remove; quorum miss starts/continues **7-day grace**, then remove

---

## 5. Proposal signal gate

| | FastAPI | Supabase |
|---|---|---|
| Path | `web-backend/app/services/signal_gates.py` | Counts in detail; unlock may be stubbed |
| Status | **Oracle** | Partial |

| Constant | Value |
|---|---|
| `SIGNAL_DEMAND_RATIO_THRESHOLD_PERCENT` | `66.0` |

```
ratio_met = (demand / total * 100) >= 66.0
if platform context: unlocked = ratio_met AND demand >= required_votes(N)
else: unlocked = ratio_met
```

Applied when advancing from project `phase-1` or event `proposal`.

---

## 6. Access control (private events + tags)

| | FastAPI | Supabase |
|---|---|---|
| Path | `access_control.py` + `domain/access_policy.py` | `_shared/access.ts` |
| Status | **Oracle** | Largely ported |

### Tag visibility

1. Channel tag **or** open community tag → public
2. No closed-community tags → public
3. Closed-community-only → viewer must be member of **every** closed community

### Private events

- Skip tag gate
- `invite_only`: event members only (strangers **404**)
- `private_community`: home-community member **or** event member
- Absent from public/region feeds for non-members

### Posts

- `followers` audience → accepted follow (or self)

---

## 7. Project / event phases

### Projects (`phase-1` … `phase-7`)

Proposal → Production Plan → Distribution Plan → Acquisition → Activity → Pending Execution → Closed.

- Advance past plan phases needs an approved **leading** plan of the correct kind
- `personal-service`: no phase-change / governance vote requests
- Platform-tagged: quorum = global weekly actives; any signed-in user may vote

### Events (`proposal` → `event-plan` → `activity` → `closed`)

- Proposal→advance uses signal gate
- `organizer_controlled`: only organizers drive lifecycle; public events cannot use this mode
- Platform-tagged: any signed-in user may cast governance votes

---

## 8. Supabase lifecycle paths that must not 501

| Action path | Handler |
|---|---|
| `plans/overall-vote` | `castProjectPlanVote` / `castEventPlanVote` |
| `phase-change/vote` | `voteProjectPhaseChange` / `voteEventPhaseChange` |
| `activities/commitment` | `commitActivityRoleByLabel` |
| `activities/rating` | `upsertActivityRating` |
| `pull-requests` / `…/vote` / `…/merge` | PR lifecycle |
| Help `roles/{id}/commit` / `uncommit` | Help role slots |

Pass rule: `voteCount >= requiredVotes(N)` and `approvalRatio >= 0.66`.

---

## 9. Local proof expectations

### Already covered by `parity-math.test.ts`

- `requiredVotes` for key sizes
- `summarizeVotes` ratio
- Delete quorum floors (spam 3, serious-harm 5, tiny DM 1)
- Region radius clamp (default 25, min 1, max 20000)

### Must be covered by expanded smoke / browser signoff

1. Second-account report vote → resolution moves toward `under_review` / voteSummary updates
2. Neutral / clear content vote (`vote: 0`)
3. Platform moderator standing vote after volunteer
4. Event `plans/overall-vote` alias (not only project)
5. Project `phase-change/vote` and `activities/commitment` by label
6. Closed community hidden from non-members in search
7. Scope invite create + redeem
8. Mark-one notification read
9. Send message into an existing conversation
10. Private event stays 404 for strangers
11. Nested comments / follower-only post visibility (browser)
12. Board standing vote response shape

---

## 10. Intentional divergences (not blockers)

| Area | FastAPI | Supabase |
|---|---|---|
| Messaging at rest | Fernet possible | Plaintext (`encryption_version: 0`) |
| Location search / reverse | Nominatim | DB nearest / `ilike` |
| Niche software lifecycle | Full routes | Explicit **501** for some edge paths |
| Auth session | HttpOnly cookies + CSRF | JWT in `localStorage` (same-origin) |
| Weekly-active quorum | Meaningful-actions cache | Membership fallback when sparse |

Everything else unexplained is a **blocker** until fixed or intentionally documented here / in PARITY_AUDIT.md.
