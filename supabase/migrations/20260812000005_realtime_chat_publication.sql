-- Publish chat and inbox changes used by the authenticated realtime client.

ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS comments_realtime_read ON public.comments;
CREATE POLICY comments_realtime_read
ON public.comments
FOR SELECT
TO authenticated
USING (
  author_id = auth.uid()
  OR public.can_view_feed_subject(auth.uid(), subject_type, subject_id)
);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'messages',
    'conversation_members',
    'notifications',
    'comments'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = table_name
    ) THEN
      EXECUTE format(
        'ALTER PUBLICATION supabase_realtime ADD TABLE public.%I',
        table_name
      );
    END IF;
  END LOOP;
END;
$$;
