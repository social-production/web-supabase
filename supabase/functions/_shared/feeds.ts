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
import { loadActiveReport, loadActiveReportsByTargetIds, moderationFieldsFromRow } from './moderation.ts';
import { measureServerSpan } from './performance.ts';

type VoteDirection = -1 | 0 | 1;

type FeedTagBundle = {
  channelTags: Array<{ slug: string; label: string; kind: 'channel' }>;
  communityTags: Array<{ slug: string; label: string; kind: 'community' }>;
};

type FeedSignalSummary = {
  supportCount: number;
  opposeCount: number;
  viewerSignal: 'demand' | 'opposition' | null;
  signalCount: number;
  favorability: number | null;
};

type FeedEnrichment = {
  tagsById?: Map<string, FeedTagBundle>;
  votesById?: Map<string, VoteDirection>;
  reportsById?: Map<string, Awaited<ReturnType<typeof loadActiveReport>>>;
  signalsById?: Map<string, FeedSignalSummary>;
  helpRolesById?: Map<string, Array<{ title: string; description: string; slots: number }>>;
};

const TAG_TABLE: Record<string, { table: string; idCol: string }> = {
  thread: { table: 'thread_tags', idCol: 'thread_id' },
  project: { table: 'project_tags', idCol: 'project_id' },
  event: { table: 'event_tags', idCol: 'event_id' },
  help_request: { table: 'help_request_tags', idCol: 'help_request_id' }
};

function feedAuthorFromUser(
  user: { id?: string | null; username?: string | null; profile_image_url?: string | null } | null | undefined,
  fallbackId?: string | null
) {
  return {
    id: String(user?.id ?? fallbackId ?? ''),
    username: user?.username ?? 'unknown',
    profileImageUrl: user?.profile_image_url ?? null
  };
}

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

async function viewerVotesBatch(
  db: SupabaseClient,
  userId: string | null,
  targetType: string,
  targetIds: string[]
) {
  const out = new Map<string, VoteDirection>();
  const unique = [...new Set(targetIds.filter(Boolean))];
  for (const id of unique) out.set(id, 0);
  if (!userId || unique.length === 0) return out;
  const { data } = await db
    .from('content_votes')
    .select('target_id, direction')
    .eq('target_type', targetType)
    .eq('voter_id', userId)
    .in('target_id', unique);
  for (const row of data ?? []) {
    out.set(String(row.target_id), (row.direction ?? 0) as VoteDirection);
  }
  return out;
}

async function signalSummary(
  db: SupabaseClient,
  table: 'project_signals' | 'event_signals',
  idCol: string,
  entityId: string,
  userId: string | null
): Promise<FeedSignalSummary> {
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

async function signalSummariesBatch(
  db: SupabaseClient,
  table: 'project_signals' | 'event_signals',
  idCol: string,
  entityIds: string[],
  userId: string | null
) {
  const out = new Map<string, FeedSignalSummary>();
  const unique = [...new Set(entityIds.filter(Boolean))];
  for (const id of unique) {
    out.set(id, {
      supportCount: 0,
      opposeCount: 0,
      viewerSignal: null,
      signalCount: 0,
      favorability: null
    });
  }
  if (unique.length === 0) return out;
  const { data } = await db.from(table).select('*').in(idCol, unique);
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const id = String(row[idCol] ?? '');
    const current = out.get(id) ?? {
      supportCount: 0,
      opposeCount: 0,
      viewerSignal: null as 'demand' | 'opposition' | null,
      signalCount: 0,
      favorability: null as number | null
    };
    const signalType = String(row.signal_type ?? '');
    if (signalType === 'demand' || signalType === 'support') current.supportCount += 1;
    if (signalType === 'opposition' || signalType === 'oppose') current.opposeCount += 1;
    if (userId && String(row.user_id ?? '') === userId) {
      current.viewerSignal =
        signalType === 'opposition' || signalType === 'oppose' ? 'opposition' : 'demand';
    }
    current.signalCount = current.supportCount + current.opposeCount;
    current.favorability = current.signalCount > 0 ? current.supportCount / current.signalCount : null;
    out.set(id, current);
  }
  return out;
}

async function loadEntityTagsBatch(
  db: SupabaseClient,
  entityType: string,
  entityIds: string[]
) {
  const out = new Map<string, FeedTagBundle>();
  const unique = [...new Set(entityIds.filter(Boolean))];
  for (const id of unique) out.set(id, { channelTags: [], communityTags: [] });
  const meta = TAG_TABLE[entityType];
  if (!meta || unique.length === 0) return out;

  const { data: tags } = await db.from(meta.table).select('*').in(meta.idCol, unique);

  const channelIds = new Set<string>();
  const communityIds = new Set<string>();
  const rowsByEntity = new Map<string, Array<{ channel_id?: string | null; community_id?: string | null }>>();
  for (const row of (tags ?? []) as Array<Record<string, unknown>>) {
    const entityId = String(row[meta.idCol] ?? '');
    if (!entityId) continue;
    const list = rowsByEntity.get(entityId) ?? [];
    list.push({
      channel_id: (row.channel_id as string | null | undefined) ?? null,
      community_id: (row.community_id as string | null | undefined) ?? null
    });
    rowsByEntity.set(entityId, list);
    if (row.channel_id) channelIds.add(String(row.channel_id));
    if (row.community_id) communityIds.add(String(row.community_id));
  }

  const [{ data: channels }, { data: communities }] = await Promise.all([
    channelIds.size
      ? db.from('channels').select('id, slug, name').in('id', [...channelIds])
      : Promise.resolve({ data: [] as Array<{ id: string; slug: string; name: string }> }),
    communityIds.size
      ? db.from('communities').select('id, slug, name').in('id', [...communityIds])
      : Promise.resolve({ data: [] as Array<{ id: string; slug: string; name: string }> })
  ]);
  const channelById = new Map((channels ?? []).map((row) => [String(row.id), row]));
  const communityById = new Map((communities ?? []).map((row) => [String(row.id), row]));

  for (const [entityId, rows] of rowsByEntity) {
    const channelTags: FeedTagBundle['channelTags'] = [];
    const communityTags: FeedTagBundle['communityTags'] = [];
    for (const row of rows) {
      if (row.channel_id) {
        const channel = channelById.get(String(row.channel_id));
        if (channel) channelTags.push({ slug: channel.slug, label: channel.name, kind: 'channel' });
      }
      if (row.community_id) {
        const community = communityById.get(String(row.community_id));
        if (community) {
          communityTags.push({ slug: community.slug, label: community.name, kind: 'community' });
        }
      }
    }
    out.set(entityId, { channelTags, communityTags });
  }
  return out;
}

