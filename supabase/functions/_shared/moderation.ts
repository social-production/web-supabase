/**
 * Report threshold + resolution automation ported from
 * web-backend/app/services/moderation/{thresholds,serialize,effects}.py
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { normalizeYesNo, requiredVotes, weeklyActiveCount } from './votes.ts';

const MIN_NON_DM_DELETE_QUORUM = 3;
const MIN_SERIOUS_HARM_HIDE_QUORUM = 3;
const MIN_SERIOUS_HARM_DELETE_QUORUM = 5;
const MIN_APPROVAL_SHARE = 0.66;

const TABLE_BY_TYPE: Record<string, string> = {
  thread: 'threads',
  post: 'posts',
  project: 'projects',
  event: 'events',
  help_request: 'help_requests',
  comment: 'comments',
  message: 'messages'
};

export function ageBoostPercent(ageDays: number): number {
  if (ageDays < 1) return 0;
  if (ageDays < 7) return 10;
  if (ageDays < 30) return 20;
  if (ageDays < 180) return 30;
  return 35;
}

export function popularityBoostPercent(score: number): number {
  if (score < 2) return 0;
  if (score < 8) return 5;
  if (score < 20) return 10;
  if (score < 50) return 15;
  return 20;
}

export function isTinyPrivateDm(targetType: string, audienceSize: number): boolean {
  return targetType === 'message' && audienceSize <= 1;
}

export function deleteYesShare(reason: string, ageDays: number, engagementScore: number): number {
  const age = ageBoostPercent(ageDays);
  const popularity = popularityBoostPercent(engagementScore);
  if (reason === 'serious-harm') {
    const boost = Math.floor((age + popularity) / 2);
    return Math.min(0.85, MIN_APPROVAL_SHARE + boost / 100);
  }
  return Math.min(0.9, MIN_APPROVAL_SHARE + (age + popularity) / 100);
}

export function hideYesShare(reason: string, ageDays: number, engagementScore: number): number {
  if (reason !== 'serious-harm') return 1;
  const age = ageBoostPercent(ageDays);
  const popularity = popularityBoostPercent(engagementScore);
  const boost = Math.floor((age + popularity) / 4);
  return Math.min(0.8, MIN_APPROVAL_SHARE + boost / 100);
}

export function deleteQuorum(audienceSize: number, reason: string, targetType = ''): number {
  if (isTinyPrivateDm(targetType, audienceSize)) return 1;
  const base = Math.max(0, requiredVotes(Math.max(0, audienceSize)));
  if (reason === 'serious-harm') {
    if (base <= 0) return MIN_SERIOUS_HARM_DELETE_QUORUM;
    return Math.max(MIN_SERIOUS_HARM_DELETE_QUORUM, Math.ceil(base * 0.66));
  }
  if (base <= 0) return MIN_NON_DM_DELETE_QUORUM;
  return Math.max(MIN_NON_DM_DELETE_QUORUM, base);
}

export function hideQuorum(audienceSize: number, targetType = ''): number {
  if (isTinyPrivateDm(targetType, audienceSize)) return 1;
  const base = Math.max(0, requiredVotes(Math.max(0, audienceSize)));
  if (base <= 0) return MIN_SERIOUS_HARM_HIDE_QUORUM;
  return Math.max(MIN_SERIOUS_HARM_HIDE_QUORUM, Math.ceil(base * 0.33));
}

function approvalRatio(yes: number, no: number): number {
  const total = yes + no;
  return total <= 0 ? 0 : yes / total;
}

function deletionReady(yes: number, no: number, deleteQ: number, share: number): boolean {
  return yes + no >= deleteQ && approvalRatio(yes, no) >= share;
}

function hideReady(reason: string, yes: number, no: number, hideQ: number, share: number): boolean {
  if (reason !== 'serious-harm') return false;
  return yes + no >= hideQ && approvalRatio(yes, no) >= share;
}

function canStillReachDeletion(
  yes: number,
  no: number,
  eligible: number,
  deleteQ: number,
  share: number
): boolean {
  const total = yes + no;
  const remaining = Math.max(0, eligible - total);
  const maxTotal = total + remaining;
  const maxYes = yes + remaining;
  if (maxTotal < deleteQ || maxTotal <= 0) return false;
  return maxYes / maxTotal >= share;
}

export function nextResolution(input: {
  targetType: string;
  reason: string;
  current: string;
  yesCount: number;
  noCount: number;
  eligible: number;
  deleteQuorum: number;
  hideQuorum: number;
  deleteShare: number;
  hideShare: number;
}): string {
  const {
    targetType,
    reason,
    current,
    yesCount,
    noCount,
    eligible,
    deleteQuorum: deleteQ,
    hideQuorum: hideQ,
    deleteShare,
    hideShare
  } = input;

  if (
    (current === 'under_review' || current === 'hidden') &&
    !canStillReachDeletion(yesCount, noCount, eligible, deleteQ, deleteShare)
  ) {
    return 'dismissed';
  }

  const readyDelete = deletionReady(yesCount, noCount, deleteQ, deleteShare);
  const readyHide = hideReady(reason, yesCount, noCount, hideQ, hideShare);

  if (current === 'open' && yesCount >= 1) {
    if (isTinyPrivateDm(targetType, eligible) && readyDelete) return 'removed';
    return 'under_review';
  }
  if (readyDelete && (current === 'under_review' || current === 'hidden')) return 'removed';
  if (readyHide && current === 'under_review') return 'hidden';
  return ['open', 'under_review', 'hidden'].includes(current) ? current : 'open';
}

export function advanceResolution(input: Parameters<typeof nextResolution>[0]): string {
  let resolution = ['open', 'under_review', 'hidden'].includes(input.current) ? input.current : 'open';
  let nxt = nextResolution({ ...input, current: resolution });
  if (nxt === resolution || nxt === 'removed' || nxt === 'dismissed') return nxt;
  if (nxt === 'under_review') {
    const further = nextResolution({ ...input, current: 'under_review' });
    // Allow same-request hide/remove (serious-harm / tiny DM). Do not immediately
    // dismiss a brand-new under_review case just because the local electorate is
    // still smaller than the minimum delete quorum — that made reporting look
    // completely broken on fresh local installs.
    if (further === 'hidden' || further === 'removed') return further;
    return 'under_review';
  }
  return nxt;
}

async function audienceForTarget(db: SupabaseClient, targetType: string, targetId: string): Promise<number> {
  // Early local/beta platforms often have fewer people than the minimum delete
  // quorum (3). Without a floor, the first second-account vote dismisses every
  // public report as "unreachable". Keep a modest floor so reports stay active
  // while the community is still growing.
  const EARLY_PLATFORM_FLOOR = MIN_NON_DM_DELETE_QUORUM * 4; // 12

  if (targetType === 'message') {
    const { data: msg } = await db.from('messages').select('conversation_id').eq('id', targetId).maybeSingle();
    if (!msg) return await weeklyActiveCount(db);
    const { count } = await db
      .from('conversation_members')
      .select('*', { count: 'exact', head: true })
      .eq('conversation_id', msg.conversation_id);
    return Math.max(0, (count ?? 1) - 1);
  }
  if (targetType === 'project') {
    const { count } = await db.from('project_memberships').select('*', { count: 'exact', head: true }).eq('project_id', targetId);
    return Math.max(count ?? 0, await weeklyActiveCount(db), await totalUsers(db), EARLY_PLATFORM_FLOOR);
  }
  if (targetType === 'event') {
    const { count } = await db.from('event_memberships').select('*', { count: 'exact', head: true }).eq('event_id', targetId);
    return Math.max(count ?? 0, await weeklyActiveCount(db), await totalUsers(db), EARLY_PLATFORM_FLOOR);
  }
  // Public thread/post/help/comment surfaces.
  const weekly = await weeklyActiveCount(db);
  const users = await totalUsers(db);
  return Math.max(weekly, users, EARLY_PLATFORM_FLOOR);
}

async function totalUsers(db: SupabaseClient): Promise<number> {
  const { count } = await db.from('users').select('*', { count: 'exact', head: true });
  return Math.max(1, count ?? 1);
}

async function engagementForTarget(db: SupabaseClient, targetType: string, targetId: string): Promise<{ ageDays: number; score: number; createdAt: string | null }> {
  const table = TABLE_BY_TYPE[targetType];
  if (!table) return { ageDays: 0, score: 0, createdAt: null };
  const { data } = await db.from(table).select('created_at, vote_count, comment_count').eq('id', targetId).maybeSingle();
  if (!data) return { ageDays: 0, score: 0, createdAt: null };
  const created = data.created_at ? new Date(data.created_at).getTime() : Date.now();
  const ageDays = Math.max(0, (Date.now() - created) / 86400000);
  const score = Number(data.vote_count ?? 0) + Number(data.comment_count ?? 0);
  return { ageDays, score, createdAt: data.created_at ?? null };
}

async function applyModerationState(
  db: SupabaseClient,
  targetType: string,
  targetId: string,
  moderationState: string,
  moderationReason: string | null
) {
  const table = TABLE_BY_TYPE[targetType];
  if (!table) return;
  await db
    .from(table)
    .update({
      moderation_state: moderationState,
      moderation_reason: moderationReason
    })
    .eq('id', targetId);
  if (moderationState === 'removed') {
    await db.from('searchable_documents').delete().eq('entity_type', targetType).eq('entity_id', targetId);
  }
}

export async function buildReportVoteSummary(
  db: SupabaseClient,
  report: {
    id: string;
    reason: string;
    target_type: string;
    target_id: string;
    resolution: string;
  },
  viewerId: string | null
) {
  const { data: votes } = await db.from('report_votes').select('voter_id, vote').eq('report_id', report.id);
  let yesCount = 0;
  let noCount = 0;
  let activeVote: 'yes' | 'no' | null = null;
  for (const row of votes ?? []) {
    const n = normalizeYesNo(row.vote);
    if (n === 1) yesCount += 1;
    if (n === -1) noCount += 1;
    if (viewerId && row.voter_id === viewerId) activeVote = n === 1 ? 'yes' : n === -1 ? 'no' : null;
  }
  const audienceSize = await audienceForTarget(db, report.target_type, report.target_id);
  const { ageDays, score } = await engagementForTarget(db, report.target_type, report.target_id);
  const deleteQ = deleteQuorum(audienceSize, report.reason, report.target_type);
  const hideQ = hideQuorum(audienceSize, report.target_type);
  const deleteShare = deleteYesShare(report.reason, ageDays, score);
  const hideShare = hideYesShare(report.reason, ageDays, score);
  return {
    yesCount,
    noCount,
    activeVote,
    eligibleVoterCount: audienceSize,
    audienceSize,
    totalVotes: yesCount + noCount,
    votesRequired: deleteQ,
    requiredYesShare: deleteShare,
    deleteYesShare: deleteShare,
    hideYesShare: hideShare,
    deleteQuorum: deleteQ,
    hideQuorum: hideQ,
    removalQuorum: deleteQ,
    restrictionQuorum: hideQ,
    restrictionVotesRequired: hideQ
  };
}

export async function reconcileReport(
  db: SupabaseClient,
  reportId: string,
  viewerId: string | null
) {
  const { data: report } = await db.from('reports').select('*').eq('id', reportId).maybeSingle();
  if (!report) throw new Error('not_found');
  const summary = await buildReportVoteSummary(db, report, viewerId);
  const next = advanceResolution({
    targetType: report.target_type,
    reason: report.reason,
    current: report.resolution ?? 'open',
    yesCount: summary.yesCount,
    noCount: summary.noCount,
    eligible: summary.audienceSize,
    deleteQuorum: summary.deleteQuorum,
    hideQuorum: summary.hideQuorum,
    deleteShare: summary.deleteYesShare,
    hideShare: summary.hideYesShare
  });
  if (next !== report.resolution) {
    await db.from('reports').update({ resolution: next }).eq('id', report.id);
    const moderationState =
      next === 'dismissed'
        ? 'visible'
        : next === 'under_review'
          ? 'under_review'
          : next === 'hidden'
            ? 'hidden'
            : next === 'removed'
              ? 'removed'
              : 'visible';
    await applyModerationState(
      db,
      report.target_type,
      report.target_id,
      moderationState,
      next === 'dismissed' ? null : report.reason
    );
  }
  const { data: author } = await db.from('users').select('username').eq('id', report.reporter_id).maybeSingle();
  return {
    id: report.id,
    subjectId: report.subject_id ?? report.target_id,
    targetId: report.target_id,
    reason: report.reason,
    description: report.description ?? '',
    createdAt: report.created_at,
    authorUsername: author?.username ?? '',
    resolution: next,
    voteSummary: summary
  };
}

const ACTIVE_REPORT_RESOLUTIONS = new Set(['open', 'under_review', 'hidden']);

export async function loadActiveReport(
  db: SupabaseClient,
  targetType: string,
  targetId: string,
  viewerId: string | null
) {
  const { data: report } = await db
    .from('reports')
    .select('*')
    .eq('target_type', targetType)
    .eq('target_id', targetId)
    .in('resolution', [...ACTIVE_REPORT_RESOLUTIONS])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!report) return null;
  const summary = await buildReportVoteSummary(db, report, viewerId);
  const { data: author } = await db
    .from('users')
    .select('username')
    .eq('id', report.reporter_id)
    .maybeSingle();
  return {
    id: report.id,
    subjectId: report.subject_id ?? report.target_id,
    targetId: report.target_id,
    reason: report.reason,
    description: report.description ?? '',
    createdAt: report.created_at,
    authorUsername: author?.username ?? '',
    resolution: report.resolution ?? 'open',
    voteSummary: summary
  };
}

export async function loadActiveReportsByTargetIds(
  db: SupabaseClient,
  targetType: string,
  targetIds: string[],
  viewerId: string | null
) {
  const unique = [...new Set(targetIds.filter(Boolean))];
  const out = new Map<string, Awaited<ReturnType<typeof loadActiveReport>>>();
  if (unique.length === 0) return out;
  const { data: reports } = await db
    .from('reports')
    .select('*')
    .eq('target_type', targetType)
    .in('target_id', unique)
    .in('resolution', [...ACTIVE_REPORT_RESOLUTIONS]);
  for (const report of reports ?? []) {
    // Prefer the newest active report per target.
    const existing = out.get(report.target_id);
    if (existing && String(existing.createdAt) >= String(report.created_at)) continue;
    const summary = await buildReportVoteSummary(db, report, viewerId);
    const { data: author } = await db
      .from('users')
      .select('username')
      .eq('id', report.reporter_id)
      .maybeSingle();
    out.set(String(report.target_id), {
      id: report.id,
      subjectId: report.subject_id ?? report.target_id,
      targetId: report.target_id,
      reason: report.reason,
      description: report.description ?? '',
      createdAt: report.created_at,
      authorUsername: author?.username ?? '',
      resolution: report.resolution ?? 'open',
      voteSummary: summary
    });
  }
  return out;
}

export function moderationFieldsFromRow(
  row: Record<string, unknown>,
  report: Awaited<ReturnType<typeof loadActiveReport>> | null = null
) {
  const moderationState = (row.moderation_state as string | undefined) ?? 'visible';
  return {
    report,
    hasActiveReport: Boolean(report),
    isUnderReview: moderationState === 'under_review' || report?.resolution === 'under_review',
    isRemovedByReport: moderationState === 'removed',
    moderationState
  };
}

export async function castReportVote(
  db: SupabaseClient,
  userId: string,
  reportId: string,
  vote: unknown
) {
  const direction = normalizeYesNo(vote);
  if (direction === 0) {
    await db.from('report_votes').delete().eq('report_id', reportId).eq('voter_id', userId);
  } else {
    await db.from('report_votes').upsert(
      {
        report_id: reportId,
        voter_id: userId,
        vote: direction === 1 ? 'yes' : 'no'
      },
      { onConflict: 'report_id,voter_id' }
    );
  }
  return reconcileReport(db, reportId, userId);
}
