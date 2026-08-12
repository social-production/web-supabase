-- One indexed candidate pass for all feed surfaces. Hydration remains batched in
-- the edge function, while access and source selection happen once in SQL.

CREATE INDEX IF NOT EXISTS ix_threads_feed_recent
  ON public.threads (last_activity_at DESC, id);
CREATE INDEX IF NOT EXISTS ix_projects_feed_recent
  ON public.projects (last_activity_at DESC, id);
CREATE INDEX IF NOT EXISTS ix_events_feed_recent
  ON public.events (last_activity_at DESC, id);
CREATE INDEX IF NOT EXISTS ix_help_requests_feed_recent
  ON public.help_requests (created_at DESC, id);
CREATE INDEX IF NOT EXISTS ix_posts_author_recent
  ON public.posts (author_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS ix_comments_author_recent
  ON public.comments (author_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS ix_project_updates_latest
  ON public.project_updates (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_event_updates_latest
  ON public.event_updates (event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_user_follows_feed
  ON public.user_follows (follower_id, status, followed_id);
CREATE INDEX IF NOT EXISTS ix_notifications_unread_recipient
  ON public.notifications (recipient_id, created_at DESC)
  WHERE is_unread = true;
CREATE INDEX IF NOT EXISTS ix_reports_target_active
  ON public.reports (target_type, target_id)
  WHERE resolution = 'open';
CREATE INDEX IF NOT EXISTS ix_thread_tags_channel_scope
  ON public.thread_tags (channel_id, thread_id) WHERE channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_thread_tags_community_scope
  ON public.thread_tags (community_id, thread_id) WHERE community_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_project_tags_channel_scope
  ON public.project_tags (channel_id, project_id) WHERE channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_project_tags_community_scope
  ON public.project_tags (community_id, project_id) WHERE community_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_event_tags_channel_scope
  ON public.event_tags (channel_id, event_id) WHERE channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_event_tags_community_scope
  ON public.event_tags (community_id, event_id) WHERE community_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_help_request_tags_channel_scope
  ON public.help_request_tags (channel_id, help_request_id) WHERE channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_help_request_tags_community_scope
  ON public.help_request_tags (community_id, help_request_id) WHERE community_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.get_feed_candidates(
  p_user_id uuid DEFAULT NULL,
  p_filter text DEFAULT 'all',
  p_author_id uuid DEFAULT NULL,
  p_author_ids uuid[] DEFAULT NULL,
  p_include_discovery boolean DEFAULT false,
  p_scope_kind text DEFAULT NULL,
  p_scope_id uuid DEFAULT NULL,
  p_include_private_events boolean DEFAULT false,
  p_include_comment_activity boolean DEFAULT false,
  p_before timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 100
)
RETURNS TABLE (
  entity_type text,
  entity_id uuid,
  sort_at timestamptz,
  feed_source text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH viewer_communities AS (
    SELECT sm.scope_id
    FROM scope_memberships sm
    WHERE sm.user_id = p_user_id
      AND sm.scope_kind = 'community'
  ),
  candidates AS (
    SELECT
      'thread'::text AS entity_type,
      t.id AS entity_id,
      t.last_activity_at AS sort_at,
      CASE WHEN t.author_id = ANY(COALESCE(p_author_ids, '{}'::uuid[]))
        THEN 'following'::text ELSE 'discovery'::text END AS feed_source
    FROM threads t
    WHERE p_filter IN ('all', 'threads')
      AND t.moderation_state <> 'removed'
      AND (p_before IS NULL OR t.last_activity_at < p_before)
      AND (p_author_id IS NULL OR t.author_id = p_author_id)
      AND (p_author_ids IS NULL OR p_include_discovery OR t.author_id = ANY(p_author_ids))
      AND (
        p_scope_id IS NULL
        OR (p_scope_kind = 'channel' AND EXISTS (
          SELECT 1 FROM thread_tags st WHERE st.thread_id = t.id AND st.channel_id = p_scope_id
        ))
        OR (p_scope_kind = 'community' AND EXISTS (
          SELECT 1 FROM thread_tags st WHERE st.thread_id = t.id AND st.community_id = p_scope_id
        ))
      )
      AND (
        EXISTS (SELECT 1 FROM thread_tags st WHERE st.thread_id = t.id AND st.channel_id IS NOT NULL)
        OR EXISTS (
          SELECT 1 FROM thread_tags st JOIN communities c ON c.id = st.community_id
          WHERE st.thread_id = t.id AND c.join_policy <> 'closed'
        )
        OR NOT EXISTS (
          SELECT 1
          FROM thread_tags st
          JOIN communities c ON c.id = st.community_id AND c.join_policy = 'closed'
          WHERE st.thread_id = t.id
            AND NOT EXISTS (
              SELECT 1 FROM viewer_communities vc WHERE vc.scope_id = st.community_id
            )
        )
      )

    UNION ALL
    SELECT 'project', p.id, p.last_activity_at,
      CASE WHEN p.author_id = ANY(COALESCE(p_author_ids, '{}'::uuid[]))
        THEN 'following'::text ELSE 'discovery'::text END
    FROM projects p
    WHERE p_filter IN ('all', 'projects')
      AND p.moderation_state <> 'removed'
      AND NOT p.is_closed
      AND (p_before IS NULL OR p.last_activity_at < p_before)
      AND (p_author_id IS NULL OR p.author_id = p_author_id)
      AND (p_author_ids IS NULL OR p_include_discovery OR p.author_id = ANY(p_author_ids))
      AND (
        p_scope_id IS NULL
        OR (p_scope_kind = 'channel' AND EXISTS (
          SELECT 1 FROM project_tags st WHERE st.project_id = p.id AND st.channel_id = p_scope_id
        ))
        OR (p_scope_kind = 'community' AND EXISTS (
          SELECT 1 FROM project_tags st WHERE st.project_id = p.id AND st.community_id = p_scope_id
        ))
      )
      AND (
        EXISTS (SELECT 1 FROM project_tags st WHERE st.project_id = p.id AND st.channel_id IS NOT NULL)
        OR EXISTS (
          SELECT 1 FROM project_tags st JOIN communities c ON c.id = st.community_id
          WHERE st.project_id = p.id AND c.join_policy <> 'closed'
        )
        OR NOT EXISTS (
          SELECT 1
          FROM project_tags st
          JOIN communities c ON c.id = st.community_id AND c.join_policy = 'closed'
          WHERE st.project_id = p.id
            AND NOT EXISTS (
              SELECT 1 FROM viewer_communities vc WHERE vc.scope_id = st.community_id
            )
        )
      )

    UNION ALL
    SELECT 'event', e.id, e.last_activity_at,
      CASE WHEN e.created_by = ANY(COALESCE(p_author_ids, '{}'::uuid[]))
        THEN 'following'::text ELSE 'discovery'::text END
    FROM events e
    WHERE p_filter IN ('all', 'events')
      AND e.moderation_state <> 'removed'
      AND (p_before IS NULL OR e.last_activity_at < p_before)
      AND (p_author_id IS NULL OR e.created_by = p_author_id)
      AND (p_author_ids IS NULL OR p_include_discovery OR e.created_by = ANY(p_author_ids))
      AND (
        e.is_private = false
        OR (
          p_include_private_events
          AND p_user_id IS NOT NULL
          AND (
            e.created_by = p_user_id
            OR EXISTS (
              SELECT 1 FROM event_memberships em
              WHERE em.event_id = e.id AND em.user_id = p_user_id
            )
            OR (
              e.audience = 'private_community'
              AND e.home_community_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM scope_memberships sm
                WHERE sm.user_id = p_user_id
                  AND sm.scope_kind = 'community'
                  AND sm.scope_id = e.home_community_id
              )
            )
          )
        )
      )
      AND (
        p_scope_id IS NULL
        OR (p_scope_kind = 'channel' AND EXISTS (
          SELECT 1 FROM event_tags st WHERE st.event_id = e.id AND st.channel_id = p_scope_id
        ))
        OR (p_scope_kind = 'community' AND EXISTS (
          SELECT 1 FROM event_tags st WHERE st.event_id = e.id AND st.community_id = p_scope_id
        ))
      )
      AND (
        e.is_private
        OR EXISTS (SELECT 1 FROM event_tags st WHERE st.event_id = e.id AND st.channel_id IS NOT NULL)
        OR EXISTS (
          SELECT 1 FROM event_tags st JOIN communities c ON c.id = st.community_id
          WHERE st.event_id = e.id AND c.join_policy <> 'closed'
        )
        OR NOT EXISTS (
          SELECT 1
          FROM event_tags st
          JOIN communities c ON c.id = st.community_id AND c.join_policy = 'closed'
          WHERE st.event_id = e.id
            AND NOT EXISTS (
              SELECT 1 FROM viewer_communities vc WHERE vc.scope_id = st.community_id
            )
        )
      )

    UNION ALL
    SELECT 'help_request', h.id, h.created_at,
      CASE WHEN h.author_id = ANY(COALESCE(p_author_ids, '{}'::uuid[]))
        THEN 'following'::text ELSE 'discovery'::text END
    FROM help_requests h
    WHERE p_filter IN ('all', 'help_requests')
      AND h.moderation_state <> 'removed'
      AND (p_before IS NULL OR h.created_at < p_before)
      AND (p_author_id IS NULL OR h.author_id = p_author_id)
      AND (p_author_ids IS NULL OR p_include_discovery OR h.author_id = ANY(p_author_ids))
      AND (
        p_scope_id IS NULL
        OR (p_scope_kind = 'channel' AND EXISTS (
          SELECT 1 FROM help_request_tags st
          WHERE st.help_request_id = h.id AND st.channel_id = p_scope_id
        ))
        OR (p_scope_kind = 'community' AND EXISTS (
          SELECT 1 FROM help_request_tags st
          WHERE st.help_request_id = h.id AND st.community_id = p_scope_id
        ))
      )
      AND (
        EXISTS (
          SELECT 1 FROM help_request_tags st
          WHERE st.help_request_id = h.id AND st.channel_id IS NOT NULL
        )
        OR EXISTS (
          SELECT 1 FROM help_request_tags st JOIN communities c ON c.id = st.community_id
          WHERE st.help_request_id = h.id AND c.join_policy <> 'closed'
        )
        OR NOT EXISTS (
          SELECT 1
          FROM help_request_tags st
          JOIN communities c ON c.id = st.community_id AND c.join_policy = 'closed'
          WHERE st.help_request_id = h.id
            AND NOT EXISTS (
              SELECT 1 FROM viewer_communities vc WHERE vc.scope_id = st.community_id
            )
        )
      )

    UNION ALL
    SELECT 'post', p.id, p.created_at,
      CASE WHEN p_author_ids IS NOT NULL THEN 'following'::text END
    FROM posts p
    WHERE p_filter IN ('all', 'posts')
      AND p.moderation_state <> 'removed'
      AND p_scope_id IS NULL
      AND (p_author_id IS NOT NULL OR p_author_ids IS NOT NULL)
      AND (p_before IS NULL OR p.created_at < p_before)
      AND (p_author_id IS NULL OR p.author_id = p_author_id)
      AND (p_author_ids IS NULL OR p.author_id = ANY(p_author_ids))
      AND (
        p.audience = 'public'
        OR p.author_id = p_user_id
        OR (
          p.audience = 'followers'
          AND EXISTS (
            SELECT 1 FROM user_follows f
            WHERE f.follower_id = p_user_id
              AND f.followed_id = p.author_id
              AND f.status = 'accepted'
          )
        )
      )

    UNION ALL
    SELECT 'comment', c.id, c.created_at,
      CASE WHEN p_author_ids IS NOT NULL THEN 'following'::text END
    FROM comments c
    WHERE p_include_comment_activity
      AND p_filter = 'all'
      AND (p_author_id IS NOT NULL OR p_author_ids IS NOT NULL)
      AND c.moderation_state <> 'removed'
      AND (p_before IS NULL OR c.created_at < p_before)
      AND (p_author_id IS NULL OR c.author_id = p_author_id)
      AND (p_author_ids IS NULL OR c.author_id = ANY(p_author_ids))
  )
  SELECT candidates.*
  FROM candidates
  ORDER BY sort_at DESC, entity_id DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 400);
$$;

REVOKE ALL ON FUNCTION public.get_feed_candidates(
  uuid, text, uuid, uuid[], boolean, text, uuid, boolean, boolean, timestamptz, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_feed_candidates(
  uuid, text, uuid, uuid[], boolean, text, uuid, boolean, boolean, timestamptz, integer
) TO service_role;

CREATE OR REPLACE FUNCTION public.can_view_feed_subject(
  p_user_id uuid,
  p_subject_type text,
  p_subject_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  entity_table text;
  tag_table text;
  tag_id_column text;
  extra_predicate text := '';
  visible boolean := false;
BEGIN
  IF p_subject_type = 'post' THEN
    SELECT EXISTS (
      SELECT 1
      FROM posts p
      WHERE p.id = p_subject_id
        AND p.moderation_state <> 'removed'
        AND (
          p.audience = 'public'
          OR p.author_id = p_user_id
          OR EXISTS (
            SELECT 1 FROM user_follows f
            WHERE f.follower_id = p_user_id
              AND f.followed_id = p.author_id
              AND f.status = 'accepted'
          )
        )
    ) INTO visible;
    RETURN visible;
  END IF;

  IF p_subject_type = 'event' THEN
    SELECT EXISTS (
      SELECT 1
      FROM events e
      WHERE e.id = p_subject_id
        AND e.moderation_state <> 'removed'
        AND (
          (
            e.is_private
            AND p_user_id IS NOT NULL
            AND (
              e.created_by = p_user_id
              OR EXISTS (
                SELECT 1 FROM event_memberships em
                WHERE em.event_id = e.id AND em.user_id = p_user_id
              )
              OR (
                e.audience = 'private_community'
                AND e.home_community_id IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM scope_memberships sm
                  WHERE sm.user_id = p_user_id
                    AND sm.scope_kind = 'community'
                    AND sm.scope_id = e.home_community_id
                )
              )
            )
          )
          OR (
            NOT e.is_private
            AND (
              EXISTS (SELECT 1 FROM event_tags t WHERE t.event_id = e.id AND t.channel_id IS NOT NULL)
              OR EXISTS (
                SELECT 1 FROM event_tags t JOIN communities c ON c.id = t.community_id
                WHERE t.event_id = e.id AND c.join_policy <> 'closed'
              )
              OR NOT EXISTS (
                SELECT 1
                FROM event_tags t
                JOIN communities c ON c.id = t.community_id AND c.join_policy = 'closed'
                WHERE t.event_id = e.id
                  AND NOT EXISTS (
                    SELECT 1 FROM scope_memberships sm
                    WHERE sm.user_id = p_user_id
                      AND sm.scope_kind = 'community'
                      AND sm.scope_id = t.community_id
                  )
              )
            )
          )
        )
    ) INTO visible;
    RETURN visible;
  END IF;

  CASE p_subject_type
    WHEN 'thread' THEN
      entity_table := 'threads'; tag_table := 'thread_tags'; tag_id_column := 'thread_id';
      extra_predicate := '';
    WHEN 'project' THEN
      entity_table := 'projects'; tag_table := 'project_tags'; tag_id_column := 'project_id';
      extra_predicate := ' AND NOT e.is_closed';
    WHEN 'help_request' THEN
      entity_table := 'help_requests'; tag_table := 'help_request_tags';
      tag_id_column := 'help_request_id';
      extra_predicate := '';
    ELSE
      RETURN false;
  END CASE;

  EXECUTE format(
    'SELECT EXISTS (
       SELECT 1 FROM %I e
       WHERE e.id = $1
         AND e.moderation_state <> ''removed'' %s
         AND (
           EXISTS (SELECT 1 FROM %I t WHERE t.%I = e.id AND t.channel_id IS NOT NULL)
           OR EXISTS (
             SELECT 1 FROM %I t JOIN communities c ON c.id = t.community_id
             WHERE t.%I = e.id AND c.join_policy <> ''closed''
           )
           OR NOT EXISTS (
             SELECT 1 FROM %I t
             JOIN communities c ON c.id = t.community_id AND c.join_policy = ''closed''
             WHERE t.%I = e.id
               AND NOT EXISTS (
                 SELECT 1 FROM scope_memberships sm
                 WHERE sm.user_id = $2
                   AND sm.scope_kind = ''community''
                   AND sm.scope_id = t.community_id
               )
           )
         )
     )',
    entity_table,
    extra_predicate,
    tag_table,
    tag_id_column,
    tag_table,
    tag_id_column,
    tag_table,
    tag_id_column
  ) INTO visible USING p_subject_id, p_user_id;
  RETURN visible;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_feed_comment_context(
  p_user_id uuid,
  p_comment_ids uuid[]
)
RETURNS TABLE (
  comment_id uuid,
  subject_title text,
  subject_slug text,
  reply_count bigint,
  visible boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.id,
    CASE c.subject_type
      WHEN 'thread' THEN (SELECT t.title FROM threads t WHERE t.id = c.subject_id)
      WHEN 'project' THEN (SELECT p.title FROM projects p WHERE p.id = c.subject_id)
      WHEN 'event' THEN (SELECT e.title FROM events e WHERE e.id = c.subject_id)
      WHEN 'help_request' THEN (SELECT h.title FROM help_requests h WHERE h.id = c.subject_id)
      WHEN 'post' THEN (SELECT left(p.body, 120) FROM posts p WHERE p.id = c.subject_id)
      ELSE NULL
    END,
    CASE c.subject_type
      WHEN 'thread' THEN (SELECT t.slug::text FROM threads t WHERE t.id = c.subject_id)
      WHEN 'project' THEN (SELECT p.slug::text FROM projects p WHERE p.id = c.subject_id)
      WHEN 'event' THEN (SELECT e.slug::text FROM events e WHERE e.id = c.subject_id)
      ELSE NULL
    END,
    (SELECT count(*) FROM comments reply WHERE reply.parent_id = c.id),
    can_view_feed_subject(p_user_id, c.subject_type, c.subject_id)
  FROM comments c
  WHERE c.id = ANY(p_comment_ids);
$$;

REVOKE ALL ON FUNCTION public.can_view_feed_subject(uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_feed_comment_context(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_view_feed_subject(uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_feed_comment_context(uuid, uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION public.get_latest_feed_updates(
  p_project_ids uuid[] DEFAULT '{}'::uuid[],
  p_event_ids uuid[] DEFAULT '{}'::uuid[]
)
RETURNS TABLE (
  entity_type text,
  entity_id uuid,
  body text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 'project'::text, latest.project_id, latest.body, latest.created_at
  FROM (
    SELECT DISTINCT ON (pu.project_id)
      pu.project_id, pu.body, pu.created_at
    FROM project_updates pu
    WHERE pu.project_id = ANY(p_project_ids)
    ORDER BY pu.project_id, pu.created_at DESC
  ) latest
  UNION ALL
  SELECT 'event'::text, latest.event_id, latest.body, latest.created_at
  FROM (
    SELECT DISTINCT ON (eu.event_id)
      eu.event_id, eu.body, eu.created_at
    FROM event_updates eu
    WHERE eu.event_id = ANY(p_event_ids)
    ORDER BY eu.event_id, eu.created_at DESC
  ) latest;
$$;

REVOKE ALL ON FUNCTION public.get_latest_feed_updates(uuid[], uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_latest_feed_updates(uuid[], uuid[]) TO service_role;
