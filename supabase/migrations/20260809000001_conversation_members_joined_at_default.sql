-- Allow conversation member inserts that omit joined_at (matches FastAPI defaults).
ALTER TABLE public.conversation_members
  ALTER COLUMN joined_at SET DEFAULT now();
