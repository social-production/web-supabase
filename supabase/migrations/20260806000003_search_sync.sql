-- Search document sync + helper RPC for gateway upserts.

CREATE OR REPLACE FUNCTION public.upsert_searchable_document(
  p_entity_type text,
  p_entity_id uuid,
  p_title text,
  p_summary text,
  p_meta text,
  p_href text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.searchable_documents (
    entity_type, entity_id, title, summary, meta, href, search_vector, updated_at
  ) VALUES (
    p_entity_type,
    p_entity_id,
    p_title,
    p_summary,
    p_meta,
    p_href,
    to_tsvector('english', coalesce(p_title, '') || ' ' || coalesce(p_summary, '') || ' ' || coalesce(p_meta, '')),
    now()
  )
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET
    title = EXCLUDED.title,
    summary = EXCLUDED.summary,
    meta = EXCLUDED.meta,
    href = EXCLUDED.href,
    search_vector = EXCLUDED.search_vector,
    updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_thread_search_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.upsert_searchable_document(
    'thread',
    NEW.id,
    NEW.title,
    left(coalesce(NEW.body, ''), 280),
    'thread',
    '/threads/' || NEW.slug
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_thread_search ON public.threads;
CREATE TRIGGER trg_sync_thread_search
AFTER INSERT OR UPDATE OF title, body, slug ON public.threads
FOR EACH ROW EXECUTE FUNCTION public.sync_thread_search_document();

CREATE OR REPLACE FUNCTION public.sync_project_search_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.upsert_searchable_document(
    'project',
    NEW.id,
    NEW.title,
    left(coalesce(NEW.description, ''), 280),
    coalesce(NEW.project_mode, 'project'),
    '/projects/' || NEW.slug
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_project_search ON public.projects;
CREATE TRIGGER trg_sync_project_search
AFTER INSERT OR UPDATE OF title, description, slug, project_mode ON public.projects
FOR EACH ROW EXECUTE FUNCTION public.sync_project_search_document();

CREATE OR REPLACE FUNCTION public.sync_event_search_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.upsert_searchable_document(
    'event',
    NEW.id,
    NEW.title,
    left(coalesce(NEW.description, ''), 280),
    'event',
    '/events/' || NEW.slug
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_event_search ON public.events;
CREATE TRIGGER trg_sync_event_search
AFTER INSERT OR UPDATE OF title, description, slug ON public.events
FOR EACH ROW EXECUTE FUNCTION public.sync_event_search_document();

CREATE OR REPLACE FUNCTION public.sync_user_search_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.upsert_searchable_document(
    'user',
    NEW.id,
    NEW.username,
    left(coalesce(NEW.bio, ''), 280),
    'user',
    '/profile/' || NEW.username
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_user_search ON public.users;
CREATE TRIGGER trg_sync_user_search
AFTER INSERT OR UPDATE OF username, bio ON public.users
FOR EACH ROW EXECUTE FUNCTION public.sync_user_search_document();

GRANT EXECUTE ON FUNCTION public.upsert_searchable_document(text, uuid, text, text, text, text)
  TO anon, authenticated, service_role;
