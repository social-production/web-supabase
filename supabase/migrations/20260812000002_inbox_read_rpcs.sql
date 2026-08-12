-- Collapse inbox, linked-chat, and unread fan-out into set-based database reads.

CREATE OR REPLACE FUNCTION public.get_conversation_inbox(
  p_user_id uuid,
  p_limit integer DEFAULT 100
)
RETURNS TABLE (
  id uuid,
  kind varchar,
  title varchar,
  created_at timestamptz,
  last_message_at timestamptz,
  preview text,
  unread_count bigint,
  participants jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.id,
    c.kind,
    CASE
      WHEN c.kind = 'direct' THEN COALESCE(
        (
          SELECT u.username
          FROM conversation_members other_cm
          JOIN users u ON u.id = other_cm.user_id
          WHERE other_cm.conversation_id = c.id
            AND other_cm.user_id <> p_user_id
          LIMIT 1
        ),
        'Direct message'
      )
      ELSE COALESCE(c.title, 'Group chat')
    END AS title,
    c.created_at,
    COALESCE(c.last_message_at, c.created_at) AS last_message_at,
    COALESCE(latest.encrypted_body, '') AS preview,
    (
      SELECT count(*)
      FROM messages unread
      WHERE unread.conversation_id = c.id
        AND unread.sender_id IS DISTINCT FROM p_user_id
        AND (cm.last_read_at IS NULL OR unread.created_at > cm.last_read_at)
    ) AS unread_count,
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', u.id,
            'username', u.username,
            'profileImageUrl', u.profile_image_url
          )
          ORDER BY u.username
        )
        FROM conversation_members member_cm
        JOIN users u ON u.id = member_cm.user_id
        WHERE member_cm.conversation_id = c.id
      ),
      '[]'::jsonb
    ) AS participants
  FROM conversation_members cm
  JOIN conversations c ON c.id = cm.conversation_id
  LEFT JOIN LATERAL (
    SELECT m.encrypted_body, m.created_at
    FROM messages m
    WHERE m.conversation_id = c.id
    ORDER BY m.created_at DESC
    LIMIT 1
  ) latest ON true
  WHERE cm.user_id = p_user_id
  ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 200);
$$;

CREATE OR REPLACE FUNCTION public.get_linked_chat_inbox(
  p_user_id uuid,
  p_limit integer DEFAULT 80
)
RETURNS TABLE (
  id uuid,
  kind text,
  entity_id uuid,
  entity_slug text,
  title text,
  preview text,
  last_message_at timestamptz,
  comment_count integer,
  unread_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH linked_subjects AS (
    SELECT 'project'::text AS kind, pm.project_id AS entity_id
    FROM project_memberships pm
    WHERE pm.user_id = p_user_id
    UNION
    SELECT 'event'::text, em.event_id
    FROM event_memberships em
    WHERE em.user_id = p_user_id
    UNION
    SELECT recent.subject_type, recent.subject_id
    FROM (
      SELECT c.subject_type::text, c.subject_id, max(c.created_at) AS last_commented_at
      FROM comments c
      WHERE c.author_id = p_user_id
        AND c.subject_type IN ('project', 'event', 'help_request')
      GROUP BY c.subject_type, c.subject_id
      ORDER BY last_commented_at DESC
      LIMIT 600
    ) recent
    UNION
    SELECT 'help_request'::text, hr.id
    FROM help_requests hr
    WHERE hr.author_id = p_user_id
    UNION
    SELECT 'help_request'::text, hrr.help_request_id
    FROM help_request_role_assignments hra
    JOIN help_request_roles hrr ON hrr.id = hra.role_id
    WHERE hra.user_id = p_user_id
  ),
  entities AS (
    SELECT
      'project'::text AS kind,
      p.id AS entity_id,
      p.slug::text AS entity_slug,
      p.title::text AS title,
      p.last_activity_at AS fallback_at,
      p.comment_count
    FROM projects p
    JOIN linked_subjects s ON s.kind = 'project' AND s.entity_id = p.id
    UNION ALL
    SELECT
      'event'::text,
      e.id,
      e.slug::text,
      e.title::text,
      e.last_activity_at,
      e.comment_count
    FROM events e
    JOIN linked_subjects s ON s.kind = 'event' AND s.entity_id = e.id
    UNION ALL
    SELECT
      'help_request'::text,
      h.id,
      h.id::text,
      h.title::text,
      COALESCE(h.last_activity_at, h.created_at),
      h.comment_count
    FROM help_requests h
    JOIN linked_subjects s ON s.kind = 'help_request' AND s.entity_id = h.id
  )
  SELECT
    entity.entity_id AS id,
    entity.kind,
    entity.entity_id,
    entity.entity_slug,
    entity.title,
    COALESCE(left(latest.body, 200), '') AS preview,
    COALESCE(latest.created_at, entity.fallback_at) AS last_message_at,
    entity.comment_count,
    (
      SELECT count(*)
      FROM comments unread
      LEFT JOIN subject_chat_reads read_state
        ON read_state.user_id = p_user_id
       AND read_state.subject_type = entity.kind
       AND read_state.subject_id = entity.entity_id
      WHERE unread.subject_type = entity.kind
        AND unread.subject_id = entity.entity_id
        AND unread.author_id IS DISTINCT FROM p_user_id
        AND (
          read_state.last_read_at IS NULL
          OR unread.created_at > read_state.last_read_at
        )
    ) AS unread_count
  FROM entities entity
  LEFT JOIN LATERAL (
    SELECT c.body, c.created_at
    FROM comments c
    WHERE c.subject_type = entity.kind
      AND c.subject_id = entity.entity_id
    ORDER BY c.created_at DESC
    LIMIT 1
  ) latest ON true
  ORDER BY COALESCE(latest.created_at, entity.fallback_at) DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 240);
