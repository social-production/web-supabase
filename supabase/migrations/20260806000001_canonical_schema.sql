-- Social Production canonical schema for Supabase
-- Generated from web-backend SQLAlchemy models, adapted for Supabase Auth.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE locations (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	provider_place_id VARCHAR(160), 
	display_label VARCHAR(240) NOT NULL, 
	latitude NUMERIC(9, 6), 
	longitude NUMERIC(9, 6), 
	region VARCHAR(120), 
	country VARCHAR(120), 
	precision VARCHAR(16) DEFAULT 'approximate' NOT NULL, 
	is_online BOOLEAN DEFAULT false NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_locations PRIMARY KEY (id), 
	CONSTRAINT ck_locations_locations_precision CHECK (precision IN ('exact', 'approximate')), 
	CONSTRAINT ck_locations_locations_coords_or_online CHECK ((is_online = TRUE) OR (latitude IS NOT NULL AND longitude IS NOT NULL))
);

CREATE INDEX ix_locations_provider_place_id ON locations (provider_place_id);

CREATE INDEX ix_locations_lat_lon ON locations (latitude, longitude);

CREATE TABLE searchable_documents (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	entity_type VARCHAR(24) NOT NULL, 
	entity_id UUID NOT NULL, 
	title TEXT NOT NULL, 
	summary TEXT NOT NULL, 
	meta TEXT NOT NULL, 
	href TEXT NOT NULL, 
	search_vector TSVECTOR NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_searchable_documents PRIMARY KEY (id), 
	CONSTRAINT uq_searchable_documents_entity UNIQUE (entity_type, entity_id)
);

CREATE TABLE users (
	id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
	username VARCHAR(32) NOT NULL,
	email VARCHAR(320),
	password_hash TEXT,
	bio TEXT,
	profile_image_url TEXT,
	is_active BOOLEAN DEFAULT true NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	CONSTRAINT uq_users_username UNIQUE (username),
	CONSTRAINT uq_users_email UNIQUE (email)
);

