-- Extra searchable entity sync + revoke anon execute on upsert RPC.

CREATE OR REPLACE FUNCTION public.sync_post_search_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.upsert_searchable_document(
    'post',
    NEW.id,
    left(coalesce(NEW.body, ''), 80),
    left(coalesce(NEW.body, ''), 280),
    'post',
    '/posts/' || NEW.id::text
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_post_search ON public.posts;
CREATE TRIGGER trg_sync_post_search
AFTER INSERT OR UPDATE OF body ON public.posts
FOR EACH ROW EXECUTE FUNCTION public.sync_post_search_document();

CREATE OR REPLACE FUNCTION public.sync_help_request_search_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.upsert_searchable_document(
    'help_request',
    NEW.id,
    NEW.title,
    left(coalesce(NEW.body, ''), 280),
    'help_request',
    '/help-requests/' || NEW.id::text
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_help_request_search ON public.help_requests;
CREATE TRIGGER trg_sync_help_request_search
AFTER INSERT OR UPDATE OF title, body ON public.help_requests
FOR EACH ROW EXECUTE FUNCTION public.sync_help_request_search_document();

CREATE OR REPLACE FUNCTION public.sync_channel_search_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.upsert_searchable_document(
    'channel',
    NEW.id,
    NEW.name,
    left(coalesce(NEW.description, ''), 280),
    'channel',
    '/channels/' || NEW.slug
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_channel_search ON public.channels;
CREATE TRIGGER trg_sync_channel_search
AFTER INSERT OR UPDATE OF name, description, slug ON public.channels
FOR EACH ROW EXECUTE FUNCTION public.sync_channel_search_document();

CREATE OR REPLACE FUNCTION public.sync_community_search_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.upsert_searchable_document(
    'community',
    NEW.id,
    NEW.name,
    left(coalesce(NEW.description, ''), 280),
    'community',
    '/communities/' || NEW.slug
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_community_search ON public.communities;
CREATE TRIGGER trg_sync_community_search
AFTER INSERT OR UPDATE OF name, description, slug ON public.communities
FOR EACH ROW EXECUTE FUNCTION public.sync_community_search_document();

-- Clients must not poison the search index; service role + authenticated edge only.
REVOKE EXECUTE ON FUNCTION public.upsert_searchable_document(text, uuid, text, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.upsert_searchable_document(text, uuid, text, text, text, text)
  TO authenticated, service_role;