async function helpRolesBatch(db: SupabaseClient, helpRequestIds: string[]) {
  const out = new Map<string, Array<{ title: string; description: string; slots: number }>>();
  const unique = [...new Set(helpRequestIds.filter(Boolean))];
  for (const id of unique) out.set(id, []);
  if (unique.length === 0) return out;
  const { data } = await db
    .from('help_request_roles')
    .select('help_request_id, title, description, slots')
    .in('help_request_id', unique);
  for (const row of data ?? []) {
    const id = String(row.help_request_id);
    const list = out.get(id) ?? [];
    list.push({
      title: row.title,
      description: row.description ?? '',
      slots: row.slots
    });
    out.set(id, list);
  }
  return out;
}

async function buildFeedEnrichment(
  db: SupabaseClient,
  userId: string | null,
  entityType: 'thread' | 'project' | 'event' | 'help_request' | 'post' | 'comment',
  entityIds: string[],
  options: { includeSignals?: boolean; includeTags?: boolean; includeHelpRoles?: boolean } = {}
): Promise<FeedEnrichment> {
  const unique = [...new Set(entityIds.filter(Boolean))];
  if (unique.length === 0) return {};

  const includeTags = options.includeTags ?? (entityType !== 'post' && entityType !== 'comment');
  const includeSignals = options.includeSignals ?? (entityType === 'project' || entityType === 'event');
  const includeHelpRoles = options.includeHelpRoles ?? entityType === 'help_request';

  const [tagsById, votesById, reportsById, signalsById, helpRolesById] = await Promise.all([
    includeTags ? loadEntityTagsBatch(db, entityType, unique) : Promise.resolve(undefined),
    viewerVotesBatch(db, userId, entityType, unique),
    loadActiveReportsByTargetIds(db, entityType, unique, userId),
    includeSignals
      ? signalSummariesBatch(
          db,
          entityType === 'event' ? 'event_signals' : 'project_signals',
          entityType === 'event' ? 'event_id' : 'project_id',
          unique,
          userId
        )
      : Promise.resolve(undefined),
    includeHelpRoles ? helpRolesBatch(db, unique) : Promise.resolve(undefined)
  ]);

  return {
    tagsById,
    votesById,
    reportsById,
    signalsById,
    helpRolesById
  };
}

async function resolveTags(
  db: SupabaseClient,
  entityType: string,
  entityId: string,
  enrichment?: FeedEnrichment
): Promise<FeedTagBundle> {
  const cached = enrichment?.tagsById?.get(String(entityId));
  if (cached) return cached;
  return loadEntityTags(db, entityType, entityId);
}

async function resolveVote(
  db: SupabaseClient,
  userId: string | null,
  targetType: string,
  targetId: string,
  enrichment?: FeedEnrichment
): Promise<VoteDirection> {
  if (enrichment?.votesById?.has(String(targetId))) {
    return enrichment.votesById.get(String(targetId)) ?? 0;
  }
  return viewerVote(db, userId, targetType, targetId);
}

async function resolveReport(
  db: SupabaseClient,
  targetType: string,
  targetId: string,
  userId: string | null,
  enrichment?: FeedEnrichment
) {
  if (enrichment?.reportsById) {
    return enrichment.reportsById.get(String(targetId)) ?? null;
  }
  return loadActiveReport(db, targetType, targetId, userId);
}

async function resolveSignals(
  db: SupabaseClient,
  table: 'project_signals' | 'event_signals',
  idCol: string,
  entityId: string,
  userId: string | null,
  enrichment?: FeedEnrichment
): Promise<FeedSignalSummary> {
  const cached = enrichment?.signalsById?.get(String(entityId));
  if (cached) return cached;
  return signalSummary(db, table, idCol, entityId, userId);
}

async function mapThread(
  db: SupabaseClient,
  userId: string | null,
  thread: any,
  enrichment?: FeedEnrichment,
  accessPrechecked = false
) {
  if (!accessPrechecked && !(await canViewByTags(db, userId, 'thread', thread.id))) return null;
  const author = Array.isArray(thread.users) ? thread.users[0] : thread.users;
  const tags = await resolveTags(db, 'thread', thread.id, enrichment);
  const report = await resolveReport(db, 'thread', thread.id, userId, enrichment);
  const feedAuthor = feedAuthorFromUser(author, thread.author_id);
  return {
    kind: 'thread',
    id: thread.id,
    slug: thread.slug,
    href: `/threads/${thread.slug}`,
    createdAt: thread.created_at,
    title: thread.title,
    body: thread.body,
    author: feedAuthor,
    authorUsername: feedAuthor.username,
    ...tags,
    voteCount: thread.vote_count ?? 0,
    activeVote: await resolveVote(db, userId, 'thread', thread.id, enrichment),
    commentCount: thread.comment_count ?? 0,
    lastActivityAt: thread.last_activity_at ?? thread.created_at,
    ...mapModeration(thread, report)
  };
}

async function mapPost(
  db: SupabaseClient,
  userId: string | null,
  post: any,
  feedSource?: string,
  enrichment?: FeedEnrichment,
  accessPrechecked = false
) {
  if (!accessPrechecked && !(await canViewPost(db, userId, post))) return null;
  const author = Array.isArray(post.users) ? post.users[0] : post.users;
  const report = await resolveReport(db, 'post', post.id, userId, enrichment);
  return {
    kind: 'post',
    id: `post-activity-${post.id}`,
    href: `/posts/${post.id}`,
    createdAt: post.created_at,
    author: feedAuthorFromUser(author, post.author_id),
    body: post.body,
    linkedSubjects: [],
    feedSource,
    audience: post.audience === 'followers' ? 'followers' : 'public',
    voteTargetId: post.id,
    voteCount: post.vote_count ?? 0,
    activeVote: await resolveVote(db, userId, 'post', post.id, enrichment),
    commentCount: post.comment_count ?? 0,
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
  if (!projectIds.length && !eventIds.length) return latest;

  const { data, error } = await db.rpc('get_latest_feed_updates', {
    p_project_ids: projectIds,
    p_event_ids: eventIds
  });
  if (error) throw error;
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    latest.set(`${row.entity_type}:${row.entity_id}`, {
      body: truncateUpdateBody(String(row.body ?? '')),
      createdAt: String(row.created_at)
    });
  }

  return latest;
}

