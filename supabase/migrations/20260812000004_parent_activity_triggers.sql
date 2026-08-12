-- Keep recent-feed ordering correct regardless of which mutation creates an update.

CREATE OR REPLACE FUNCTION public.touch_project_from_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE projects
  SET last_activity_at = GREATEST(
    COALESCE(last_activity_at, NEW.created_at),
    NEW.created_at
  )
  WHERE id = NEW.project_id;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.touch_event_from_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE events
  SET last_activity_at = GREATEST(
    COALESCE(last_activity_at, NEW.created_at),
    NEW.created_at
  )
  WHERE id = NEW.event_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_project_updates_touch_parent ON public.project_updates;
CREATE TRIGGER trg_project_updates_touch_parent
AFTER INSERT ON public.project_updates
FOR EACH ROW EXECUTE FUNCTION public.touch_project_from_update();

DROP TRIGGER IF EXISTS trg_event_updates_touch_parent ON public.event_updates;
CREATE TRIGGER trg_event_updates_touch_parent
AFTER INSERT ON public.event_updates
FOR EACH ROW EXECUTE FUNCTION public.touch_event_from_update();

REVOKE ALL ON FUNCTION public.touch_project_from_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.touch_event_from_update() FROM PUBLIC;
