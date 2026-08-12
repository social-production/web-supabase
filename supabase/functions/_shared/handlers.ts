/**
 * Domain handlers for the Social Production gateway Edge Function.
 * Returns camelCase AppAdapter shapes. Uses service-role client for orchestration
 * and auth.uid() from the JWT for viewer identity.
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import {
  canViewCommunityInSearch,
  canViewEntity,
  canViewVoteTarget,
  isScopeMember,
  loadEntityTags
} from './access.ts';
import { castReportVote, loadActiveReport, loadActiveReportsByTargetIds, reconcileReport } from './moderation.ts';
import { handleFeedPage as assembleFeedPage, handleMapMarkers, viewerVote as feedViewerVote } from './feeds.ts';
import { recordMeaningfulAction } from './votes.ts';
import { buildActivityRail } from './activityRail.ts';
import { buildLinkedChats, countLinkedChatUnread } from './linkedChats.ts';

type VoteDirection = -1 | 0 | 1;

function voteFromDirection(direction: string): VoteDirection {
  if (direction === 'up') return 1;
  if (direction === 'down') return -1;
  return 0;
}

function directionFromVote(vote: VoteDirection): 'up' | 'down' | 'neutral' {
  if (vote === 1) return 'up';
  if (vote === -1) return 'down';
  return 'neutral';
}

async function loadViewer(db: SupabaseClient, userId: string | null) {
  if (!userId) return null;
  const { data } = await db
    .from('users')
    .select('id, username, bio, profile_image_url')
    .eq('id', userId)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id,
    username: data.username,
    bio: data.bio ?? undefined,
    profileImageUrl: data.profile_image_url ?? undefined
  };
}

async function unreadCounts(db: SupabaseClient, userId: string | null) {
  if (!userId) return { notifications: 0, messages: 0 };
  const [{ count: notifications }, { data: memberships }, linkedUnread] = await Promise.all([
    db
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('recipient_id', userId)
      .eq('is_unread', true),
    db.from('conversation_members').select('conversation_id, last_read_at').eq('user_id', userId),
    countLinkedChatUnread(db, userId)
  ]);

  let messages = 0;
  const membershipRows = memberships ?? [];
  if (membershipRows.length) {
    const unreadPairs = await Promise.all(
      membershipRows.map(async (row) => {
        let query = db
          .from('messages')
          .select('*', { count: 'exact', head: true })
          .eq('conversation_id', row.conversation_id)
          .neq('sender_id', userId);
        if (row.last_read_at) {
          query = query.gt('created_at', row.last_read_at);
        }
        const { count } = await query;
        return count ?? 0;
      })
    );
    messages = unreadPairs.reduce((sum, count) => sum + count, 0);
  }

  messages += linkedUnread;

  return { notifications: notifications ?? 0, messages };
}

export async function handleBootstrap(db: SupabaseClient, userId: string | null) {
  const viewer = await loadViewer(db, userId);
  const counts = await unreadCounts(db, userId);

  const { data: platformRows } = await db
    .from('channels')
    .select('id, slug, name')
    .in('slug', ['platform', 'stewardship'])
    .order('slug')
    .limit(1);
  const platformChannel = platformRows?.[0] ?? null;

  let memberScopeIds = new Set<string>();
  let memberChannelIds: string[] = [];
  let memberCommunityIds: string[] = [];
  if (userId) {
    const { data: memberships } = await db
      .from('scope_memberships')
      .select('scope_kind, scope_id')
      .eq('user_id', userId);
    for (const row of memberships ?? []) {
      if (!row.scope_id) continue;
      memberScopeIds.add(`${row.scope_kind}:${row.scope_id}`);
      if (row.scope_kind === 'channel') memberChannelIds.push(row.scope_id);
      if (row.scope_kind === 'community') memberCommunityIds.push(row.scope_id);
    }
  }

  const [{ data: channels }, { data: communities }] = await Promise.all([
    memberChannelIds.length
      ? db
          .from('channels')
          .select('id, slug, name')
          .in('id', memberChannelIds)
          .order('name')
      : Promise.resolve({ data: [] as Array<{ id: string; slug: string; name: string }> }),
    memberCommunityIds.length
      ? db
          .from('communities')
          .select('id, slug, name, join_policy')
          .in('id', memberCommunityIds)
          .order('name')
      : Promise.resolve({
          data: [] as Array<{ id: string; slug: string; name: string; join_policy?: string }>
        })
  ]);

  const mapScope = (
    kind: 'channel' | 'community',
    rows: Array<{ slug: string; name: string; join_policy?: string; id?: string }> | null
  ) =>
    (rows ?? []).map((row) => ({
      slug: row.slug,
      label: row.name,
      href: kind === 'channel' ? `/channels/${row.slug}` : `/communities/${row.slug}`,
      visibility: row.join_policy === 'closed' ? 'private' : 'public',
      viewerIsMember: row.id ? memberScopeIds.has(`${kind}:${row.id}`) : false
    }));

  const platformViewerIsMember = platformChannel?.id
    ? memberScopeIds.has(`channel:${platformChannel.id}`)
    : false;

  return {
    viewer,
    featureFlags: { assets: false, funding: false, platform: true },
    unreadCounts: counts,
    directory: {
      platform: {
        slug: 'platform',
        label: platformChannel?.name ?? 'Platform',
        href: '/platform',
        visibility: 'public' as const,
        viewerIsMember: platformViewerIsMember
      },
      channels: mapScope(
        'channel',
        (channels ?? []).filter((row) => row.slug !== 'platform' && row.slug !== 'stewardship')
      ),
      communities: mapScope('community', communities)
    },
    suggestedContacts: [],
    // Defer heavy rail assembly; clients load /bootstrap/activity-rail after first paint.
    activityRail: [],
    activityRailHistory: []
  };
}

export async function handleActivityRail(db: SupabaseClient, userId: string | null) {
  return buildActivityRail(db, userId);
}

export async function handleBootstrapSummary(db: SupabaseClient, userId: string | null) {
  return { unreadCounts: await unreadCounts(db, userId) };
}

function mapModeration(
  row: Record<string, unknown>,
  report: Awaited<ReturnType<typeof loadActiveReport>> | null = null
) {
  return {
    report,
    moderationState: (row.moderation_state as string | undefined) ?? 'visible',
    hasActiveReport: Boolean(report),
    isUnderReview:
      row.moderation_state === 'under_review' || report?.resolution === 'under_review',
    isRemovedByReport: row.moderation_state === 'removed'
  };
}

async function viewerVote(
  db: SupabaseClient,
  userId: string | null,
  targetType: string,
  targetId: string
): Promise<VoteDirection> {
  if (!userId) return 0;
  const { data } = await db
    .from('content_votes')
    .select('direction')
    .eq('target_type', targetType)
    .eq('target_id', targetId)
    .eq('voter_id', userId)
    .maybeSingle();
  return (data?.direction ?? 0) as VoteDirection;
}

export async function handlePublicFeedPage(
  db: SupabaseClient,
  userId: string | null,
  params: URLSearchParams
) {
  return assembleFeedPage(db, userId, 'public', params);
}

export async function handleNamedFeedPage(
  db: SupabaseClient,
  userId: string | null,
  kind: 'public' | 'home' | 'personal' | 'region' | 'scope' | 'user',
  params: URLSearchParams
) {
  return assembleFeedPage(db, userId, kind, params);
}

export { handleMapMarkers };

export async function handleSetVote(
  db: SupabaseClient,
  userId: string,
  body: { target_type: string; target_id: string; direction: string }
) {
  const direction = voteFromDirection(body.direction);
  const targetType = body.target_type;
  const targetId = body.target_id;

  if (!(await canViewVoteTarget(db, userId, targetType, targetId))) {
    throw new Error('not_found');
  }

  if (direction === 0) {
    await db
      .from('content_votes')
      .delete()
      .eq('target_type', targetType)
      .eq('target_id', targetId)
      .eq('voter_id', userId);
  } else {
    const { error } = await db.from('content_votes').upsert(
      {
        target_type: targetType,
        target_id: targetId,
        voter_id: userId,
        direction,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'target_type,target_id,voter_id' }
    );
    if (error) throw error;
  }

  const { data: votes } = await db
    .from('content_votes')
    .select('direction')
    .eq('target_type', targetType)
    .eq('target_id', targetId);
  const voteCount = (votes ?? []).reduce((sum, row) => sum + Number(row.direction ?? 0), 0);

  const tableByType: Record<string, string> = {
    thread: 'threads',
    post: 'posts',
    project: 'projects',
    event: 'events',
    help_request: 'help_requests',
    comment: 'comments'
  };
  const table = tableByType[targetType];
  if (table) {
    await db.from(table).update({ vote_count: voteCount }).eq('id', targetId);
  }

  if (direction !== 0) {
    await recordMeaningfulAction(db, userId, 'content-vote', {
      target_type: targetType,
      target_id: targetId,
      direction
    });
  }

  return { ok: true, voteCount, activeVote: direction };
}

async function mapCommentTree(
  db: SupabaseClient,
  userId: string | null,
  rows: Array<Record<string, any>>,
  parentId: string | null = null,
  reportById: Map<string, Awaited<ReturnType<typeof loadActiveReport>>> = new Map()
): Promise<unknown[]> {
  const children = rows.filter((row) => (row.parent_id ?? null) === parentId);
  const result = [];
  for (const row of children) {
    const author = Array.isArray(row.users) ? row.users[0] : row.users;
    const report = reportById.get(String(row.id)) ?? null;
    result.push({
      id: row.id,
      authorUsername: author?.username ?? 'unknown',
      body: row.body,
      createdAt: row.created_at,
      voteCount: row.vote_count ?? 0,
      activeVote: await viewerVote(db, userId, 'comment', row.id),
      report,
      hasActiveReport: Boolean(report),
      isUnderReview: row.moderation_state === 'under_review' || report?.resolution === 'under_review',
      moderationState: row.moderation_state ?? 'visible',
      replies: await mapCommentTree(db, userId, rows, row.id, reportById)
    });
  }
  return result;
}

export async function handleGetComments(
  db: SupabaseClient,
  userId: string | null,
  subjectType: string,
  subjectId: string
) {
  if (!(await canViewEntity(db, userId, subjectType, subjectId))) {
    throw new Error('not_found');
  }
  const { data } = await db
    .from('comments')
    .select(
      'id, parent_id, body, vote_count, created_at, moderation_state, author_id, users!fk_comments_author_id_users(username)'
    )
    .eq('subject_type', subjectType)
    .eq('subject_id', subjectId)
    .order('created_at', { ascending: true });

  const rows = data ?? [];
  const reportById = await loadActiveReportsByTargetIds(
    db,
    'comment',
    rows.map((row) => String(row.id)),
    userId
  );
  return mapCommentTree(db, userId, rows, null, reportById);
}

export async function handleAddComment(
  db: SupabaseClient,
  userId: string,
  body: { subject_type: string; subject_id: string; body: string; parent_id?: string | null }
) {
  if (!(await canViewEntity(db, userId, body.subject_type, body.subject_id))) {
    throw new Error('not_found');
  }
  if (body.parent_id) {
    const { data: parent } = await db
      .from('comments')
      .select('id, subject_type, subject_id')
      .eq('id', body.parent_id)
      .maybeSingle();
    if (
      !parent ||
      parent.subject_type !== body.subject_type ||
      parent.subject_id !== body.subject_id
    ) {
      throw new Error('not_found');
    }
  }
  const { data, error } = await db
    .from('comments')
    .insert({
      subject_type: body.subject_type,
      subject_id: body.subject_id,
      parent_id: body.parent_id ?? null,
      author_id: userId,
      body: body.body,
      vote_count: 0
    })
    .select('id')
    .single();
  if (error) throw error;

  const subjectTable =
    body.subject_type === 'thread'
      ? 'threads'
      : body.subject_type === 'post'
        ? 'posts'
        : body.subject_type === 'project'
          ? 'projects'
          : body.subject_type === 'event'
            ? 'events'
            : body.subject_type === 'help_request'
              ? 'help_requests'
              : null;
  if (subjectTable) {
    const { data: subject } = await db
      .from(subjectTable)
      .select('comment_count')
      .eq('id', body.subject_id)
      .maybeSingle();
    if (subject) {
      await db
        .from(subjectTable)
        .update({ comment_count: Number(subject.comment_count ?? 0) + 1 })
        .eq('id', body.subject_id);
    }
  }

  await recordMeaningfulAction(db, userId, 'add-comment', {
    subject_type: body.subject_type,
    subject_id: body.subject_id,
    comment_id: data.id
  });

  return { ok: true, id: data.id };
}

export async function handleSubmitReport(
  db: SupabaseClient,
  userId: string,
  body: {
    target_type: string;
    target_id: string;
    reason: string;
    description: string;
    subject_id?: string;
  }
) {
  if (!(await canViewVoteTarget(db, userId, body.target_type, body.target_id))) {
    throw new Error('not_found');
  }
  const { data, error } = await db
    .from('reports')
    .insert({
      subject_type: body.target_type,
      subject_id: body.subject_id ?? body.target_id,
      target_type: body.target_type,
      target_id: body.target_id,
      reason: body.reason,
      description: body.description,
      reporter_id: userId,
      resolution: 'open'
    })
    .select('id')
    .single();
  if (error) throw error;

  // Reporter auto-casts yes, then threshold automation advances resolution.
  await db.from('report_votes').upsert(
    {
      report_id: data.id,
      voter_id: userId,
      vote: 'yes'
    },
    { onConflict: 'report_id,voter_id' }
  );
  return reconcileReport(db, data.id, userId);
}

export async function handleReportVote(
  db: SupabaseClient,
  userId: string,
  reportId: string,
  vote: unknown
) {
  return castReportVote(db, userId, reportId, vote);
}

export async function handleNotifications(db: SupabaseClient, userId: string) {
  const viewer = await loadViewer(db, userId);
  const { data } = await db
    .from('notifications')
    .select('*')
    .eq('recipient_id', userId)
    .order('created_at', { ascending: false })
    .limit(100);

  return {
    viewer,
    items: (data ?? []).map((row) => ({
      id: row.id,
      kind: row.kind,
      surface: row.surface ?? 'personal',
      subjectKind: row.subject_type ?? 'thread',
      title: row.title,
      body: row.body ?? '',
      href: row.href ?? '/',
      createdAt: row.created_at,
      isUnread: !!row.is_unread,
      channelTags: [],
      communityTags: []
    }))
  };
}

export async function handleMarkNotificationRead(db: SupabaseClient, userId: string, id: string) {
  await db
    .from('notifications')
    .update({ is_unread: false, read_at: new Date().toISOString() })
    .eq('id', id)
    .eq('recipient_id', userId);
  return { ok: true };
}

export async function handleMarkAllNotificationsRead(db: SupabaseClient, userId: string) {
  await db
    .from('notifications')
    .update({ is_unread: false, read_at: new Date().toISOString() })
    .eq('recipient_id', userId)
    .eq('is_unread', true);
  return { ok: true };
}

export async function handleSearch(db: SupabaseClient, userId: string | null, query: string, limit = 20) {
  if (!query.trim()) {
    return {
      query,
      suggestedQueries: ['projects', 'events', 'threads', 'communities'],
      results: [],
      items: []
    };
  }

  const { data } = await db
    .from('searchable_documents')
    .select('id, entity_type, entity_id, title, summary, href, meta')
    .textSearch('search_vector', query, { type: 'websearch', config: 'english' })
    .limit(Math.min(limit * 3, 60));

  const kindMap: Record<string, string> = {
    project: 'project',
    thread: 'thread',
    event: 'event',
    channel: 'channel',
    community: 'community',
    user: 'profile'
  };

  const results = [];
  const items = [];
  for (const row of data ?? []) {
    const entityType = String(row.entity_type ?? '').toLowerCase();
    if (entityType === 'user' || entityType === 'channel') {
      // Always searchable (matches FastAPI filter_search_results).
    } else if (entityType === 'community') {
      if (!(await canViewCommunityInSearch(db, userId, row.entity_id))) continue;
    } else if (!(await canViewEntity(db, userId, entityType, row.entity_id))) {
      continue;
    }
    const mapped = {
      id: row.entity_id,
      kind: kindMap[row.entity_type] ?? 'thread',
      title: row.title,
      summary: row.summary,
      href: row.href,
      meta: row.meta ?? '',
      entityType: row.entity_type,
      entity_type: row.entity_type,
      entityId: row.entity_id,
      entity_id: row.entity_id
    };
    results.push(mapped);
    items.push(mapped);
    if (results.length >= limit) break;
  }

  return {
    query,
    suggestedQueries: [],
    results,
    items,
    total: results.length
  };
}

export async function handleScope(
  db: SupabaseClient,
  userId: string | null,
  kind: 'channel' | 'community',
  slug: string
) {
  const table = kind === 'channel' ? 'channels' : 'communities';
  const { data: scope } = await db.from(table).select('*').eq('slug', slug).maybeSingle();
  if (!scope) return null;

  let viewerIsMember = false;
  if (userId) {
    const { data: membership } = await db
      .from('scope_memberships')
      .select('id')
      .eq('scope_kind', kind)
      .eq('scope_id', scope.id)
      .eq('user_id', userId)
      .maybeSingle();
    viewerIsMember = !!membership;
  }

  const { count: memberCount } = await db
    .from('scope_memberships')
    .select('*', { count: 'exact', head: true })
    .eq('scope_kind', kind)
    .eq('scope_id', scope.id);
  const members = memberCount ?? 0;

  const joinPolicy =
    kind === 'community' && scope.join_policy === 'closed' ? 'invite_only' : 'open';

  if (kind === 'community' && scope.join_policy === 'closed' && !viewerIsMember) {
    return {
      kind,
      slug: scope.slug,
      title: scope.name,
      description: scope.description ?? '',
      badges: ['Invite only'],
      emptyFeedText: 'Join this closed community to see its feed.',
      membership: {
        memberCount: members,
        viewerIsMember: false,
        viewerCanToggleMembership: false,
        joinPolicy: 'invite_only',
        viewerCanSeeFeed: false,
        hiddenFeedCopy: 'Join to see this community feed.'
      },
      feed: [],
      stats: { projects: 0, threads: 0, events: 0, members },
      moderators: [],
      moderatorCandidates: []
    };
  }

  const feed = await assembleFeedPage(
    db,
    userId,
    'scope',
    new URLSearchParams({ kind, slug, limit: '20', offset: '0' })
  );

  return {
    kind,
    slug: scope.slug,
    title: scope.name,
    description: scope.description ?? '',
    badges: joinPolicy === 'invite_only' ? ['Invite only'] : [],
    emptyFeedText: 'Nothing here yet.',
    membership: {
      memberCount: members,
      viewerIsMember,
      viewerCanToggleMembership: joinPolicy === 'open' || viewerIsMember,
      joinPolicy,
      viewerCanSeeFeed: joinPolicy === 'open' || viewerIsMember,
      hiddenFeedCopy: joinPolicy === 'invite_only' ? 'Join to see this community feed.' : undefined
    },
    feed: feed.items,
    stats: { projects: 0, threads: 0, events: 0, members }
  };
}

export async function handleGetSettings(db: SupabaseClient, userId: string) {
  const viewer = await loadViewer(db, userId);
  if (!viewer) return null;

  let { data } = await db.from('user_settings').select('*').eq('user_id', userId).maybeSingle();
  if (!data) {
    const { data: created } = await db
      .from('user_settings')
      .upsert({ user_id: userId })
      .select('*')
      .single();
    data = created;
  }
  if (!data) return null;

  return {
    profileUsername: viewer.username,
    profileBio: viewer.bio ?? '',
    profileImageUrl: viewer.profileImageUrl ?? '',
    appearanceThemeMode: data.appearance_theme_mode,
    defaultFeed: data.default_feed,
    publicFeedPreferences: {
      scope: data.public_feed_scope,
      filter: data.public_feed_filter,
      sort: data.public_feed_sort,
      window: data.public_feed_window
    },
    personalFeedPreferences: {
      scope: data.personal_feed_scope,
      filter: data.personal_feed_filter,
      sort: data.personal_feed_sort,
      window: data.personal_feed_window
    },
    hidePublicActivityFromPersonalFeeds: data.hide_public_activity_from_personal_feeds,
    hidePersonalFeedFromNonFollowers: data.hide_personal_feed_from_non_followers,
    hidePublicProfileActivityFromNonFollowers: data.hide_public_profile_activity_from_non_followers,
    requireFollowApproval: data.require_follow_approval,
    preferredLanguage: data.preferred_language === 'nl' ? 'nl' : 'en',
    displayTimezone: data.display_timezone ?? null,
    defaultLocationId: data.default_location_id ?? null
  };
}

export async function handleUpdateSettings(
  db: SupabaseClient,
  userId: string,
  patch: Record<string, unknown>
) {
  const userPatch: Record<string, unknown> = {};
  if (typeof patch.profileBio === 'string') userPatch.bio = patch.profileBio;
  if (typeof patch.profileImageUrl === 'string') userPatch.profile_image_url = patch.profileImageUrl;
  if (Object.keys(userPatch).length > 0) {
    userPatch.updated_at = new Date().toISOString();
    await db.from('users').update(userPatch).eq('id', userId);
  }

  const mapped: Record<string, unknown> = {};
  const map: Record<string, string> = {
    appearanceThemeMode: 'appearance_theme_mode',
    defaultFeed: 'default_feed',
    preferredLanguage: 'preferred_language',
    displayTimezone: 'display_timezone',
    defaultLocationId: 'default_location_id',
    requireFollowApproval: 'require_follow_approval',
    hidePublicActivityFromPersonalFeeds: 'hide_public_activity_from_personal_feeds',
    hidePersonalFeedFromNonFollowers: 'hide_personal_feed_from_non_followers',
    hidePublicProfileActivityFromNonFollowers: 'hide_public_profile_activity_from_non_followers'
  };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'profileBio' || key === 'profileImageUrl' || key === 'profileUsername') continue;
    if (key === 'publicFeedPreferences' && value && typeof value === 'object') {
      const prefs = value as Record<string, unknown>;
      if (prefs.scope != null) mapped.public_feed_scope = prefs.scope;
      if (prefs.filter != null) mapped.public_feed_filter = prefs.filter;
      if (prefs.sort != null) mapped.public_feed_sort = prefs.sort;
      if (prefs.window != null) mapped.public_feed_window = prefs.window;
      continue;
    }
    if (key === 'personalFeedPreferences' && value && typeof value === 'object') {
      const prefs = value as Record<string, unknown>;
      if (prefs.scope != null) mapped.personal_feed_scope = prefs.scope;
      if (prefs.filter != null) mapped.personal_feed_filter = prefs.filter;
      if (prefs.sort != null) mapped.personal_feed_sort = prefs.sort;
      if (prefs.window != null) mapped.personal_feed_window = prefs.window;
      continue;
    }
    if (map[key]) mapped[map[key]] = value;
  }
  mapped.updated_at = new Date().toISOString();
  await db.from('user_settings').upsert({ user_id: userId, ...mapped });
  return { ok: true };
}

export { directionFromVote, loadViewer };


export async function handleProfile(db: SupabaseClient, userId: string | null, username: string) {
  const { data: profile } = await db
    .from('users')
    .select('id, username, bio, profile_image_url, created_at')
    .eq('username', username)
    .maybeSingle();
  if (!profile) return null;

  const [
    { count: followersCount },
    { count: followingCount },
    followersRes,
    followingRes
  ] = await Promise.all([
    db
      .from('user_follows')
      .select('*', { count: 'exact', head: true })
      .eq('followed_id', profile.id)
      .eq('status', 'accepted'),
    db
      .from('user_follows')
      .select('*', { count: 'exact', head: true })
      .eq('follower_id', profile.id)
      .eq('status', 'accepted'),
    db
      .from('user_follows')
      .select('follower_id, users!fk_user_follows_follower_id_users(id, username, profile_image_url)')
      .eq('followed_id', profile.id)
      .eq('status', 'accepted')
      .limit(50),
    db
      .from('user_follows')
      .select('followed_id, users!fk_user_follows_followed_id_users(id, username, profile_image_url)')
      .eq('follower_id', profile.id)
      .eq('status', 'accepted')
      .limit(50)
  ]);

  let viewerFollowStatus: 'pending' | 'accepted' | null = null;
  let pendingFollowRequests: Array<{ id: string; username: string; profileImageUrl?: string | null }> = [];
  const isOwnProfile = Boolean(userId && userId === profile.id);

  if (userId && userId !== profile.id) {
    const { data: follow } = await db
      .from('user_follows')
      .select('status')
      .eq('follower_id', userId)
      .eq('followed_id', profile.id)
      .maybeSingle();
    viewerFollowStatus =
      follow?.status === 'pending' || follow?.status === 'accepted' ? follow.status : null;
  }

  if (isOwnProfile) {
    const { data: pending } = await db
      .from('user_follows')
      .select('follower_id, users!fk_user_follows_follower_id_users(id, username, profile_image_url)')
      .eq('followed_id', profile.id)
      .eq('status', 'pending')
      .limit(50);
    pendingFollowRequests = (pending ?? []).map((row) => {
      const u = Array.isArray(row.users) ? row.users[0] : row.users;
      return {
        id: u?.id ?? row.follower_id,
        username: u?.username ?? 'unknown',
        profileImageUrl: u?.profile_image_url ?? null
      };
    });
  }

  const canViewPersonalFeed = isOwnProfile || viewerFollowStatus === 'accepted';

  const feed = await assembleFeedPage(
    db,
    userId,
    'user',
    new URLSearchParams({ username, limit: '20', offset: '0' })
  );

  const mapFollowUser = (row: any, key: 'follower_id' | 'followed_id') => {
    const u = Array.isArray(row.users) ? row.users[0] : row.users;
    return {
      id: u?.id ?? row[key],
      username: u?.username ?? 'unknown',
      profileImageUrl: u?.profile_image_url ?? null
    };
  };

  return {
    username: profile.username,
    bio: profile.bio ?? undefined,
    profileImageUrl: profile.profile_image_url ?? undefined,
    followersCount: followersCount ?? 0,
    followingCount: followingCount ?? 0,
    followers: (followersRes.data ?? []).map((row) => mapFollowUser(row, 'follower_id')),
    following: (followingRes.data ?? []).map((row) => mapFollowUser(row, 'followed_id')),
    pendingFollowRequests,
    canViewPersonalFeed,
    canViewPublicProfileActivity: true,
    viewerIsFollowing: viewerFollowStatus === 'accepted',
    viewerFollowStatus,
    isOwnProfile,
    feed: feed.items
  };
}

export async function handleTaggableScopes(
  db: SupabaseClient,
  userId: string | null,
  query: string,
  kind?: string | null,
  limit = 20
) {
  const q = query.trim();
  const capped = Math.min(Math.max(limit || 20, 1), 25);
  const memberScopeIds = new Set<string>();
  if (userId) {
    const { data: memberships } = await db
      .from('scope_memberships')
      .select('scope_kind, scope_id')
      .eq('user_id', userId);
    for (const row of memberships ?? []) {
      memberScopeIds.add(`${row.scope_kind}:${row.scope_id}`);
    }
  }

  let channels: Array<{ id: string; slug: string; name: string }> = [];
  if (!kind || kind === 'channel') {
    let req = db.from('channels').select('id, slug, name').order('name').limit(capped);
    if (q) req = req.or(`name.ilike.%${q}%,slug.ilike.%${q}%`);
    channels = ((await req).data ?? []) as Array<{ id: string; slug: string; name: string }>;
  }

  let communities: Array<{ id: string; slug: string; name: string; join_policy: string }> = [];
  if (!kind || kind === 'community') {
    let req = db
      .from('communities')
      .select('id, slug, name, join_policy')
      .order('name')
      .limit(capped);
    if (q) req = req.or(`name.ilike.%${q}%,slug.ilike.%${q}%`);
    communities = ((await req).data ?? []) as Array<{
      id: string;
      slug: string;
      name: string;
      join_policy: string;
    }>;
    communities = communities.filter((row) => {
      if (row.join_policy !== 'closed') return true;
      return memberScopeIds.has(`community:${row.id}`);
    });
  }

  return {
    channels: channels.map((row) => ({
      slug: row.slug,
      label: row.name,
      href: `/channels/${row.slug}`,
      visibility: 'public' as const,
      viewerIsMember: memberScopeIds.has(`channel:${row.id}`)
    })),
    communities: communities.map((row) => ({
      slug: row.slug,
      label: row.name,
      href: `/communities/${row.slug}`,
      visibility: row.join_policy === 'closed' ? ('private' as const) : ('public' as const),
      viewerIsMember: memberScopeIds.has(`community:${row.id}`)
    }))
  };
}

export async function handleMessageContacts(db: SupabaseClient, userId: string, query: string, limit = 8) {
  const q = query.trim();
  let req = db.from('users').select('id, username, bio, profile_image_url').neq('id', userId).limit(limit);
  if (q) req = req.ilike('username', `%${q}%`);
  const { data } = await req;
  return { items: (data ?? []).map((row) => ({ id: row.id, username: row.username, bio: row.bio ?? undefined, profileImageUrl: row.profile_image_url ?? undefined })) };
}

export async function handleLinkedChats(db: SupabaseClient, userId: string) {
  return buildLinkedChats(db, userId);
}

export async function handleFollowRequests(db: SupabaseClient, userId: string) {
  const { data } = await db
    .from('user_follows')
    .select('follower_id, users!fk_user_follows_follower_id_users(id, username, bio, profile_image_url)')
    .eq('followed_id', userId)
    .eq('status', 'pending');
  return {
    items: (data ?? []).map((row) => {
      const user = Array.isArray(row.users) ? row.users[0] : row.users;
      return { id: user?.id ?? row.follower_id, username: user?.username ?? 'unknown', bio: user?.bio ?? undefined, profileImageUrl: user?.profile_image_url ?? undefined };
    })
  };
}