async function mapProject(
  db: SupabaseClient,
  userId: string | null,
  project: any,
  latestUpdate?: { body: string; createdAt: string } | null,
  enrichment?: FeedEnrichment,
  accessPrechecked = false
) {
  if (!accessPrechecked && !(await canViewByTags(db, userId, 'project', project.id))) return null;
  const author = Array.isArray(project.users) ? project.users[0] : project.users;
  const tags = await resolveTags(db, 'project', project.id, enrichment);
  const signals = await resolveSignals(
    db,
    'project_signals',
    'project_id',
    project.id,
    userId,
    enrichment
  );
  const report = await resolveReport(db, 'project', project.id, userId, enrichment);
  const feedAuthor = feedAuthorFromUser(author, project.author_id);
  return {
    kind: 'project',
    id: project.id,
    slug: project.slug,
    href: `/projects/${project.slug}`,
    createdAt: project.created_at,
    title: project.title,
    author: feedAuthor,
    authorUsername: feedAuthor.username,
    projectMode: project.project_mode,
    projectSubtype: project.project_subtype,
    summary: project.description ?? '',
    ...tags,
    stage: project.stage_label ?? '',
    locationLabel: project.location_label ?? '',
    locationId: project.location_id ?? null,
    voteCount: project.vote_count ?? 0,
    activeVote: await resolveVote(db, userId, 'project', project.id, enrichment),
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
          latestUpdateAt: latestUpdate.createdAt,
          activityKind:
            +new Date(latestUpdate.createdAt) > +new Date(project.created_at)
              ? 'updated'
              : 'created'
        }
      : { activityKind: 'created' as const }),
    ...mapModeration(project, report)
  };
}

async function mapEvent(
  db: SupabaseClient,
  userId: string | null,
  event: any,
  latestUpdate?: { body: string; createdAt: string } | null,
  enrichment?: FeedEnrichment,
  accessPrechecked = false
) {
  if (!accessPrechecked && !(await canViewPrivateEvent(db, userId, event))) return null;
  if (!accessPrechecked && !event.is_private && !(await canViewByTags(db, userId, 'event', event.id))) return null;
  const author = Array.isArray(event.users) ? event.users[0] : event.users;
  const tags = await resolveTags(db, 'event', event.id, enrichment);
  const signals = await resolveSignals(
    db,
    'event_signals',
    'event_id',
    event.id,
    userId,
    enrichment
  );
  const report = await resolveReport(db, 'event', event.id, userId, enrichment);
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
    author: feedAuthorFromUser(author, event.created_by),
    createdByUsername: author?.username ?? 'unknown',
    timeLabel: event.scheduled_at ?? event.time_label ?? '',
    locationLabel: event.location_label ?? '',
    locationId: event.location_id ?? null,
    voteCount: event.vote_count ?? 0,
    activeVote: await resolveVote(db, userId, 'event', event.id, enrichment),
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
          latestUpdateAt: latestUpdate.createdAt,
          activityKind:
            +new Date(latestUpdate.createdAt) > +new Date(event.created_at)
              ? 'updated'
              : 'created'
        }
      : { activityKind: 'created' as const }),
    ...mapModeration(event, report)
  };
}

async function mapHelp(
  db: SupabaseClient,
  userId: string | null,
  request: any,
  enrichment?: FeedEnrichment,
  accessPrechecked = false
) {
  if (!accessPrechecked && !(await canViewByTags(db, userId, 'help_request', request.id))) return null;
  const author = Array.isArray(request.users) ? request.users[0] : request.users;
  const tags = await resolveTags(db, 'help_request', request.id, enrichment);
  const report = await resolveReport(db, 'help_request', request.id, userId, enrichment);
  const roles =
    enrichment?.helpRolesById?.get(String(request.id)) ??
    (
      await db
        .from('help_request_roles')
        .select('title, description, slots')
        .eq('help_request_id', request.id)
    ).data?.map((role) => ({
      title: role.title,
      description: role.description ?? '',
      slots: role.slots
    })) ??
    [];
  return {
    kind: 'help-request',
    id: request.id,
    href: `/help-requests/${request.id}`,
    createdAt: request.created_at,
    title: request.title,
    body: request.body ?? '',
    author: feedAuthorFromUser(author, request.author_id),
    authorUsername: author?.username ?? 'unknown',
    locationLabel: request.location_label ?? '',
    locationId: request.location_id ?? null,
    scheduleLabel: request.schedule_label ?? '',
    neededAt: request.needed_at,
    roles,
    ...tags,
    voteCount: request.vote_count ?? 0,
    activeVote: await resolveVote(db, userId, 'help_request', request.id, enrichment),
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
  feedSource?: string,
  context?: Map<
    string,
    { subjectTitle: string; subjectSlug: string | null; replyCount: number; visible: boolean }
  >,
  enrichment?: FeedEnrichment
) {
  if (comment.moderation_state === 'removed') return null;
  const subjectType = String(comment.subject_type ?? '');
  const subjectId = String(comment.subject_id ?? '');
  if (!subjectType || !subjectId) return null;

  const summary = context?.get(String(comment.id));
  if (context && !summary?.visible) return null;

  // Non-feed callers retain the standalone visibility checks.
  if (!context && subjectType === 'post') {
    const { data: post } = await db
      .from('posts')
      .select('id, body, author_id, audience, moderation_state')
      .eq('id', subjectId)
      .maybeSingle();
    if (!post || post.moderation_state === 'removed') return null;
    if (!(await canViewPost(db, userId, post))) return null;
  } else if (!context && subjectType === 'event') {
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
  } else if (
    !context &&
    (subjectType === 'thread' || subjectType === 'project' || subjectType === 'help_request')
  ) {
    if (!(await canViewEntity(db, userId, subjectType, subjectId))) return null;
  } else if (!context) {
    return null;
  }

  let subjectTitle = summary?.subjectTitle ?? 'Untitled';
  let slug: string | null = summary?.subjectSlug ?? null;
  if (!context && subjectType === 'thread') {
    const { data } = await db.from('threads').select('slug, title, moderation_state').eq('id', subjectId).maybeSingle();
    if (!data || data.moderation_state === 'removed') return null;
    subjectTitle = data.title ?? subjectTitle;
    slug = data.slug ?? null;
  } else if (!context && subjectType === 'project') {
    const { data } = await db
      .from('projects')
      .select('slug, title, is_closed, moderation_state')
      .eq('id', subjectId)
      .maybeSingle();
    if (!data || data.moderation_state === 'removed' || data.is_closed) return null;
    subjectTitle = data.title ?? subjectTitle;
    slug = data.slug ?? null;
  } else if (!context && subjectType === 'event') {
    const { data } = await db.from('events').select('slug, title, moderation_state').eq('id', subjectId).maybeSingle();
    if (!data || data.moderation_state === 'removed') return null;
    subjectTitle = data.title ?? subjectTitle;
    slug = data.slug ?? null;
  } else if (!context && subjectType === 'help_request') {
    const { data } = await db.from('help_requests').select('title, moderation_state').eq('id', subjectId).maybeSingle();
    if (!data || data.moderation_state === 'removed') return null;
    subjectTitle = data.title ?? subjectTitle;
  } else if (!context && subjectType === 'post') {
    const { data } = await db.from('posts').select('body, moderation_state').eq('id', subjectId).maybeSingle();
    if (!data || data.moderation_state === 'removed') return null;
    subjectTitle = String(data.body ?? '').slice(0, 120) || 'Post';
  }

  const author = Array.isArray(comment.users) ? comment.users[0] : comment.users;
  const replyCount = summary
    ? summary.replyCount
    : (
        await db
          .from('comments')
          .select('id', { count: 'exact', head: true })
          .eq('parent_id', comment.id)
      ).count;

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
    activeVote: await resolveVote(db, userId, 'comment', comment.id, enrichment),
    commentCount: replyCount ?? 0,
    feedSource,
    lastActivityAt: comment.created_at,
    ...mapModeration(
      comment,
      await resolveReport(db, 'comment', comment.id, userId, enrichment)
    )
  };
}