CREATE TABLE board_standing_votes (
	target_user_id UUID NOT NULL, 
	voter_id UUID NOT NULL, 
	vote SMALLINT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_board_standing_votes PRIMARY KEY (target_user_id, voter_id), 
	CONSTRAINT fk_board_standing_votes_target_user_id_users FOREIGN KEY(target_user_id) REFERENCES users (id) ON DELETE CASCADE, 
	CONSTRAINT fk_board_standing_votes_voter_id_users FOREIGN KEY(voter_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE channels (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	slug VARCHAR(80) NOT NULL, 
	name VARCHAR(120) NOT NULL, 
	description TEXT NOT NULL, 
	created_by UUID, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_channels PRIMARY KEY (id), 
	CONSTRAINT uq_channels_slug UNIQUE (slug), 
	CONSTRAINT fk_channels_created_by_users FOREIGN KEY(created_by) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE comments (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	subject_type VARCHAR(16) NOT NULL, 
	subject_id UUID NOT NULL, 
	parent_id UUID, 
	author_id UUID, 
	body TEXT NOT NULL, 
	vote_count INTEGER DEFAULT '0' NOT NULL, 
	moderation_state VARCHAR(24) DEFAULT 'visible' NOT NULL, 
	moderation_reason VARCHAR(24), 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_comments PRIMARY KEY (id), 
	CONSTRAINT fk_comments_parent_id_comments FOREIGN KEY(parent_id) REFERENCES comments (id) ON DELETE CASCADE, 
	CONSTRAINT fk_comments_author_id_users FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE communities (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	slug VARCHAR(80) NOT NULL, 
	name VARCHAR(120) NOT NULL, 
	description TEXT NOT NULL, 
	join_policy VARCHAR(16) NOT NULL, 
	created_by UUID, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_communities PRIMARY KEY (id), 
	CONSTRAINT uq_communities_slug UNIQUE (slug), 
	CONSTRAINT fk_communities_created_by_users FOREIGN KEY(created_by) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE content_votes (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	target_type VARCHAR(16) NOT NULL, 
	target_id UUID NOT NULL, 
	voter_id UUID NOT NULL, 
	direction SMALLINT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_content_votes PRIMARY KEY (id), 
	CONSTRAINT uq_content_votes_target_voter UNIQUE (target_type, target_id, voter_id), 
	CONSTRAINT fk_content_votes_voter_id_users FOREIGN KEY(voter_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE conversations (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	kind VARCHAR(16) NOT NULL, 
	title VARCHAR(200), 
	created_by UUID, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	last_message_at TIMESTAMP WITH TIME ZONE, 
	CONSTRAINT pk_conversations PRIMARY KEY (id), 
	CONSTRAINT fk_conversations_created_by_users FOREIGN KEY(created_by) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE governance_decision_history (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	entity_kind VARCHAR(16) NOT NULL, 
	entity_id UUID NOT NULL, 
	decision_kind VARCHAR(48) NOT NULL, 
	status VARCHAR(16) NOT NULL, 
	approval_threshold_percent NUMERIC(5, 2) DEFAULT '66.00' NOT NULL, 
	payload JSONB NOT NULL, 
	author_id UUID, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	resolved_at TIMESTAMP WITH TIME ZONE, 
	CONSTRAINT pk_governance_decision_history PRIMARY KEY (id), 
	CONSTRAINT fk_governance_decision_history_author_id_users FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE help_requests (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	author_id UUID, 
	title VARCHAR(200) NOT NULL, 
	body TEXT NOT NULL, 
	location_label VARCHAR(200) NOT NULL, 
	location_id UUID, 
	schedule_label VARCHAR(200) NOT NULL, 
	needed_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	ends_at TIMESTAMP WITH TIME ZONE, 
	roles JSONB DEFAULT '[]'::jsonb NOT NULL, 
	vote_count INTEGER DEFAULT '0' NOT NULL, 
	comment_count INTEGER DEFAULT '0' NOT NULL, 
	moderation_state VARCHAR(24) DEFAULT 'visible' NOT NULL, 
	moderation_reason VARCHAR(24), 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_help_requests PRIMARY KEY (id), 
	CONSTRAINT fk_help_requests_author_id_users FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE SET NULL, 
	CONSTRAINT fk_help_requests_location_id_locations FOREIGN KEY(location_id) REFERENCES locations (id) ON DELETE SET NULL
);

CREATE TABLE meaningful_actions (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	user_id UUID NOT NULL, 
	action_type VARCHAR(32) NOT NULL, 
	occurred_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	metadata JSONB DEFAULT '{}'::jsonb NOT NULL, 
	CONSTRAINT pk_meaningful_actions PRIMARY KEY (id), 
	CONSTRAINT fk_meaningful_actions_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE notifications (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	recipient_id UUID NOT NULL, 
	actor_id UUID, 
	kind VARCHAR(24) NOT NULL, 
	surface VARCHAR(16) NOT NULL, 
	subject_type VARCHAR(16) NOT NULL, 
	subject_id UUID NOT NULL, 
	target_id UUID, 
	title VARCHAR(240) NOT NULL, 
	body TEXT NOT NULL, 
	href TEXT NOT NULL, 
	is_unread BOOLEAN DEFAULT true NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	read_at TIMESTAMP WITH TIME ZONE, 
	CONSTRAINT pk_notifications PRIMARY KEY (id), 
	CONSTRAINT fk_notifications_recipient_id_users FOREIGN KEY(recipient_id) REFERENCES users (id) ON DELETE CASCADE, 
	CONSTRAINT fk_notifications_actor_id_users FOREIGN KEY(actor_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE platform_board_memberships (
	user_id UUID NOT NULL, 
	standing_state VARCHAR(24) NOT NULL, 
	grace_started_at TIMESTAMP WITH TIME ZONE, 
	grace_ends_at TIMESTAMP WITH TIME ZONE, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_platform_board_memberships PRIMARY KEY (user_id), 
	CONSTRAINT fk_platform_board_memberships_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE posts (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	author_id UUID, 
	body TEXT NOT NULL, 
	audience VARCHAR(16) NOT NULL, 
	vote_count INTEGER DEFAULT '0' NOT NULL, 
	comment_count INTEGER DEFAULT '0' NOT NULL, 
	moderation_state VARCHAR(24) DEFAULT 'visible' NOT NULL, 
	moderation_reason VARCHAR(24), 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_posts PRIMARY KEY (id), 
	CONSTRAINT fk_posts_author_id_users FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE projects (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	slug VARCHAR(120) NOT NULL, 
	title VARCHAR(200) NOT NULL, 
	description TEXT NOT NULL, 
	author_id UUID, 
	project_mode VARCHAR(32) NOT NULL, 
	project_subtype VARCHAR(32), 
	current_phase_id VARCHAR(24) NOT NULL, 
	stage_label VARCHAR(80) NOT NULL, 
	location_label VARCHAR(160) NOT NULL, 
	location_id UUID, 
	is_platform_tagged BOOLEAN DEFAULT false NOT NULL, 
	is_closed BOOLEAN DEFAULT false NOT NULL, 
	close_outcome VARCHAR(16), 
	signal_count INTEGER DEFAULT '0' NOT NULL, 
	vote_count INTEGER DEFAULT '0' NOT NULL, 
	comment_count INTEGER DEFAULT '0' NOT NULL, 
	member_count INTEGER DEFAULT '0' NOT NULL, 
	land_asset_id UUID, 
	acquisition_id UUID, 
	moderation_state VARCHAR(24) DEFAULT 'visible' NOT NULL, 
	moderation_reason VARCHAR(24), 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	last_activity_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	CONSTRAINT pk_projects PRIMARY KEY (id), 
	CONSTRAINT uq_projects_slug UNIQUE (slug), 
	CONSTRAINT fk_projects_author_id_users FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE SET NULL, 
	CONSTRAINT fk_projects_location_id_locations FOREIGN KEY(location_id) REFERENCES locations (id) ON DELETE SET NULL
);

CREATE TABLE reports (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	subject_type VARCHAR(16) NOT NULL, 
	subject_id UUID NOT NULL, 
	target_type VARCHAR(24) NOT NULL, 
	target_id UUID NOT NULL, 
	reason VARCHAR(24) NOT NULL, 
	description TEXT NOT NULL, 
	reporter_id UUID, 
	reported_author_id UUID, 
	resolution VARCHAR(16) DEFAULT 'open' NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_reports PRIMARY KEY (id), 
	CONSTRAINT fk_reports_reporter_id_users FOREIGN KEY(reporter_id) REFERENCES users (id) ON DELETE SET NULL, 
	CONSTRAINT fk_reports_reported_author_id_users FOREIGN KEY(reported_author_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE scope_confidence_votes (
	target_user_id UUID NOT NULL, 
	voter_id UUID NOT NULL, 
	scope_kind VARCHAR(16) NOT NULL, 
	scope_id UUID NOT NULL, 
	vote VARCHAR(8) NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_scope_confidence_votes PRIMARY KEY (target_user_id, voter_id, scope_kind, scope_id), 
	CONSTRAINT ck_scope_confidence_votes_scope_confidence_votes_not_self CHECK (target_user_id <> voter_id), 
	CONSTRAINT fk_scope_confidence_votes_target_user_id_users FOREIGN KEY(target_user_id) REFERENCES users (id) ON DELETE CASCADE, 
	CONSTRAINT fk_scope_confidence_votes_voter_id_users FOREIGN KEY(voter_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE scope_invites (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	scope_kind VARCHAR(16) NOT NULL, 
	scope_id UUID, 
	token_hash TEXT NOT NULL, 
	created_by UUID, 
	expires_at TIMESTAMP WITH TIME ZONE, 
	max_uses INTEGER, 
	uses INTEGER DEFAULT '0' NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_scope_invites PRIMARY KEY (id), 
	CONSTRAINT uq_scope_invites_token_hash UNIQUE (token_hash), 
	CONSTRAINT fk_scope_invites_created_by_users FOREIGN KEY(created_by) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE scope_memberships (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	scope_kind VARCHAR(16) NOT NULL, 
	scope_id UUID, 
	user_id UUID NOT NULL, 
	role VARCHAR(32) DEFAULT 'member' NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_scope_memberships PRIMARY KEY (id), 
	CONSTRAINT uq_scope_memberships_scope_user UNIQUE (scope_kind, scope_id, user_id), 
	CONSTRAINT fk_scope_memberships_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE subject_chat_reads (
	user_id UUID NOT NULL, 
	subject_type VARCHAR(16) NOT NULL, 
	subject_id UUID NOT NULL, 
	last_read_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	CONSTRAINT pk_subject_chat_reads PRIMARY KEY (user_id, subject_type, subject_id), 
	CONSTRAINT fk_subject_chat_reads_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE threads (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	slug VARCHAR(120) NOT NULL, 
	title VARCHAR(200) NOT NULL, 
	body TEXT NOT NULL, 
	author_id UUID, 
	vote_count INTEGER DEFAULT '0' NOT NULL, 
	comment_count INTEGER DEFAULT '0' NOT NULL, 
	moderation_state VARCHAR(24) DEFAULT 'visible' NOT NULL, 
	moderation_reason VARCHAR(24), 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	last_activity_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	CONSTRAINT pk_threads PRIMARY KEY (id), 
	CONSTRAINT uq_threads_slug UNIQUE (slug), 
	CONSTRAINT fk_threads_author_id_users FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE user_follows (
	follower_id UUID NOT NULL, 
	followed_id UUID NOT NULL, 
	status VARCHAR(16) DEFAULT 'accepted' NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_user_follows PRIMARY KEY (follower_id, followed_id), 
	CONSTRAINT ck_user_follows_user_follows_not_self CHECK (follower_id <> followed_id), 
	CONSTRAINT fk_user_follows_follower_id_users FOREIGN KEY(follower_id) REFERENCES users (id) ON DELETE CASCADE, 
	CONSTRAINT fk_user_follows_followed_id_users FOREIGN KEY(followed_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE user_settings (
	user_id UUID NOT NULL, 
	appearance_theme_mode VARCHAR(10) DEFAULT 'light' NOT NULL, 
	default_feed VARCHAR(10) DEFAULT 'public' NOT NULL, 
	public_feed_scope VARCHAR(16) DEFAULT 'global' NOT NULL, 
	public_feed_filter VARCHAR(16) DEFAULT 'all' NOT NULL, 
	public_feed_sort VARCHAR(16) DEFAULT 'popular' NOT NULL, 
	public_feed_window VARCHAR(8) DEFAULT 'all' NOT NULL, 
	personal_feed_scope VARCHAR(16) DEFAULT 'popular' NOT NULL, 
	personal_feed_filter VARCHAR(16) DEFAULT 'all' NOT NULL, 
	personal_feed_sort VARCHAR(16) DEFAULT 'popular' NOT NULL, 
	personal_feed_window VARCHAR(8) DEFAULT 'all' NOT NULL, 
	hide_public_activity_from_personal_feeds BOOLEAN DEFAULT false NOT NULL, 
	hide_personal_feed_from_non_followers BOOLEAN DEFAULT false NOT NULL, 
	hide_public_profile_activity_from_non_followers BOOLEAN DEFAULT false NOT NULL, 
	require_follow_approval BOOLEAN DEFAULT false NOT NULL, 
	preferred_language VARCHAR(5) DEFAULT 'en' NOT NULL, 
	display_timezone VARCHAR(64), 
	default_location_id UUID, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_user_settings PRIMARY KEY (user_id), 
	CONSTRAINT fk_user_settings_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	CONSTRAINT fk_user_settings_default_location_id_locations FOREIGN KEY(default_location_id) REFERENCES locations (id) ON DELETE SET NULL
);

CREATE TABLE conversation_members (
	conversation_id UUID NOT NULL, 
	user_id UUID NOT NULL, 
	joined_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	last_read_at TIMESTAMP WITH TIME ZONE, 
	CONSTRAINT pk_conversation_members PRIMARY KEY (conversation_id, user_id), 
	CONSTRAINT fk_conversation_members_conversation_id_conversations FOREIGN KEY(conversation_id) REFERENCES conversations (id) ON DELETE CASCADE, 
	CONSTRAINT fk_conversation_members_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE events (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	slug VARCHAR(120) NOT NULL, 
	title VARCHAR(200) NOT NULL, 
	description TEXT NOT NULL, 
	created_by UUID, 
	is_private BOOLEAN DEFAULT false NOT NULL, 
	audience VARCHAR(24) DEFAULT 'public' NOT NULL, 
	governance VARCHAR(24) DEFAULT 'collaborative' NOT NULL, 
	home_community_id UUID, 
	current_phase_id VARCHAR(24) NOT NULL, 
	time_label VARCHAR(120) NOT NULL, 
	location_label VARCHAR(160) NOT NULL, 
	location_id UUID, 
	scheduled_at TIMESTAMP WITH TIME ZONE, 
	ends_at TIMESTAMP WITH TIME ZONE, 
	vote_count INTEGER DEFAULT '0' NOT NULL, 
	comment_count INTEGER DEFAULT '0' NOT NULL, 
	going_count INTEGER DEFAULT '0' NOT NULL, 
	member_count INTEGER DEFAULT '0' NOT NULL, 
	moderation_state VARCHAR(24) DEFAULT 'visible' NOT NULL, 
	moderation_reason VARCHAR(24), 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	last_activity_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	CONSTRAINT pk_events PRIMARY KEY (id), 
	CONSTRAINT uq_events_slug UNIQUE (slug), 
	CONSTRAINT fk_events_created_by_users FOREIGN KEY(created_by) REFERENCES users (id) ON DELETE SET NULL, 
	CONSTRAINT fk_events_home_community_id_communities FOREIGN KEY(home_community_id) REFERENCES communities (id) ON DELETE SET NULL, 
	CONSTRAINT fk_events_location_id_locations FOREIGN KEY(location_id) REFERENCES locations (id) ON DELETE SET NULL
);

CREATE TABLE help_request_roles (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	help_request_id UUID NOT NULL, 
	title VARCHAR(120) NOT NULL, 
	description TEXT DEFAULT '' NOT NULL, 
	slots INTEGER NOT NULL, 
	sort_order INTEGER DEFAULT '0' NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_help_request_roles PRIMARY KEY (id), 
	CONSTRAINT fk_help_request_roles_help_request_id_help_requests FOREIGN KEY(help_request_id) REFERENCES help_requests (id) ON DELETE CASCADE
);

CREATE TABLE help_request_tags (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	help_request_id UUID NOT NULL, 
	tag_kind VARCHAR(16) NOT NULL, 
	channel_id UUID, 
	community_id UUID, 
	CONSTRAINT pk_help_request_tags PRIMARY KEY (id), 
	CONSTRAINT uq_help_request_tags_tag UNIQUE (help_request_id, tag_kind, channel_id, community_id), 
	CONSTRAINT fk_help_request_tags_help_request_id_help_requests FOREIGN KEY(help_request_id) REFERENCES help_requests (id) ON DELETE CASCADE, 
	CONSTRAINT fk_help_request_tags_channel_id_channels FOREIGN KEY(channel_id) REFERENCES channels (id) ON DELETE CASCADE, 
	CONSTRAINT fk_help_request_tags_community_id_communities FOREIGN KEY(community_id) REFERENCES communities (id) ON DELETE CASCADE
);

CREATE TABLE messages (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	conversation_id UUID NOT NULL, 
	sender_id UUID, 
	encrypted_body TEXT NOT NULL, 
	encryption_version SMALLINT DEFAULT '1' NOT NULL, 
	moderation_state VARCHAR(24) DEFAULT 'visible' NOT NULL, 
	moderation_reason VARCHAR(24), 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_messages PRIMARY KEY (id), 
	CONSTRAINT fk_messages_conversation_id_conversations FOREIGN KEY(conversation_id) REFERENCES conversations (id) ON DELETE CASCADE, 
	CONSTRAINT fk_messages_sender_id_users FOREIGN KEY(sender_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE post_links (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	post_id UUID NOT NULL, 
	subject_type VARCHAR(16) NOT NULL, 
	subject_id UUID NOT NULL, 
	label VARCHAR(200) NOT NULL, 
	href TEXT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_post_links PRIMARY KEY (id), 
	CONSTRAINT fk_post_links_post_id_posts FOREIGN KEY(post_id) REFERENCES posts (id) ON DELETE CASCADE
);

CREATE TABLE project_conversions (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	predecessor_project_id UUID NOT NULL, 
	successor_project_id UUID NOT NULL, 
	summary TEXT NOT NULL, 
	inventory_note TEXT NOT NULL, 
	permanence_note TEXT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_conversions PRIMARY KEY (id), 
	CONSTRAINT uq_project_conversions_predecessor UNIQUE (predecessor_project_id), 
	CONSTRAINT fk_project_conversions_predecessor_project_id_projects FOREIGN KEY(predecessor_project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_conversions_successor_project_id_projects FOREIGN KEY(successor_project_id) REFERENCES projects (id) ON DELETE CASCADE
);

CREATE TABLE project_edit_requests (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	project_id UUID NOT NULL, 
	title VARCHAR(200) NOT NULL, 
	description TEXT NOT NULL, 
	author_id UUID, 
	status VARCHAR(24) DEFAULT 'open' NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_edit_requests PRIMARY KEY (id), 
	CONSTRAINT fk_project_edit_requests_project_id_projects FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_edit_requests_author_id_users FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE project_inherited_decisions (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	successor_project_id UUID NOT NULL, 
	predecessor_project_id UUID NOT NULL, 
	predecessor_slug VARCHAR(80) NOT NULL, 
	predecessor_title VARCHAR(200) NOT NULL, 
	source_decision_id UUID, 
	kind VARCHAR(64) NOT NULL, 
	kind_label VARCHAR(120) NOT NULL, 
	status VARCHAR(24) NOT NULL, 
	author_username VARCHAR(64) NOT NULL, 
	original_created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	electorate_size INTEGER DEFAULT '0' NOT NULL, 
	yes_count INTEGER DEFAULT '0' NOT NULL, 
	no_count INTEGER DEFAULT '0' NOT NULL, 
	approval_threshold_percent INTEGER DEFAULT '66' NOT NULL, 
	payload JSONB DEFAULT '{}'::jsonb NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_inherited_decisions PRIMARY KEY (id), 
	CONSTRAINT fk_project_inherited_decisions_successor_project_id_projects FOREIGN KEY(successor_project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_inherited_decisions_predecessor_project_id_projects FOREIGN KEY(predecessor_project_id) REFERENCES projects (id) ON DELETE CASCADE
);

CREATE INDEX ix_project_inherited_decisions_successor ON project_inherited_decisions (successor_project_id);

CREATE TABLE project_link_requests (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	source_project_id UUID NOT NULL, 
	target_project_id UUID NOT NULL, 
	relationship_label VARCHAR(120) NOT NULL, 
	summary TEXT NOT NULL, 
	proposed_by UUID, 
	status VARCHAR(24) DEFAULT 'open' NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_link_requests PRIMARY KEY (id), 
	CONSTRAINT fk_project_link_requests_source_project_id_projects FOREIGN KEY(source_project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_link_requests_target_project_id_projects FOREIGN KEY(target_project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_link_requests_proposed_by_users FOREIGN KEY(proposed_by) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE project_links (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	source_project_id UUID NOT NULL, 
	target_project_id UUID NOT NULL, 
	relationship_label VARCHAR(120) NOT NULL, 
	summary TEXT NOT NULL, 
	link_kind VARCHAR(24) NOT NULL, 
	status VARCHAR(24) DEFAULT 'active' NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_links PRIMARY KEY (id), 
	CONSTRAINT fk_project_links_source_project_id_projects FOREIGN KEY(source_project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_links_target_project_id_projects FOREIGN KEY(target_project_id) REFERENCES projects (id) ON DELETE CASCADE
);

CREATE TABLE project_memberships (
	project_id UUID NOT NULL, 
	user_id UUID NOT NULL, 
	is_manager BOOLEAN DEFAULT false NOT NULL, 
	is_manager_candidate BOOLEAN DEFAULT false NOT NULL, 
	joined_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	CONSTRAINT pk_project_memberships PRIMARY KEY (project_id, user_id), 
	CONSTRAINT fk_project_memberships_project_id_projects FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_memberships_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE project_merge_capability_change_requests (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	project_id UUID NOT NULL, 
	decision_id UUID NOT NULL, 
	action VARCHAR(8) NOT NULL, 
	target_user_id UUID NOT NULL, 
	author_id UUID, 
	status VARCHAR(24) DEFAULT 'open' NOT NULL, 
	approval_threshold_percent NUMERIC(5, 2) DEFAULT '66.00' NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_merge_capability_change_requests PRIMARY KEY (id), 
	CONSTRAINT fk_project_merge_capability_change_requests_project_id_projects FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_merge_capability_change_requests_target_user_055f FOREIGN KEY(target_user_id) REFERENCES users (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_merge_capability_change_requests_author_id_users FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE project_merge_capability_members (
	project_id UUID NOT NULL, 
	user_id UUID NOT NULL, 
	source_label VARCHAR(120) DEFAULT 'approved-request' NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_merge_capability_members PRIMARY KEY (project_id, user_id), 
	CONSTRAINT fk_project_merge_capability_members_project_id_projects FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_merge_capability_members_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE project_phase_change_requests (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	project_id UUID NOT NULL, 
	from_phase_id VARCHAR(24) NOT NULL, 
	target_phase_id VARCHAR(24) NOT NULL, 
	change_kind VARCHAR(16) NOT NULL, 
	close_outcome VARCHAR(16), 
	conversion_target_mode VARCHAR(32), 
	conversion_target_subtype VARCHAR(32), 
	conversion_successor_title VARCHAR(200), 
	conversion_successor_description TEXT, 
	reason TEXT NOT NULL, 
	author_id UUID, 
	status VARCHAR(24) DEFAULT 'open' NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_phase_change_requests PRIMARY KEY (id), 
	CONSTRAINT fk_project_phase_change_requests_project_id_projects FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_phase_change_requests_author_id_users FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE project_plans (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	project_id UUID NOT NULL, 
	phase_kind VARCHAR(32) NOT NULL, 
	title VARCHAR(200) NOT NULL, 
	description TEXT NOT NULL, 
	author_id UUID, 
	project_subtype VARCHAR(32), 
	repository_url TEXT, 
	demand_consideration_note TEXT DEFAULT '' NOT NULL, 
	total_cost_label VARCHAR(80), 
	location_id UUID, 
	plan_payload JSONB DEFAULT '{}'::jsonb NOT NULL, 
	is_leading BOOLEAN DEFAULT false NOT NULL, 
	status VARCHAR(24) DEFAULT 'open' NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_plans PRIMARY KEY (id), 
	CONSTRAINT fk_project_plans_project_id_projects FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_plans_author_id_users FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE SET NULL, 
	CONSTRAINT fk_project_plans_location_id_locations FOREIGN KEY(location_id) REFERENCES locations (id) ON DELETE SET NULL
);

CREATE TABLE project_pull_requests (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	project_id UUID NOT NULL, 
	decision_id UUID, 
	title VARCHAR(200) NOT NULL, 
	summary TEXT NOT NULL, 
	pull_request_id VARCHAR(120) NOT NULL, 
	pull_request_url TEXT NOT NULL, 
	author_id UUID, 
	stage VARCHAR(24) DEFAULT 'approval' NOT NULL, 
	merge_id VARCHAR(120), 
	merge_url TEXT, 
	merged_by_user_id UUID, 
	approval_threshold_percent NUMERIC(5, 2) DEFAULT '66.00' NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_pull_requests PRIMARY KEY (id), 
	CONSTRAINT fk_project_pull_requests_project_id_projects FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_pull_requests_author_id_users FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE SET NULL, 
	CONSTRAINT fk_project_pull_requests_merged_by_user_id_users FOREIGN KEY(merged_by_user_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE project_revert_history (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	project_id UUID NOT NULL, 
	target_phase_id VARCHAR(24) NOT NULL, 
	reason TEXT NOT NULL, 
	author_id UUID, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_revert_history PRIMARY KEY (id), 
	CONSTRAINT fk_project_revert_history_project_id_projects FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_revert_history_author_id_users FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE project_service_history_completions (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	project_id UUID NOT NULL, 
	history_item_key VARCHAR(120) NOT NULL, 
	requester_user_id UUID, 
	participant_user_id UUID, 
	role VARCHAR(16) NOT NULL, 
	completion_state VARCHAR(16) NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_service_history_completions PRIMARY KEY (id), 
	CONSTRAINT ck_project_service_history_completions_project_service__604e CHECK ((requester_user_id IS NOT NULL) <> (participant_user_id IS NOT NULL)), 
	CONSTRAINT uq_project_service_history_completions_key UNIQUE (project_id, history_item_key, role, requester_user_id, participant_user_id), 
	CONSTRAINT fk_project_service_history_completions_project_id_projects FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_service_history_completions_requester_user_id_users FOREIGN KEY(requester_user_id) REFERENCES users (id) ON DELETE SET NULL, 
	CONSTRAINT fk_project_service_history_completions_participant_user_5cf3 FOREIGN KEY(participant_user_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE project_service_request_setting_changes (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	project_id UUID NOT NULL, 
	author_id UUID, 
	reason TEXT NOT NULL, 
	enabled BOOLEAN NOT NULL, 
	request_mode VARCHAR(16) NOT NULL, 
	allow_off_schedule_requests BOOLEAN NOT NULL, 
	status VARCHAR(24) DEFAULT 'open' NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_service_request_setting_changes PRIMARY KEY (id), 
	CONSTRAINT fk_project_service_request_setting_changes_project_id_projects FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_service_request_setting_changes_author_id_users FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE project_service_request_settings (
	project_id UUID NOT NULL, 
	enabled BOOLEAN DEFAULT false NOT NULL, 
	request_mode VARCHAR(16) DEFAULT 'both' NOT NULL, 
	allow_off_schedule_requests BOOLEAN DEFAULT false NOT NULL, 
	summary TEXT DEFAULT '' NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_service_request_settings PRIMARY KEY (project_id), 
	CONSTRAINT fk_project_service_request_settings_project_id_projects FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE
);

CREATE TABLE project_signals (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	project_id UUID NOT NULL, 
	user_id UUID NOT NULL, 
	signal_type VARCHAR(16) NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_signals PRIMARY KEY (id), 
	CONSTRAINT uq_project_signals_project_user UNIQUE (project_id, user_id), 
	CONSTRAINT fk_project_signals_project_id_projects FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_signals_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE project_tags (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	project_id UUID NOT NULL, 
	tag_kind VARCHAR(16) NOT NULL, 
	channel_id UUID, 
	community_id UUID, 
	CONSTRAINT pk_project_tags PRIMARY KEY (id), 
	CONSTRAINT uq_project_tags_tag UNIQUE (project_id, tag_kind, channel_id, community_id), 
	CONSTRAINT fk_project_tags_project_id_projects FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_tags_channel_id_channels FOREIGN KEY(channel_id) REFERENCES channels (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_tags_community_id_communities FOREIGN KEY(community_id) REFERENCES communities (id) ON DELETE CASCADE
);

CREATE TABLE project_update_requests (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	project_id UUID NOT NULL, 
	body TEXT NOT NULL, 
	author_id UUID, 
	status VARCHAR(24) DEFAULT 'open' NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_update_requests PRIMARY KEY (id), 
	CONSTRAINT fk_project_update_requests_project_id_projects FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_update_requests_author_id_users FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE project_updates (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	project_id UUID NOT NULL, 
	title VARCHAR(200) NOT NULL, 
	body TEXT NOT NULL, 
	author_id UUID, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_updates PRIMARY KEY (id), 
	CONSTRAINT fk_project_updates_project_id_projects FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_updates_author_id_users FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE project_values (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	project_id UUID NOT NULL, 
	label VARCHAR(200) NOT NULL, 
	author_id UUID, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_values PRIMARY KEY (id), 
	CONSTRAINT fk_project_values_project_id_projects FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_values_author_id_users FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE report_votes (
	report_id UUID NOT NULL, 
	voter_id UUID NOT NULL, 
	vote VARCHAR(8) NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_report_votes PRIMARY KEY (report_id, voter_id), 
	CONSTRAINT fk_report_votes_report_id_reports FOREIGN KEY(report_id) REFERENCES reports (id) ON DELETE CASCADE, 
	CONSTRAINT fk_report_votes_voter_id_users FOREIGN KEY(voter_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE thread_tags (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	thread_id UUID NOT NULL, 
	tag_kind VARCHAR(16) NOT NULL, 
	channel_id UUID, 
	community_id UUID, 
	CONSTRAINT pk_thread_tags PRIMARY KEY (id), 
	CONSTRAINT uq_thread_tags_tag UNIQUE (thread_id, tag_kind, channel_id, community_id), 
	CONSTRAINT fk_thread_tags_thread_id_threads FOREIGN KEY(thread_id) REFERENCES threads (id) ON DELETE CASCADE, 
	CONSTRAINT fk_thread_tags_channel_id_channels FOREIGN KEY(channel_id) REFERENCES channels (id) ON DELETE CASCADE, 
	CONSTRAINT fk_thread_tags_community_id_communities FOREIGN KEY(community_id) REFERENCES communities (id) ON DELETE CASCADE
);

CREATE TABLE detail_links (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	source_kind VARCHAR(24) NOT NULL, 
	source_project_id UUID, 
	source_event_id UUID, 
	target_kind VARCHAR(24) NOT NULL, 
	target_project_id UUID, 
	target_event_id UUID, 
	relationship_label VARCHAR(120) NOT NULL, 
	summary TEXT NOT NULL, 
	link_kind VARCHAR(24) NOT NULL, 
	status VARCHAR(24) DEFAULT 'active' NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_detail_links PRIMARY KEY (id), 
	CONSTRAINT fk_detail_links_source_project_id_projects FOREIGN KEY(source_project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_detail_links_source_event_id_events FOREIGN KEY(source_event_id) REFERENCES events (id) ON DELETE CASCADE, 
	CONSTRAINT fk_detail_links_target_project_id_projects FOREIGN KEY(target_project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_detail_links_target_event_id_events FOREIGN KEY(target_event_id) REFERENCES events (id) ON DELETE CASCADE
);

CREATE TABLE event_activity_history_completions (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	event_id UUID NOT NULL, 
	history_item_key VARCHAR(120) NOT NULL, 
	participant_user_id UUID, 
	role VARCHAR(16) NOT NULL, 
	completion_state VARCHAR(16) NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_event_activity_history_completions PRIMARY KEY (id), 
	CONSTRAINT uq_event_activity_history_completions_key UNIQUE (event_id, history_item_key, role, participant_user_id), 
	CONSTRAINT fk_event_activity_history_completions_event_id_events FOREIGN KEY(event_id) REFERENCES events (id) ON DELETE CASCADE, 
	CONSTRAINT fk_event_activity_history_completions_participant_user_id_users FOREIGN KEY(participant_user_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE event_attendance (
	event_id UUID NOT NULL, 
	user_id UUID NOT NULL, 
	attendance_state VARCHAR(16) NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	CONSTRAINT pk_event_attendance PRIMARY KEY (event_id, user_id), 
	CONSTRAINT fk_event_attendance_event_id_events FOREIGN KEY(event_id) REFERENCES events (id) ON DELETE CASCADE, 
	CONSTRAINT fk_event_attendance_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE event_edit_requests (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	event_id UUID NOT NULL, 
	title VARCHAR(200) NOT NULL, 
	description TEXT NOT NULL, 
	author_id UUID, 
	status VARCHAR(24) DEFAULT 'open' NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_event_edit_requests PRIMARY KEY (id), 
	CONSTRAINT fk_event_edit_requests_event_id_events FOREIGN KEY(event_id) REFERENCES events (id) ON DELETE CASCADE, 
	CONSTRAINT fk_event_edit_requests_author_id_users FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE event_editors (
	event_id UUID NOT NULL, 
	user_id UUID NOT NULL, 
	granted_by UUID, 
	granted_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	CONSTRAINT pk_event_editors PRIMARY KEY (event_id, user_id), 
	CONSTRAINT fk_event_editors_event_id_events FOREIGN KEY(event_id) REFERENCES events (id) ON DELETE CASCADE, 
	CONSTRAINT fk_event_editors_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	CONSTRAINT fk_event_editors_granted_by_users FOREIGN KEY(granted_by) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE event_memberships (
	event_id UUID NOT NULL, 
	user_id UUID NOT NULL, 
	role VARCHAR(24) DEFAULT 'member' NOT NULL, 
	joined_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	CONSTRAINT pk_event_memberships PRIMARY KEY (event_id, user_id), 
	CONSTRAINT fk_event_memberships_event_id_events FOREIGN KEY(event_id) REFERENCES events (id) ON DELETE CASCADE, 
	CONSTRAINT fk_event_memberships_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE event_phase_change_requests (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	event_id UUID NOT NULL, 
	from_phase_id VARCHAR(24) NOT NULL, 
	target_phase_id VARCHAR(24) NOT NULL, 
	change_kind VARCHAR(16) NOT NULL, 
	reason TEXT NOT NULL, 
	author_id UUID, 
	status VARCHAR(24) DEFAULT 'open' NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_event_phase_change_requests PRIMARY KEY (id), 
	CONSTRAINT fk_event_phase_change_requests_event_id_events FOREIGN KEY(event_id) REFERENCES events (id) ON DELETE CASCADE, 
	CONSTRAINT fk_event_phase_change_requests_author_id_users FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE event_plans (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	event_id UUID NOT NULL, 
	title VARCHAR(200) NOT NULL, 
	description TEXT NOT NULL, 
	author_id UUID, 
	demand_consideration_note TEXT DEFAULT '' NOT NULL, 
	location_label VARCHAR(160) NOT NULL, 
	location_id UUID, 
	schedule_payload JSONB DEFAULT '{}'::jsonb NOT NULL, 
	plan_payload JSONB DEFAULT '{}'::jsonb NOT NULL, 
	is_leading BOOLEAN DEFAULT false NOT NULL, 
	status VARCHAR(24) DEFAULT 'open' NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_event_plans PRIMARY KEY (id), 
	CONSTRAINT fk_event_plans_event_id_events FOREIGN KEY(event_id) REFERENCES events (id) ON DELETE CASCADE, 
	CONSTRAINT fk_event_plans_author_id_users FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE SET NULL, 
	CONSTRAINT fk_event_plans_location_id_locations FOREIGN KEY(location_id) REFERENCES locations (id) ON DELETE SET NULL
);

CREATE TABLE event_signals (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	event_id UUID NOT NULL, 
	user_id UUID NOT NULL, 
	signal_type VARCHAR(16) NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_event_signals PRIMARY KEY (id), 
	CONSTRAINT uq_event_signals_event_user UNIQUE (event_id, user_id), 
	CONSTRAINT fk_event_signals_event_id_events FOREIGN KEY(event_id) REFERENCES events (id) ON DELETE CASCADE, 
	CONSTRAINT fk_event_signals_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE event_tags (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	event_id UUID NOT NULL, 
	tag_kind VARCHAR(16) NOT NULL, 
	channel_id UUID, 
	community_id UUID, 
	CONSTRAINT pk_event_tags PRIMARY KEY (id), 
	CONSTRAINT uq_event_tags_tag UNIQUE (event_id, tag_kind, channel_id, community_id), 
	CONSTRAINT fk_event_tags_event_id_events FOREIGN KEY(event_id) REFERENCES events (id) ON DELETE CASCADE, 
	CONSTRAINT fk_event_tags_channel_id_channels FOREIGN KEY(channel_id) REFERENCES channels (id) ON DELETE CASCADE, 
	CONSTRAINT fk_event_tags_community_id_communities FOREIGN KEY(community_id) REFERENCES communities (id) ON DELETE CASCADE
);

CREATE TABLE event_update_requests (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	event_id UUID NOT NULL, 
	body TEXT NOT NULL, 
	author_id UUID, 
	status VARCHAR(24) DEFAULT 'open' NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_event_update_requests PRIMARY KEY (id), 
	CONSTRAINT fk_event_update_requests_event_id_events FOREIGN KEY(event_id) REFERENCES events (id) ON DELETE CASCADE, 
	CONSTRAINT fk_event_update_requests_author_id_users FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE event_updates (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	event_id UUID NOT NULL, 
	title VARCHAR(200) NOT NULL, 
	body TEXT NOT NULL, 
	author_id UUID, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_event_updates PRIMARY KEY (id), 
	CONSTRAINT fk_event_updates_event_id_events FOREIGN KEY(event_id) REFERENCES events (id) ON DELETE CASCADE, 
	CONSTRAINT fk_event_updates_author_id_users FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE event_values (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	event_id UUID NOT NULL, 
	label VARCHAR(200) NOT NULL, 
	author_id UUID, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_event_values PRIMARY KEY (id), 
	CONSTRAINT fk_event_values_event_id_events FOREIGN KEY(event_id) REFERENCES events (id) ON DELETE CASCADE, 
	CONSTRAINT fk_event_values_author_id_users FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE help_request_role_assignments (
	role_id UUID NOT NULL, 
	user_id UUID NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_help_request_role_assignments PRIMARY KEY (role_id, user_id), 
	CONSTRAINT fk_help_request_role_assignments_role_id_help_request_roles FOREIGN KEY(role_id) REFERENCES help_request_roles (id) ON DELETE CASCADE, 
	CONSTRAINT fk_help_request_role_assignments_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE project_activities (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	project_id UUID NOT NULL, 
	linked_plan_id UUID, 
	linked_plan_phase_id VARCHAR(64), 
	linked_request_id UUID, 
	title VARCHAR(200) NOT NULL, 
	author_id UUID, 
	scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	ends_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	is_online BOOLEAN DEFAULT false NOT NULL, 
	location_label VARCHAR(160) NOT NULL, 
	location_id UUID, 
	note TEXT NOT NULL, 
	status VARCHAR(24) DEFAULT 'active' NOT NULL, 
	participant_auto_uncompleted_at TIMESTAMP WITH TIME ZONE, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_activities PRIMARY KEY (id), 
	CONSTRAINT fk_project_activities_project_id_projects FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_activities_linked_plan_id_project_plans FOREIGN KEY(linked_plan_id) REFERENCES project_plans (id) ON DELETE SET NULL, 
	CONSTRAINT fk_project_activities_author_id_users FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE SET NULL, 
	CONSTRAINT fk_project_activities_location_id_locations FOREIGN KEY(location_id) REFERENCES locations (id) ON DELETE SET NULL
);

CREATE TABLE project_edit_request_votes (
	request_id UUID NOT NULL, 
	voter_id UUID NOT NULL, 
	vote VARCHAR(8) NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_edit_request_votes PRIMARY KEY (request_id, voter_id), 
	CONSTRAINT fk_project_edit_request_votes_request_id_project_edit_requests FOREIGN KEY(request_id) REFERENCES project_edit_requests (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_edit_request_votes_voter_id_users FOREIGN KEY(voter_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE project_link_request_votes (
	request_id UUID NOT NULL, 
	voter_id UUID NOT NULL, 
	vote VARCHAR(8) NOT NULL, 
	vote_scope VARCHAR(16) NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_link_request_votes PRIMARY KEY (request_id, voter_id, vote_scope), 
	CONSTRAINT fk_project_link_request_votes_request_id_project_link_requests FOREIGN KEY(request_id) REFERENCES project_link_requests (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_link_request_votes_voter_id_users FOREIGN KEY(voter_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE project_merge_capability_change_votes (
	request_id UUID NOT NULL, 
	voter_id UUID NOT NULL, 
	vote VARCHAR(8) NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_merge_capability_change_votes PRIMARY KEY (request_id, voter_id), 
	CONSTRAINT fk_project_merge_capability_change_votes_request_id_pro_8da2 FOREIGN KEY(request_id) REFERENCES project_merge_capability_change_requests (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_merge_capability_change_votes_voter_id_users FOREIGN KEY(voter_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE project_phase_change_votes (
	request_id UUID NOT NULL, 
	voter_id UUID NOT NULL, 
	vote VARCHAR(8) NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_phase_change_votes PRIMARY KEY (request_id, voter_id), 
	CONSTRAINT fk_project_phase_change_votes_request_id_project_phase__8174 FOREIGN KEY(request_id) REFERENCES project_phase_change_requests (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_phase_change_votes_voter_id_users FOREIGN KEY(voter_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE project_plan_criterion_ratings (
	plan_id UUID NOT NULL, 
	criterion_id VARCHAR(120) NOT NULL, 
	voter_id UUID NOT NULL, 
	rating INTEGER NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_plan_criterion_ratings PRIMARY KEY (plan_id, criterion_id, voter_id), 
	CONSTRAINT fk_project_plan_criterion_ratings_plan_id_project_plans FOREIGN KEY(plan_id) REFERENCES project_plans (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_plan_criterion_ratings_voter_id_users FOREIGN KEY(voter_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE project_plan_value_votes (
	plan_id UUID NOT NULL, 
	value_id UUID NOT NULL, 
	voter_id UUID NOT NULL, 
	vote VARCHAR(8) NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_plan_value_votes PRIMARY KEY (plan_id, value_id, voter_id), 
	CONSTRAINT fk_project_plan_value_votes_plan_id_project_plans FOREIGN KEY(plan_id) REFERENCES project_plans (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_plan_value_votes_value_id_project_values FOREIGN KEY(value_id) REFERENCES project_values (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_plan_value_votes_voter_id_users FOREIGN KEY(voter_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE project_plan_votes (
	plan_id UUID NOT NULL, 
	voter_id UUID NOT NULL, 
	vote VARCHAR(8) NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_plan_votes PRIMARY KEY (plan_id, voter_id), 
	CONSTRAINT fk_project_plan_votes_plan_id_project_plans FOREIGN KEY(plan_id) REFERENCES project_plans (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_plan_votes_voter_id_users FOREIGN KEY(voter_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE project_pull_request_votes (
	request_id UUID NOT NULL, 
	voter_id UUID NOT NULL, 
	vote VARCHAR(8) NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_pull_request_votes PRIMARY KEY (request_id, voter_id), 
	CONSTRAINT fk_project_pull_request_votes_request_id_project_pull_requests FOREIGN KEY(request_id) REFERENCES project_pull_requests (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_pull_request_votes_voter_id_users FOREIGN KEY(voter_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE project_repository_replacement_requests (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	project_id UUID NOT NULL, 
	decision_id UUID NOT NULL, 
	repository_url TEXT NOT NULL, 
	previous_repository_url TEXT DEFAULT '' NOT NULL, 
	reason TEXT NOT NULL, 
	related_pull_request_id UUID NOT NULL, 
	author_id UUID, 
	status VARCHAR(24) DEFAULT 'open' NOT NULL, 
	approval_threshold_percent NUMERIC(5, 2) DEFAULT '66.00' NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_repository_replacement_requests PRIMARY KEY (id), 
	CONSTRAINT fk_project_repository_replacement_requests_project_id_projects FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_repository_replacement_requests_related_pull_a19f FOREIGN KEY(related_pull_request_id) REFERENCES project_pull_requests (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_repository_replacement_requests_author_id_users FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE project_service_request_setting_change_votes (
	request_id UUID NOT NULL, 
	voter_id UUID NOT NULL, 
	vote VARCHAR(8) NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_service_request_setting_change_votes PRIMARY KEY (request_id, voter_id), 
	CONSTRAINT fk_project_service_request_setting_change_votes_request_d3bc FOREIGN KEY(request_id) REFERENCES project_service_request_setting_changes (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_service_request_setting_change_votes_voter_id_users FOREIGN KEY(voter_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE project_update_request_votes (
	request_id UUID NOT NULL, 
	voter_id UUID NOT NULL, 
	vote VARCHAR(8) NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_update_request_votes PRIMARY KEY (request_id, voter_id), 
	CONSTRAINT fk_project_update_request_votes_request_id_project_upda_eb75 FOREIGN KEY(request_id) REFERENCES project_update_requests (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_update_request_votes_voter_id_users FOREIGN KEY(voter_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE project_value_importance_votes (
	value_id UUID NOT NULL, 
	voter_id UUID NOT NULL, 
	importance SMALLINT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_value_importance_votes PRIMARY KEY (value_id, voter_id), 
	CONSTRAINT fk_project_value_importance_votes_value_id_project_values FOREIGN KEY(value_id) REFERENCES project_values (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_value_importance_votes_voter_id_users FOREIGN KEY(voter_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE detail_link_requests (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	source_kind VARCHAR(24) NOT NULL, 
	source_project_id UUID, 
	source_event_id UUID, 
	target_kind VARCHAR(24) NOT NULL, 
	target_project_id UUID, 
	target_event_id UUID, 
	relationship_label VARCHAR(120) NOT NULL, 
	summary TEXT NOT NULL, 
	request_type VARCHAR(24) DEFAULT 'create' NOT NULL, 
	link_id UUID, 
	proposed_by UUID, 
	status VARCHAR(24) DEFAULT 'open' NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_detail_link_requests PRIMARY KEY (id), 
	CONSTRAINT fk_detail_link_requests_source_project_id_projects FOREIGN KEY(source_project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_detail_link_requests_source_event_id_events FOREIGN KEY(source_event_id) REFERENCES events (id) ON DELETE CASCADE, 
	CONSTRAINT fk_detail_link_requests_target_project_id_projects FOREIGN KEY(target_project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_detail_link_requests_target_event_id_events FOREIGN KEY(target_event_id) REFERENCES events (id) ON DELETE CASCADE, 
	CONSTRAINT fk_detail_link_requests_link_id_detail_links FOREIGN KEY(link_id) REFERENCES detail_links (id) ON DELETE CASCADE, 
	CONSTRAINT fk_detail_link_requests_proposed_by_users FOREIGN KEY(proposed_by) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE event_activities (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	event_id UUID NOT NULL, 
	linked_plan_id UUID, 
	linked_plan_phase_id VARCHAR(64), 
	title VARCHAR(200) NOT NULL, 
	author_id UUID, 
	scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	ends_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	is_online BOOLEAN DEFAULT false NOT NULL, 
	location_label VARCHAR(160) NOT NULL, 
	location_id UUID, 
	note TEXT NOT NULL, 
	participant_auto_uncompleted_at TIMESTAMP WITH TIME ZONE, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_event_activities PRIMARY KEY (id), 
	CONSTRAINT fk_event_activities_event_id_events FOREIGN KEY(event_id) REFERENCES events (id) ON DELETE CASCADE, 
	CONSTRAINT fk_event_activities_linked_plan_id_event_plans FOREIGN KEY(linked_plan_id) REFERENCES event_plans (id) ON DELETE SET NULL, 
	CONSTRAINT fk_event_activities_author_id_users FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE SET NULL, 
	CONSTRAINT fk_event_activities_location_id_locations FOREIGN KEY(location_id) REFERENCES locations (id) ON DELETE SET NULL
);

CREATE TABLE event_edit_request_votes (
	request_id UUID NOT NULL, 
	voter_id UUID NOT NULL, 
	vote VARCHAR(8) NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_event_edit_request_votes PRIMARY KEY (request_id, voter_id), 
	CONSTRAINT fk_event_edit_request_votes_request_id_event_edit_requests FOREIGN KEY(request_id) REFERENCES event_edit_requests (id) ON DELETE CASCADE, 
	CONSTRAINT fk_event_edit_request_votes_voter_id_users FOREIGN KEY(voter_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE event_phase_change_votes (
	request_id UUID NOT NULL, 
	voter_id UUID NOT NULL, 
	vote VARCHAR(8) NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_event_phase_change_votes PRIMARY KEY (request_id, voter_id), 
	CONSTRAINT fk_event_phase_change_votes_request_id_event_phase_chan_fdc5 FOREIGN KEY(request_id) REFERENCES event_phase_change_requests (id) ON DELETE CASCADE, 
	CONSTRAINT fk_event_phase_change_votes_voter_id_users FOREIGN KEY(voter_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE event_plan_criterion_ratings (
	plan_id UUID NOT NULL, 
	criterion_id VARCHAR(120) NOT NULL, 
	voter_id UUID NOT NULL, 
	rating INTEGER NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_event_plan_criterion_ratings PRIMARY KEY (plan_id, criterion_id, voter_id), 
	CONSTRAINT fk_event_plan_criterion_ratings_plan_id_event_plans FOREIGN KEY(plan_id) REFERENCES event_plans (id) ON DELETE CASCADE, 
	CONSTRAINT fk_event_plan_criterion_ratings_voter_id_users FOREIGN KEY(voter_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE event_plan_value_votes (
	plan_id UUID NOT NULL, 
	value_id UUID NOT NULL, 
	voter_id UUID NOT NULL, 
	vote VARCHAR(8) NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_event_plan_value_votes PRIMARY KEY (plan_id, value_id, voter_id), 
	CONSTRAINT fk_event_plan_value_votes_plan_id_event_plans FOREIGN KEY(plan_id) REFERENCES event_plans (id) ON DELETE CASCADE, 
	CONSTRAINT fk_event_plan_value_votes_value_id_event_values FOREIGN KEY(value_id) REFERENCES event_values (id) ON DELETE CASCADE, 
	CONSTRAINT fk_event_plan_value_votes_voter_id_users FOREIGN KEY(voter_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE event_plan_votes (
	plan_id UUID NOT NULL, 
	voter_id UUID NOT NULL, 
	vote VARCHAR(8) NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_event_plan_votes PRIMARY KEY (plan_id, voter_id), 
	CONSTRAINT fk_event_plan_votes_plan_id_event_plans FOREIGN KEY(plan_id) REFERENCES event_plans (id) ON DELETE CASCADE, 
	CONSTRAINT fk_event_plan_votes_voter_id_users FOREIGN KEY(voter_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE event_update_request_votes (
	request_id UUID NOT NULL, 
	voter_id UUID NOT NULL, 
	vote VARCHAR(8) NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_event_update_request_votes PRIMARY KEY (request_id, voter_id), 
	CONSTRAINT fk_event_update_request_votes_request_id_event_update_requests FOREIGN KEY(request_id) REFERENCES event_update_requests (id) ON DELETE CASCADE, 
	CONSTRAINT fk_event_update_request_votes_voter_id_users FOREIGN KEY(voter_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE event_value_importance_votes (
	value_id UUID NOT NULL, 
	voter_id UUID NOT NULL, 
	importance SMALLINT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_event_value_importance_votes PRIMARY KEY (value_id, voter_id), 
	CONSTRAINT fk_event_value_importance_votes_value_id_event_values FOREIGN KEY(value_id) REFERENCES event_values (id) ON DELETE CASCADE, 
	CONSTRAINT fk_event_value_importance_votes_voter_id_users FOREIGN KEY(voter_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE project_activity_ratings (
	activity_id UUID NOT NULL, 
	user_id UUID NOT NULL, 
	rating INTEGER NOT NULL, 
	comment TEXT, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_activity_ratings PRIMARY KEY (activity_id, user_id), 
	CONSTRAINT ck_project_activity_ratings_project_activity_ratings_ra_4f21 CHECK (rating >= 1 AND rating <= 5), 
	CONSTRAINT fk_project_activity_ratings_activity_id_project_activities FOREIGN KEY(activity_id) REFERENCES project_activities (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_activity_ratings_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE project_activity_roles (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	activity_id UUID NOT NULL, 
	label VARCHAR(100) NOT NULL, 
	required_count INTEGER NOT NULL, 
	maximum_count INTEGER, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_activity_roles PRIMARY KEY (id), 
	CONSTRAINT fk_project_activity_roles_activity_id_project_activities FOREIGN KEY(activity_id) REFERENCES project_activities (id) ON DELETE CASCADE
);

CREATE TABLE project_repository_replacement_votes (
	request_id UUID NOT NULL, 
	voter_id UUID NOT NULL, 
	vote VARCHAR(8) NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_repository_replacement_votes PRIMARY KEY (request_id, voter_id), 
	CONSTRAINT fk_project_repository_replacement_votes_request_id_proj_f144 FOREIGN KEY(request_id) REFERENCES project_repository_replacement_requests (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_repository_replacement_votes_voter_id_users FOREIGN KEY(voter_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE project_service_requests (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	project_id UUID NOT NULL, 
	requester_id UUID, 
	title VARCHAR(200) NOT NULL, 
	body TEXT NOT NULL, 
	status VARCHAR(24) NOT NULL, 
	scheduled_at TIMESTAMP WITH TIME ZONE, 
	ends_at TIMESTAMP WITH TIME ZONE, 
	linked_activity_id UUID, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_service_requests PRIMARY KEY (id), 
	CONSTRAINT fk_project_service_requests_project_id_projects FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_service_requests_requester_id_users FOREIGN KEY(requester_id) REFERENCES users (id) ON DELETE SET NULL, 
	CONSTRAINT fk_project_service_requests_linked_activity_id_project__8663 FOREIGN KEY(linked_activity_id) REFERENCES project_activities (id) ON DELETE SET NULL
);

CREATE TABLE detail_link_request_votes (
	request_id UUID NOT NULL, 
	voter_id UUID NOT NULL, 
	vote VARCHAR(8) NOT NULL, 
	vote_scope VARCHAR(16) NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_detail_link_request_votes PRIMARY KEY (request_id, voter_id, vote_scope), 
	CONSTRAINT fk_detail_link_request_votes_request_id_detail_link_requests FOREIGN KEY(request_id) REFERENCES detail_link_requests (id) ON DELETE CASCADE, 
	CONSTRAINT fk_detail_link_request_votes_voter_id_users FOREIGN KEY(voter_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE event_activity_ratings (
	activity_id UUID NOT NULL, 
	user_id UUID NOT NULL, 
	rating INTEGER NOT NULL, 
	comment TEXT, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_event_activity_ratings PRIMARY KEY (activity_id, user_id), 
	CONSTRAINT ck_event_activity_ratings_event_activity_ratings_rating_range CHECK (rating >= 1 AND rating <= 5), 
	CONSTRAINT fk_event_activity_ratings_activity_id_event_activities FOREIGN KEY(activity_id) REFERENCES event_activities (id) ON DELETE CASCADE, 
	CONSTRAINT fk_event_activity_ratings_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE event_activity_roles (
	id UUID DEFAULT gen_random_uuid() NOT NULL, 
	activity_id UUID NOT NULL, 
	label VARCHAR(100) NOT NULL, 
	required_count INTEGER NOT NULL, 
	maximum_count INTEGER, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_event_activity_roles PRIMARY KEY (id), 
	CONSTRAINT fk_event_activity_roles_activity_id_event_activities FOREIGN KEY(activity_id) REFERENCES event_activities (id) ON DELETE CASCADE
);

CREATE TABLE project_activity_assignments (
	role_id UUID NOT NULL, 
	user_id UUID NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_project_activity_assignments PRIMARY KEY (role_id, user_id), 
	CONSTRAINT fk_project_activity_assignments_role_id_project_activity_roles FOREIGN KEY(role_id) REFERENCES project_activity_roles (id) ON DELETE CASCADE, 
	CONSTRAINT fk_project_activity_assignments_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE event_activity_assignments (
	role_id UUID NOT NULL, 
	user_id UUID NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_event_activity_assignments PRIMARY KEY (role_id, user_id), 
	CONSTRAINT fk_event_activity_assignments_role_id_event_activity_roles FOREIGN KEY(role_id) REFERENCES event_activity_roles (id) ON DELETE CASCADE, 
	CONSTRAINT fk_event_activity_assignments_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- Feedback submissions (frontend contract; not present in FastAPI models as a table)
CREATE TABLE IF NOT EXISTS feedback_submissions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  category VARCHAR(64) NOT NULL,
  body TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Keep public.users in sync when auth.users are created via Supabase Auth.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  chosen_username text;
BEGIN
  chosen_username := coalesce(
    nullif(trim(new.raw_user_meta_data->>'username'), ''),
    split_part(coalesce(new.email, 'user'), '@', 1)
  );
  -- Ensure uniqueness
  WHILE EXISTS (SELECT 1 FROM public.users WHERE username = chosen_username) LOOP
    chosen_username := chosen_username || '_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
  END LOOP;

  INSERT INTO public.users (id, username, email, bio, is_active)
  VALUES (
    new.id,
    left(chosen_username, 32),
    new.email,
    nullif(trim(new.raw_user_meta_data->>'profile_bio'), ''),
    true
  )
  ON CONFLICT (id) DO UPDATE
    SET email = excluded.email,
        updated_at = now();

  INSERT INTO public.user_settings (user_id)
  VALUES (new.id)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- Helper: current app user id from JWT
CREATE OR REPLACE FUNCTION public.current_app_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT auth.uid();
$$;

-- Basic RLS enablement (Edge Functions use service role for complex orchestration;
-- policies allow authenticated users to read/write their own rows where appropriate).
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_read_all ON public.users FOR SELECT USING (true);
CREATE POLICY users_update_self ON public.users FOR UPDATE USING (id = auth.uid());
CREATE POLICY settings_own ON public.user_settings FOR ALL USING (user_id = auth.uid());
CREATE POLICY follows_read ON public.user_follows FOR SELECT USING (true);
CREATE POLICY follows_write_self ON public.user_follows FOR ALL USING (follower_id = auth.uid());
CREATE POLICY notifications_own ON public.notifications FOR ALL USING (recipient_id = auth.uid());
CREATE POLICY conversation_members_own ON public.conversation_members FOR SELECT USING (user_id = auth.uid());
CREATE POLICY messages_member_read ON public.messages FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.conversation_members cm
    WHERE cm.conversation_id = messages.conversation_id AND cm.user_id = auth.uid()
  )
);
CREATE POLICY feedback_insert_own ON public.feedback_submissions FOR INSERT WITH CHECK (user_id = auth.uid() OR user_id IS NULL);
CREATE POLICY feedback_read_own ON public.feedback_submissions FOR SELECT USING (user_id = auth.uid());
