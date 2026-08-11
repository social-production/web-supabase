/**
 * Access-policy helpers ported from web-backend access_policy + access_control.
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

export type EntityTagScope = {
  hasChannelTag: boolean;
  hasOpenCommunityTag: boolean;
  closedCommunityIds: string[];
};

const TAG_TABLE: Record<string, { table: string; idCol: string }> = {
  thread: { table: 'thread_tags', idCol: 'thread_id' },
  project: { table: 'project_tags', idCol: 'project_id' },
  event: { table: 'event_tags', idCol: 'event_id' },
  help_request: { table: 'help_request_tags', idCol: 'help_request_id' }
};

export function canViewByTagScope(
  viewerId: string | null,
  scope: EntityTagScope,
  viewerClosedMemberships: string[]
): boolean {
  if (scope.hasChannelTag || scope.hasOpenCommunityTag) return true;
  if (scope.closedCommunityIds.length === 0) return true;
  if (!viewerId) return false;
  const member = new Set(viewerClosedMemberships);
  return scope.closedCommunityIds.every((id) => member.has(id));
}

export async function loadEntityTagScope(
  db: SupabaseClient,
  entityType: string,
  entityId: string
): Promise<EntityTagScope> {
  const meta = TAG_TABLE[entityType];
  if (!meta) {
    return { hasChannelTag: false, hasOpenCommunityTag: false, closedCommunityIds: [] };
  }

  const { data: tags } = await db
    .from(meta.table)
    .select('channel_id, community_id')
    .eq(meta.idCol, entityId);

  let hasChannelTag = false;
  let hasOpenCommunityTag = false;
  const closedCommunityIds: string[] = [];
  const communityIds = (tags ?? [])
    .map((row) => row.community_id)
    .filter((id): id is string => Boolean(id));

  for (const row of tags ?? []) {
    if (row.channel_id) hasChannelTag = true;
  }

  if (communityIds.length > 0) {
    const { data: communities } = await db
      .from('communities')
      .select('id, join_policy')
      .in('id', communityIds);
    const byId = new Map((communities ?? []).map((c) => [c.id, c.join_policy]));
    for (const id of communityIds) {
      if (byId.get(id) === 'closed') closedCommunityIds.push(id);
      else hasOpenCommunityTag = true;
    }
  }

  return { hasChannelTag, hasOpenCommunityTag, closedCommunityIds };
}

export async function viewerClosedCommunityMemberships(
  db: SupabaseClient,
  viewerId: string | null
): Promise<string[]> {
  if (!viewerId) return [];
  const { data } = await db
    .from('scope_memberships')
    .select('scope_id')
    .eq('user_id', viewerId)
    .eq('scope_kind', 'community');
  return (data ?? []).map((row) => row.scope_id).filter(Boolean);
}

export async function canViewByTags(
  db: SupabaseClient,
  viewerId: string | null,
  entityType: string,
  entityId: string
): Promise<boolean> {
  const scope = await loadEntityTagScope(db, entityType, entityId);
  const memberships =
    scope.closedCommunityIds.length > 0
      ? await viewerClosedCommunityMemberships(db, viewerId)
      : [];
  return canViewByTagScope(viewerId, scope, memberships);
}

export async function isScopeMember(
  db: SupabaseClient,
  scopeKind: string,
  scopeId: string,
  userId: string
): Promise<boolean> {
  const { data } = await db
    .from('scope_memberships')
    .select('user_id')
    .eq('scope_kind', scopeKind)
    .eq('scope_id', scopeId)
    .eq('user_id', userId)
    .maybeSingle();
  return Boolean(data);
}

export async function isProjectMember(
  db: SupabaseClient,
  projectId: string,
  userId: string
): Promise<boolean> {
  const { data } = await db
    .from('project_memberships')
    .select('user_id')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .maybeSingle();
  return Boolean(data);
}

export async function isEventMember(
  db: SupabaseClient,
  eventId: string,
  userId: string
): Promise<boolean> {
  const { data } = await db
    .from('event_memberships')
    .select('user_id')
    .eq('event_id', eventId)
    .eq('user_id', userId)
    .maybeSingle();
  return Boolean(data);
}

export async function viewerFollowsAuthor(
  db: SupabaseClient,
  viewerId: string,
  authorId: string
): Promise<boolean> {
  if (viewerId === authorId) return true;
  const { data } = await db
    .from('user_follows')
    .select('follower_id')
    .eq('follower_id', viewerId)
    .eq('followed_id', authorId)
    .eq('status', 'accepted')
    .maybeSingle();
  return Boolean(data);
}

export async function canViewPost(
  db: SupabaseClient,
  viewerId: string | null,
  post: { audience?: string | null; author_id?: string | null }
): Promise<boolean> {
  const audience = String(post.audience ?? 'public').toLowerCase();
  if (audience === 'public') return true;
  if (!viewerId || !post.author_id) return false;
  if (audience === 'followers') {
    return viewerFollowsAuthor(db, viewerId, post.author_id);
  }
  return viewerId === post.author_id;
}

export async function canViewPrivateEvent(
  db: SupabaseClient,
  viewerId: string | null,
  event: {
    is_private?: boolean | null;
    audience?: string | null;
    home_community_id?: string | null;
    id: string;
    created_by?: string | null;
  }
): Promise<boolean> {
  if (!event.is_private) return true;
  if (!viewerId) return false;
  if (event.created_by && event.created_by === viewerId) return true;
  if (await isEventMember(db, event.id, viewerId)) return true;
  if (
    event.audience === 'private_community' &&
    event.home_community_id &&
    (await isScopeMember(db, 'community', event.home_community_id, viewerId))
  ) {
    return true;
  }
  return false;
}

export async function canViewEntity(
  db: SupabaseClient,
  viewerId: string | null,
  entityType: string,
  entityId: string
): Promise<boolean> {
  const type = entityType.trim().toLowerCase();

  if (type === 'post') {
    const { data } = await db
      .from('posts')
      .select('id, audience, author_id')
      .eq('id', entityId)
      .maybeSingle();
    if (!data) return false;
    return canViewPost(db, viewerId, data);
  }

  if (type === 'event') {
    const { data } = await db
      .from('events')
      .select('id, is_private, audience, home_community_id, created_by')
      .eq('id', entityId)
      .maybeSingle();
    if (!data) return false;
    // FastAPI: private events are membership/audience gated only (skip tag gate).
    if (data.is_private) {
      return canViewPrivateEvent(db, viewerId, data);
    }
    return canViewByTags(db, viewerId, 'event', entityId);
  }

  if (type === 'thread' || type === 'project' || type === 'help_request') {
    const table =
      type === 'thread' ? 'threads' : type === 'project' ? 'projects' : 'help_requests';
    const { data } = await db.from(table).select('id').eq('id', entityId).maybeSingle();
    if (!data) return false;
    return canViewByTags(db, viewerId, type, entityId);
  }

  // Fail closed for unknown entity types (matches FastAPI can_view_entity).
  return false;
}

export async function canViewVoteTarget(
  db: SupabaseClient,
  viewerId: string | null,
  targetType: string,
  targetId: string
): Promise<boolean> {
  const type = targetType.trim().toLowerCase();
  if (type === 'comment') {
    const { data } = await db
      .from('comments')
      .select('subject_type, subject_id')
      .eq('id', targetId)
      .maybeSingle();
    if (!data) return false;
    return canViewEntity(db, viewerId, String(data.subject_type), String(data.subject_id));
  }
  return canViewEntity(db, viewerId, type, targetId);
}

export async function canViewCommunityInSearch(
  db: SupabaseClient,
  viewerId: string | null,
  communityId: string
): Promise<boolean> {
  const { data } = await db
    .from('communities')
    .select('id, join_policy')
    .eq('id', communityId)
    .maybeSingle();
  if (!data) return false;
  if (data.join_policy !== 'closed') return true;
  if (!viewerId) return false;
  return isScopeMember(db, 'community', communityId, viewerId);
}

export async function loadEntityTags(
  db: SupabaseClient,
  entityType: string,
  entityId: string
): Promise<{
  channelTags: Array<{ slug: string; label: string; kind: 'channel' }>;
  communityTags: Array<{ slug: string; label: string; kind: 'community' }>;
}> {
  const meta = TAG_TABLE[entityType];
  if (!meta) return { channelTags: [], communityTags: [] };

  const { data: tags } = await db
    .from(meta.table)
    .select('channel_id, community_id')
    .eq(meta.idCol, entityId);

  const channelIds = (tags ?? []).map((t) => t.channel_id).filter(Boolean) as string[];
  const communityIds = (tags ?? []).map((t) => t.community_id).filter(Boolean) as string[];

  const channelTags: Array<{ slug: string; label: string; kind: 'channel' }> = [];
  const communityTags: Array<{ slug: string; label: string; kind: 'community' }> = [];

  if (channelIds.length) {
    const { data } = await db.from('channels').select('slug, name').in('id', channelIds);
    for (const row of data ?? []) {
      channelTags.push({ slug: row.slug, label: row.name, kind: 'channel' });
    }
  }
  if (communityIds.length) {
    const { data } = await db.from('communities').select('slug, name').in('id', communityIds);
    for (const row of data ?? []) {
      communityTags.push({ slug: row.slug, label: row.name, kind: 'community' });
    }
  }

  return { channelTags, communityTags };
}
