/**
 * Differentiated feed assembly with access filtering.
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import {
  canViewByTags,
  canViewEntity,
  canViewPost,
  canViewPrivateEvent,
  loadEntityTags,
  viewerFollowsAuthor
} from './access.ts';
import { loadActiveReport, moderationFieldsFromRow } from './moderation.ts';

type VoteDirection = -1 | 0 | 1;

function mapModeration(
  row: Record<string, unknown>,
  report: Awaited<ReturnType<typeof loadActiveReport>> | null = null
) {
  const fields = moderationFieldsFromRow(row, report);
  return {
    report: fields.report,
    moderationState: fields.moderationState,
    hasActiveReport: fields.hasActiveReport,
    isUnderReview: fields.isUnderReview,
    isRemovedByReport: fields.isRemovedByReport
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

async function signalSummary(
  db: SupabaseClient,
  table: 'project_signals' | 'event_signals',
  idCol: string,
  entityId: string,
  userId: string | null
) {
  const { data } = await db.from(table).select('signal_type, user_id').eq(idCol, entityId);
  let supportCount = 0;
  let opposeCount = 0;
  let viewerSignal: 'demand' | 'opposition' | null = null;
  for (const row of data ?? []) {
    if (row.signal_type === 'demand' || row.signal_type === 'support') supportCount += 1;
    if (row.signal_type === 'opposition' || row.signal_type === 'oppose') opposeCount += 1;
    if (userId && row.user_id === userId) {
      viewerSignal =
        row.signal_type === 'opposition' || row.signal_type === 'oppose'
          ? 'opposition'
          : 'demand';
    }
  }
  const signalCount = supportCount + opposeCount;
  const favorability = signalCount > 0 ? supportCount / signalCount : null;
  return { supportCount, opposeCount, viewerSignal, signalCount, favorability };
}

async function mapThread(db: SupabaseClient, userId: string | null, thread: any) {
  if (!(await canViewByTags(db, userId, 'thread', thread.id))) return null;
  const author = Array.isArray(thread.users) ? thread.users[0] : thread.users;
  const tags = await loadEntityTags(db, 'thread', thread.id);
  const report = await loadActiveReport(db, 'thread', thread.id, userId);
  return {
    kind: 'thread',
    id: thread.id,
    slug: thread.slug,
    href: `/threads/${thread.slug}`,
    createdAt: thread.created_at,
    title: thread.title,
    body: thread.body,
    authorUsername: author?.username ?? 'unknown',
    ...tags,
    voteCount: thread.vote_count ?? 0,
    activeVote: await viewerVote(db, userId, 'thread', thread.id),
    commentCount: thread.comment_count ?? 0,
    lastActivityAt: thread.last_activity_at ?? thread.created_at,
    ...mapModeration(thread, report)
  };
}

async function mapPost(db: SupabaseClient, userId: string | null, post: any, feedSource?: string) {
  if (!(await canViewPost(db, userId, post))) return null;
  const author = Array.isArray(post.users) ? post.users[0] : post.users;
  const report = await loadActiveReport(db, 'post', post.id, userId);
  return {
    kind: 'post',
    id: `post-activity-${post.id}`,
    href: `/posts/${post.id}`,
    createdAt: post.created_at,
    author: {
      username: author?.username ?? 'unknown',
      profileImageUrl: author?.profile_image_url ?? null
    },
    body: post.body,
    linkedSubjects: [],
    voteTargetId: post.id,
    voteCount: post.vote_count ?? 0,
    activeVote: await viewerVote(db, userId, 'post', post.id),
    commentCount: post.comment_count ?? 0,
    feedSource,
    ...mapModeration(post, report)
  };
}

function truncateUpdateBody(body: string, limit = 200) {
  const text = String(body ?? '').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

async function fetchLatestUpdates(
  db: SupabaseClient,
  projectIds: string[],
  eventIds: string[]
) {
  const latest = new Map<string, { body: string; createdAt: string }>();

  if (projectIds.length) {
    const { data } = await db
      .from('project_updates')
      .select('project_id, body, created_at')
      .in('project_id', projectIds)
      .order('created_at', { ascending: false });
    for (const row of data ?? []) {
      const key = `project:${row.project_id}`;
      if (latest.has(key)) continue;
      latest.set(key, {
        body: truncateUpdateBody(String(row.body ?? '')),
        createdAt: String(row.created_at)
      });
    }
  }

  if (eventIds.length) {
    const { data } = await db
      .from('event_updates')
      .select('event_id, body, created_at')
      .in('event_id', eventIds)
      .order('created_at', { ascending: false });
    for (const row of data ?? []) {
      const key = `event:${row.event_id}`;
      if (latest.has(key)) continue;
      latest.set(key, {
        body: truncateUpdateBody(String(row.body ?? '')),
        createdAt: String(row.created_at)
      });
    }
  }

  return latest;
}

async function mapProject(
  db: SupabaseClient,
  userId: string | null,
  project: any,
  latestUpdate?: { body: string; createdAt: string } | null
) {
  if (!(await canViewByTags(db, userId, 'project', project.id))) return null;
  const author = Array.isArray(project.users) ? project.users[0] : project.users;
  const tags = await loadEntityTags(db, 'project', project.id);
  const signals = await signalSummary(db, 'project_signals', 'project_id', project.id, userId);
  const report = await loadActiveReport(db, 'project', project.id, userId);
  return {
    kind: 'project',
    id: project.id,
    slug: project.slug,
    href: `/projects/${project.slug}`,
    createdAt: project.created_at,
    title: project.title,
    authorUsername: author?.username ?? 'unknown',
    projectMode: project.project_mode,
    projectSubtype: project.project_subtype,
    summary: project.description ?? '',
    ...tags,
    stage: project.stage_label ?? '',
    locationLabel: project.location_label ?? '',
    locationId: project.location_id ?? null,
    voteCount: project.vote_count ?? 0,
    activeVote: await viewerVote(db, userId, 'project', project.id),
    signalCount: signals.signalCount,
    supportCount: signals.supportCount,
    opposeCount: signals.opposeCount,
    favorability: signals.favorability,
    viewerSignal: signals.viewerSignal,
    commentCount: project.comment_count ?? 0,
    memberCount: project.member_count ?? 0,
    lastActivityAt: project.last_activity_at ?? project.created_at,
    isClosed: Boolean(project.is_closed),
    ...(latestUpdate
      ? {
          latestDescription: latestUpdate.body,
          latestUpdateAt: latestUpdate.createdAt
        }
      : {}),
    ...mapModeration(project, report)
  };
}

async function mapEvent(
  db: SupabaseClient,
  userId: string | null,
  event: any,
  latestUpdate?: { body: string; createdAt: string } | null
) {
  if (!(await canViewPrivateEvent(db, userId, event))) return null;
  if (!event.is_private && !(await canViewByTags(db, userId, 'event', event.id))) return null;
  const author = Array.isArray(event.users) ? event.users[0] : event.users;
  const tags = await loadEntityTags(db, 'event', event.id);
  const signals = await signalSummary(db, 'event_signals', 'event_id', event.id, userId);
  const report = await loadActiveReport(db, 'event', event.id, userId);
  return {
    kind: 'event',
    id: event.id,
    slug: event.slug,
    href: `/events/${event.slug}`,
    createdAt: event.created_at,
    title: event.title,
    description: event.description ?? '',
    isPrivate: !!event.is_private,
    stage: '',
    ...tags,
    createdByUsername: author?.username ?? 'unknown',
    timeLabel: event.scheduled_at ?? event.time_label ?? '',
    locationLabel: event.location_label ?? '',
    locationId: event.location_id ?? null,
    voteCount: event.vote_count ?? 0,
    activeVote: await viewerVote(db, userId, 'event', event.id),
    signalCount: signals.signalCount,
    supportCount: signals.supportCount,
    opposeCount: signals.opposeCount,
    favorability: signals.favorability,
    viewerSignal: signals.viewerSignal,
    commentCount: event.comment_count ?? 0,
    memberCount: event.member_count ?? 0,
    lastActivityAt: event.last_activity_at ?? event.created_at,
    ...(latestUpdate
      ? {
          latestUpdateBody: latestUpdate.body,
          latestUpdateAt: latestUpdate.createdAt
        }
      : {}),
    ...mapModeration(event, report)
  };
}

async function mapHelp(db: SupabaseClient, userId: string | null, request: any) {
  if (!(await canViewByTags(db, userId, 'help_request', request.id))) return null;
  const author = Array.isArray(request.users) ? request.users[0] : request.users;
  const tags = await loadEntityTags(db, 'help_request', request.id);
  const report = await loadActiveReport(db, 'help_request', request.id, userId);
  const { data: roles } = await db
    .from('help_request_roles')
    .select('title, description, slots')
    .eq('help_request_id', request.id);
  return {
    kind: 'help-request',
    id: request.id,
    href: `/help-requests/${request.id}`,
    createdAt: request.created_at,
    title: request.title,
    body: request.body ?? '',
    authorUsername: author?.username ?? 'unknown',
    locationLabel: request.location_label ?? '',
    locationId: request.location_id ?? null,
    scheduleLabel: request.schedule_label ?? '',
    neededAt: request.needed_at,
    roles: (roles ?? []).map((role) => ({
      title: role.title,
      description: role.description ?? '',
      slots: role.slots
    })),
    ...tags,
    voteCount: request.vote_count ?? 0,
    activeVote: await viewerVote(db, userId, 'help_request', request.id),
    commentCount: request.comment_count ?? 0,
    lastActivityAt: request.last_activity_at ?? request.created_at,
    ...mapModeration(request, report)
  };
}

function commentActivityHref(
  subjectType: string,
  subjectId: string,
  slug: string | null,
  commentId: string
): string {
  switch (subjectType) {
    case 'thread':
      return slug ? `/threads/${slug}?comment=${commentId}` : '#';
    case 'post':
      return `/posts/${subjectId}?comment=${commentId}`;
    case 'project':
      return slug ? `/projects/${slug}?tab=chat&comment=${commentId}` : '#';
    case 'event':
      return slug ? `/events/${slug}?tab=chat&comment=${commentId}` : '#';
    case 'help_request':
      return `/help-requests/${subjectId}?tab=chat&comment=${commentId}`;
    default:
      return '#';
  }
}

function mapSubjectKind(subjectType: string): string {
  if (subjectType === 'help_request') return 'help-request';
  if (
    subjectType === 'thread' ||
    subjectType === 'post' ||
    subjectType === 'project' ||
    subjectType === 'event'
  ) {
    return subjectType;
  }
  return 'thread';
}

async function mapCommentActivity(
  db: SupabaseClient,
  userId: string | null,
  comment: any,
  feedSource?: string
) {
  if (comment.moderation_state === 'removed') return null;
  const subjectType = String(comment.subject_type ?? '');
  const subjectId = String(comment.subject_id ?? '');
  if (!subjectType || !subjectId) return null;

  // Respect the same visibility rules as the subject itself.
  if (subjectType === 'post') {
    const { data: post } = await db
      .from('posts')
      .select('id, body, author_id, audience, moderation_state')
      .eq('id', subjectId)
      .maybeSingle();
    if (!post || post.moderation_state === 'removed') return null;
    if (!(await canViewPost(db, userId, post))) return null;
  } else if (subjectType === 'event') {
    const { data: event } = await db
      .from('events')
      .select(
        'id, slug, title, is_private, audience, home_community_id, created_by, moderation_state'
      )
      .eq('id', subjectId)
      .maybeSingle();
    if (!event || event.moderation_state === 'removed') return null;
    if (!(await canViewPrivateEvent(db, userId, event))) return null;
    if (!event.is_private && !(await canViewByTags(db, userId, 'event', event.id))) return null;
  } else if (subjectType === 'thread' || subjectType === 'project' || subjectType === 'help_request') {
    if (!(await canViewEntity(db, userId, subjectType, subjectId))) return null;
  } else {
    return null;
  }

  let subjectTitle = 'Untitled';
  let slug: string | null = null;
  if (subjectType === 'thread') {
    const { data } = await db.from('threads').select('slug, title, moderation_state').eq('id', subjectId).maybeSingle();
    if (!data || data.moderation_state === 'removed') return null;
    subjectTitle = data.title ?? subjectTitle;
    slug = data.slug ?? null;
  } else if (subjectType === 'project') {
    const { data } = await db
      .from('projects')
      .select('slug, title, is_closed, moderation_state')
      .eq('id', subjectId)
      .maybeSingle();
    if (!data || data.moderation_state === 'removed' || data.is_closed) return null;
    subjectTitle = data.title ?? subjectTitle;
    slug = data.slug ?? null;
  } else if (subjectType === 'event') {
    const { data } = await db.from('events').select('slug, title, moderation_state').eq('id', subjectId).maybeSingle();
    if (!data || data.moderation_state === 'removed') return null;
    subjectTitle = data.title ?? subjectTitle;
    slug = data.slug ?? null;
  } else if (subjectType === 'help_request') {
    const { data } = await db.from('help_requests').select('title, moderation_state').eq('id', subjectId).maybeSingle();
    if (!data || data.moderation_state === 'removed') return null;
    subjectTitle = data.title ?? subjectTitle;
  } else if (subjectType === 'post') {
    const { data } = await db.from('posts').select('body, moderation_state').eq('id', subjectId).maybeSingle();
    if (!data || data.moderation_state === 'removed') return null;
    subjectTitle = String(data.body ?? '').slice(0, 120) || 'Post';
  }

  const author = Array.isArray(comment.users) ? comment.users[0] : comment.users;
  const { count: replyCount } = await db
    .from('comments')
    .select('id', { count: 'exact', head: true })
    .eq('parent_id', comment.id);

  return {
    kind: 'comment-activity',
    id: comment.id,
    href: commentActivityHref(subjectType, subjectId, slug, comment.id),
    createdAt: comment.created_at,
    author: {
      id: author?.id ?? comment.author_id ?? '',
      username: author?.username ?? 'unknown',
      profileImageUrl: author?.profile_image_url ?? null
    },
    authorUsername: author?.username ?? 'unknown',
    subjectKind: mapSubjectKind(subjectType),
    subjectType,
    subjectId,
    subjectSlug: slug,
    subjectTitle,
    title: subjectTitle,
    body: comment.body ?? '',
    commentExcerpt: comment.body ?? '',
    voteTargetId: comment.id,
    voteCount: comment.vote_count ?? 0,
    activeVote: await viewerVote(db, userId, 'comment', comment.id),
    commentCount: replyCount ?? 0,
    feedSource,
    lastActivityAt: comment.created_at,
    ...mapModeration(comment, await loadActiveReport(db, 'comment', comment.id, userId))
  };
}

function pageResult(items: unknown[], limit: number, offset: number) {
  const pageItems = items.slice(offset, offset + limit);
  return {
    items: pageItems,
    limit,
    offset,
    hasMore: offset + limit < items.length
  };
}

async function collectCandidates(
  db: SupabaseClient,
  userId: string | null,
  filter: string,
  opts: {
    authorIds?: string[] | null;
    authorId?: string | null;
    scopeKind?: 'channel' | 'community' | null;
    scopeId?: string | null;
    includePrivateEvents?: boolean;
    includeCommentActivity?: boolean;
    lat?: number | null;
    lon?: number | null;
    radiusKm?: number | null;
  } = {}
) {
  const fetchLimit = 80;
  const items: Array<{ sortAt: string; item: unknown }> = [];

  const scopedEntityIds = async (entityType: string): Promise<Set<string> | null> => {
    if (!opts.scopeKind || !opts.scopeId) return null;
    const meta =
      entityType === 'thread'
        ? { table: 'thread_tags', idCol: 'thread_id' }
        : entityType === 'project'
          ? { table: 'project_tags', idCol: 'project_id' }
          : entityType === 'event'
            ? { table: 'event_tags', idCol: 'event_id' }
            : entityType === 'help_request'
              ? { table: 'help_request_tags', idCol: 'help_request_id' }
              : null;
    if (!meta) return new Set();
    const col = opts.scopeKind === 'channel' ? 'channel_id' : 'community_id';
    const { data, error } = await db.from(meta.table).select(meta.idCol).eq(col, opts.scopeId);
    if (error) {
      console.error('scopedEntityIds error', entityType, error);
      return new Set();
    }
    return new Set((data ?? []).map((row) => String((row as Record<string, unknown>)[meta.idCol])));
  };

  const threadScopeIds = await scopedEntityIds('thread');
  const projectScopeIds = await scopedEntityIds('project');
  const eventScopeIds = await scopedEntityIds('event');
  const helpScopeIds = await scopedEntityIds('help_request');

  const inScope = (entityType: string, entityId: string) => {
    const set =
      entityType === 'thread'
        ? threadScopeIds
        : entityType === 'project'
          ? projectScopeIds
          : entityType === 'event'
            ? eventScopeIds
            : entityType === 'help_request'
              ? helpScopeIds
              : null;
    if (!set) return true;
    return set.has(String(entityId));
  };

  if (filter === 'all' || filter === 'threads') {
    if (!(threadScopeIds && threadScopeIds.size === 0)) {
      let q = db
        .from('threads')
        .select(
          'id, slug, title, body, author_id, vote_count, comment_count, created_at, last_activity_at, moderation_state, users!fk_threads_author_id_users(username)'
        )
        .order('last_activity_at', { ascending: false })
        .limit(fetchLimit);
      if (opts.authorId) q = q.eq('author_id', opts.authorId);
      if (opts.authorIds) q = q.in('author_id', opts.authorIds);
      if (threadScopeIds) q = q.in('id', [...threadScopeIds]);
      const { data } = await q;
      for (const thread of data ?? []) {
        if (!inScope('thread', thread.id)) continue;
        const mapped = await mapThread(db, userId, thread);
        if (mapped) items.push({ sortAt: mapped.lastActivityAt, item: mapped });
      }
    }
  }

  // Posts belong on personal/user timelines only. Including them in public/scope
  // discovery feeds crashes PublicFeedCard (posts lack channelTags and fall through to EventCard).
  if (
    (filter === 'all' || filter === 'posts') &&
    !opts.scopeKind &&
    (opts.authorId || (opts.authorIds && opts.authorIds.length > 0))
  ) {
    let q = db
      .from('posts')
      .select(
        'id, body, author_id, audience, vote_count, comment_count, created_at, moderation_state, users!fk_posts_author_id_users(username, profile_image_url)'
      )
      .order('created_at', { ascending: false })
      .limit(fetchLimit);
    if (opts.authorId) q = q.eq('author_id', opts.authorId);
    if (opts.authorIds) q = q.in('author_id', opts.authorIds);
    const { data } = await q;
    for (const post of data ?? []) {
      const mapped = await mapPost(db, userId, post, opts.authorIds ? 'following' : undefined);
      if (mapped) items.push({ sortAt: mapped.createdAt, item: mapped });
    }
  }

  if (filter === 'all' || filter === 'projects') {
    if (!(projectScopeIds && projectScopeIds.size === 0)) {
      let q = db
        .from('projects')
        .select(
          'id, slug, title, description, author_id, project_mode, project_subtype, stage_label, location_label, location_id, vote_count, signal_count, comment_count, member_count, is_closed, created_at, last_activity_at, moderation_state, users!fk_projects_author_id_users(username)'
        )
        .order('last_activity_at', { ascending: false })
        .limit(fetchLimit);
      if (opts.authorId) q = q.eq('author_id', opts.authorId);
      if (opts.authorIds) q = q.in('author_id', opts.authorIds);
      if (projectScopeIds) q = q.in('id', [...projectScopeIds]);
      const { data } = await q;
      const scopedProjects = (data ?? []).filter((project) => inScope('project', project.id));
      const latestUpdates = await fetchLatestUpdates(
        db,
        scopedProjects.map((project) => String(project.id)),
        []
      );
      for (const project of scopedProjects) {
        const mapped = await mapProject(
          db,
          userId,
          project,
          latestUpdates.get(`project:${project.id}`) ?? null
        );
        if (mapped) items.push({ sortAt: mapped.lastActivityAt, item: mapped });
      }
    }
  }

  if (filter === 'all' || filter === 'events') {
    if (!(eventScopeIds && eventScopeIds.size === 0)) {
      let q = db
        .from('events')
        .select(
          'id, slug, title, description, created_by, is_private, audience, home_community_id, location_label, location_id, scheduled_at, time_label, vote_count, comment_count, member_count, created_at, last_activity_at, moderation_state, users!fk_events_created_by_users(username)'
        )
        .order('last_activity_at', { ascending: false })
        .limit(fetchLimit);
      if (!opts.includePrivateEvents) q = q.eq('is_private', false);
      if (opts.authorId) q = q.eq('created_by', opts.authorId);
      if (opts.authorIds) q = q.in('created_by', opts.authorIds);
      if (eventScopeIds) q = q.in('id', [...eventScopeIds]);
      const { data } = await q;
      const scopedEvents = (data ?? []).filter((event) => inScope('event', event.id));
      const latestUpdates = await fetchLatestUpdates(
        db,
        [],
        scopedEvents.map((event) => String(event.id))
      );
      for (const event of scopedEvents) {
        const mapped = await mapEvent(
          db,
          userId,
          event,
          latestUpdates.get(`event:${event.id}`) ?? null
        );
        if (mapped) items.push({ sortAt: mapped.lastActivityAt, item: mapped });
      }
    }
  }

  if (filter === 'all' || filter === 'help_requests') {
    if (!(helpScopeIds && helpScopeIds.size === 0)) {
      let q = db
        .from('help_requests')
        .select(
          'id, title, body, author_id, location_label, location_id, schedule_label, needed_at, vote_count, comment_count, created_at, moderation_state, users!fk_help_requests_author_id_users(username)'
        )
        .order('created_at', { ascending: false })
        .limit(fetchLimit);
      if (opts.authorId) q = q.eq('author_id', opts.authorId);
      if (opts.authorIds) q = q.in('author_id', opts.authorIds);
      if (helpScopeIds) q = q.in('id', [...helpScopeIds]);
      const { data } = await q;
      for (const request of data ?? []) {
        if (!inScope('help_request', request.id)) continue;
        const mapped = await mapHelp(db, userId, request);
        if (mapped) items.push({ sortAt: mapped.lastActivityAt, item: mapped });
      }
    }
  }

  // FastAPI parity: personal/user/home-following feeds include comment activity.
  if (opts.includeCommentActivity && filter === 'all' && (opts.authorId || opts.authorIds?.length)) {
    let q = db
      .from('comments')
      .select(
        'id, subject_type, subject_id, parent_id, body, author_id, vote_count, created_at, moderation_state, users!fk_comments_author_id_users(id, username, profile_image_url)'
      )
      .neq('moderation_state', 'removed')
      .order('created_at', { ascending: false })
      .limit(fetchLimit);
    if (opts.authorId) q = q.eq('author_id', opts.authorId);
    if (opts.authorIds) q = q.in('author_id', opts.authorIds);
    const { data } = await q;
    for (const comment of data ?? []) {
      const mapped = await mapCommentActivity(
        db,
        userId,
        comment,
        opts.authorIds ? 'following' : undefined
      );
      if (mapped) items.push({ sortAt: mapped.createdAt, item: mapped });
    }
  }

  items.sort((a, b) => String(b.sortAt).localeCompare(String(a.sortAt)));
  return items.map((entry) => entry.item);
}

export async function handleFeedPage(
  db: SupabaseClient,
  userId: string | null,
  kind: 'public' | 'home' | 'personal' | 'region' | 'scope' | 'user',
  params: URLSearchParams
) {
  const limit = Math.min(Number(params.get('limit') ?? 20), 50);
  const offset = Math.max(Number(params.get('offset') ?? 0), 0);
  const filter = params.get('filter') ?? 'all';
  const sort = params.get('sort') ?? 'recent';

  if (kind === 'public') {
    const items = await collectCandidates(db, userId, filter, {});
    const page = pageResult(items, limit, offset);
    return { ...page, sort, total: items.length };
  }

  if (kind === 'home') {
    // Authenticated home: followed authors + public discovery.
    let authorIds: string[] | null = null;
    if (userId) {
      const { data: follows } = await db
        .from('user_follows')
        .select('followed_id')
        .eq('follower_id', userId)
        .eq('status', 'accepted');
      authorIds = (follows ?? []).map((row) => row.followed_id);
      authorIds.push(userId);
    }
    const following = authorIds?.length
      ? await collectCandidates(db, userId, filter, {
          authorIds,
          includeCommentActivity: true
        })
      : [];
    const discovery = await collectCandidates(db, userId, filter, {});
    const seen = new Set<string>();
    const merged: unknown[] = [];
    for (const item of [...following, ...discovery]) {
      const id = (item as { id?: string }).id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(item);
    }
    const page = pageResult(merged, limit, offset);
    return { ...page, sort, total: merged.length };
  }

  if (kind === 'personal') {
    const scope = params.get('scope') ?? 'following';
    if (!userId) return pageResult([], limit, offset);
    const { data: follows } = await db
      .from('user_follows')
      .select('followed_id')
      .eq('follower_id', userId)
      .eq('status', 'accepted');
    const authorIds = (follows ?? []).map((row) => row.followed_id);
    authorIds.push(userId);
    if (scope === 'following') {
      const items = await collectCandidates(db, userId, filter, {
        authorIds,
        includeCommentActivity: true
      });
      return { ...pageResult(items, limit, offset), sort, total: items.length };
    }
    // popular = followed authors + public discovery (FastAPI parity)
    const following = await collectCandidates(db, userId, filter, {
      authorIds,
      includeCommentActivity: true
    });
    const discovery = await collectCandidates(db, userId, filter, {});
    const seen = new Set<string>();
    const merged: unknown[] = [];
    for (const item of [...following, ...discovery]) {
      const id = (item as { id?: string }).id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(item);
    }
    return { ...pageResult(merged, limit, offset), sort, total: merged.length };
  }

  if (kind === 'user') {
    const username = params.get('username') ?? '';
    const { data: profile } = await db
      .from('users')
      .select('id')
      .eq('username', username)
      .maybeSingle();
    if (!profile) return pageResult([], limit, offset);
    const items = await collectCandidates(db, userId, filter, {
      authorId: profile.id,
      includeCommentActivity: true
    });
    return { ...pageResult(items, limit, offset), sort, total: items.length };
  }

  if (kind === 'scope') {
    const scopeKind = (params.get('kind') as 'channel' | 'community') ?? 'channel';
    const slug = params.get('slug') ?? '';
    const table = scopeKind === 'channel' ? 'channels' : 'communities';
    const { data: scope } = await db
      .from(table)
      .select(scopeKind === 'community' ? 'id, join_policy' : 'id')
      .eq('slug', slug)
      .maybeSingle();
    if (!scope) return pageResult([], limit, offset);
    if (scopeKind === 'community' && scope.join_policy === 'closed') {
      if (!userId) return pageResult([], limit, offset);
      const { data: membership } = await db
        .from('scope_memberships')
        .select('user_id')
        .eq('scope_kind', 'community')
        .eq('scope_id', scope.id)
        .eq('user_id', userId)
        .maybeSingle();
      if (!membership) return pageResult([], limit, offset);
    }
    const items = await collectCandidates(db, userId, filter, {
      scopeKind,
      scopeId: scope.id,
      includePrivateEvents: true
    });
    return { ...pageResult(items, limit, offset), sort, total: items.length };
  }

  if (kind === 'region') {
    const lat = Number(params.get('lat'));
    const lon = Number(params.get('lon'));
    const rawRadius = Number(params.get('radiusKm') ?? params.get('radius_km') ?? 25);
    const radiusKm = Number.isFinite(rawRadius)
      ? Math.min(Math.max(Math.trunc(rawRadius), 1), 20000)
      : 25;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return { ...pageResult([], limit, offset), sort, total: 0 };
    }
    const items = await collectCandidates(db, userId, filter, {
      lat,
      lon,
      radiusKm,
      // Region feed is physical-only; private events are excluded by mapper options below.
      includePrivateEvents: false
    });
    const haversine = (aLat: number, aLon: number, bLat: number, bLon: number) => {
      const toRad = (v: number) => (v * Math.PI) / 180;
      const R = 6371;
      const dLat = toRad(bLat - aLat);
      const dLon = toRad(bLon - aLon);
      const aa =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(aa));
    };
    const withDistance: unknown[] = [];
    for (const item of items) {
      const kindLabel = String((item as { kind?: string }).kind ?? '');
      if (kindLabel === 'thread' || kindLabel === 'post') continue;
      const locationId = (item as { locationId?: string | null }).locationId ?? null;
      if (!locationId) continue;
      const { data: loc } = await db
        .from('locations')
        .select('latitude, longitude, is_online')
        .eq('id', locationId)
        .maybeSingle();
      if (!loc?.latitude || !loc?.longitude || loc.is_online) continue;
      const distanceKm = haversine(lat, lon, Number(loc.latitude), Number(loc.longitude));
      if (distanceKm > radiusKm) continue;
      withDistance.push({ ...(item as object), distanceKm });
    }
    withDistance.sort(
      (a, b) =>
        Number((a as { distanceKm: number }).distanceKm) -
        Number((b as { distanceKm: number }).distanceKm)
    );
    return { ...pageResult(withDistance, limit, offset), sort, total: withDistance.length };
  }

  return pageResult([], limit, offset);
}

export async function handleMapMarkers(
  db: SupabaseClient,
  userId: string | null,
  params: URLSearchParams
) {
  const lat = Number(params.get('lat'));
  const lon = Number(params.get('lon'));
  const rawRadius = Number(params.get('radiusKm') ?? params.get('radius_km') ?? 25);
  const radiusKm = Number.isFinite(rawRadius)
    ? Math.min(Math.max(Math.trunc(rawRadius), 1), 20000)
    : 25;
  const filter = params.get('filter') ?? 'all';
  const markers: unknown[] = [];

  const haversine = (aLat: number, aLon: number, bLat: number, bLon: number) => {
    const toRad = (v: number) => (v * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(bLat - aLat);
    const dLon = toRad(bLon - aLon);
    const aa =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(aa));
  };

  const pushIfNear = async (
    entityType: 'event' | 'project' | 'help_request',
    row: any,
    title: string,
    slug: string | null,
    href: string,
    locationId: string | null
  ) => {
    if (!locationId) return;
    if (!(await canViewEntity(db, userId, entityType, row.id))) return;
    const { data: loc } = await db
      .from('locations')
      .select('*')
      .eq('id', locationId)
      .maybeSingle();
    if (!loc?.latitude || !loc?.longitude || loc.is_online) return;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const distanceKm = haversine(lat, lon, Number(loc.latitude), Number(loc.longitude));
    if (distanceKm > radiusKm) return;
    markers.push({
      id: row.id,
      entityType,
      slug,
      title,
      href,
      latitude: Number(loc.latitude),
      longitude: Number(loc.longitude),
      precision: loc.precision ?? 'approximate',
      displayLabel: loc.display_label,
      distanceKm,
      scheduledAt: row.scheduled_at ?? row.needed_at ?? null,
      endsAt: row.ends_at ?? null
    });
  };

  if (filter === 'all' || filter === 'events') {
    const { data } = await db
      .from('events')
      .select('id, slug, title, location_id, scheduled_at, ends_at, is_private')
      .not('location_id', 'is', null)
      .limit(100);
    for (const row of data ?? []) {
      await pushIfNear('event', row, row.title, row.slug, `/events/${row.slug}`, row.location_id);
    }
  }
  if (filter === 'all' || filter === 'projects') {
    const { data } = await db
      .from('projects')
      .select('id, slug, title, location_id')
      .not('location_id', 'is', null)
      .limit(100);
    for (const row of data ?? []) {
      await pushIfNear(
        'project',
        row,
        row.title,
        row.slug,
        `/projects/${row.slug}`,
        row.location_id
      );
    }
  }
  if (filter === 'all' || filter === 'help_requests') {
    const { data } = await db
      .from('help_requests')
      .select('id, title, location_id, needed_at, ends_at')
      .not('location_id', 'is', null)
      .limit(100);
    for (const row of data ?? []) {
      await pushIfNear(
        'help_request',
        row,
        row.title,
        null,
        `/help-requests/${row.id}`,
        row.location_id
      );
    }
  }

  markers.sort(
    (a, b) =>
      Number((a as { distanceKm: number }).distanceKm) -
      Number((b as { distanceKm: number }).distanceKm)
  );
  return markers;
}

export { viewerVote, mapModeration, signalSummary };
