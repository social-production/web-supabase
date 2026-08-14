-- Limit each feed entity type before merging so indexes on last_activity_at / created_at
-- can stop after p_limit rows instead of scanning then sorting the full union.

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
  WITH cap AS (
    SELECT LEAST(GREATEST(p_limit, 1), 400) AS n
  ),
  viewer_communities AS (
    SELECT sm.scope_id
    FROM scope_memberships sm
    WHERE sm.user_id = p_user_id
      AND sm.scope_kind = 'community'
  ),
  thread_candidates AS (
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
    ORDER BY t.last_activity_at DESC, t.id DESC
    LIMIT (SELECT n FROM cap)
  ),
  project_candidates AS (
    SELECT 'project'::text, p.id, p.last_activity_at,
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
    ORDER BY p.last_activity_at DESC, p.id DESC
    LIMIT (SELECT n FROM cap)
  ),
  event_candidates AS (
    SELECT 'event'::text, e.id, e.last_activity_at,
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
    ORDER BY e.last_activity_at DESC, e.id DESC
    LIMIT (SELECT n FROM cap)
  ),
  help_candidates AS (
    SELECT 'help_request'::text, h.id, h.created_at,
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
    ORDER BY h.created_at DESC, h.id DESC
    LIMIT (SELECT n FROM cap)
  ),
  post_candidates AS (
    SELECT 'post'::text, p.id, p.created_at,
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
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT (SELECT n FROM cap)
  ),
  comment_candidates AS (
    SELECT 'comment'::text, c.id, c.created_at,
      CASE WHEN p_author_ids IS NOT NULL THEN 'following'::text END
    FROM comments c
    WHERE p_include_comment_activity
      AND p_filter = 'all'
      AND (p_author_id IS NOT NULL OR p_author_ids IS NOT NULL)
      AND c.moderation_state <> 'removed'
      AND (p_before IS NULL OR c.created_at < p_before)
      AND (p_author_id IS NULL OR c.author_id = p_author_id)
      AND (p_author_ids IS NULL OR c.author_id = ANY(p_author_ids))
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT (SELECT n FROM cap)
  ),
  candidates AS (
    SELECT * FROM thread_candidates
    UNION ALL
    SELECT * FROM project_candidates
    UNION ALL
    SELECT * FROM event_candidates
    UNION ALL
    SELECT * FROM help_candidates
    UNION ALL
    SELECT * FROM post_candidates
    UNION ALL
    SELECT * FROM comment_candidates
  )
  SELECT candidates.*
  FROM candidates
  ORDER BY sort_at DESC, entity_id DESC
  LIMIT (SELECT n FROM cap);
$$;

REVOKE ALL ON FUNCTION public.get_feed_candidates(
  uuid, text, uuid, uuid[], boolean, text, uuid, boolean, boolean, timestamptz, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_feed_candidates(
  uuid, text, uuid, uuid[], boolean, text, uuid, boolean, boolean, timestamptz, integer
) TO service_role;

CREATE INDEX IF NOT EXISTS ix_comments_subject_created
  ON public.comments (subject_type, subject_id, created_at);
