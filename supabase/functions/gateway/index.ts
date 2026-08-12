import { corsHeaders, error, json } from '../_shared/http.ts';
import {
  handleAddComment,
  handleBootstrap,
  handleBootstrapSummary,
  handleActivityRail,
  handleFollowRequests,
  handleGetComments,
  handleGetSettings,
  handleLinkedChats,
  handleMapMarkers,
  handleMarkAllNotificationsRead,
  handleMarkNotificationRead,
  handleMessageContacts,
  handleNamedFeedPage,
  handleNotifications,
  handleProfile,
  handlePublicFeedPage,
  handleReportVote,
  handleScope,
  handleSearch,
  handleSetVote,
  handleSubmitReport,
  handleTaggableScopes,
  handleUpdateSettings,
  loadViewer
} from '../_shared/handlers.ts';
import * as mutations from '../_shared/mutations.ts';
import * as lifecycle from '../_shared/lifecycle.ts';
import * as board from '../_shared/board.ts';
import {
  buildEventLifecycle,
  buildLinksFrame,
  buildProjectLifecycle,
  hydrateActivities,
  hydrateEventEditRequests,
  hydrateEventHistory,
  hydrateEventUpdateRequests,
  hydrateProjectEditRequests,
  hydrateProjectHistory,
  hydrateProjectUpdateRequests
} from '../_shared/detail.ts';
import { createServiceClient, requireUserId } from '../_shared/supabase.ts';
import { isEventMember, isProjectMember, loadEntityTags, canViewEntity, canViewPost } from '../_shared/access.ts';
import { persistBodyTags, extractSlugs, TagError } from '../_shared/tags.ts';
import { reverseGeocodeExternal, searchPlacesExternal, clientIpFromRequest, ipLocationHintExternal } from '../_shared/geocoding.ts';
import { loadActiveReport, moderationFieldsFromRow } from '../_shared/moderation.ts';
import { recordMeaningfulAction } from '../_shared/votes.ts';