function pageResult(items: unknown[], limit: number, offset: number) {
  const pageItems = items.slice(offset, offset + limit);
  const lastItem = pageItems.at(-1) as
    | { lastActivityAt?: string; createdAt?: string; lastMessageAt?: string }
    | undefined;
  return {
    items: pageItems,
    limit,
    offset,
    hasMore: offset + limit < items.length,
    nextCursor:
      lastItem?.lastActivityAt ?? lastItem?.createdAt ?? lastItem?.lastMessageAt ?? null
  };
}

async function collectCandidatesImpl(
  db: SupabaseClient,
  userId: string | null,
  filter: string,
  opts: {
    authorIds?: string[] | null;
    authorId?: string | null;
    includeDiscovery?: boolean;
    scopeKind?: 'channel' | 'community' | null;
    scopeId?: string | null;
    includePrivateEvents?: boolean;
    includeCommentActivity?: boolean;
    before?: string | null;
    lat?: number | null;
    lon?: number | null;
    radiusKm?: number | null;
    fetchLimit?: number;
  } = {}
) {
  const fetchLimit = Math.min(Math.max(opts.fetchLimit ?? 80, 20), 80);
  const items: Array<{ sortAt: string; item: unknown }> = [];
  const { data: candidateRows, error: candidateError } = await db.rpc('get_feed_candidates', {
    p_user_id: userId,
    p_filter: filter,
    p_author_id: opts.authorId ?? null,
    p_author_ids: opts.authorIds ?? null,
    p_include_discovery: opts.includeDiscovery ?? false,
    p_scope_kind: opts.scopeKind ?? null,
    p_scope_id: opts.scopeId ?? null,
    p_include_private_events: opts.includePrivateEvents ?? false,
    p_include_comment_activity: opts.includeCommentActivity ?? false,
    p_before: opts.before ?? null,
    p_limit: Math.min(fetchLimit * 5, 400)
  });
  if (candidateError) throw candidateError;

  const typedCandidateRows = (candidateRows ?? []) as Array<{
    entity_type: string;
    entity_id: string;
  }>;
  const candidateIds = (entityType: string) =>
    new Set(
      typedCandidateRows
        .filter((row) => row.entity_type === entityType)
        .map((row) => String(row.entity_id))
    );
  const threadScopeIds = candidateIds('thread');
  const projectScopeIds = candidateIds('project');
  const eventScopeIds = candidateIds('event');
  const helpScopeIds = candidateIds('help_request');
  const postCandidateIds = candidateIds('post');
  const commentCandidateIds = candidateIds('comment');

  const pushMapped = (
    mapped: Array<{ sortAt: string; item: unknown } | null | undefined>
  ) => {
    for (const entry of mapped) {
      if (entry) items.push(entry);
    }
  };

  if (filter === 'all' || filter === 'threads') {
    if (!(threadScopeIds && threadScopeIds.size === 0)) {
      let q = db
        .from('threads')
        .select(
          'id, slug, title, body, author_id, vote_count, comment_count, created_at, last_activity_at, moderation_state, users!fk_threads_author_id_users(id, username, profile_image_url)'
        )
        .order('last_activity_at', { ascending: false })
        .limit(fetchLimit);
      if (opts.authorId) q = q.eq('author_id', opts.authorId);
      if (opts.authorIds) q = q.in('author_id', opts.authorIds);
      if (threadScopeIds) q = q.in('id', [...threadScopeIds]);
      const { data } = await q;
      const scoped = data ?? [];
      const enrichment = await buildFeedEnrichment(
        db,
        userId,
        'thread',
        scoped.map((thread) => String(thread.id))
      );
      pushMapped(
        await Promise.all(
          scoped.map(async (thread) => {
            const mapped = await mapThread(db, userId, thread, enrichment, true);
            return mapped ? { sortAt: mapped.lastActivityAt, item: mapped } : null;
          })
        )
      );
    }
  }

  // Posts belong on personal/user timelines only. Including them in public/scope
  // discovery feeds crashes PublicFeedCard (posts lack channelTags and fall through to EventCard).
  if (
    (filter === 'all' || filter === 'posts') &&
    !opts.scopeKind &&
    (opts.authorId || (opts.authorIds && opts.authorIds.length > 0)) &&
    postCandidateIds.size > 0
  ) {
    let q = db
      .from('posts')
      .select(
        'id, body, author_id, audience, vote_count, comment_count, created_at, moderation_state, users!fk_posts_author_id_users(id, username, profile_image_url)'
      )
      .in('id', [...postCandidateIds])
      .order('created_at', { ascending: false })
      .limit(fetchLimit);
    if (opts.authorId) q = q.eq('author_id', opts.authorId);
    if (opts.authorIds) q = q.in('author_id', opts.authorIds);
    const { data } = await q;
    const posts = data ?? [];
    const enrichment = await buildFeedEnrichment(
      db,
      userId,
      'post',
      posts.map((post) => String(post.id)),
      { includeTags: false, includeSignals: false }
    );
    pushMapped(
      await Promise.all(
        posts.map(async (post) => {
          const mapped = await mapPost(
            db,
            userId,
            post,
            opts.authorIds ? 'following' : undefined,
            enrichment,
            true
          );
          return mapped ? { sortAt: mapped.createdAt, item: mapped } : null;
        })
      )
    );
  }

  if (filter === 'all' || filter === 'projects') {
    if (!(projectScopeIds && projectScopeIds.size === 0)) {
      let q = db
        .from('projects')
        .select(
          'id, slug, title, description, author_id, project_mode, project_subtype, stage_label, location_label, location_id, vote_count, signal_count, comment_count, member_count, is_closed, created_at, last_activity_at, moderation_state, users!fk_projects_author_id_users(id, username, profile_image_url)'
        )
        .order('last_activity_at', { ascending: false })
        .limit(fetchLimit);
      if (opts.authorId) q = q.eq('author_id', opts.authorId);
      if (opts.authorIds) q = q.in('author_id', opts.authorIds);
      if (projectScopeIds) q = q.in('id', [...projectScopeIds]);
      const { data } = await q;
      const scopedProjects = data ?? [];
      const projectIds = scopedProjects.map((project) => String(project.id));
      const [latestUpdates, enrichment] = await Promise.all([
        fetchLatestUpdates(db, projectIds, []),
        buildFeedEnrichment(db, userId, 'project', projectIds, { includeSignals: true })
      ]);
      pushMapped(
        await Promise.all(
          scopedProjects.map(async (project) => {
            const mapped = await mapProject(
              db,
              userId,
              project,
              latestUpdates.get(`project:${project.id}`) ?? null,
              enrichment,
              true
            );
            return mapped ? { sortAt: mapped.lastActivityAt, item: mapped } : null;
          })
        )
      );
    }
  }

  if (filter === 'all' || filter === 'events') {
    if (!(eventScopeIds && eventScopeIds.size === 0)) {
      let q = db
        .from('events')
        .select(
          'id, slug, title, description, created_by, is_private, audience, home_community_id, location_label, location_id, scheduled_at, time_label, vote_count, comment_count, member_count, created_at, last_activity_at, moderation_state, users!fk_events_created_by_users(id, username, profile_image_url)'
        )
        .order('last_activity_at', { ascending: false })
        .limit(fetchLimit);
      if (!opts.includePrivateEvents) q = q.eq('is_private', false);
      if (opts.authorId) q = q.eq('created_by', opts.authorId);
      if (opts.authorIds) q = q.in('created_by', opts.authorIds);
      if (eventScopeIds) q = q.in('id', [...eventScopeIds]);
      const { data } = await q;
      const scopedEvents = data ?? [];
      const eventIds = scopedEvents.map((event) => String(event.id));
      const [latestUpdates, enrichment] = await Promise.all([
        fetchLatestUpdates(db, [], eventIds),
        buildFeedEnrichment(db, userId, 'event', eventIds, { includeSignals: true })
      ]);
      pushMapped(
        await Promise.all(
          scopedEvents.map(async (event) => {
            const mapped = await mapEvent(
              db,
              userId,
              event,
              latestUpdates.get(`event:${event.id}`) ?? null,
              enrichment,
              true
            );
            return mapped ? { sortAt: mapped.lastActivityAt, item: mapped } : null;
          })
        )
      );
    }
  }

  if (filter === 'all' || filter === 'help_requests') {
    if (!(helpScopeIds && helpScopeIds.size === 0)) {
      let q = db
        .from('help_requests')
        .select(
          'id, title, body, author_id, location_label, location_id, schedule_label, needed_at, vote_count, comment_count, created_at, moderation_state, users!fk_help_requests_author_id_users(id, username, profile_image_url)'
        )
        .order('created_at', { ascending: false })
        .limit(fetchLimit);
      if (opts.authorId) q = q.eq('author_id', opts.authorId);
      if (opts.authorIds) q = q.in('author_id', opts.authorIds);
      if (helpScopeIds) q = q.in('id', [...helpScopeIds]);
      const { data } = await q;
      const scoped = data ?? [];
      const enrichment = await buildFeedEnrichment(
        db,
        userId,
        'help_request',
        scoped.map((request) => String(request.id)),
        { includeHelpRoles: true }
      );
      pushMapped(
        await Promise.all(
          scoped.map(async (request) => {
            const mapped = await mapHelp(db, userId, request, enrichment, true);
            return mapped ? { sortAt: mapped.lastActivityAt, item: mapped } : null;
          })
        )
      );
    }
  }

  // FastAPI parity: personal/user/home-following feeds include comment activity.
  if (
    opts.includeCommentActivity &&
    filter === 'all' &&
    (opts.authorId || opts.authorIds?.length) &&
    commentCandidateIds.size > 0
  ) {
    let q = db
      .from('comments')
      .select(
        'id, subject_type, subject_id, parent_id, body, author_id, vote_count, created_at, moderation_state, users!fk_comments_author_id_users(id, username, profile_image_url)'
      )
      .in('id', [...commentCandidateIds])
      .neq('moderation_state', 'removed')
      .order('created_at', { ascending: false })
      .limit(fetchLimit);
    if (opts.authorId) q = q.eq('author_id', opts.authorId);
    if (opts.authorIds) q = q.in('author_id', opts.authorIds);
    const { data } = await q;
    const comments = data ?? [];
    const commentIds = comments.map((comment) => String(comment.id));
    const [contextResult, enrichment] = await Promise.all([
      db.rpc('get_feed_comment_context', {
        p_user_id: userId,
        p_comment_ids: commentIds
      }),
      buildFeedEnrichment(db, userId, 'comment', commentIds, {
        includeTags: false,
        includeSignals: false
      })
    ]);
    if (contextResult.error) throw contextResult.error;
    const contextRows = (contextResult.data ?? []) as Array<Record<string, unknown>>;
    const context = new Map<
      string,
      { subjectTitle: string; subjectSlug: string | null; replyCount: number; visible: boolean }
    >(
      contextRows.map((row) => [
        String(row.comment_id),
        {
          subjectTitle: String(row.subject_title ?? 'Untitled'),
          subjectSlug: row.subject_slug ? String(row.subject_slug) : null,
          replyCount: Number(row.reply_count ?? 0),
          visible: Boolean(row.visible)
        }
      ])
    );
    pushMapped(
      await Promise.all(
        comments.map(async (comment) => {
          const mapped = await mapCommentActivity(
            db,
            userId,
            comment,
            opts.authorIds ? 'following' : undefined,
            context,
            enrichment
          );
          return mapped ? { sortAt: mapped.createdAt, item: mapped } : null;
        })
      )
    );
  }

  items.sort((a, b) => String(b.sortAt).localeCompare(String(a.sortAt)));
  return items.map((entry) => entry.item);
}

