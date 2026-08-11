/**
 * Resolve channel/community slugs and persist entity tag rows.
 * Mirrors web-backend/app/services/content/scopes.py create-tag behavior.
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

export type TaggableEntity = 'thread' | 'project' | 'event' | 'help_request';

const TAG_TABLE: Record<TaggableEntity, { table: string; idCol: string }> = {
  thread: { table: 'thread_tags', idCol: 'thread_id' },
  project: { table: 'project_tags', idCol: 'project_id' },
  event: { table: 'event_tags', idCol: 'event_id' },
  help_request: { table: 'help_request_tags', idCol: 'help_request_id' }
};

export class TagError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.status = status;
  }
}

function normalizeSlugs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    let slug = '';
    if (typeof item === 'string') slug = item;
    else if (item && typeof item === 'object' && typeof (item as { slug?: unknown }).slug === 'string') {
      slug = (item as { slug: string }).slug;
    }
    slug = slug.trim().toLowerCase();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

/** Accept channel_slugs / channelTags and community_slugs / communityTags. */
export function extractSlugs(body: Record<string, unknown>): {
  channelSlugs: string[];
  communitySlugs: string[];
} {
  return {
    channelSlugs: normalizeSlugs(body.channel_slugs ?? body.channelTags ?? body.channel_tags),
    communitySlugs: normalizeSlugs(body.community_slugs ?? body.communityTags ?? body.community_tags)
  };
}

export async function resolveChannelIds(db: SupabaseClient, slugs: string[]): Promise<string[]> {
  if (slugs.length === 0) return [];
  const { data, error } = await db.from('channels').select('id, slug').in('slug', slugs);
  if (error) throw error;
  const bySlug = new Map((data ?? []).map((row) => [String(row.slug).toLowerCase(), row.id as string]));
  const missing = slugs.filter((slug) => !bySlug.has(slug));
  if (missing.length) throw new TagError(`unknown_channel:${missing.join(',')}`, 422);
  return slugs.map((slug) => bySlug.get(slug)!);
}

export async function resolveCommunityIds(
  db: SupabaseClient,
  slugs: string[],
  userId: string
): Promise<string[]> {
  if (slugs.length === 0) return [];
  const { data, error } = await db
    .from('communities')
    .select('id, slug, join_policy')
    .in('slug', slugs);
  if (error) throw error;
  const bySlug = new Map(
    (data ?? []).map((row) => [String(row.slug).toLowerCase(), row as { id: string; join_policy: string }])
  );
  const missing = slugs.filter((slug) => !bySlug.has(slug));
  if (missing.length) throw new TagError(`unknown_community:${missing.join(',')}`, 422);

  const closedIds = slugs
    .map((slug) => bySlug.get(slug)!)
    .filter((row) => row.join_policy === 'closed')
    .map((row) => row.id);
  if (closedIds.length) {
    const { data: memberships } = await db
      .from('scope_memberships')
      .select('scope_id')
      .eq('user_id', userId)
      .eq('scope_kind', 'community')
      .in('scope_id', closedIds);
    const memberSet = new Set((memberships ?? []).map((row) => row.scope_id as string));
    const forbidden = closedIds.filter((id) => !memberSet.has(id));
    if (forbidden.length) throw new TagError('forbidden_closed_community', 403);
  }

  return slugs.map((slug) => bySlug.get(slug)!.id);
}

export async function insertEntityTags(
  db: SupabaseClient,
  entity: TaggableEntity,
  entityId: string,
  channelIds: string[],
  communityIds: string[]
): Promise<void> {
  const meta = TAG_TABLE[entity];
  const rows = [
    ...channelIds.map((channelId) => ({
      [meta.idCol]: entityId,
      tag_kind: 'channel',
      channel_id: channelId,
      community_id: null
    })),
    ...communityIds.map((communityId) => ({
      [meta.idCol]: entityId,
      tag_kind: 'community',
      channel_id: null,
      community_id: communityId
    }))
  ];
  if (rows.length === 0) return;
  const { error } = await db.from(meta.table).insert(rows);
  if (error) throw error;
}

export async function persistBodyTags(
  db: SupabaseClient,
  userId: string,
  entity: TaggableEntity,
  entityId: string,
  body: Record<string, unknown>,
  options?: { requireAny?: boolean; requireChannel?: boolean }
): Promise<{ channelSlugs: string[]; communitySlugs: string[]; isPlatformTagged: boolean }> {
  const { channelSlugs, communitySlugs } = extractSlugs(body);
  if (options?.requireChannel && channelSlugs.length === 0) {
    throw new TagError('channel_tag_required', 422);
  }
  if (options?.requireAny !== false && channelSlugs.length === 0 && communitySlugs.length === 0) {
    throw new TagError('scope_tag_required', 422);
  }
  const channelIds = await resolveChannelIds(db, channelSlugs);
  const communityIds = await resolveCommunityIds(db, communitySlugs, userId);
  await insertEntityTags(db, entity, entityId, channelIds, communityIds);
  return {
    channelSlugs,
    communitySlugs,
    isPlatformTagged: channelSlugs.includes('platform')
  };
}
