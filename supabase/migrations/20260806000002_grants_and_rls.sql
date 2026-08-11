-- Ensure Data API / Edge Function roles can access the canonical schema.
-- Newer Supabase defaults no longer auto-expose public tables.

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- Baseline RLS on content tables (gateway still uses service_role for orchestration).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'threads', 'posts', 'projects', 'events', 'help_requests',
    'content_comments', 'content_votes', 'content_reports', 'report_votes',
    'channels', 'communities', 'scope_memberships', 'locations',
    'conversations', 'scope_invites'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = t || '_read_all'
      ) THEN
        EXECUTE format(
          'CREATE POLICY %I ON public.%I FOR SELECT USING (true)',
          t || '_read_all', t
        );
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = t || '_insert_auth'
      ) THEN
        EXECUTE format(
          'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (true)',
          t || '_insert_auth', t
        );
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = t || '_update_auth'
      ) THEN
        EXECUTE format(
          'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (true) WITH CHECK (true)',
          t || '_update_auth', t
        );
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = t || '_delete_auth'
      ) THEN
        EXECUTE format(
          'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (true)',
          t || '_delete_auth', t
        );
      END IF;
    END IF;
  END LOOP;
END $$;