$$;

CREATE OR REPLACE FUNCTION public.get_unread_totals(p_user_id uuid)
RETURNS TABLE (notifications bigint, messages bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH direct_unread AS (
    SELECT count(*) AS total
    FROM conversation_members cm
    JOIN messages m ON m.conversation_id = cm.conversation_id
    WHERE cm.user_id = p_user_id
      AND m.sender_id IS DISTINCT FROM p_user_id
      AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at)
  ),
  linked_subjects AS (
    SELECT 'project'::text AS kind, pm.project_id AS entity_id
    FROM project_memberships pm
    WHERE pm.user_id = p_user_id
    UNION
    SELECT 'event'::text, em.event_id
    FROM event_memberships em
    WHERE em.user_id = p_user_id
    UNION
    SELECT recent.subject_type, recent.subject_id
    FROM (
      SELECT c.subject_type::text, c.subject_id, max(c.created_at) AS last_commented_at
      FROM comments c
      WHERE c.author_id = p_user_id
        AND c.subject_type IN ('project', 'event', 'help_request')
      GROUP BY c.subject_type, c.subject_id
      ORDER BY last_commented_at DESC
      LIMIT 600
    ) recent
    UNION
    SELECT 'help_request'::text, hr.id
    FROM help_requests hr
    WHERE hr.author_id = p_user_id
    UNION
    SELECT 'help_request'::text, hrr.help_request_id
    FROM help_request_role_assignments hra
    JOIN help_request_roles hrr ON hrr.id = hra.role_id
    WHERE hra.user_id = p_user_id
  ),
  linked_unread AS (
    SELECT count(*) AS total
    FROM linked_subjects subject
    JOIN comments c
      ON c.subject_type = subject.kind
     AND c.subject_id = subject.entity_id
    LEFT JOIN subject_chat_reads read_state
      ON read_state.user_id = p_user_id
     AND read_state.subject_type = subject.kind
     AND read_state.subject_id = subject.entity_id
    WHERE c.author_id IS DISTINCT FROM p_user_id
      AND (
        read_state.last_read_at IS NULL
        OR c.created_at > read_state.last_read_at
      )
  )
  SELECT
    (SELECT count(*) FROM notifications n
     WHERE n.recipient_id = p_user_id AND n.is_unread = true),
    COALESCE((SELECT total FROM direct_unread), 0)
      + COALESCE((SELECT total FROM linked_unread), 0);
$$;

REVOKE ALL ON FUNCTION public.get_conversation_inbox(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_linked_chat_inbox(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_unread_totals(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_conversation_inbox(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_linked_chat_inbox(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_unread_totals(uuid) TO service_role;
