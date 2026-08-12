/**
 * Platform board standing / grace / promote / demote
 * ported from web-backend/app/services/board.py + platform.py feed bits
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { MIN_APPROVAL_RATIO, normalizeYesNo, recordMeaningfulAction, requiredVotes, weeklyActiveCount } from './votes.ts';
import { handleFeedPage } from './feeds.ts';

const BOARD_STATE_MEMBER = 'member';
const BOARD_STATE_CANDIDATE = 'candidate';
const GRACE_PERIOD_DAYS = 7;

type VoteStats = {
  yesCount: number;
  noCount: number;
  voteCount: number;
  approvalRatio: number;
};

function emptyStats(): VoteStats {
  return { yesCount: 0, noCount: 0, voteCount: 0, approvalRatio: 0 };
}

async function voteStatsMap(db: SupabaseClient, targetIds: string[]): Promise<Map<string, VoteStats>> {
  const map = new Map<string, VoteStats>();
  if (targetIds.length === 0) return map;
  const { data } = await db
    .from('board_standing_votes')
    .select('target_user_id, vote')
    .in('target_user_id', targetIds);
  for (const id of targetIds) map.set(id, emptyStats());
  for (const row of data ?? []) {
    const stats = map.get(row.target_user_id) ?? emptyStats();
    const n = normalizeYesNo(row.vote);
    if (n === 1) stats.yesCount += 1;
    if (n === -1) stats.noCount += 1;
    stats.voteCount = stats.yesCount + stats.noCount;
    stats.approvalRatio = stats.voteCount > 0 ? stats.yesCount / stats.voteCount : 0;
    map.set(row.target_user_id, stats);
  }
  return map;
}

function meetsThreshold(stats: VoteStats, quorum: number): boolean {
  return stats.voteCount >= quorum && (stats.voteCount === 0 || stats.approvalRatio >= MIN_APPROVAL_RATIO);
}

function computeStandingState(input: {
  dbState: string;
  stats: VoteStats;
  quorum: number;
  graceEndsAt: string | null;
}): string {
  const now = Date.now();
  if (input.dbState === BOARD_STATE_CANDIDATE) {
    return meetsThreshold(input.stats, input.quorum) ? 'qualifying' : 'below-threshold';
  }
  if (input.stats.voteCount > 0 && input.stats.approvalRatio < MIN_APPROVAL_RATIO) {
    return 'below-threshold';
  }
  if (input.stats.voteCount >= input.quorum) return 'active';
  if (input.graceEndsAt && new Date(input.graceEndsAt).getTime() >= now) return 'grace';
  return 'below-threshold';
}

async function reconcileBoard(db: SupabaseClient): Promise<{ quorum: number; weeklyActiveUsers: number }> {
  // Board standing must stay usable on early betas with sparse meaningful_actions rows.
  const weeklyActiveUsers = Math.max(await weeklyActiveCount(db), 1);
  const quorum = requiredVotes(weeklyActiveUsers);
  const { data: memberships } = await db.from('platform_board_memberships').select('*');
  const ids = (memberships ?? []).map((m) => m.user_id);
  const statsMap = await voteStatsMap(db, ids);
  const now = new Date();
  const graceEnd = new Date(now.getTime() + GRACE_PERIOD_DAYS * 86400000).toISOString();

  for (const row of memberships ?? []) {
    const stats = statsMap.get(row.user_id) ?? emptyStats();
    if (row.standing_state === BOARD_STATE_CANDIDATE) {
      if (meetsThreshold(stats, quorum)) {
        await db
          .from('platform_board_memberships')
          .update({
            standing_state: BOARD_STATE_MEMBER,
            grace_started_at: null,
            grace_ends_at: null,
            updated_at: now.toISOString()
          })
          .eq('user_id', row.user_id);
      }
      continue;
    }

    // member
    if (stats.voteCount > 0 && stats.approvalRatio < MIN_APPROVAL_RATIO) {
      await db.from('platform_board_memberships').delete().eq('user_id', row.user_id);
      continue;
    }
    if (stats.voteCount >= quorum) {
      if (row.grace_started_at || row.grace_ends_at) {
        await db
          .from('platform_board_memberships')
          .update({ grace_started_at: null, grace_ends_at: null, updated_at: now.toISOString() })
          .eq('user_id', row.user_id);
      }
      continue;
    }
    if (row.grace_ends_at && new Date(row.grace_ends_at).getTime() >= now.getTime()) {
      continue;
    }
    if (!row.grace_ends_at) {
      await db
        .from('platform_board_memberships')
        .update({
          grace_started_at: now.toISOString(),
          grace_ends_at: graceEnd,
          updated_at: now.toISOString()
        })
        .eq('user_id', row.user_id);
      continue;
    }
    await db.from('platform_board_memberships').delete().eq('user_id', row.user_id);
  }

  return { quorum, weeklyActiveUsers };
}

export async function volunteerForBoard(db: SupabaseClient, userId: string) {
  await db.from('platform_board_memberships').upsert({
    user_id: userId,
    standing_state: BOARD_STATE_CANDIDATE,
    grace_started_at: null,
    grace_ends_at: null,
    updated_at: new Date().toISOString()
  });
  await recordMeaningfulAction(db, userId, 'volunteer-board', { standing_state: BOARD_STATE_CANDIDATE });
  await reconcileBoard(db);
  return { ok: true };
}

export async function removeBoardVolunteer(db: SupabaseClient, userId: string) {
  await db.from('platform_board_memberships').delete().eq('user_id', userId);
  return { ok: true };
}

export async function castBoardModeratorVote(
  db: SupabaseClient,
  voterId: string,
  targetUserId: string,
  vote: unknown
) {
  if (!targetUserId) throw new Error('not_found');
  if (targetUserId === voterId) throw new Error('cannot_vote_self');
  const direction = normalizeYesNo(vote);
  if (direction === 0) {
    await db
      .from('board_standing_votes')
      .delete()
      .eq('target_user_id', targetUserId)
      .eq('voter_id', voterId);
  } else {
    await db.from('board_standing_votes').upsert(
      {
        target_user_id: targetUserId,
        voter_id: voterId,
        vote: direction
      },
      { onConflict: 'target_user_id,voter_id' }
    );
    await recordMeaningfulAction(db, voterId, 'board-standing-vote', {
      target_user_id: targetUserId,
      vote: direction
    });
  }
  await reconcileBoard(db);
  return { ok: true };
}

async function resolvePlatformChannel(db: SupabaseClient) {
  const { data } = await db
    .from('channels')
    .select('id, slug, name, description')
    .in('slug', ['platform', 'stewardship'])
    .order('slug', { ascending: true })
    .limit(1)
    .maybeSingle();
  return data;
}

export async function getPlatformBoard(db: SupabaseClient, viewerId: string | null) {
  const { quorum, weeklyActiveUsers } = await reconcileBoard(db);
  const platformChannel = await resolvePlatformChannel(db);
  const { data: memberships } = await db.from('platform_board_memberships').select('*');
  const ids = (memberships ?? []).map((m) => m.user_id);
  const statsMap = await voteStatsMap(db, ids);
  const { data: users } = ids.length
    ? await db.from('users').select('id, username, profile_image_url, bio').in('id', ids)
    : { data: [] as Array<Record<string, unknown>> };
  const userById = new Map((users ?? []).map((u) => [u.id as string, u]));

  let viewerVoteMap = new Map<string, number>();
  if (viewerId && ids.length) {
    const { data: votes } = await db
      .from('board_standing_votes')
      .select('target_user_id, vote')
      .eq('voter_id', viewerId)
      .in('target_user_id', ids);
    viewerVoteMap = new Map((votes ?? []).map((v) => [v.target_user_id, Number(v.vote)]));
  }

  const moderators = [];
  const moderatorCandidates = [];
  for (const row of memberships ?? []) {
    const stats = statsMap.get(row.user_id) ?? emptyStats();
    const user = userById.get(row.user_id);
    const standingState = computeStandingState({
      dbState: row.standing_state,
      stats,
      quorum,
      graceEndsAt: row.grace_ends_at
    });
    const viewerVote =
      viewerVoteMap.get(row.user_id) === 1
        ? 'yes'
        : viewerVoteMap.get(row.user_id) === -1
          ? 'no'
          : null;
    // Frontend ScopeMemberSummary expects confidence* fields (FastAPI mapper parity).
    const mapped = {
      id: row.user_id,
      username: user?.username ?? 'unknown',
      bio: (user?.bio as string | undefined) ?? '',
      confidenceTargetId: row.user_id,
      confidenceUpVotes: stats.yesCount,
      confidenceDownVotes: stats.noCount,
      confidenceVoteCount: stats.voteCount,
      confidenceReviewCount: stats.voteCount,
      confidenceRatio: stats.approvalRatio,
      confidenceStandingState: standingState,
      confidenceVotesRequired: quorum,
      confidenceWeeklyActiveUserCount: weeklyActiveUsers,
      confidenceGraceEndsAt: row.grace_ends_at,
      confidenceActiveVote: viewerVote === 'yes' ? 1 : viewerVote === 'no' ? -1 : 0
    };
    if (row.standing_state === BOARD_STATE_MEMBER) moderators.push(mapped);
    else moderatorCandidates.push(mapped);
  }

  let viewerIsMember = false;
  let memberCount = 0;
  if (platformChannel) {
    const { count } = await db
      .from('scope_memberships')
      .select('*', { count: 'exact', head: true })
      .eq('scope_kind', 'channel')
      .eq('scope_id', platformChannel.id);
    memberCount = count ?? 0;
    if (viewerId) {
      const { data: membership } = await db
        .from('scope_memberships')
        .select('id')
        .eq('scope_kind', 'channel')
        .eq('scope_id', platformChannel.id)
        .eq('user_id', viewerId)
        .maybeSingle();
      viewerIsMember = !!membership;
    }
  }

  const viewerBoardState =
    viewerId && (memberships ?? []).find((m) => m.user_id === viewerId)?.standing_state
      ? ((memberships ?? []).find((m) => m.user_id === viewerId)?.standing_state as string)
      : null;

  const feed = platformChannel
    ? (
        await handleFeedPage(
          db,
          viewerId,
          'scope',
          new URLSearchParams({
            kind: 'channel',
            slug: platformChannel.slug,
            limit: '20',
            offset: '0'
          })
        )
      ).items
    : [];

  return {
    kind: 'platform',
    slug: platformChannel?.slug ?? 'platform',
    title: platformChannel?.name ?? 'Platform',
    description: platformChannel?.description ?? 'Platform board and assets',
    badges: [],
    emptyFeedText: 'Nothing here yet.',
    membership: {
      memberCount,
      viewerIsMember,
      viewerCanToggleMembership: Boolean(viewerId && platformChannel),
      joinPolicy: 'open',
      viewerCanSeeFeed: true
    },
    feed,
    stats: {
      projects: 0,
      threads: 0,
      events: 0,
      members: memberCount
    },
    moderators,
    moderatorCandidates,
    moderatorCandidacyOptions: viewerId
      ? {
          viewerState: viewerBoardState,
          canVolunteer: viewerBoardState == null
        }
      : null,
    requiredQuorum: quorum,
    weeklyActiveUsers
  };
}
