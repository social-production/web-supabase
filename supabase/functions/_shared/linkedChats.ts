/**
 * Set-based linked-chat reads for the /messages inbox.
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { measureServerSpan } from './performance.ts';

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

export async function buildLinkedChats(db: SupabaseClient, userId: string) {
  return measureServerSpan('inbox.linked-chats', async () => {
    const { data, error } = await db.rpc('get_linked_chat_inbox', {
      p_user_id: userId,
      p_limit: 80
    });
    if (error) throw error;
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const items = rows.map((row) => ({
      id: String(row.id),
      kind: row.kind,
      entity_id: String(row.entity_id),
      entity_slug: String(row.entity_slug),
      title: String(row.title),
      preview: String(row.preview ?? ''),
      last_message_at: String(row.last_message_at),
      comment_count: Number(row.comment_count ?? 0),
      unread_count: Number(row.unread_count ?? 0)
    })) as LinkedChatItem[];
    return { total: items.length, items };
  });
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