// Re-export viewer vote helper via a light local call using service client after handlers load.
async function viewerActiveVote(
  db: ReturnType<typeof createServiceClient>,
  userId: string | null,
  targetType: string,
  targetId: string
): Promise<number> {
  if (!userId) return 0;
  const { data } = await db
    .from('content_votes')
    .select('direction')
    .eq('target_type', targetType)
    .eq('target_id', targetId)
    .eq('voter_id', userId)
    .maybeSingle();
  return Number(data?.direction ?? 0);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    // Local serve may pass `/gateway/...`; Kong may pass `/functions/v1/gateway/...`.
    let path = url.pathname
      .replace(/^\/functions\/v1\/gateway/, '')
      .replace(/^\/gateway/, '');
    if (!path.startsWith('/')) path = `/${path}`;
    if (path !== '/' && path.endsWith('/')) path = path.slice(0, -1);
    const authHeader = req.headers.get('Authorization');
    const db = createServiceClient();
    const userId = await requireUserId(db, authHeader);

    const readJson = async () => {
      try {
        return await req.json();
      } catch {
        return {};
      }
    };

    // Health
    if (req.method === 'GET' && (path === '/' || path === '/healthz')) {
      return json({ ok: true, provider: 'supabase', service: 'gateway' });
    }

    // Bootstrap
    if (req.method === 'GET' && path === '/bootstrap') {
      return json(await handleBootstrap(db, userId));
    }
    if (req.method === 'GET' && path === '/bootstrap/summary') {
      return json(await handleBootstrapSummary(db, userId));
    }
    if (req.method === 'GET' && path === '/bootstrap/activity-rail') {
      return json(await handleActivityRail(db, userId));
    }

    // Feeds
    if (req.method === 'GET' && path === '/feeds/public') {
      return json(await handleNamedFeedPage(db, userId, 'public', url.searchParams));
    }
    if (req.method === 'GET' && path === '/feeds/home') {
      return json(await handleNamedFeedPage(db, userId, 'home', url.searchParams));
    }
    if (req.method === 'GET' && path === '/feeds/personal') {
      return json(await handleNamedFeedPage(db, userId, 'personal', url.searchParams));
    }
    if (req.method === 'GET' && path === '/feeds/region') {
      return json(await handleNamedFeedPage(db, userId, 'region', url.searchParams));
    }
    if (req.method === 'GET' && path === '/feeds/scope') {
      return json(await handleNamedFeedPage(db, userId, 'scope', url.searchParams));
    }
    if (req.method === 'GET' && path === '/feeds/user') {
      return json(await handleNamedFeedPage(db, userId, 'user', url.searchParams));
    }
    if (req.method === 'GET' && path === '/map/markers') {
      return json(await handleMapMarkers(db, userId, url.searchParams));
    }

    // Governance
    if (req.method === 'POST' && path === '/governance/votes') {
      if (!userId) return error('unauthorized', 401);
      const body = await readJson();
      const target = body.target ?? {};
      return json(
        await handleSetVote(db, userId, {
          target_type: target.type ?? body.target_type ?? body.targetType,
          target_id: target.id ?? body.target_id ?? body.targetId,
          direction:
            body.direction ??
            (body.vote === 1 || body.vote === 'up'
              ? 'up'
              : body.vote === -1 || body.vote === 'down'
                ? 'down'
                : 'neutral')
        })
      );
    }
    if (req.method === 'GET' && path === '/governance/comments') {
      const subjectType = url.searchParams.get('subject_type') ?? '';
      const subjectId = url.searchParams.get('subject_id') ?? '';
      return json({ items: await handleGetComments(db, userId, subjectType, subjectId) });
    }
    if (req.method === 'POST' && path === '/governance/comments') {
      if (!userId) return error('unauthorized', 401);
      const body = await readJson();
      const subject = body.subject ?? {};
      return json(
        await handleAddComment(db, userId, {
          subject_type: subject.type ?? body.subject_type ?? body.subjectType,
          subject_id: subject.id ?? body.subject_id ?? body.subjectId,
          body: body.body,
          parent_id: body.parentId ?? body.parent_id ?? null
        })
      );
    }
    if (req.method === 'POST' && path === '/governance/reports') {
      if (!userId) return error('unauthorized', 401);
      const body = await readJson();
      const target = body.target ?? {};
      return json({
        report: await handleSubmitReport(db, userId, {
          target_type: target.type ?? body.target_type ?? body.targetType,
          target_id: target.id ?? body.target_id ?? body.targetId,
          reason: body.reason,
          description: body.details ?? body.description ?? '',
          subject_id: body.subjectId ?? body.subject_id
        })
      });
    }
    if (req.method === 'POST' && path.startsWith('/governance/reports/') && path.endsWith('/vote')) {
      if (!userId) return error('unauthorized', 401);
      const reportId = path.split('/')[3];
      const body = await readJson();
      return json({ report: await handleReportVote(db, userId, reportId, body.vote) });
    }

    // Search
    if (req.method === 'GET' && path === '/search') {
      const q = url.searchParams.get('q') ?? '';
      const limit = Number(url.searchParams.get('limit') ?? 20);
      return json(await handleSearch(db, userId, q, limit));
    }

    // Scopes
    if (req.method === 'GET' && path.startsWith('/scopes/channels/')) {
      const slug = decodeURIComponent(path.slice('/scopes/channels/'.length));
      const data = await handleScope(db, userId, 'channel', slug);
      return data ? json(data) : error('not_found', 404);
    }
    if (req.method === 'GET' && path.startsWith('/scopes/communities/')) {
      const slug = decodeURIComponent(path.slice('/scopes/communities/'.length));
      const data = await handleScope(db, userId, 'community', slug);
      return data ? json(data) : error('not_found', 404);
    }
    if (req.method === 'GET' && path === '/scopes/taggable') {
      return json(
        await handleTaggableScopes(
          db,
          userId,
          url.searchParams.get('q') ?? '',
          url.searchParams.get('kind'),
          Number(url.searchParams.get('limit') ?? 20)
        )
      );
    }
    if (req.method === 'GET' && path === '/scopes/platform') {
      return json(await board.getPlatformBoard(db, userId));
    }
    if (req.method === 'POST' && path === '/scopes/membership') {
      if (!userId) return error('unauthorized', 401);
      const body = await readJson();
      const kindRaw = String(body.kind ?? '');
      const scopeKind = kindRaw === 'platform' || kindRaw === 'channel' ? 'channel' : 'community';
      const slug = kindRaw === 'platform' ? 'platform' : String(body.slug ?? '');
      const table = scopeKind === 'channel' ? 'channels' : 'communities';
      const { data: scope } = await db.from(table).select('id').eq('slug', slug).maybeSingle();
      if (!scope) return error('not_found', 404);
      if (body.viewerIsMember) {
        await db
          .from('scope_memberships')
          .delete()
          .eq('scope_kind', scopeKind)
          .eq('scope_id', scope.id)
          .eq('user_id', userId);
      } else {
        await db.from('scope_memberships').upsert(
          {
            scope_kind: scopeKind,
            scope_id: scope.id,
            user_id: userId,
            role: 'member'
          },
          { onConflict: 'scope_kind,scope_id,user_id' }
        );
      }
      return json({ ok: true });
    }

    // Notifications
    if (req.method === 'GET' && path === '/notifications') {
      if (!userId) return error('unauthorized', 401);
      return json(await handleNotifications(db, userId));
    }
    if (req.method === 'POST' && path === '/notifications/read-all') {
      if (!userId) return error('unauthorized', 401);
      return json(await handleMarkAllNotificationsRead(db, userId));
    }
    if (req.method === 'POST' && path.startsWith('/notifications/') && path.endsWith('/read')) {
      if (!userId) return error('unauthorized', 401);
      const id = path.split('/')[2];
      return json(await handleMarkNotificationRead(db, userId, id));
    }

    // Users / settings / profile
    if (req.method === 'GET' && path === '/users/me') {
      return json({ viewer: await loadViewer(db, userId) });
    }
    if (req.method === 'GET' && path === '/users/me/settings') {
      if (!userId) return error('unauthorized', 401);
      return json(await handleGetSettings(db, userId));
    }
    if (req.method === 'PATCH' && path === '/users/me/settings') {
      if (!userId) return error('unauthorized', 401);
      return json(await handleUpdateSettings(db, userId, await readJson()));
    }
    if (req.method === 'GET' && path === '/users/me/follow-requests') {
      if (!userId) return error('unauthorized', 401);
      return json(await handleFollowRequests(db, userId));
    }
    if (req.method === 'GET' && path.startsWith('/users/') && !path.includes('/me')) {
      const username = decodeURIComponent(path.slice('/users/'.length).split('/')[0]);
      const data = await handleProfile(db, userId, username);
      return data ? json(data) : error('not_found', 404);
    }
    if (req.method === 'POST' && path.match(/^\/users\/[^/]+\/follow$/)) {
      if (!userId) return error('unauthorized', 401);
      const username = decodeURIComponent(path.split('/')[2]);
      const { data: target } = await db.from('users').select('id').eq('username', username).maybeSingle();
      if (!target) return error('not_found', 404);
      if (target.id === userId) return error('cannot_follow_self', 400);
      const { data: existing } = await db
        .from('user_follows')
        .select('status')
        .eq('follower_id', userId)
        .eq('followed_id', target.id)
        .maybeSingle();
      if (existing) {
        return json({
          ok: true,
          following: existing.status === 'accepted',
          followStatus: existing.status,
          username
        });
      }
      const { data: settings } = await db.from('user_settings').select('require_follow_approval').eq('user_id', target.id).maybeSingle();
      const status = settings?.require_follow_approval ? 'pending' : 'accepted';
      await db.from('user_follows').insert({
        follower_id: userId,
        followed_id: target.id,
        status
      });
      const { data: actor } = await db.from('users').select('username').eq('id', userId).maybeSingle();
      const actorUsername = actor?.username ?? 'someone';
      if (status === 'pending') {
        await db.from('notifications').insert({
          recipient_id: target.id,
          actor_id: userId,
          kind: 'follow-request',
          surface: 'profile',
          subject_type: 'user',
          subject_id: userId,
          target_id: target.id,
          title: 'Follow request',
          body: `@${actorUsername} requested to follow you.`,
          href: `/profile/${actorUsername}`,
          is_unread: true
        });
      } else {
        await db.from('notifications').insert({
          recipient_id: target.id,
          actor_id: userId,
          kind: 'new-follower',
          surface: 'profile',
          subject_type: 'user',
          subject_id: userId,
          target_id: target.id,
          title: 'New follower',
          body: `@${actorUsername} started following you.`,
          href: `/profile/${actorUsername}`,
          is_unread: true
        });
      }
      return json({ ok: true, following: status === 'accepted', followStatus: status, username });
    }
    if (req.method === 'DELETE' && path.match(/^\/users\/[^/]+\/follow$/)) {
      if (!userId) return error('unauthorized', 401);
      const username = decodeURIComponent(path.split('/')[2]);
      const { data: target } = await db.from('users').select('id').eq('username', username).maybeSingle();
      if (!target) return error('not_found', 404);
      await db
        .from('user_follows')
        .delete()
        .eq('follower_id', userId)
        .eq('followed_id', target.id);
      return json({ ok: true });
    }

    // Messages
    if (req.method === 'GET' && path === '/messages/conversations') {
      if (!userId) return error('unauthorized', 401);
      const viewer = await loadViewer(db, userId);
      const { data: memberships } = await db
        .from('conversation_members')
        .select('conversation_id, last_read_at, conversations(*)')
        .eq('user_id', userId);

      const membershipRows = (memberships ?? [])
        .map((membership) => {
          const conversation = Array.isArray(membership.conversations)
            ? membership.conversations[0]
            : membership.conversations;
          if (!conversation) return null;
          return {
            conversation,
            lastReadAt: membership.last_read_at as string | null
          };
        })
        .filter(Boolean) as Array<{ conversation: any; lastReadAt: string | null }>;

      const conversationIds = membershipRows.map((row) => String(row.conversation.id));
      const participantsByConversation = new Map<
        string,
        Array<{ id: string; username: string; profileImageUrl: string | null }>
      >();
      const latestByConversation = new Map<string, { body: string; createdAt: string }>();
      const unreadByConversation = new Map<string, number>();

      if (conversationIds.length) {
        const memberPromise = db
          .from('conversation_members')
          .select(
            'conversation_id, user_id, users!fk_conversation_members_user_id_users(id, username, profile_image_url)'
          )
          .in('conversation_id', conversationIds);

        // One latest row + one unread COUNT per conversation — never scan full histories.
        const latestPromises = conversationIds.map((conversationId) =>
          db
            .from('messages')
            .select('conversation_id, encrypted_body, created_at')
            .eq('conversation_id', conversationId)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()
            .then(({ data }) => data)
        );
        const unreadPromises = membershipRows.map(({ conversation, lastReadAt }) => {
          let query = db
            .from('messages')
            .select('*', { count: 'exact', head: true })
            .eq('conversation_id', conversation.id)
            .neq('sender_id', userId);
          if (lastReadAt) {
            query = query.gt('created_at', lastReadAt);
          }
          return query.then(({ count }) => [String(conversation.id), count ?? 0] as const);
        });

        const [{ data: memberRows }, latestRows, unreadPairs] = await Promise.all([
          memberPromise,
          Promise.all(latestPromises),
          Promise.all(unreadPromises)
        ]);

        for (const row of memberRows ?? []) {
          const conversationId = String(row.conversation_id);
          const user = Array.isArray(row.users) ? row.users[0] : row.users;
          const list = participantsByConversation.get(conversationId) ?? [];
          list.push({
            id: user?.id ?? row.user_id,
            username: user?.username ?? 'unknown',
            profileImageUrl: user?.profile_image_url ?? null
          });
          participantsByConversation.set(conversationId, list);
        }

        for (const row of latestRows) {
          if (!row) continue;
          latestByConversation.set(String(row.conversation_id), {
            body: String(row.encrypted_body ?? ''),
            createdAt: String(row.created_at)
          });
        }
        for (const [conversationId, count] of unreadPairs) {
          unreadByConversation.set(conversationId, count);
        }
      }

      const conversations = membershipRows.map(({ conversation }) => {
        const conversationId = String(conversation.id);
        const participants = participantsByConversation.get(conversationId) ?? [];
        const partner =
          conversation.kind === 'direct'
            ? participants.find((participant) => participant.id !== userId) ?? null
            : null;
        const title =
          conversation.kind === 'direct'
            ? partner?.username ?? 'Direct message'
            : (conversation.title ?? 'Group chat');
        const latest = latestByConversation.get(conversationId);
        return {
          id: conversationId,
          kind: conversation.kind,
          title,
          participants,
          preview: latest?.body ?? '',
          lastMessageAt: conversation.last_message_at ?? conversation.created_at,
          unreadCount: unreadByConversation.get(conversationId) ?? 0,
          messages: []
        };
      });
      conversations.sort((a, b) => String(b.lastMessageAt).localeCompare(String(a.lastMessageAt)));
      // Linked chats load via /messages/linked-chats — keep this endpoint lean for first paint.
      return json({
        viewer,
        conversations,
        linkedChats: [],
        suggestedContacts: [],
        activeConversationId: conversations[0]?.id ?? null
      });
    }
    if (
      req.method === 'GET' &&
      path.match(/^\/messages\/conversations\/[^/]+\/messages$/)
    ) {
      if (!userId) return error('unauthorized', 401);
      const conversationId = path.split('/')[3];
      const { data: membership } = await db
        .from('conversation_members')
        .select('conversation_id')
        .eq('conversation_id', conversationId)
        .eq('user_id', userId)
        .maybeSingle();
      if (!membership) return error('not_found', 404);
      const { data: members } = await db
        .from('conversation_members')
        .select('user_id, users!fk_conversation_members_user_id_users(id, username, profile_image_url)')
        .eq('conversation_id', conversationId);
      const participants = (members ?? []).map((m) => {
        const u = Array.isArray(m.users) ? m.users[0] : m.users;
        return {
          id: u?.id ?? m.user_id,
          username: u?.username ?? 'unknown',
          profileImageUrl: u?.profile_image_url ?? null
        };
      });
      const participantById = new Map(participants.map((p) => [p.id, p]));
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100), 1), 200);
      const { data: msgs } = await db
        .from('messages')
        .select('id, sender_id, encrypted_body, created_at, moderation_state')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(limit);
      return json({
        conversationId,
        messages: (msgs ?? []).map((m) => {
          const sender = participantById.get(m.sender_id) ?? {
            id: m.sender_id,
            username: 'unknown',
            profileImageUrl: null
          };
          return {
            id: m.id,
            sender,
            body: m.encrypted_body,
            createdAt: m.created_at,
            isOwn: m.sender_id === userId,
            moderationState: m.moderation_state ?? 'visible'
          };
        })
      });
    }
    if (req.method === 'GET' && path === '/messages/linked-chats') {
      if (!userId) return error('unauthorized', 401);
      return json(await handleLinkedChats(db, userId));
    }
    if (req.method === 'GET' && path === '/messages/contacts') {
      if (!userId) return error('unauthorized', 401);
      return json(await handleMessageContacts(db, userId, url.searchParams.get('q') ?? '', Number(url.searchParams.get('limit') ?? 8)));
    }
    if (req.method === 'POST' && path === '/messages/direct') {
      if (!userId) return error('unauthorized', 401);
      const body = await readJson();
      const { data: other } = await db
        .from('users')
        .select('id, username')
        .eq('username', body.participantUsername ?? body.username)
        .maybeSingle();
      if (!other) return error('not_found', 404);
      const { data: conversation, error: convErr } = await db
        .from('conversations')
        .insert({ kind: 'direct', created_by: userId })
        .select('id')
        .single();
      if (convErr) throw convErr;
      const joinedAt = new Date().toISOString();
      const { error: memberErr } = await db.from('conversation_members').insert([
        {
          conversation_id: conversation.id,
          user_id: userId,
          joined_at: joinedAt,
          last_read_at: joinedAt
        },
        { conversation_id: conversation.id, user_id: other.id, joined_at: joinedAt }
      ]);
      if (memberErr) throw memberErr;
      if (body.body) {
        const { error: msgErr } = await db.from('messages').insert({
          conversation_id: conversation.id,
          sender_id: userId,
          encrypted_body: body.body,
          encryption_version: 0
        });
        if (msgErr) throw msgErr;
        await db
          .from('conversations')
          .update({ last_message_at: new Date().toISOString() })
          .eq('id', conversation.id);
      }
      return json({ ok: true, conversationId: conversation.id });
    }
    if (req.method === 'POST' && path.match(/^\/messages\/conversations\/[^/]+\/messages$/)) {
      if (!userId) return error('unauthorized', 401);
      const conversationId = path.split('/')[3];
      const body = await readJson();
      const sentAt = new Date().toISOString();
      await db.from('messages').insert({
        conversation_id: conversationId,
        sender_id: userId,
        encrypted_body: body.body,
        encryption_version: 0,
        created_at: sentAt
      });
      await db
        .from('conversations')
        .update({ last_message_at: sentAt })
        .eq('id', conversationId);
      await db
        .from('conversation_members')
        .update({ last_read_at: sentAt })
        .eq('conversation_id', conversationId)
        .eq('user_id', userId);
      return json({ ok: true });
    }
    if (req.method === 'POST' && path.match(/^\/messages\/conversations\/[^/]+\/read$/)) {
      if (!userId) return error('unauthorized', 401);
      const conversationId = path.split('/')[3];
      await db
        .from('conversation_members')
        .update({ last_read_at: new Date().toISOString() })
        .eq('conversation_id', conversationId)
        .eq('user_id', userId);
      return json({ ok: true });
    }

    // Content detail
    if (req.method === 'GET' && path.startsWith('/content/threads/')) {
      const slug = decodeURIComponent(path.slice('/content/threads/'.length));
      const { data } = await db
        .from('threads')
        .select('*, users!fk_threads_author_id_users(username)')
        .eq('slug', slug)
        .maybeSingle();
      if (!data) return error('not_found', 404);
      if (!(await canViewEntity(db, userId, 'thread', data.id))) return error('not_found', 404);
      const author = Array.isArray(data.users) ? data.users[0] : data.users;
      const tags = await loadEntityTags(db, 'thread', data.id);
      const comments = await handleGetComments(db, userId, 'thread', data.id);
      const report = await loadActiveReport(db, 'thread', data.id, userId);
      const moderation = moderationFieldsFromRow(data, report);
      return json({
        id: data.id,
        slug: data.slug,
        title: data.title,
        body: data.body,
        authorUsername: author?.username ?? 'unknown',
        channelTags: tags.channelTags,
        communityTags: tags.communityTags,
        voteCount: data.vote_count ?? 0,
        activeVote: await viewerActiveVote(db, userId, 'thread', data.id),
        commentCount: data.comment_count ?? 0,
        lastActivityAt: data.last_activity_at,
        report: moderation.report,
        isRemovedByReport: moderation.isRemovedByReport,
        hasActiveReport: moderation.hasActiveReport,
        isUnderReview: moderation.isUnderReview,
        moderationState: moderation.moderationState,
        discussionNote: '',
        discussion: comments
      });
    }
    if (req.method === 'GET' && path.startsWith('/content/posts/')) {
      const id = decodeURIComponent(path.slice('/content/posts/'.length));
      const { data } = await db
        .from('posts')
        .select('*, users!fk_posts_author_id_users(username, profile_image_url)')
        .eq('id', id)
        .maybeSingle();
      if (!data) return error('not_found', 404);
      if (!(await canViewPost(db, userId, data))) return error('not_found', 404);
      const author = Array.isArray(data.users) ? data.users[0] : data.users;
      const comments = await handleGetComments(db, userId, 'post', data.id);
      const report = await loadActiveReport(db, 'post', data.id, userId);
      const moderation = moderationFieldsFromRow(data, report);
      return json({
        id: data.id,
        authorUsername: author?.username ?? 'unknown',
        authorProfileImageUrl: author?.profile_image_url ?? null,
        body: data.body,
        audience: data.audience,
        voteCount: data.vote_count ?? 0,
        activeVote: await viewerActiveVote(db, userId, 'post', data.id),
        commentCount: data.comment_count ?? 0,
        createdAt: data.created_at,
        report: moderation.report,
        isRemovedByReport: moderation.isRemovedByReport,
        hasActiveReport: moderation.hasActiveReport,
        isUnderReview: moderation.isUnderReview,
        moderationState: moderation.moderationState,
        discussionNote: '',
        discussion: comments
      });
    }
    if (req.method === 'POST' && path === '/content/threads') {
      if (!userId) return error('unauthorized', 401);
      const body = await readJson();
      const slug =
        (body.slug as string | undefined) ??
        `${String(body.title ?? 'thread')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 60)}-${crypto.randomUUID().slice(0, 8)}`;
      const { data, error: insertError } = await db
        .from('threads')
        .insert({
          slug,
          title: body.title,
          body: body.body,
          author_id: userId,
          last_activity_at: new Date().toISOString()
        })
        .select('id, slug')
        .single();
      if (insertError) throw insertError;
      await persistBodyTags(db, userId, 'thread', data.id, body, { requireAny: true });
      await recordMeaningfulAction(db, userId, 'create-thread', {
        thread_id: data.id,
        slug: data.slug
      });
      return json({ ok: true, id: data.id, slug: data.slug });
    }
    if (req.method === 'POST' && path === '/content/posts') {
      if (!userId) return error('unauthorized', 401);
      const body = await readJson();
      const { data, error: insertError } = await db
        .from('posts')
        .insert({
          body: body.body,
          audience: body.audience ?? 'followers',
          author_id: userId
        })
        .select('id')
        .single();
      if (insertError) throw insertError;
      await recordMeaningfulAction(db, userId, 'create-post', { post_id: data.id });
      return json({ ok: true, id: data.id });
    }

    // Projects / events / help requests — detail reads with access gates
    if (req.method === 'GET' && path.startsWith('/projects/')) {
      const slug = decodeURIComponent(path.slice('/projects/'.length).split('/')[0]);
      if (req.method === 'GET' && !path.slice(`/projects/${slug}`.length)) {
        const { data } = await db
          .from('projects')
          .select('*, users!fk_projects_author_id_users(username)')
          .eq('slug', slug)
          .maybeSingle();
        if (!data) return error('not_found', 404);
        if (!(await canViewEntity(db, userId, 'project', data.id))) return error('not_found', 404);
        const author = Array.isArray(data.users) ? data.users[0] : data.users;
        const viewerIsMember = userId ? await isProjectMember(db, data.id, userId) : false;
        const [tags, comments, activities, projectReport, activeVote] = await Promise.all([
          loadEntityTags(db, 'project', data.id),
          handleGetComments(db, userId, 'project', data.id),
          hydrateActivities(db, 'project', data.id, userId),
          loadActiveReport(db, 'project', data.id, userId),
          viewerActiveVote(db, userId, 'project', data.id)
        ]);
        const projectLifecycle = await buildProjectLifecycle(
          db,
          data,
          userId,
          viewerIsMember,
          activities
        );
        const population = Number(projectLifecycle.voteContextPopulation ?? data.member_count ?? 0);
        const [
          updatesRes,
          updateRequests,
          editRequests,
          linksFrame,
          history,
          membersRes
        ] = await Promise.all([
          db
            .from('project_updates')
            .select(
              'id, title, body, created_at, author_id, users!fk_project_updates_author_id_users(username)'
            )
            .eq('project_id', data.id)
            .order('created_at', { ascending: false }),
          hydrateProjectUpdateRequests(db, data.id, userId, population),
          hydrateProjectEditRequests(db, data.id, userId, population),
          buildLinksFrame(db, 'project', data, viewerIsMember, userId),
          hydrateProjectHistory(db, data.id, userId, population, viewerIsMember),
          db
            .from('project_memberships')
            .select('user_id, users!fk_project_memberships_user_id_users(id, username, profile_image_url)')
            .eq('project_id', data.id)
        ]);
        const projectModeration = moderationFieldsFromRow(data, projectReport);
        return json({
          id: data.id,
          slug: data.slug,
          createdAt: data.created_at,
          title: data.title,
          authorUsername: author?.username ?? 'unknown',
          projectMode: data.project_mode,
          projectSubtype: data.project_subtype,
          description: data.description ?? '',
          stage: data.stage_label ?? '',
          locationLabel: data.location_label ?? '',
          locationId: data.location_id,
          voteCount: data.vote_count ?? 0,
          activeVote,
          signalCount: data.signal_count ?? 0,
          commentCount: data.comment_count ?? 0,
          memberCount: data.member_count ?? 0,
          lastActivityAt: data.last_activity_at,
          channelTags: tags.channelTags,
          communityTags: tags.communityTags,
          lifecycle: projectLifecycle,
          updates: (updatesRes.data ?? []).map((u) => {
            const updateAuthor = Array.isArray(u.users) ? u.users[0] : u.users;
            return {
              id: u.id,
              title: u.title,
              body: u.body,
              authorUsername: updateAuthor?.username ?? 'unknown',
              createdAt: u.created_at
            };
          }),
          updateRequests,
          viewerCanRequestUpdate: Boolean(userId),
          viewerCanVoteOnUpdateRequests: Boolean(userId),
          editRequests,
          viewerCanRequestEdit: Boolean(userId),
          viewerCanVoteOnEditRequests: Boolean(userId),
          linksFrame,
          inventoryFrame: null,
          history,
          members: (membersRes.data ?? []).map((m) => {
            const u = Array.isArray(m.users) ? m.users[0] : m.users;
            return {
              id: u?.id ?? m.user_id,
              username: u?.username ?? 'unknown',
              profileImageUrl: u?.profile_image_url ?? null
            };
          }),
          viewerIsMember,
          viewerCanToggleMembership: Boolean(userId),
          viewerCanShare: Boolean(userId),
          shareContacts: [],
          report: projectModeration.report,
          isRemovedByReport: projectModeration.isRemovedByReport,
          hasActiveReport: projectModeration.hasActiveReport,
          isUnderReview: projectModeration.isUnderReview,
          moderationState: projectModeration.moderationState,
          discussionNote: '',
          discussion: comments
        });
      }
    }

    if (req.method === 'POST' && path === '/projects') {
      if (!userId) return error('unauthorized', 401);
      const body = await readJson();
      const { channelSlugs } = extractSlugs(body);
      if (channelSlugs.length === 0) throw new TagError('channel_tag_required', 422);
      const slug =
        body.slug ??
        `${String(body.title ?? 'project')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .slice(0, 60)}-${crypto.randomUUID().slice(0, 8)}`;
      const isPlatformTagged = channelSlugs.includes('platform');
      const { data, error: insertError } = await db
        .from('projects')
        .insert({
          slug,
          title: body.title,
          description: body.description ?? '',
          author_id: userId,
          project_mode: body.projectMode ?? body.project_mode ?? 'productive',
          current_phase_id: 'phase-1',
          stage_label: body.stage ?? body.stageLabel ?? 'Proposal',
          location_label: body.locationLabel ?? '',
          location_id: body.locationId ?? body.location_id ?? null,
          is_platform_tagged: isPlatformTagged,
          last_activity_at: new Date().toISOString()
        })
        .select('id, slug')
        .single();
      if (insertError) throw insertError;
      await persistBodyTags(db, userId, 'project', data.id, body, { requireChannel: true });
      await db.from('project_memberships').insert({
        project_id: data.id,
        user_id: userId,
        joined_at: new Date().toISOString()
      });
      await db.from('projects').update({ member_count: 1 }).eq('id', data.id);
      await recordMeaningfulAction(db, userId, 'create-project', {
        project_id: data.id,
        slug: data.slug
      });
      return json({ ok: true, id: data.id, slug: data.slug });
    }

    if (req.method === 'GET' && path.startsWith('/events/')) {
      const slug = decodeURIComponent(path.slice('/events/'.length).split('/')[0]);
      if (path === `/events/${slug}`) {
        const { data } = await db
          .from('events')
          .select('*, users!fk_events_created_by_users(username)')
          .eq('slug', slug)
          .maybeSingle();
        if (!data) return error('not_found', 404);
        if (!(await canViewEntity(db, userId, 'event', data.id))) return error('not_found', 404);
        const author = Array.isArray(data.users) ? data.users[0] : data.users;
        const tags = await loadEntityTags(db, 'event', data.id);
        const comments = await handleGetComments(db, userId, 'event', data.id);
        const viewerIsMember = userId ? await isEventMember(db, data.id, userId) : false;
        const activities = await hydrateActivities(db, 'event', data.id, userId);
        const eventLifecycle = await buildEventLifecycle(
          db,
          data,
          userId,
          viewerIsMember,
          activities
        );
        const eventReport = await loadActiveReport(db, 'event', data.id, userId);
        const eventModeration = moderationFieldsFromRow(data, eventReport);
        let homeCommunity = null;
        if (data.home_community_id) {
          const { data: community } = await db
            .from('communities')
            .select('id, slug, name')
            .eq('id', data.home_community_id)
            .maybeSingle();
          if (community) {
            homeCommunity = { id: community.id, slug: community.slug, name: community.name };
          }
        }
        const { data: editors } = await db
          .from('event_editors')
          .select('user_id, users!fk_event_editors_user_id_users(username, profile_image_url)')
          .eq('event_id', data.id);
        const eventEditors = (editors ?? []).map((row) => {
          const u = Array.isArray(row.users) ? row.users[0] : row.users;
          return {
            id: row.user_id,
            username: u?.username ?? 'unknown',
            profileImageUrl: u?.profile_image_url ?? null
          };
        });
        const members = ((await db.from('event_memberships').select('user_id, users!fk_event_memberships_user_id_users(id, username, profile_image_url)').eq('event_id', data.id)).data ?? []).map((m) => {
          const u = Array.isArray(m.users) ? m.users[0] : m.users;
          return { id: u?.id ?? m.user_id, username: u?.username ?? 'unknown', profileImageUrl: u?.profile_image_url ?? null };
        });
        const invitedUsernames =
          data.audience === 'invite_only'
            ? members
                .filter((m) => m.id !== data.created_by)
                .map((m) => m.username)
            : [];
        const viewerIsOrganizer =
          Boolean(userId) &&
          (data.created_by === userId || eventEditors.some((e) => e.id === userId));
        const viewerHasEventEditAccess =
          String(data.governance) === 'organizer_controlled' ? viewerIsOrganizer : viewerIsMember;
        return json({
          id: data.id,
          slug: data.slug,
          createdAt: data.created_at,
          title: data.title,
          description: data.description ?? '',
          createdByUsername: author?.username ?? 'unknown',
          isPrivate: !!data.is_private,
          audience: data.audience ?? (data.is_private ? 'invite_only' : 'public'),
          governance: data.governance ?? 'collaborative',
          homeCommunity,
          locationLabel: data.location_label ?? '',
          locationId: data.location_id,
          scheduledAt: data.scheduled_at,
          endsAt: data.ends_at,
          timeLabel: data.time_label ?? data.scheduled_at ?? '',
          voteCount: data.vote_count ?? 0,
          activeVote: await viewerActiveVote(db, userId, 'event', data.id),
          signalCount: eventLifecycle.phaseOne.signalSummary?.totalCount ?? 0,
          signalSummary: eventLifecycle.phaseOne.signalSummary,
          commentCount: data.comment_count ?? 0,
          memberCount: data.member_count ?? 0,
          lastActivityAt: data.last_activity_at,
          channelTags: tags.channelTags,
          communityTags: tags.communityTags,
          lifecycle: eventLifecycle,
          attendanceNote: '',
          agenda: [],
          updates: ((await db.from('event_updates').select('id, title, body, created_at, author_id, users!fk_event_updates_author_id_users(username)').eq('event_id', data.id).order('created_at', { ascending: false })).data ?? []).map((u) => {
            const updateAuthor = Array.isArray(u.users) ? u.users[0] : u.users;
            return {
              id: u.id,
              title: u.title,
              body: u.body,
              authorUsername: updateAuthor?.username ?? 'unknown',
              createdAt: u.created_at
            };
          }),
          updateRequests: await hydrateEventUpdateRequests(
            db,
            data.id,
            userId,
            Number(eventLifecycle.voteContextPopulation ?? data.member_count ?? 0)
          ),
          viewerCanRequestUpdate: Boolean(userId),
          viewerCanVoteOnUpdateRequests: Boolean(userId),
          editRequests: await hydrateEventEditRequests(
            db,
            data.id,
            userId,
            Number(eventLifecycle.voteContextPopulation ?? data.member_count ?? 0)
          ),
          viewerCanRequestEdit: Boolean(userId),
          viewerCanVoteOnEditRequests: Boolean(userId),
          linksFrame: await buildLinksFrame(db, 'event', data, viewerIsMember, userId),
          history: await hydrateEventHistory(
            db,
            data.id,
            userId,
            Number(eventLifecycle.voteContextPopulation ?? data.member_count ?? 0),
            viewerIsMember,
            String(data.governance) === 'organizer_controlled'
          ),
          attendees: [],
          invitedUsernames,
          eventEditors,
          members,
          viewerIsMember,
          viewerIsOrganizer,
          viewerCanToggleMembership: Boolean(userId) && String(data.governance) !== 'organizer_controlled',
          viewerHasEventEditAccess,
          viewerCanManageEditors: viewerIsOrganizer,
          viewerCanShare: Boolean(userId),
          availableEditorInvitees: [],
          shareContacts: [],
          report: eventModeration.report,
          isRemovedByReport: eventModeration.isRemovedByReport,
          hasActiveReport: eventModeration.hasActiveReport,
          isUnderReview: eventModeration.isUnderReview,
          moderationState: eventModeration.moderationState,
          discussionNote: '',
          discussion: comments
        });
      }
    }

    if (req.method === 'POST' && path === '/events') {
      if (!userId) return error('unauthorized', 401);
      const body = await readJson();
      try {
        return json(await mutations.createEvent(db, userId, body, persistBodyTags));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'invalid_audience' || msg === 'invalid_governance' || msg === 'public_must_be_collaborative') {
          return error(msg, 422);
        }
        if (msg === 'home_community_required' || msg === 'unknown_community') return error(msg, 422);
        if (msg.startsWith('unknown_username:')) return error(msg, 422);
        if (msg === 'organizer_requires_plan_stages' || msg === 'organizer_requires_schedule') {
          return error(msg, 422);
        }
        if (msg === 'forbidden') return error('forbidden', 403);
        if (err instanceof TagError) return error(err.message, 422);
        throw err;
      }
    }

    if (req.method === 'GET' && path.startsWith('/help-requests/')) {
      const id = decodeURIComponent(path.slice('/help-requests/'.length).split('/')[0]);
      const { data } = await db
        .from('help_requests')
        .select('*, users!fk_help_requests_author_id_users(username)')
        .eq('id', id)
        .maybeSingle();
      if (!data) return error('not_found', 404);
      if (!(await canViewEntity(db, userId, 'help_request', data.id))) return error('not_found', 404);
      const author = Array.isArray(data.users) ? data.users[0] : data.users;
      const { data: roles } = await db
        .from('help_request_roles')
        .select('*, help_request_role_assignments(user_id)')
        .eq('help_request_id', id);
      const tags = await loadEntityTags(db, 'help_request', data.id);
      const comments = await handleGetComments(db, userId, 'help_request', data.id);
      const helpReport = await loadActiveReport(db, 'help_request', data.id, userId);
      const helpModeration = moderationFieldsFromRow(data, helpReport);
      return json({
        id: data.id,
        createdAt: data.created_at,
        title: data.title,
        body: data.body ?? '',
        authorUsername: author?.username ?? 'unknown',
        locationLabel: data.location_label ?? '',
        scheduleLabel: data.schedule_label ?? '',
        neededAt: data.needed_at,
        endsAt: data.ends_at,
        channelTags: tags.channelTags,
        communityTags: tags.communityTags,
        voteCount: data.vote_count ?? 0,
        activeVote: await viewerActiveVote(db, userId, 'help_request', data.id),
        commentCount: data.comment_count ?? 0,
        roles: (roles ?? []).map((role) => ({
          roleId: role.id,
          title: role.title,
          description: role.description ?? '',
          slots: role.slots,
          filledCount: (role.help_request_role_assignments ?? []).length,
          isViewerAssigned: (role.help_request_role_assignments ?? []).some(
            (a: { user_id: string }) => a.user_id === userId
          )
        })),
        report: helpModeration.report,
        isRemovedByReport: helpModeration.isRemovedByReport,
        hasActiveReport: helpModeration.hasActiveReport,
        isUnderReview: helpModeration.isUnderReview,
        moderationState: helpModeration.moderationState,
        discussionNote: '',
        discussion: comments
      });
    }

    if (req.method === 'POST' && path === '/help-requests') {
      if (!userId) return error('unauthorized', 401);
      const body = await readJson();
      const neededAt = body.neededAt ?? body.needed_at ?? new Date().toISOString();
      const { data, error: insertError } = await db
        .from('help_requests')
        .insert({
          title: body.title,
          body: body.body ?? '',
          author_id: userId,
          location_label: body.locationLabel ?? body.location_label ?? '',
          location_id: body.locationId ?? body.location_id ?? null,
          schedule_label: body.scheduleLabel ?? body.schedule_label ?? '',
          needed_at: neededAt,
          ends_at: body.endsAt ?? body.ends_at ?? null,
          last_activity_at: new Date().toISOString()
        })
        .select('id')
        .single();
      if (insertError) throw insertError;
      await persistBodyTags(db, userId, 'help_request', data.id, body, { requireAny: true });

      const roleInputs = Array.isArray(body.roles) ? body.roles : [];
      if (roleInputs.length > 0) {
        const { error: rolesError } = await db.from('help_request_roles').insert(
          roleInputs.map(
            (
              role: { title?: string; description?: string; slots?: number },
              index: number
            ) => ({
              help_request_id: data.id,
              title: role.title ?? `Role ${index + 1}`,
              description: role.description ?? '',
              slots: Number(role.slots ?? 1),
              sort_order: index
            })
          )
        );
        if (rolesError) throw rolesError;
      }

      await recordMeaningfulAction(db, userId, 'create-help-request', { help_request_id: data.id });
      return json({ ok: true, id: data.id });
    }

    // Locations
    if (req.method === 'GET' && path === '/locations/search') {
      const q = (url.searchParams.get('q') ?? '').trim();
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 8), 1), 10);
      const { data } = await db
        .from('locations')
        .select('*')
        .ilike('display_label', `%${q}%`)
        .limit(limit);
      const localItems = (data ?? []).map((row) => ({
        id: row.id,
        providerPlaceId: row.provider_place_id,
        displayLabel: row.display_label,
        latitude: row.latitude,
        longitude: row.longitude,
        region: row.region,
        country: row.country,
        precision: row.precision,
        isOnline: row.is_online
      }));
      // Prefer local DB hits, then fill from Nominatim so typeahead works on a fresh DB.
      const remaining = Math.max(limit - localItems.length, 0);
      let externalItems: Awaited<ReturnType<typeof searchPlacesExternal>> = [];
      if (remaining > 0 && q.length >= 2) {
        externalItems = await searchPlacesExternal(q, remaining + 2);
      }
      const seen = new Set(
        localItems
          .map((item) => (item.providerPlaceId || item.displayLabel || '').toLowerCase())
          .filter(Boolean)
      );
      const merged = [...localItems];
      for (const item of externalItems) {
        const key = (item.providerPlaceId || item.displayLabel || '').toLowerCase();
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        merged.push(item);
        if (merged.length >= limit) break;
      }
      return json({ items: merged });
    }
    if (req.method === 'POST' && path === '/locations') {
      const body = await readJson();
      const { data, error: insertError } = await db
        .from('locations')
        .insert({
          provider_place_id: body.providerPlaceId ?? null,
          display_label: body.displayLabel,
          latitude: body.latitude ?? null,
          longitude: body.longitude ?? null,
          region: body.region ?? null,
          country: body.country ?? null,
          precision: body.precision ?? 'approximate',
          is_online: !!body.isOnline
        })
        .select('*')
        .single();
      if (insertError) throw insertError;
      return json({
        id: data.id,
        providerPlaceId: data.provider_place_id,
        displayLabel: data.display_label,
        latitude: data.latitude,
        longitude: data.longitude,
        region: data.region,
        country: data.country,
        precision: data.precision,
        isOnline: data.is_online
      });
    }
    if (req.method === 'GET' && path === '/locations/ip-hint') {
      const hint = await ipLocationHintExternal(clientIpFromRequest(req));
      if (!hint) {
        return error('ip_location_unavailable', 422);
      }
      return json({ items: [hint] });
    }
    if (req.method === 'GET' && path === '/locations/reverse') {
      const lat = Number(url.searchParams.get('lat'));
      const lon = Number(url.searchParams.get('lon'));
      const { data } = await db
        .from('locations')
        .select('*')
        .not('latitude', 'is', null)
        .not('longitude', 'is', null)
        .limit(50);
      const scored = (data ?? [])
        .map((row) => {
          const dlat = Number(row.latitude) - lat;
          const dlon = Number(row.longitude) - lon;
          return { row, dist: dlat * dlat + dlon * dlon };
        })
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 5)
        .map(({ row }) => ({
          id: row.id,
          providerPlaceId: row.provider_place_id,
          displayLabel: row.display_label,
          latitude: row.latitude,
          longitude: row.longitude,
          region: row.region,
          country: row.country,
          precision: row.precision,
          isOnline: row.is_online
        }));
      if (scored.length > 0) {
        return json({ items: scored, ...(scored[0] ?? {}) });
      }
      // Fresh DB / no nearby rows: ask Nominatim so attach-from-map still works.
      const external = await reverseGeocodeExternal(lat, lon);
      if (external) {
        return json({ items: [external], ...external });
      }
      return json({ items: [] });
    }
    if (
      req.method === 'GET' &&
      path.startsWith('/locations/') &&
      path !== '/locations/search' &&
      path !== '/locations/reverse' &&
      path !== '/locations/ip-hint'
    ) {
      const id = path.slice('/locations/'.length);
      const { data } = await db.from('locations').select('*').eq('id', id).maybeSingle();
      if (!data) return error('not_found', 404);
      return json({
        id: data.id,
        providerPlaceId: data.provider_place_id,
        displayLabel: data.display_label,
        latitude: data.latitude,
        longitude: data.longitude,
        region: data.region,
        country: data.country,
        precision: data.precision,
        isOnline: data.is_online
      });
    }

    // Onboarding — AppAdapter shape (matches FastAPI bootstrap/onboarding)
    if (req.method === 'GET' && path === '/onboarding') {
      return json({
        title: 'Sign in or create an account',
        intro: 'Sign in to post, follow people, and create projects, threads, and events.',
        accountModes: [
          {
            value: 'signup',
            label: 'Sign up',
            description: 'Create a new account.'
          },
          {
            value: 'login',
            label: 'Log in',
            description: 'Use an existing account.'
          }
        ],
        starterChannels: [],
        starterCommunities: []
      });
    }

    // Mutation router for project/event/help/scope/message lifecycle
    if (req.method !== 'GET') {
      if (!userId) return error('unauthorized', 401);
      const body = await readJson();

      if (req.method === 'POST' && path.match(/^\/users\/[^/]+\/follow\/accept$/)) {
        const username = decodeURIComponent(path.split('/')[2]);
        return json(await mutations.acceptFollowRequest(db, userId, username));
      }
      if (req.method === 'POST' && path.match(/^\/users\/[^/]+\/follow\/reject$/)) {
        const username = decodeURIComponent(path.split('/')[2]);
        return json(await mutations.rejectFollowRequest(db, userId, username));
      }

      if (req.method === 'POST' && path === '/scopes/invites') {
        return json(await mutations.createScopeInvite(db, userId, body.kind, body.slug));
      }
      if (req.method === 'POST' && path === '/scopes/invites/redeem') {
        return json(await mutations.redeemScopeInvite(db, userId, body.kind, body.slug, body.inviteValue));
      }
      if (req.method === 'POST' && path === '/scopes/channels') {
        return json(await mutations.createChannel(db, userId, body));
      }
      if (req.method === 'POST' && path === '/scopes/communities') {
        return json(await mutations.createCommunity(db, userId, body));
      }
      if (req.method === 'POST' && path.match(/^\/scopes\/communities\/[^/]+\/invite$/)) {
        const slug = decodeURIComponent(path.split('/')[3]);
        return json(await mutations.inviteUserToCommunity(db, userId, slug, body.username));
      }
      if (req.method === 'POST' && path === '/scopes/platform/volunteer') {
        return json(await board.volunteerForBoard(db, userId));
      }
      if (req.method === 'POST' && path === '/scopes/platform/volunteer/remove') {
        return json(await board.removeBoardVolunteer(db, userId));
      }
      if (req.method === 'POST' && path === '/scopes/platform/moderator-vote') {
        return json(
          await board.castBoardModeratorVote(
            db,
            userId,
            body.targetUserId ?? body.target_user_id,
            body.vote
          )
        );
      }

      if (req.method === 'POST' && path === '/messages/groups') {
        return json(await mutations.createGroupConversation(db, userId, body));
      }
      if (req.method === 'POST' && path.match(/^\/messages\/conversations\/[^/]+\/rename$/)) {
        const id = path.split('/')[3];
        return json(await mutations.renameGroupConversation(db, userId, id, body.title));
      }
      if (req.method === 'POST' && path.match(/^\/messages\/conversations\/[^/]+\/members$/)) {
        const id = path.split('/')[3];
        return json(await mutations.addGroupMember(db, userId, id, body.username));
      }
      if (req.method === 'POST' && path.match(/^\/messages\/conversations\/[^/]+\/members\/remove$/)) {
        const id = path.split('/')[3];
        return json(await mutations.removeGroupMember(db, userId, id, body.username));
      }
      if (req.method === 'POST' && path === '/messages/linked-chats/read') {
        return json(await mutations.markLinkedChatRead(db, userId, body.subjectType, body.subjectId));
      }

      if (req.method === 'POST' && path.match(/^\/help-requests\/[^/]+\/roles\/[^/]+\/commit$/)) {
        const parts = path.split('/');
        return json(await mutations.commitHelpRole(db, userId, parts[2], parts[4], true));
      }
      if (req.method === 'POST' && path.match(/^\/help-requests\/[^/]+\/roles\/[^/]+\/uncommit$/)) {
        const parts = path.split('/');
        return json(await mutations.commitHelpRole(db, userId, parts[2], parts[4], false));
      }

      const projectMatch = path.match(/^\/projects\/([^/]+)\/(.+)$/);
      if (req.method === 'POST' && projectMatch) {
        const slug = decodeURIComponent(projectMatch[1]);
        const action = projectMatch[2];
        if (action === 'membership') return json(await mutations.toggleProjectMembership(db, userId, slug));
        if (action === 'demand-signal') return json(await mutations.setProjectSignal(db, userId, slug, 'demand'));
        if (action === 'signal') return json(await mutations.setProjectSignal(db, userId, slug, body.signal ?? null));
        if (action === 'values') return json(await mutations.addProjectValue(db, userId, slug, body.label));
        if (action === 'updates') return json(await mutations.addProjectUpdate(db, userId, slug, body.title, body.body));
        if (action === 'details') return json(await mutations.updateProjectDetails(db, userId, slug, body.title, body.description));
        if (action === 'phase-change') return json(await mutations.requestProjectPhaseChange(db, userId, slug, body));
        if (action === 'phase/advance') return json(await mutations.advanceProjectPhase(db, userId, slug, body.closeNote));
        if (action === 'phase/revert') return json(await mutations.requestProjectPhaseRevert(db, userId, slug, body));
        if (action === 'production-plans') return json(await mutations.addProjectProductionPlan(db, userId, slug, body));
        if (action === 'distribution-plans') return json(await mutations.addProjectProductionPlan(db, userId, slug, { ...body, phase: 'distribution' }));
        if (action === 'share') return json(await mutations.shareEntityWithUser(db, userId, 'project', slug, body.username));
        if (action === 'values/importance') {
          return json(
            await lifecycle.voteProjectValueImportance(db, userId, slug, body.valueId, body.importance)
          );
        }
        if (action === 'update-requests') {
          const project = (
            await db.from('projects').select('id, member_count').eq('slug', slug).maybeSingle()
          ).data;
          if (!project) return error('not_found', 404);
          const population = Number(project.member_count ?? 1);
          if (population <= 1) {
            await db.from('project_updates').insert({
              project_id: project.id,
              title: 'Update',
              body: body.body ?? '',
              author_id: userId
            });
            await db
              .from('projects')
              .update({ last_activity_at: new Date().toISOString() })
              .eq('id', project.id);
            return json({ ok: true, autoApproved: true });
          }
          await db
            .from('project_update_requests')
            .insert({ project_id: project.id, body: body.body, author_id: userId });
          return json({ ok: true });
        }
        if (action === 'edit-requests') {
          const project = (await db.from('projects').select('id').eq('slug', slug).maybeSingle()).data;
          if (!project) return error('not_found', 404);
          await db.from('project_edit_requests').insert({ project_id: project.id, title: body.title, description: body.description, author_id: userId });
          return json({ ok: true });
        }
        if (action === 'activities') {
          const project = (await db.from('projects').select('id').eq('slug', slug).maybeSingle()).data;
          if (!project) return error('not_found', 404);
          const now = new Date();
          const scheduledAt = body.scheduledAt ?? now.toISOString();
          const endsAt = body.endsAt ?? new Date(now.getTime() + 3600000).toISOString();
          const { data: activity, error: activityErr } = await db
            .from('project_activities')
            .insert({
              project_id: project.id,
              title: body.title ?? 'Activity',
              author_id: userId,
              scheduled_at: scheduledAt,
              ends_at: endsAt,
              location_label: body.locationLabel ?? '',
              location_id: body.locationId ?? null,
              note: body.description ?? body.note ?? '',
              is_online: Boolean(body.isOnline),
              linked_plan_id: body.linkedPlanId ?? null,
              linked_plan_phase_id: body.linkedPlanPhaseId ?? body.linked_plan_phase_id ?? null
            })
            .select('id')
            .single();
          if (activityErr) throw activityErr;
          const roles = (body.roleRequirements ?? body.roles ?? []) as Array<Record<string, unknown>>;
          if (roles.length) {
            await db.from('project_activity_roles').insert(
              roles.map((role) => ({
                activity_id: activity.id,
                label: role.label ?? role.title ?? 'Role',
                required_count: Number(role.requiredCount ?? role.slots ?? 1),
                maximum_count: role.maximumCount ?? role.maximum_count ?? null
              }))
            );
          }
          return json({ ok: true, id: activity.id });
        }

        // Action-style aliases used by the Supabase AppAdapter / frontend driver
        if (action === 'plans/overall-vote') {
          return json(await lifecycle.castProjectPlanVote(db, userId, slug, body.planId, body.vote));
        }
        if (action === 'plans/value-vote') {
          return json(
            await lifecycle.castProjectPlanValueVote(
              db,
              userId,
              slug,
              body.planId,
              body.valueId,
              body.vote
            )
          );
        }
        if (action === 'plans/criterion-rating') {
          return json(
            await lifecycle.castProjectPlanCriterionRating(
              db,
              userId,
              slug,
              body.planId,
              body.criterionId,
              body.rating
            )
          );
        }
        if (action === 'phase-change/vote') {
          return json(await lifecycle.voteProjectPhaseChange(db, userId, slug, body.requestId, body.vote));
        }
        if (action === 'update-requests/vote') {
          return json(await lifecycle.voteProjectUpdateRequest(db, userId, slug, body.requestId, body.vote));
        }
        if (action === 'edit-requests/vote') {
          return json(await lifecycle.voteProjectEditRequest(db, userId, slug, body.requestId, body.vote));
        }
        if (action === 'manual-links/vote') {
          return json(
            await lifecycle.voteDetailLinkRequest(
              db,
              userId,
              body.requestId,
              body.vote,
              body.voteScope === 'target' ? 'target' : 'source'
            )
          );
        }
        if (action === 'activities/commitment') {
          const commit = body.roleLabel != null && body.roleLabel !== '';
          return json(
            await lifecycle.commitActivityRoleByLabel(
              db,
              userId,
              'project',
              body.activityId,
              commit ? body.roleLabel : null,
              commit
            )
          );
        }
        if (action === 'activities/rating') {
          return json(await lifecycle.upsertActivityRating(db, userId, 'project', body.activityId, body.rating));
        }
        if (action === 'activities/rating/delete') {
          await db
            .from('project_activity_ratings')
            .delete()
            .eq('activity_id', body.activityId)
            .eq('user_id', userId);
          return json({ ok: true });
        }
        if (action === 'pull-requests') {
          return json(await lifecycle.submitPullRequest(db, userId, slug, body));
        }
        if (action === 'pull-requests/vote') {
          return json(await lifecycle.votePullRequest(db, userId, slug, body.decisionId, body.vote));
        }
        if (action === 'pull-requests/merge') {
          return json(await lifecycle.recordPullRequestMerge(db, userId, slug, body.requestId, body));
        }
        if (action === 'service-requests/plan') {
          return json(await lifecycle.planServiceRequest(db, userId, slug, body.requestId, body));
        }
        if (action === 'service-requests/status') {
          await db
            .from('project_service_requests')
            .update({ status: body.status })
            .eq('id', body.requestId);
          return json({ ok: true });
        }
        if (action === 'manual-links/sever') {
          return json(
            await lifecycle.createDetailLinkSeverRequest(
              db,
              userId,
              'project',
              slug,
              String(body.linkId ?? body.link_id ?? ''),
              body.summary ?? body.note
            )
          );
        }
        if (action === 'service-requests/settings-change') {
          return json(await lifecycle.createSettingsChangeRequest(db, userId, slug, body));
        }
        if (action === 'service-requests/settings-change/vote') {
          return json(
            await lifecycle.voteSettingsChangeRequest(
              db,
              userId,
              slug,
              String(body.requestId ?? body.request_id ?? ''),
              body.vote
            )
          );
        }
        if (action === 'service-history/completion') {
          return json(await lifecycle.toggleServiceHistoryCompletion(db, userId, slug, body));
        }
        if (action === 'merge-capability') {
          try {
            return json(await lifecycle.requestMergeCapabilityChange(db, userId, slug, body));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg === 'not_found') return error('not_found', 404);
            if (msg === 'invalid_target') return error(msg, 422);
            throw err;
          }
        }
        if (action === 'merge-capability/vote') {
          try {
            return json(
              await lifecycle.voteMergeCapabilityChange(db, userId, slug, body.requestId, body.vote)
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg === 'not_found') return error('not_found', 404);
            throw err;
          }
        }
        if (action === 'repository-replacement') {
          try {
            return json(await lifecycle.requestRepositoryReplacement(db, userId, slug, body));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg === 'not_found') return error('not_found', 404);
            if (msg === 'invalid_request') return error(msg, 422);
            throw err;
          }
        }
        if (action === 'repository-replacement/vote') {
          try {
            return json(
              await lifecycle.voteRepositoryReplacement(db, userId, slug, body.requestId, body.vote)
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg === 'not_found') return error('not_found', 404);
            throw err;
          }
        }

        const planVote = action.match(/^plans\/([^/]+)\/vote$/);
        if (planVote) return json(await lifecycle.castProjectPlanVote(db, userId, slug, planVote[1], body.vote));
        const phaseVote = action.match(/^phase-requests\/([^/]+)\/vote$/);
        if (phaseVote) return json(await lifecycle.voteProjectPhaseChange(db, userId, slug, phaseVote[1], body.vote));
        const updateVote = action.match(/^update-requests\/([^/]+)\/vote$/);
        if (updateVote) return json(await lifecycle.voteProjectUpdateRequest(db, userId, slug, updateVote[1], body.vote));
        const editVote = action.match(/^edit-requests\/([^/]+)\/vote$/);
        if (editVote) return json(await lifecycle.voteProjectEditRequest(db, userId, slug, editVote[1], body.vote));
        if (action === 'manual-links') return json(await lifecycle.createDetailLinkRequest(db, userId, 'project', slug, body));
        const linkVote = action.match(/^manual-links\/([^/]+)\/vote$/);
        if (linkVote) {
          return json(
            await lifecycle.voteDetailLinkRequest(
              db,
              userId,
              linkVote[1],
              body.vote,
              body.voteScope === 'target' ? 'target' : 'source'
            )
          );
        }
        if (action === 'service-requests') return json(await lifecycle.createServiceRequest(db, userId, slug, body));
        const servicePlan = action.match(/^service-requests\/([^/]+)\/plan$/);
        if (servicePlan) return json(await lifecycle.planServiceRequest(db, userId, slug, servicePlan[1], body));
        if (action === 'software/pull-requests') return json(await lifecycle.submitPullRequest(db, userId, slug, body));
        const prVote = action.match(/^software\/pull-requests\/([^/]+)\/vote$/);
        if (prVote) return json(await lifecycle.votePullRequest(db, userId, slug, prVote[1], body.vote));
        const prMerge = action.match(/^software\/pull-requests\/([^/]+)\/merge$/);
        if (prMerge) return json(await lifecycle.recordPullRequestMerge(db, userId, slug, prMerge[1], body));
        const activityRating = action.match(/^activities\/([^/]+)\/rating$/);
        if (activityRating) {
          return json(await lifecycle.upsertActivityRating(db, userId, 'project', activityRating[1], body.rating));
        }
        const activityCommit = action.match(/^activities\/([^/]+)\/roles\/([^/]+)\/commit$/);
        if (activityCommit) {
          return json(
            await lifecycle.commitActivityRole(db, userId, 'project', activityCommit[1], activityCommit[2], true)
          );
        }
        const activityUncommit = action.match(/^activities\/([^/]+)\/roles\/([^/]+)\/uncommit$/);
        if (activityUncommit) {
          return json(
            await lifecycle.commitActivityRole(db, userId, 'project', activityUncommit[1], activityUncommit[2], false)
          );
        }
      }

      const eventMatch = path.match(/^\/events\/([^/]+)\/(.+)$/);
      if (req.method === 'POST' && eventMatch) {
        const slug = decodeURIComponent(eventMatch[1]);
        const action = eventMatch[2];
        if (action === 'membership') return json(await mutations.toggleEventMembership(db, userId, slug));
        if (action === 'signal') return json(await mutations.setEventSignal(db, userId, slug, body.signal ?? null));
        if (action === 'values') return json(await mutations.addEventValue(db, userId, slug, body.label));
        if (action === 'plans') return json(await mutations.addEventPlan(db, userId, slug, body));
        if (action === 'share') return json(await mutations.shareEntityWithUser(db, userId, 'event', slug, body.username));
        if (action === 'phase-change') {
          try {
            return json(await mutations.requestEventPhaseChange(db, userId, slug, body));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg === 'not_found') return error('not_found', 404);
            if (msg === 'conflict') return error('A vote is already open — approve or reject it first.', 409);
            if (msg === 'invalid_phase') return error('invalid_phase', 422);
            throw err;
          }
        }
        if (action === 'update-requests') return json(await lifecycle.createEventUpdateRequest(db, userId, slug, body));
        if (action === 'updates') {
          try {
            return json(
              await mutations.addEventUpdate(
                db,
                userId,
                slug,
                String(body.title ?? 'Update'),
                String(body.body ?? '')
              )
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg === 'not_found') return error('not_found', 404);
            throw err;
          }
        }
        if (action === 'edit-requests') return json(await lifecycle.createEventEditRequest(db, userId, slug, body));
        if (action === 'activities') {
          const event = (await db.from('events').select('id').eq('slug', slug).maybeSingle()).data;
          if (!event) return error('not_found', 404);
          const now = new Date();
          const scheduledAt = body.scheduledAt ?? now.toISOString();
          const endsAt = body.endsAt ?? new Date(now.getTime() + 3600000).toISOString();
          const { data: activity, error: activityErr } = await db
            .from('event_activities')
            .insert({
              event_id: event.id,
              title: body.title ?? 'Activity',
              author_id: userId,
              scheduled_at: scheduledAt,
              ends_at: endsAt,
              location_label: body.locationLabel ?? '',
              location_id: body.locationId ?? null,
              note: body.description ?? body.note ?? '',
              is_online: Boolean(body.isOnline),
              linked_plan_id: body.linkedPlanId ?? null,
              linked_plan_phase_id: body.linkedPlanPhaseId ?? body.linked_plan_phase_id ?? null
            })
            .select('id')
            .single();
          if (activityErr) throw activityErr;
          const roles = (body.roleRequirements ?? body.roles ?? []) as Array<Record<string, unknown>>;
          if (roles.length) {
            await db.from('event_activity_roles').insert(
              roles.map((role) => ({
                activity_id: activity.id,
                label: role.label ?? role.title ?? 'Role',
                required_count: Number(role.requiredCount ?? role.slots ?? 1),
                maximum_count: role.maximumCount ?? role.maximum_count ?? null
              }))
            );
          }
          return json({ ok: true, id: activity.id });
        }
        if (action === 'edit-access/grant' || action === 'edit-access/revoke') {
          const event = (await db.from('events').select('id').eq('slug', slug).maybeSingle()).data;
          if (!event) return error('not_found', 404);
          if (action.endsWith('grant')) {
            await db.from('event_editors').upsert({ event_id: event.id, user_id: body.userId, granted_by: userId, granted_at: new Date().toISOString() });
          } else {
            await db.from('event_editors').delete().eq('event_id', event.id).eq('user_id', body.userId);
          }
          return json({ ok: true });
        }

        // Action-style aliases used by the Supabase AppAdapter / frontend driver
        if (action === 'values/importance') {
          return json(
            await lifecycle.voteEventValueImportance(db, userId, slug, body.valueId, body.importance)
          );
        }
        if (action === 'plans/overall-vote') {
          return json(await lifecycle.castEventPlanVote(db, userId, slug, body.planId, body.vote));
        }
        if (action === 'plans/value-vote') {
          return json(
            await lifecycle.castEventPlanValueVote(
              db,
              userId,
              slug,
              body.planId,
              body.valueId,
              body.vote
            )
          );
        }
        if (action === 'plans/criterion-rating') {
          return json(
            await lifecycle.castEventPlanCriterionRating(
              db,
              userId,
              slug,
              body.planId,
              body.criterionId,
              body.rating
            )
          );
        }
        if (action === 'phase-change/vote') {
          return json(await lifecycle.voteEventPhaseChange(db, userId, slug, body.requestId, body.vote));
        }
        if (action === 'update-requests/vote') {
          return json(await lifecycle.voteEventUpdateRequest(db, userId, slug, body.requestId, body.vote));
        }
        if (action === 'edit-requests/vote') {
          return json(await lifecycle.voteEventEditRequest(db, userId, slug, body.requestId, body.vote));
        }
        if (action === 'manual-links/vote') {
          return json(
            await lifecycle.voteDetailLinkRequest(
              db,
              userId,
              body.requestId,
              body.vote,
              body.voteScope === 'target' ? 'target' : 'source'
            )
          );
        }
        if (action === 'activities/commitment') {
          const commit = body.roleLabel != null && body.roleLabel !== '';
          return json(
            await lifecycle.commitActivityRoleByLabel(
              db,
              userId,
              'event',
              body.activityId,
              commit ? body.roleLabel : null,
              commit
            )
          );
        }
        if (action === 'activities/rating') {
          return json(await lifecycle.upsertActivityRating(db, userId, 'event', body.activityId, body.rating));
        }
        if (action === 'activities/rating/delete') {
          await db
            .from('event_activity_ratings')
            .delete()
            .eq('activity_id', body.activityId)
            .eq('user_id', userId);
          return json({ ok: true });
        }
        if (action === 'history/completion') {
          return json(await lifecycle.toggleEventHistoryCompletion(db, userId, slug, body));
        }
        if (action === 'manual-links/sever') {
          return json(
            await lifecycle.createDetailLinkSeverRequest(
              db,
              userId,
              'event',
              slug,
              String(body.linkId ?? body.link_id ?? ''),
              body.summary ?? body.note
            )
          );
        }

        const planVote = action.match(/^plans\/([^/]+)\/vote$/);
        if (planVote) return json(await lifecycle.castEventPlanVote(db, userId, slug, planVote[1], body.vote));
        const phaseVote = action.match(/^phase-requests\/([^/]+)\/vote$/);
        if (phaseVote) return json(await lifecycle.voteEventPhaseChange(db, userId, slug, phaseVote[1], body.vote));
        const updateVote = action.match(/^update-requests\/([^/]+)\/vote$/);
        if (updateVote) return json(await lifecycle.voteEventUpdateRequest(db, userId, slug, updateVote[1], body.vote));
        const editVote = action.match(/^edit-requests\/([^/]+)\/vote$/);
        if (editVote) return json(await lifecycle.voteEventEditRequest(db, userId, slug, editVote[1], body.vote));
        if (action === 'manual-links') return json(await lifecycle.createDetailLinkRequest(db, userId, 'event', slug, body));
        const linkVote = action.match(/^manual-links\/([^/]+)\/vote$/);
        if (linkVote) {
          return json(
            await lifecycle.voteDetailLinkRequest(
              db,
              userId,
              linkVote[1],
              body.vote,
              body.voteScope === 'target' ? 'target' : 'source'
            )
          );
        }
        const activityRating = action.match(/^activities\/([^/]+)\/rating$/);
        if (activityRating) {
          return json(await lifecycle.upsertActivityRating(db, userId, 'event', activityRating[1], body.rating));
        }
        const activityCommit = action.match(/^activities\/([^/]+)\/roles\/([^/]+)\/commit$/);
        if (activityCommit) {
          return json(
            await lifecycle.commitActivityRole(db, userId, 'event', activityCommit[1], activityCommit[2], true)
          );
        }
        const activityUncommit = action.match(/^activities\/([^/]+)\/roles\/([^/]+)\/uncommit$/);
        if (activityUncommit) {
          return json(
            await lifecycle.commitActivityRole(db, userId, 'event', activityUncommit[1], activityUncommit[2], false)
          );
        }
      }

      return error(`unhandled_mutation:${req.method}:${path}`, 501);
    }

    return error(`unhandled_route:${req.method}:${path}`, 404);
  } catch (err) {
    console.error(err);
    if (err instanceof TagError) {
      return error(err.message, err.status);
    }
    const message = err instanceof Error ? err.message : 'internal_error';
    if (message === 'not_found' || message === 'invalid_invite' || message === 'invite_exhausted') {
      return error(message, 404);
    }
    if (message === 'forbidden' || message === 'direct_invite_closed_only' || message === 'username_required' || message === 'invalid_vote' || message === 'role_full') {
      return error(message, message === 'forbidden' || message === 'role_full' ? 403 : 422);
    }
    if (message === 'cannot_follow_self') {
      return error(message, 400);
    }
    return error(message, 500);
  }
});