async function collectCandidates(
  db: SupabaseClient,
  userId: string | null,
  filter: string,
  opts: NonNullable<Parameters<typeof collectCandidatesImpl>[3]>
) {
  return measureServerSpan(
    'feed.collect-candidates',
    () => collectCandidatesImpl(db, userId, filter, opts),
    {
      authenticated: Boolean(userId),
      filter,
      fetchLimit: opts.fetchLimit ?? 80,
      following: Boolean(opts.authorIds?.length),
      scoped: Boolean(opts.scopeId)
    }
  );
}

function orderFeedItems(items: unknown[], sort: string): unknown[] {
  if (sort === 'recent') return items;
  const rows = [...items] as Array<Record<string, unknown>>;
  const timestamp = (item: Record<string, unknown>) =>
    Date.parse(String(item.lastActivityAt ?? item.createdAt ?? '')) || 0;
  if (sort === 'oldest') {
    return rows.sort((a, b) => timestamp(a) - timestamp(b));
  }
  const engagement = (item: Record<string, unknown>) =>
    Number(item.voteCount ?? 0) +
    Number(item.commentCount ?? item.replyCount ?? 0) * 2 +
    Number(item.memberCount ?? 0);
  if (sort === 'popular' || sort === 'top') {
    return rows.sort((a, b) => engagement(b) - engagement(a) || timestamp(b) - timestamp(a));
  }
  if (sort === 'trending') {
    const score = (item: Record<string, unknown>) => {
      const ageHours = Math.max(1, (Date.now() - timestamp(item)) / 3_600_000);
      return (engagement(item) + 1) / Math.pow(ageHours + 2, 1.2);
    };
    return rows.sort((a, b) => score(b) - score(a) || timestamp(b) - timestamp(a));
  }
  return rows;
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
  const before = params.get('before');
  const candidateBefore = sort === 'recent' ? before : null;
  const pageOffset = candidateBefore ? 0 : offset;

  if (kind === 'public') {
    const items = await collectCandidates(db, userId, filter, {
      before: candidateBefore,
      fetchLimit: Math.min(80, Math.max(40, limit + offset + 20))
    });
    const page = pageResult(orderFeedItems(items, sort), limit, pageOffset);
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
    const candidateLimit = Math.min(80, Math.max(40, limit + offset + 20));
    const items = await collectCandidates(db, userId, filter, {
      authorIds,
      includeDiscovery: true,
      includeCommentActivity: true,
      before: candidateBefore,
      fetchLimit: candidateLimit
    });
    const page = pageResult(orderFeedItems(items, sort), limit, pageOffset);
    return { ...page, sort, total: items.length };
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
    const candidateLimit = Math.min(80, Math.max(40, limit + offset + 20));
    if (scope === 'following') {
      const items = await collectCandidates(db, userId, filter, {
        authorIds,
        includeCommentActivity: true,
        before: candidateBefore,
        fetchLimit: candidateLimit
      });
      return {
        ...pageResult(orderFeedItems(items, sort), limit, pageOffset),
        sort,
        total: items.length
      };
    }
    // Popular combines followed authors and discovery in the candidate RPC.
    const items = await collectCandidates(db, userId, filter, {
      authorIds,
      includeDiscovery: true,
      includeCommentActivity: true,
      before: candidateBefore,
      fetchLimit: candidateLimit
    });
    return {
      ...pageResult(orderFeedItems(items, sort), limit, pageOffset),
      sort,
      total: items.length
    };
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
      includeCommentActivity: true,
      before: candidateBefore,
      fetchLimit: Math.min(80, Math.max(40, limit + offset + 20))
    });
    return {
      ...pageResult(orderFeedItems(items, sort), limit, pageOffset),
      sort,
      total: items.length
    };
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
    const scopeRow = scope as unknown as { id: string; join_policy?: string };
    if (scopeKind === 'community' && scopeRow.join_policy === 'closed') {
      if (!userId) return pageResult([], limit, offset);
      const { data: membership } = await db
        .from('scope_memberships')
        .select('user_id')
        .eq('scope_kind', 'community')
        .eq('scope_id', scopeRow.id)
        .eq('user_id', userId)
        .maybeSingle();
      if (!membership) return pageResult([], limit, offset);
    }
    const items = await collectCandidates(db, userId, filter, {
      scopeKind,
      scopeId: scopeRow.id,
      includePrivateEvents: true,
      before: candidateBefore
    });
    return {
      ...pageResult(orderFeedItems(items, sort), limit, pageOffset),
      sort,
      total: items.length
    };
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
      includePrivateEvents: false,
      before
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
    const locationIds = [
      ...new Set(
        items
          .map((item) => (item as { locationId?: string | null }).locationId)
          .filter((id): id is string => Boolean(id))
      )
    ];
    const { data: locationRows } = locationIds.length
      ? await db
          .from('locations')
          .select('id, latitude, longitude, is_online')
          .in('id', locationIds)
      : { data: [] as Array<Record<string, unknown>> };
    const locationById = new Map(
      (locationRows ?? []).map((row) => [String(row.id), row])
    );
    const withDistance: unknown[] = [];
    for (const item of items) {
      const kindLabel = String((item as { kind?: string }).kind ?? '');
      if (kindLabel === 'thread' || kindLabel === 'post') continue;
      const locationId = (item as { locationId?: string | null }).locationId ?? null;
      if (!locationId) continue;
      const loc = locationById.get(locationId);
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
    return { ...pageResult(withDistance, limit, pageOffset), sort, total: withDistance.length };
  }

  return pageResult([], limit, offset);
}

