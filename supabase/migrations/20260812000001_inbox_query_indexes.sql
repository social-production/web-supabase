-- Speed up inbox list, unread, and linked-chat unread lookups.
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at_desc
  ON public.messages (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversation_members_user_id
  ON public.conversation_members (user_id);

CREATE INDEX IF NOT EXISTS idx_comments_subject_created_at_desc
  ON public.comments (subject_type, subject_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_subject_chat_reads_user_subject
  ON public.subject_chat_reads (user_id, subject_type, subject_id);
