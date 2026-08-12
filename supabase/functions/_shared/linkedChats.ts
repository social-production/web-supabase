/**
 * Linked project/event/help-request chats for the /messages inbox.
 * Parity with web-backend/app/services/messages/linked_chats.py
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

type LinkedChatItem = {
  id: string;
  kind: 'project' | 'event' | 'help_request';
  entity_id: string;
  entity_slug: string;
  title: string;
  preview: string;
  last_message_at: string;
  comment_count: number;
  unread_count: number;
};

async function buildKindItems(
  db: SupabaseClient,
  userId: string,
  kind: 'project' | 'event' | 'help_request',
  rows: Array<{
    id: string;
    slug?: string | null;
    title: string;
    last_activity_at?: string | null;
    comment_count?: number | null;
  }>
): Promise<LinkedChatItem[]> {
  if (!rows.length) return [];

  const ids = rows.map((row) => String(row.id));
  const [{ data: comments }, { data: reads }] = await Promise.all([
    db
      .from('comments')
      .select('subject_id, body, created_at, author_id')
      .eq('subject_type', kind)
      .in('subject_id', ids)
      .order('created_at', { ascending: false }),
    db
      .from('subject_chat_reads')
      .select('subject_id, last_read_at')
      .eq('user_id', userId)
      .eq('subject_type', kind)
      .in('subject_id', ids)
  ]);

  const latestBySubject = new Map<string, { body: string; created_at: string }>();
  const unreadBySubject = new Map<string, number>();
  for (const id of ids) unreadBySubject.set(id, 0);

  const readMap = new Map(
    (reads ?? []).map((row) => [String(row.subject_id), String(row.last_read_at)])
  );

  for (const row of comments ?? []) {
    const subjectId = String(row.subject_id);
    if (!latestBySubject.has(subjectId)) {
      latestBySubject.set(subjectId, {
        body: String(row.body ?? ''),
        created_at: String(row.created_at)
      });
    }
    if (String(row.author_id) === userId) continue;
    const lastRead = readMap.get(subjectId);
    if (lastRead && String(row.created_at) <= lastRead) continue;
    unreadBySubject.set(subjectId, (unreadBySubject.get(subjectId) ?? 0) + 1);
  }

  return rows.map((row) => {
    const id = String(row.id);
    const comment = latestBySubject.get(id);
    return {
      id,
      kind,
      entity_id: id,
      entity_slug: String(row.slug ?? row.id),
      title: String(row.title),
      preview: comment?.body ? comment.body.slice(0, 200) : '',
      last_message_at: String(comment?.created_at ?? row.last_activity_at ?? new Date().toISOString()),
      comment_count: Number(row.comment_count ?? 0),
      unread_count: unreadBySubject.get(id) ?? 0
    };
  });
}

export async function buildLinkedChats(db: SupabaseClient, userId: string) {
  const [{ data: projectMemberships }, { data: eventMemberships }] = await Promise.all([
    db.from('project_memberships').select('project_id').eq('user_id', userId),
    db.from('event_memberships').select('event_id').eq('user_id', userId)
  ]);

  const projectIds = new Set((projectMemberships ?? []).map((row) => String(row.project_id)));
  const eventIds = new Set((eventMemberships ?? []).map((row) => String(row.event_id)));

  const [{ data: projectComments }, { data: eventComments }, { data: helpComments }] =
    await Promise.all([
      db
        .from('comments')
        .select('subject_id')
        .eq('subject_type', 'project')
        .eq('author_id', userId),
      db
        .from('comments')
        .select('subject_id')
        .eq('subject_type', 'event')
        .eq('author_id', userId),
      db
        .from('comments')
        .select('subject_id')
        .eq('subject_type', 'help_request')
        .eq('author_id', userId)
    ]);

  for (const row of projectComments ?? []) projectIds.add(String(row.subject_id));
  for (const row of eventComments ?? []) eventIds.add(String(row.subject_id));

  const helpIds = new Set((helpComments ?? []).map((row) => String(row.subject_id)));
  const { data: ownedHelp } = await db
    .from('help_requests')
    .select('id')
    .eq('author_id', userId);
  for (const row of ownedHelp ?? []) helpIds.add(String(row.id));

  const { data: assignedRoles } = await db
    .from('help_request_role_assignments')
    .select('role_id')
    .eq('user_id', userId);
  const roleIds = (assignedRoles ?? []).map((row) => String(row.role_id));
  if (roleIds.length) {
    const { data: roles } = await db
      .from('help_request_roles')
      .select('help_request_id')
      .in('id', roleIds);
    for (const row of roles ?? []) helpIds.add(String(row.help_request_id));
  }

  const items: LinkedChatItem[] = [];

  if (eventIds.size) {
    const { data: events } = await db
      .from('events')
      .select('id, slug, title, last_activity_at, comment_count')
      .in('id', [...eventIds])
      .order('last_activity_at', { ascending: false });
    items.push(...(await buildKindItems(db, userId, 'event', events ?? [])));
  }

  if (projectIds.size) {
    const { data: projects } = await db
      .from('projects')
      .select('id, slug, title, last_activity_at, comment_count')
      .in('id', [...projectIds])
      .order('last_activity_at', { ascending: false });
    items.push(...(await buildKindItems(db, userId, 'project', projects ?? [])));
  }

  if (helpIds.size) {
    const { data: helpRequests } = await db
      .from('help_requests')
      .select('id, title, created_at, comment_count')
      .in('id', [...helpIds])
      .order('created_at', { ascending: false });
    items.push(
      ...(await buildKindItems(
        db,
        userId,
        'help_request',
        (helpRequests ?? []).map((row) => ({
          id: String(row.id),
          slug: String(row.id),
          title: String(row.title),
          last_activity_at: String(row.created_at),
          comment_count: Number(row.comment_count ?? 0)
        }))
      ))
    );
  }

  items.sort((a, b) => String(b.last_message_at).localeCompare(String(a.last_message_at)));
  return { total: items.length, items };
}

export function mapLinkedChatToFrontend(item: LinkedChatItem) {
  return {
    id: item.id,
    kind: item.kind,
    subjectId: item.entity_id,
    title: item.title,
    href:
      item.kind === 'help_request'
        ? `/help-requests/${item.entity_id}`
        : `/${item.kind}s/${item.entity_slug}`,
    meta: `${item.comment_count} comments`,
    preview: item.preview,
    lastMessageAt: item.last_message_at,
    unreadCount: item.unread_count,
    comments: [] as unknown[]
  };
}

/** Lightweight unread total for badge polls — no title/preview hydration. */
export async function countLinkedChatUnread(db: SupabaseClient, userId: string) {
  const [{ data: projectMemberships }, { data: eventMemberships }, { data: ownedHelp }] =
    await Promise.all([
      db.from('project_memberships').select('project_id').eq('user_id', userId),
      db.from('event_memberships').select('event_id').eq('user_id', userId),
      db.from('help_requests').select('id').eq('author_id', userId)
    ]);

  const projectIds = new Set((projectMemberships ?? []).map((row) => String(row.project_id)));
  const eventIds = new Set((eventMemberships ?? []).map((row) => String(row.event_id)));
  const helpIds = new Set((ownedHelp ?? []).map((row) => String(row.id)));

  const [{ data: projectComments }, { data: eventComments }, { data: helpComments }] =
    await Promise.all([
      db.from('comments').select('subject_id').eq('subject_type', 'project').eq('author_id', userId),
      db.from('comments').select('subject_id').eq('subject_type', 'event').eq('author_id', userId),
      db
        .from('comments')
        .select('subject_id')
        .eq('subject_type', 'help_request')
        .eq('author_id', userId)
    ]);
  for (const row of projectComments ?? []) projectIds.add(String(row.subject_id));
  for (const row of eventComments ?? []) eventIds.add(String(row.subject_id));
  for (const row of helpComments ?? []) helpIds.add(String(row.subject_id));

  const { data: assignedRoles } = await db
    .from('help_request_role_assignments')
    .select('role_id')
    .eq('user_id', userId);
  const roleIds = (assignedRoles ?? []).map((row) => String(row.role_id));
  if (roleIds.length) {
    const { data: roles } = await db
      .from('help_request_roles')
      .select('help_request_id')
      .in('id', roleIds);
    for (const row of roles ?? []) helpIds.add(String(row.help_request_id));
  }

  const subjects: Array<{ type: 'project' | 'event' | 'help_request'; id: string }> = [
    ...[...projectIds].map((id) => ({ type: 'project' as const, id })),
    ...[...eventIds].map((id) => ({ type: 'event' as const, id })),
    ...[...helpIds].map((id) => ({ type: 'help_request' as const, id }))
  ];
  if (!subjects.length) return 0;

  const { data: reads } = await db
    .from('subject_chat_reads')
    .select('subject_type, subject_id, last_read_at')
    .eq('user_id', userId);
  const readMap = new Map(
    (reads ?? []).map((row) => [`${row.subject_type}:${row.subject_id}`, String(row.last_read_at)])
  );

  const byType = {
    project: subjects.filter((s) => s.type === 'project').map((s) => s.id),
    event: subjects.filter((s) => s.type === 'event').map((s) => s.id),
    help_request: subjects.filter((s) => s.type === 'help_request').map((s) => s.id)
  };

  const commentQueries = (
    [
      ['project', byType.project],
      ['event', byType.event],
      ['help_request', byType.help_request]
    ] as const
  )
    .filter(([, ids]) => ids.length > 0)
    .map(([type, ids]) =>
      db
        .from('comments')
        .select('subject_type, subject_id, created_at')
        .eq('subject_type', type)
        .in('subject_id', ids)
        .neq('author_id', userId)
        .then(({ data }) => data ?? [])
    );

  const commentBatches = await Promise.all(commentQueries);
  let total = 0;
  for (const rows of commentBatches) {
    for (const row of rows) {
      const key = `${row.subject_type}:${row.subject_id}`;
      const lastRead = readMap.get(key);
      if (lastRead && String(row.created_at) <= lastRead) continue;
      total += 1;
    }
  }
  return total;
}