function mapYmdInTz(date: Date, timeZone: string | null) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function mapWeekdayInTz(date: Date, timeZone: string | null) {
  try {
    const label = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || undefined,
      weekday: 'short'
    }).format(date);
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(label);
  } catch {
    return date.getUTCDay();
  }
}

function addDaysYmd(ymd: string, days: number) {
  const date = new Date(`${ymd}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function includeMapTimestamp(
  ts: string | null | undefined,
  opts: {
    window: string;
    dateFrom: string | null;
    dateTo: string | null;
    upcomingOnly: boolean;
    timeZone: string | null;
    enforceUpcoming: boolean;
  }
) {
  if (!ts) {
    return opts.window === 'all' && !opts.dateFrom && !opts.dateTo;
  }
  const millis = Date.parse(ts);
  if (Number.isNaN(millis)) return true;
  if (opts.enforceUpcoming && opts.upcomingOnly && millis < Date.now()) return false;
  if (opts.dateFrom) {
    const from =
      opts.dateFrom.length === 10
        ? Date.parse(`${opts.dateFrom}T00:00:00.000Z`)
        : Date.parse(opts.dateFrom);
    if (!Number.isNaN(from) && millis < from) return false;
  }
  if (opts.dateTo) {
    const to =
      opts.dateTo.length === 10
        ? Date.parse(`${opts.dateTo}T23:59:59.999Z`)
        : Date.parse(opts.dateTo);
    if (!Number.isNaN(to) && millis > to) return false;
  }
  if (opts.window === 'all' || opts.window === 'custom') return true;
  const itemDay = mapYmdInTz(new Date(millis), opts.timeZone);
  const now = new Date();
  const today = mapYmdInTz(now, opts.timeZone);
  if (opts.window === 'today') return itemDay === today;
  if (opts.window === 'month') return itemDay.slice(0, 7) === today.slice(0, 7);
  if (opts.window === 'week') {
    const weekday = mapWeekdayInTz(now, opts.timeZone);
    const mondayOffset = (weekday + 6) % 7;
    const weekStart = addDaysYmd(today, -mondayOffset);
    const weekEnd = addDaysYmd(weekStart, 7);
    return itemDay >= weekStart && itemDay < weekEnd;
  }
  return true;
}

async function loadMapActivityRoleCounts(
  db: SupabaseClient,
  roleTable: string,
  assignTable: string,
  activityIds: string[]
) {
  const counts = new Map<string, { committed: number; minimum: number }>();
  if (activityIds.length === 0) return counts;
  const { data: roles } = await db
    .from(roleTable)
    .select('id, activity_id, required_count')
    .in('activity_id', activityIds);
  const roleIds = (roles ?? []).map((role) => String(role.id));
  const { data: assignments } = roleIds.length
    ? await db.from(assignTable).select('role_id').in('role_id', roleIds)
    : { data: [] as Array<{ role_id: string }> };
  const filledByRole = new Map<string, number>();
  for (const row of assignments ?? []) {
    const roleId = String(row.role_id);
    filledByRole.set(roleId, (filledByRole.get(roleId) ?? 0) + 1);
  }
  for (const role of roles ?? []) {
    const activityId = String(role.activity_id);
    const current = counts.get(activityId) ?? { committed: 0, minimum: 0 };
    current.minimum += Number(role.required_count ?? 0);
    current.committed += filledByRole.get(String(role.id)) ?? 0;
    counts.set(activityId, current);
  }
  return counts;
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
  const windowFilter = (params.get('window') ?? 'all').toLowerCase();
  const dateFrom = params.get('dateFrom') ?? params.get('date_from');
  const dateTo = params.get('dateTo') ?? params.get('date_to');
  const upcomingOnly = !['0', 'false', 'no'].includes(
    String(params.get('upcomingOnly') ?? params.get('upcoming_only') ?? 'true').toLowerCase()
  );
  const timeZone = params.get('tz');
  const markers: unknown[] = [];
  const scheduleOpts = {
    window: windowFilter,
    dateFrom,
    dateTo,
    upcomingOnly,
    timeZone
  };

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

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return markers;

  const includeEvents = filter === 'all' || filter === 'events';
  const includeProjects = filter === 'all' || filter === 'projects';
  const includeHelp = filter === 'all' || filter === 'help_requests';

  const { data: candidateData, error: candidateError } = await db.rpc('get_feed_candidates', {
    p_user_id: userId,
    p_filter: filter,
    p_author_id: null,
    p_author_ids: null,
    p_include_discovery: false,
    p_scope_kind: null,
    p_scope_id: null,
    p_include_private_events: false,
    p_include_comment_activity: false,
    p_before: null,
    p_limit: 300
  });
  if (candidateError) throw candidateError;
  const candidateRows = (candidateData ?? []) as Array<Record<string, unknown>>;
  const idsFor = (entityType: string) =>
    candidateRows
      .filter((row) => row.entity_type === entityType)
      .map((row) => String(row.entity_id));
  const eventIds = includeEvents ? idsFor('event') : [];
  const projectIds = includeProjects ? idsFor('project') : [];
  const helpRequestIds = includeHelp ? idsFor('help_request') : [];

  const latDelta = radiusKm / 111;
  const lonDelta = radiusKm / Math.max(111 * Math.abs(Math.cos((lat * Math.PI) / 180)), 0.01);
  const [{ data: events }, { data: projects }, { data: helpRequests }, { data: nearbyLocations }] =
    await Promise.all([
      eventIds.length
        ? db
            .from('events')
            .select('id, slug, title, location_id, scheduled_at, ends_at')
            .in('id', eventIds)
            .not('location_id', 'is', null)
        : Promise.resolve({ data: [] }),
      projectIds.length
        ? db
            .from('projects')
            .select('id, slug, title, location_id, project_mode')
            .in('id', projectIds)
            .not('location_id', 'is', null)
        : Promise.resolve({ data: [] }),
      helpRequestIds.length
        ? db
            .from('help_requests')
            .select('id, title, location_id, needed_at, ends_at')
            .in('id', helpRequestIds)
            .not('location_id', 'is', null)
        : Promise.resolve({ data: [] }),
      db
        .from('locations')
        .select('id, latitude, longitude, precision, display_label, is_online')
        .eq('is_online', false)
        .not('latitude', 'is', null)
        .not('longitude', 'is', null)
        .gte('latitude', lat - latDelta)
        .lte('latitude', lat + latDelta)
        .gte('longitude', lon - lonDelta)
        .lte('longitude', lon + lonDelta)
        .limit(400)
    ]);

  const nearbyLocationIds = (nearbyLocations ?? []).map((row) => String(row.id));
  const [{ data: eventActivities }, { data: projectActivities }] = await Promise.all([
    includeEvents && nearbyLocationIds.length
      ? db
          .from('event_activities')
          .select('id, title, scheduled_at, ends_at, event_id, location_id')
          .in('location_id', nearbyLocationIds)
          .not('scheduled_at', 'is', null)
          .limit(200)
      : Promise.resolve({ data: [] }),
    includeProjects && nearbyLocationIds.length
      ? db
          .from('project_activities')
          .select('id, title, scheduled_at, ends_at, project_id, location_id')
          .in('location_id', nearbyLocationIds)
          .not('scheduled_at', 'is', null)
          .limit(200)
      : Promise.resolve({ data: [] })
  ]);

  const activityEventIds = [
    ...new Set((eventActivities ?? []).map((row) => String(row.event_id)).filter(Boolean))
  ];
  const activityProjectIds = [
    ...new Set((projectActivities ?? []).map((row) => String(row.project_id)).filter(Boolean))
  ];
  const [{ data: activityEvents }, { data: activityProjects }, eventRoleCounts, projectRoleCounts] =
    await Promise.all([
      activityEventIds.length
        ? db.from('events').select('id, slug, title, is_private').in('id', activityEventIds)
        : Promise.resolve({ data: [] }),
      activityProjectIds.length
        ? db
            .from('projects')
            .select('id, slug, title, project_mode, is_closed')
            .in('id', activityProjectIds)
            .eq('is_closed', false)
        : Promise.resolve({ data: [] }),
      loadMapActivityRoleCounts(
        db,
        'event_activity_roles',
        'event_activity_assignments',
        (eventActivities ?? []).map((row) => String(row.id))
      ),
      loadMapActivityRoleCounts(
        db,
        'project_activity_roles',
        'project_activity_assignments',
        (projectActivities ?? []).map((row) => String(row.id))
      )
    ]);
  const eventById = new Map((activityEvents ?? []).map((row) => [String(row.id), row]));
  const projectById = new Map((activityProjects ?? []).map((row) => [String(row.id), row]));

  const rows: Array<Record<string, any>> = [
    ...(events ?? []).map((row) => ({
      ...row,
      entityType: 'event',
      slug: row.slug,
      href: `/events/${row.slug}`,
      scheduled_at: row.scheduled_at,
      ends_at: row.ends_at,
      enforceUpcoming: true
    })),
    ...(projects ?? []).map((row) => ({
      ...row,
      entityType: 'project',
      slug: row.slug,
      href: `/projects/${row.slug}`,
      scheduled_at: null,
      ends_at: null,
      projectMode: row.project_mode ?? null,
      enforceUpcoming: false
    })),
    ...(helpRequests ?? []).map((row) => ({
      ...row,
      entityType: 'help_request',
      slug: null,
      href: `/help-requests/${row.id}`,
      scheduled_at: row.needed_at,
      ends_at: row.ends_at,
      enforceUpcoming: true
    }))
  ];
  const locationIds = [
    ...new Set(
      [
        ...rows.map((row) => String(row.location_id ?? '')),
        ...(eventActivities ?? []).map((row) => String(row.location_id ?? '')),
        ...(projectActivities ?? []).map((row) => String(row.location_id ?? ''))
      ].filter(Boolean)
    )
  ];
  const missingLocationIds = locationIds.filter(
    (id) => !(nearbyLocations ?? []).some((row) => String(row.id) === id)
  );
  const { data: extraLocations } = missingLocationIds.length
    ? await db
        .from('locations')
        .select('id, latitude, longitude, precision, display_label, is_online')
        .in('id', missingLocationIds)
    : { data: [] as Array<Record<string, unknown>> };
  const locationById = new Map(
    [...(nearbyLocations ?? []), ...(extraLocations ?? [])].map((row) => [String(row.id), row])
  );

  const pushMarker = (marker: Record<string, unknown>, scheduledAt: string | null, enforceUpcoming: boolean) => {
    if (
      !includeMapTimestamp(scheduledAt, {
        ...scheduleOpts,
        enforceUpcoming
      })
    ) {
      return;
    }
    markers.push(marker);
  };

  for (const row of rows) {
    const location = locationById.get(String(row.location_id));
    if (!location?.latitude || !location?.longitude || location.is_online) continue;
    const distanceKm = haversine(
      lat,
      lon,
      Number(location.latitude),
      Number(location.longitude)
    );
    if (distanceKm > radiusKm) continue;
    pushMarker(
      {
        id: row.id,
        entityType: row.entityType,
        activitySource: null,
        projectMode: row.projectMode ?? null,
        slug: row.slug,
        title: row.title,
        parentTitle: null,
        subtitle: null,
        href: row.href,
        latitude: Number(location.latitude),
        longitude: Number(location.longitude),
        precision: location.precision ?? 'approximate',
        displayLabel: location.display_label,
        distanceKm,
        scheduledAt: row.scheduled_at ?? null,
        endsAt: row.ends_at ?? null,
        committedCount: null,
        minimumParticipants: null
      },
      row.scheduled_at ?? null,
      Boolean(row.enforceUpcoming)
    );
  }

  for (const row of eventActivities ?? []) {
    const parent = eventById.get(String(row.event_id));
    const location = locationById.get(String(row.location_id));
    if (!parent || !location?.latitude || !location?.longitude || location.is_online) continue;
    const distanceKm = haversine(
      lat,
      lon,
      Number(location.latitude),
      Number(location.longitude)
    );
    if (distanceKm > radiusKm) continue;
    const roles = eventRoleCounts.get(String(row.id));
    pushMarker(
      {
        id: row.id,
        entityType: 'activity',
        activitySource: 'event',
        projectMode: null,
        slug: parent.slug,
        title: row.title,
        parentId: parent.id,
        parentTitle: parent.title,
        subtitle: row.title,
        href: `/events/${parent.slug}?activity=${row.id}`,
        latitude: Number(location.latitude),
        longitude: Number(location.longitude),
        precision: location.precision ?? 'approximate',
        displayLabel: location.display_label,
        distanceKm,
        scheduledAt: row.scheduled_at ?? null,
        endsAt: row.ends_at ?? null,
        committedCount: roles?.committed ?? 0,
        minimumParticipants: roles?.minimum ?? 0
      },
      row.scheduled_at ?? null,
      true
    );
  }

  for (const row of projectActivities ?? []) {
    const parent = projectById.get(String(row.project_id));
    const location = locationById.get(String(row.location_id));
    if (!parent || !location?.latitude || !location?.longitude || location.is_online) continue;
    const distanceKm = haversine(
      lat,
      lon,
      Number(location.latitude),
      Number(location.longitude)
    );
    if (distanceKm > radiusKm) continue;
    const roles = projectRoleCounts.get(String(row.id));
    pushMarker(
      {
        id: row.id,
        entityType: 'activity',
        activitySource: 'project',
        projectMode: parent.project_mode ?? null,
        slug: parent.slug,
        title: row.title,
        parentId: parent.id,
        parentTitle: parent.title,
        subtitle: row.title,
        href: `/projects/${parent.slug}?activity=${row.id}`,
        latitude: Number(location.latitude),
        longitude: Number(location.longitude),
        precision: location.precision ?? 'approximate',
        displayLabel: location.display_label,
        distanceKm,
        scheduledAt: row.scheduled_at ?? null,
        endsAt: row.ends_at ?? null,
        committedCount: roles?.committed ?? 0,
        minimumParticipants: roles?.minimum ?? 0
      },
      row.scheduled_at ?? null,
      true
    );
  }

  markers.sort(
    (a, b) =>
      Number((a as { distanceKm: number }).distanceKm) -
      Number((b as { distanceKm: number }).distanceKm)
  );
  return markers;
}

export { viewerVote, mapModeration, signalSummary };
