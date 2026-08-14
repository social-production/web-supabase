/**
 * Shared governance vote math ported from web-backend/app/utils/votes.py.
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

export const MIN_APPROVAL_RATIO = 0.66;

export function requiredVotes(n: number): number {
  if (n <= 0) return 0;
  let errorMargin: number;
  if (n < 100) errorMargin = 0.1 - (0.03 * (n - 1)) / 99;
  else if (n < 500) errorMargin = 0.07 - (0.02 * (n - 100)) / 400;
  else errorMargin = Math.max(0.02, 0.05 - (0.03 * Math.log10(n / 500)) / Math.log10(2000));
  const baseSampleSize = 0.9604 / errorMargin ** 2;
  const cochran = Math.ceil(baseSampleSize / (1 + (baseSampleSize - 1) / n));
  return Math.min(Math.ceil(0.75 * n), cochran);
}

export type VoteStats = {
  yesCount: number;
  noCount: number;
  voteCount: number;
  approvalRatio: number;
};

export function summarizeVotes(rows: Array<{ vote?: number | string | null }>): VoteStats {
  let yesCount = 0;
  let noCount = 0;
  for (const row of rows) {
    const v = row.vote;
    if (v === 1 || v === 'yes' || v === '1') yesCount += 1;
    else if (v === -1 || v === 'no' || v === '-1') noCount += 1;
  }
  const voteCount = yesCount + noCount;
  return {
    yesCount,
    noCount,
    voteCount,
    approvalRatio: voteCount > 0 ? yesCount / voteCount : 0
  };
}

export function isPassing(stats: VoteStats, population: number): boolean {
  const quorum = requiredVotes(population);
  return stats.voteCount >= quorum && (stats.voteCount === 0 || stats.approvalRatio >= MIN_APPROVAL_RATIO);
}

export function canStillPass(stats: VoteStats, population: number): boolean {
  const quorum = requiredVotes(population);
  const remaining = Math.max(0, population - stats.voteCount);
  const maxTotal = stats.voteCount + remaining;
  const maxYes = stats.yesCount + remaining;
  if (maxTotal < quorum || maxTotal <= 0) return false;
  return maxYes / maxTotal >= MIN_APPROVAL_RATIO;
}

const WEEKLY_ACTIVE_TTL_MS = 30_000;
const POPULATION_TTL_MS = 15_000;

type CacheEntry<T> = { value: T; expiresAt: number };

let weeklyActiveCache: CacheEntry<number> | null = null;
const populationCache = new Map<string, CacheEntry<number>>();

function readCache<T>(entry: CacheEntry<T> | undefined | null): T | null {
  if (!entry || Date.now() >= entry.expiresAt) {
    return null;
  }
  return entry.value;
}

export async function weeklyActiveCount(db: SupabaseClient): Promise<number> {
  const cached = readCache(weeklyActiveCache);
  if (cached != null) return cached;
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const [{ data: actions }, { data: votes }, { data: comments }] = await Promise.all([
    db.from('meaningful_actions').select('user_id').gte('occurred_at', weekAgo),
    db.from('content_votes').select('voter_id').gte('updated_at', weekAgo),
    db.from('comments').select('author_id').gte('created_at', weekAgo)
  ]);
  const ids = new Set<string>();
  for (const row of actions ?? []) {
    if (row.user_id) ids.add(String(row.user_id));
  }
  for (const row of votes ?? []) {
    if (row.voter_id) ids.add(String(row.voter_id));
  }
  for (const row of comments ?? []) {
    if (row.author_id) ids.add(String(row.author_id));
  }
  const value = ids.size;
  weeklyActiveCache = { value, expiresAt: Date.now() + WEEKLY_ACTIVE_TTL_MS };
  return value;
}

export async function projectPopulation(db: SupabaseClient, projectId: string): Promise<number> {
  const cacheKey = `project:${projectId}`;
  const cached = readCache(populationCache.get(cacheKey));
  if (cached != null) return cached;
  const { data: project } = await db
    .from('projects')
    .select('is_platform_tagged')
    .eq('id', projectId)
    .maybeSingle();
  // Platform-tagged: N = platform weekly actives, then requiredVotes(N).
  const value = project?.is_platform_tagged
    ? await weeklyActiveCount(db)
    : await weeklyActiveProjectMembers(db, projectId);
  populationCache.set(cacheKey, { value, expiresAt: Date.now() + POPULATION_TTL_MS });
  return value;
}

async function weeklyActiveProjectMembers(db: SupabaseClient, projectId: string): Promise<number> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const { data: members } = await db.from('project_memberships').select('user_id').eq('project_id', projectId);
  const memberIds = new Set((members ?? []).map((m) => String(m.user_id)));
  if (memberIds.size === 0) return 0;
  const { data: actions } = await db
    .from('meaningful_actions')
    .select('user_id')
    .gte('occurred_at', weekAgo)
    .in('user_id', [...memberIds]);
  return new Set((actions ?? []).map((a) => String(a.user_id)).filter((id) => memberIds.has(id))).size;
}

export async function isPlatformEvent(db: SupabaseClient, eventId: string): Promise<boolean> {
  const { data: platformChannel } = await db
    .from('channels')
    .select('id')
    .eq('slug', 'platform')
    .maybeSingle();
  if (!platformChannel?.id) return false;
  const { data } = await db
    .from('event_tags')
    .select('id')
    .eq('event_id', eventId)
    .eq('tag_kind', 'channel')
    .eq('channel_id', platformChannel.id)
    .limit(1);
  return (data ?? []).length > 0;
}

async function weeklyActiveEventMembers(db: SupabaseClient, eventId: string): Promise<number> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const { data: members } = await db.from('event_memberships').select('user_id').eq('event_id', eventId);
  const memberIds = new Set((members ?? []).map((m) => String(m.user_id)));
  if (memberIds.size === 0) return 0;
  const { data: actions } = await db
    .from('meaningful_actions')
    .select('user_id')
    .gte('occurred_at', weekAgo)
    .in('user_id', [...memberIds]);
  return new Set((actions ?? []).map((a) => String(a.user_id)).filter((id) => memberIds.has(id))).size;
}

export async function eventPopulation(db: SupabaseClient, eventId: string): Promise<number> {
  const cacheKey = `event:${eventId}`;
  const cached = readCache(populationCache.get(cacheKey));
  if (cached != null) return cached;
  // Platform-tagged: N = platform weekly actives. Else N = weekly actives within event membership.
  const value = (await isPlatformEvent(db, eventId))
    ? await weeklyActiveCount(db)
    : await weeklyActiveEventMembers(db, eventId);
  populationCache.set(cacheKey, { value, expiresAt: Date.now() + POPULATION_TTL_MS });
  return value;
}

export async function recordMeaningfulAction(
  db: SupabaseClient,
  userId: string,
  actionType: string,
  metadata: Record<string, unknown> = {}
) {
  await db.from('meaningful_actions').insert({
    user_id: userId,
    action_type: actionType,
    occurred_at: new Date().toISOString(),
    metadata
  });
}

export function normalizeYesNo(vote: unknown): 1 | -1 | 0 {
  if (vote === 1 || vote === 'yes' || vote === 'up' || vote === '1') return 1;
  if (vote === -1 || vote === 'no' || vote === 'down' || vote === '-1') return -1;
  return 0;
}
