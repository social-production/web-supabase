/**
 * Bootstrap activity-rail builder for hosted Supabase.
 * Governance votes plus help requests the viewer owns, signed up for, or sees in member scopes.
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { measureServerSpan } from './performance.ts';

type HelpRequestKind = 'help-request-owned' | 'help-request-signup' | 'help-request-open';

type RailItem = {
  id: string;
  subjectId: string;
  kind: 'vote' | 'project' | 'event' | HelpRequestKind;
  title: string;
  href: string;
  meta: string;
  createdAt: string;
  countLabel?: string;
  timeLabel?: string;
  body?: string;
  viewerIsAuthor?: boolean;
  viewerParticipated?: boolean;
  voteEntityKind?: 'project' | 'event';
  voteKindLabel?: string;
  voteTargetId?: string;
  voteSubKind?: 'criterion' | 'overall';
  planPhaseId?: 'phase-2' | 'phase-3';
  projectMode?: string;
  projectSlug?: string;
  eventSlug?: string;
  activityId?: string;
  scheduledAt?: string;
  endsAt?: string;
};

type HelpRequestRow = {
  id: string;
  title: string;
  body: string | null;
  needed_at: string;
  schedule_label: string | null;
  ends_at: string | null;
};

function voteHref(
  surface: 'projects' | 'events',
  slug: string,
  voteKind: string,
  targetId: string,
  extra = ''
) {
  const suffix = extra ? `&${extra}` : '';
  return `/${surface}/${slug}?open=vote&voteKind=${voteKind}&voteTarget=${targetId}${suffix}`;
}

function countLabel(yes: number, no: number) {
  return `${yes} yes · ${no} no`;
}

function summarizeRows(rows: Array<{ vote?: string | number | null }>) {
  let yes = 0;
  let no = 0;
  for (const row of rows) {
    if (row.vote === 'yes' || row.vote === 1 || row.vote === '1') yes += 1;
    else if (row.vote === 'no' || row.vote === -1 || row.vote === '-1') no += 1;
  }
  return { yes, no };
}

async function loadVoteMap(
  db: SupabaseClient,
  table: string,
  requestIds: string[],
  idColumn = 'request_id'
) {
  const map = new Map<string, Array<{ vote?: string | number | null; voter_id?: string }>>();
  if (requestIds.length === 0) return map;
  const { data } = await db.from(table).select(`${idColumn}, voter_id, vote`).in(idColumn, requestIds);
  for (const row of data ?? []) {
    const id = String((row as Record<string, unknown>)[idColumn] ?? '');
    if (!id) continue;
    const list = map.get(id) ?? [];
    list.push({ vote: row.vote as string | number | null, voter_id: row.voter_id as string });
    map.set(id, list);
  }
  return map;
}

async function loadRatedPlanIds(
  db: SupabaseClient,
  table: string,
  planIds: string[],
  userId: string
) {
  const rated = new Set<string>();
  if (planIds.length === 0) return rated;
  const { data } = await db.from(table).select('plan_id').eq('voter_id', userId).in('plan_id', planIds);
  for (const row of data ?? []) {
    rated.add(String(row.plan_id));
  }
  return rated;
}

function viewerAlreadyVoted(
  rows: Array<{ vote?: string | number | null; voter_id?: string }> | undefined,
  userId: string
) {
  return Boolean(rows?.some((row) => row.voter_id === userId));
}

function truncateBody(body: string, limit = 200) {
  const text = body.trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}…`;
}

function helpRequestStillOpen(row: { needed_at?: string | null; ends_at?: string | null }) {
  if (row.ends_at) return new Date(row.ends_at).getTime() > Date.now();
  return true;
}

function helpRequestEnded(row: { ends_at?: string | null }) {
  return Boolean(row.ends_at) && new Date(String(row.ends_at)).getTime() <= Date.now();
}

function helpCountLabel(signed: number, needed: number) {
  return needed > 0 ? `${signed} signed up · ${needed} needed` : `${signed} signed up`;
}

async function loadHelpRoleSummaries(db: SupabaseClient, helpRequestIds: string[]) {
  const summaries = new Map<string, { signed: number; needed: number }>();
  if (helpRequestIds.length === 0) return summaries;
  const { data: roles } = await db
    .from('help_request_roles')
    .select('id, help_request_id, slots')
    .in('help_request_id', helpRequestIds);
  const roleIds = (roles ?? []).map((role) => String(role.id));
  const { data: assignments } = roleIds.length
    ? await db.from('help_request_role_assignments').select('role_id').in('role_id', roleIds)
    : { data: [] as Array<{ role_id: string }> };
  const filledByRole = new Map<string, number>();
  for (const row of assignments ?? []) {
    const roleId = String(row.role_id);
    filledByRole.set(roleId, (filledByRole.get(roleId) ?? 0) + 1);
  }
  for (const role of roles ?? []) {
    const helpRequestId = String(role.help_request_id);
    const current = summaries.get(helpRequestId) ?? { signed: 0, needed: 0 };
    current.needed += Number(role.slots ?? 0);
    current.signed += filledByRole.get(String(role.id)) ?? 0;
    summaries.set(helpRequestId, current);
  }
  return summaries;
}

function toHelpRailItem(
  row: HelpRequestRow,
  kind: HelpRequestKind,
  summary: { signed: number; needed: number } | undefined,
  extra: Partial<RailItem> = {}
): RailItem {
  const neededAt = String(row.needed_at);
  return {
    id: kind === 'help-request-open' ? `open-${row.id}` : String(row.id),
    subjectId: String(row.id),
    kind,
    title: String(row.title),
    href: `/help-requests/${row.id}`,
    meta: extra.meta ?? '',
    createdAt: neededAt,
    timeLabel: String(row.schedule_label || neededAt),
    countLabel: helpCountLabel(summary?.signed ?? 0, summary?.needed ?? 0),
    body: truncateBody(String(row.body ?? '')),
    ...extra
  };
}

async function loadHelpRequestRail(
  db: SupabaseClient,
  userId: string
): Promise<{ activityRail: RailItem[]; activityRailHistory: RailItem[] }> {
  const items: RailItem[] = [];
  const history: RailItem[] = [];
  const ownedIds = new Set<string>();
  const signedUpIds = new Set<string>();

  const { data: authoredRows } = await db
    .from('help_requests')
    .select('id, title, body, needed_at, schedule_label, ends_at')
    .eq('author_id', userId)
    .order('needed_at', { ascending: true })
    .limit(16);
  const authored = (authoredRows ?? []) as HelpRequestRow[];
  const authoredIds = authored.map((row) => String(row.id));
  const authoredSummaries = await loadHelpRoleSummaries(db, authoredIds);
  for (const row of authored) {
    ownedIds.add(String(row.id));
    const summary = authoredSummaries.get(String(row.id));
    if (helpRequestStillOpen(row)) {
      items.push(
        toHelpRailItem(row, 'help-request-owned', summary, {
          meta: 'Your request',
          viewerIsAuthor: true
        })
      );
    } else if (helpRequestEnded(row)) {
      history.push(
        toHelpRailItem(row, 'help-request-owned', summary, {
          meta: 'Your request',
          viewerIsAuthor: true,
          viewerParticipated: true
        })
      );
    }
  }

  const { data: assignmentRows } = await db
    .from('help_request_role_assignments')
    .select('role_id')
    .eq('user_id', userId);
  const assignedRoleIds = [...new Set((assignmentRows ?? []).map((row) => String(row.role_id)))];
  if (assignedRoleIds.length > 0) {
    const { data: assignedRoles } = await db
      .from('help_request_roles')
      .select('help_request_id')
      .in('id', assignedRoleIds);
    const signupIds = [
      ...new Set((assignedRoles ?? []).map((row) => String(row.help_request_id)))
    ].filter((id) => !ownedIds.has(id));
    if (signupIds.length > 0) {
      const { data: signupRows } = await db
        .from('help_requests')
        .select('id, title, body, needed_at, schedule_label, ends_at')
        .in('id', signupIds)
        .order('needed_at', { ascending: true })
        .limit(16);
      const signups = (signupRows ?? []) as HelpRequestRow[];
      const signupSummaries = await loadHelpRoleSummaries(
        db,
        signups.map((row) => String(row.id))
      );
      for (const row of signups) {
        signedUpIds.add(String(row.id));
        const summary = signupSummaries.get(String(row.id));
        if (helpRequestStillOpen(row)) {
          items.push(
            toHelpRailItem(row, 'help-request-signup', summary, { meta: 'You signed up' })
          );
        } else if (helpRequestEnded(row)) {
          history.push(
            toHelpRailItem(row, 'help-request-signup', summary, {
              meta: 'You signed up',
              viewerParticipated: true
            })
          );
        }
      }
    }
  }

  const { data: memberships } = await db
    .from('scope_memberships')
    .select('scope_kind, scope_id')
    .eq('user_id', userId);
  const memberChannelIds = (memberships ?? [])
    .filter((row) => row.scope_kind === 'channel' && row.scope_id)
    .map((row) => String(row.scope_id));
  const memberCommunityIds = (memberships ?? [])
    .filter((row) => row.scope_kind === 'community' && row.scope_id)
    .map((row) => String(row.scope_id));

  const taggedIds = new Set<string>();
  if (memberChannelIds.length > 0) {
    const { data: channelTags } = await db
      .from('help_request_tags')
      .select('help_request_id')
      .in('channel_id', memberChannelIds);
    for (const row of channelTags ?? []) taggedIds.add(String(row.help_request_id));
  }
  if (memberCommunityIds.length > 0) {
    const { data: communityTags } = await db
      .from('help_request_tags')
      .select('help_request_id')
      .in('community_id', memberCommunityIds);
    for (const row of communityTags ?? []) taggedIds.add(String(row.help_request_id));
  }

  const openCandidateIds = [...taggedIds].filter(
    (id) => !ownedIds.has(id) && !signedUpIds.has(id)
  );
  if (openCandidateIds.length > 0) {
    const { data: openRows } = await db
      .from('help_requests')
      .select('id, title, body, needed_at, schedule_label, ends_at')
      .in('id', openCandidateIds)
      .order('needed_at', { ascending: true })
      .limit(16);
    const openHelp = ((openRows ?? []) as HelpRequestRow[]).filter(helpRequestStillOpen).slice(0, 6);
    const openSummaries = await loadHelpRoleSummaries(
      db,
      openHelp.map((row) => String(row.id))
    );
    for (const row of openHelp) {
      items.push(toHelpRailItem(row, 'help-request-open', openSummaries.get(String(row.id))));
    }
  }

  items.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  history.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return {
    activityRail: items.slice(0, 12),
    activityRailHistory: history.slice(0, 10)
  };
}

type ActivityParent = {
  id: string;
  slug: string;
  title: string;
  project_mode?: string | null;
};

type ActivityRow = {
  id: string;
  title: string;
  scheduled_at: string;
  ends_at: string | null;
  project_id?: string;
  event_id?: string;
};

async function loadActivityRoleSummaries(
  db: SupabaseClient,
  roleTable: string,
  assignTable: string,
  activityIds: string[]
) {
  const summaries = new Map<string, { signed: number; needed: number }>();
  if (activityIds.length === 0) return summaries;
  const { data: roles } = await db
    .from(roleTable)
    .select('id, activity_id, required_count')
    .in('activity_id', activityIds);
  const roleIds = (roles ?? []).map((role) => String(role.id));
  const { data: assignments } = roleIds.length
    ? await db.from(assignTable).select('role_id').in('role_id', roleIds)
    : { data: [] as Array<{ role_id: string }> };
  const filledByRole = new Map<string, number>();
  for (const row of assignments ?? []) {
    const roleId = String(row.role_id);
    filledByRole.set(roleId, (filledByRole.get(roleId) ?? 0) + 1);
  }
  for (const role of roles ?? []) {
    const activityId = String(role.activity_id);
    const current = summaries.get(activityId) ?? { signed: 0, needed: 0 };
    current.needed += Number(role.required_count ?? 0);
    current.signed += filledByRole.get(String(role.id)) ?? 0;
    summaries.set(activityId, current);
  }
  return summaries;
}

async function loadViewerAssignedActivityIds(
  db: SupabaseClient,
  userId: string,
  roleTable: string,
  assignTable: string,
  activityIds: string[]
) {
  const assigned = new Set<string>();
  if (activityIds.length === 0) return assigned;
  const { data: roles } = await db.from(roleTable).select('id, activity_id').in('activity_id', activityIds);
  const roleIds = (roles ?? []).map((role) => String(role.id));
  if (roleIds.length === 0) return assigned;
  const { data: assignments } = await db
    .from(assignTable)
    .select('role_id')
    .eq('user_id', userId)
    .in('role_id', roleIds);
  const assignedRoles = new Set((assignments ?? []).map((row) => String(row.role_id)));
  for (const role of roles ?? []) {
    if (assignedRoles.has(String(role.id))) assigned.add(String(role.activity_id));
  }
  return assigned;
}

function toActivityRailItem(
  row: ActivityRow,
  parent: ActivityParent,
  kind: 'project' | 'event',
  summary: { signed: number; needed: number } | undefined,
  extra: Partial<RailItem> = {}
): RailItem {
  const scheduledAt = String(row.scheduled_at);
  const endsAt = row.ends_at ? String(row.ends_at) : scheduledAt;
  const slug = parent.slug;
  const surface = kind === 'project' ? 'projects' : 'events';
  return {
    kind,
    id: String(row.id),
    subjectId: slug,
    title: String(row.title),
    href: `/${surface}/${slug}?activity=${row.id}`,
    meta: parent.title,
    createdAt: scheduledAt,
    scheduledAt,
    endsAt,
    countLabel: extra.countLabel ?? helpCountLabel(summary?.signed ?? 0, summary?.needed ?? 0),
    activityId: String(row.id),
    ...(kind === 'project'
      ? { projectSlug: slug, projectMode: String(parent.project_mode ?? 'productive') }
      : { eventSlug: slug }),
    ...extra
  };
}

async function loadScheduledActivityRail(
  db: SupabaseClient,
  userId: string,
  projectIds: string[],
  eventIds: string[]
): Promise<{ activityRail: RailItem[]; activityRailHistory: RailItem[] }> {
  const nowIso = new Date().toISOString();
  const items: RailItem[] = [];
  const history: RailItem[] = [];

  if (projectIds.length > 0) {
    const { data: projects } = await db
      .from('projects')
      .select('id, slug, title, project_mode, current_phase_id, is_closed')
      .in('id', projectIds);
    const parentById = new Map((projects ?? []).map((row) => [String(row.id), row as ActivityParent]));
    const activeProjectIds = (projects ?? [])
      .filter((row) => !row.is_closed)
      .map((row) => String(row.id));
    if (activeProjectIds.length > 0) {
      const { data: activities } = await db
        .from('project_activities')
        .select('id, title, scheduled_at, ends_at, project_id')
        .in('project_id', activeProjectIds)
        .gt('ends_at', nowIso)
        .order('scheduled_at', { ascending: true })
        .limit(8);
      const rows = (activities ?? []) as ActivityRow[];
      const summaries = await loadActivityRoleSummaries(
        db,
        'project_activity_roles',
        'project_activity_assignments',
        rows.map((row) => String(row.id))
      );
      for (const row of rows) {
        const parent = parentById.get(String(row.project_id));
        if (!parent) continue;
        items.push(toActivityRailItem(row, parent, 'project', summaries.get(String(row.id))));
      }
    }

    const { data: pastActivities } = await db
      .from('project_activities')
      .select('id, title, scheduled_at, ends_at, project_id')
      .in('project_id', projectIds)
      .lte('ends_at', nowIso)
      .order('ends_at', { ascending: false })
      .limit(20);
    const pastRows = (pastActivities ?? []) as ActivityRow[];
    const assigned = await loadViewerAssignedActivityIds(
      db,
      userId,
      'project_activity_roles',
      'project_activity_assignments',
      pastRows.map((row) => String(row.id))
    );
    for (const row of pastRows) {
      const parent = parentById.get(String(row.project_id));
      if (!parent) continue;
      history.push(
        toActivityRailItem(row, parent, 'project', undefined, {
          countLabel: undefined,
          viewerParticipated: assigned.has(String(row.id))
        })
      );
    }
  }

  if (eventIds.length > 0) {
    const { data: events } = await db
      .from('events')
      .select('id, slug, title, current_phase_id')
      .in('id', eventIds);
    const parentById = new Map((events ?? []).map((row) => [String(row.id), row as ActivityParent]));
    const activeEventIds = (events ?? [])
      .filter((row) => row.current_phase_id === 'event-plan' || row.current_phase_id === 'activity')
      .map((row) => String(row.id));
    if (activeEventIds.length > 0) {
      const { data: activities } = await db
        .from('event_activities')
        .select('id, title, scheduled_at, ends_at, event_id')
        .in('event_id', activeEventIds)
        .gt('ends_at', nowIso)
        .order('scheduled_at', { ascending: true })
        .limit(8);
      const rows = (activities ?? []) as ActivityRow[];
      const summaries = await loadActivityRoleSummaries(
        db,
        'event_activity_roles',
        'event_activity_assignments',
        rows.map((row) => String(row.id))
      );
      for (const row of rows) {
        const parent = parentById.get(String(row.event_id));
        if (!parent) continue;
        items.push(toActivityRailItem(row, parent, 'event', summaries.get(String(row.id))));
      }
    }

    const { data: pastActivities } = await db
      .from('event_activities')
      .select('id, title, scheduled_at, ends_at, event_id')
      .in('event_id', eventIds)
      .lte('ends_at', nowIso)
      .order('ends_at', { ascending: false })
      .limit(20);
    const pastRows = (pastActivities ?? []) as ActivityRow[];
    const assigned = await loadViewerAssignedActivityIds(
      db,
      userId,
      'event_activity_roles',
      'event_activity_assignments',
      pastRows.map((row) => String(row.id))
    );
    for (const row of pastRows) {
      const parent = parentById.get(String(row.event_id));
      if (!parent) continue;
      history.push(
        toActivityRailItem(row, parent, 'event', undefined, {
          countLabel: undefined,
          viewerParticipated: assigned.has(String(row.id))
        })
      );
    }
  }

  items.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  history.sort((a, b) => String(b.endsAt ?? b.createdAt).localeCompare(String(a.endsAt ?? a.createdAt)));
  return {
    activityRail: items.slice(0, 8),
    activityRailHistory: history.slice(0, 20)
  };
}

async function buildActivityRailImpl(
  db: SupabaseClient,
  userId: string | null
): Promise<{ activityRail: RailItem[]; activityRailHistory: RailItem[] }> {
  if (!userId) {
    return { activityRail: [], activityRailHistory: [] };
  }

  const items: RailItem[] = [];
  const limit = 8;

  const [{ data: projectMemberships }, { data: eventMemberships }] = await Promise.all([
    db.from('project_memberships').select('project_id').eq('user_id', userId),
    db.from('event_memberships').select('event_id').eq('user_id', userId)
  ]);
  const projectIds = [...new Set((projectMemberships ?? []).map((row) => String(row.project_id)))];
  const eventIds = [...new Set((eventMemberships ?? []).map((row) => String(row.event_id)))];

  if (projectIds.length > 0) {
    const [
      { data: projects },
      { data: phaseRequests },
      { data: updateRequests },
      { data: editRequests }
    ] = await Promise.all([
      db
        .from('projects')
        .select('id, slug, title, current_phase_id, is_closed')
        .in('id', projectIds)
        .eq('is_closed', false),
      db
        .from('project_phase_change_requests')
        .select('id, project_id, target_phase_id, created_at, status')
        .in('project_id', projectIds)
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(limit),
      db
        .from('project_update_requests')
        .select('id, project_id, body, created_at, status')
        .in('project_id', projectIds)
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(limit),
      db
        .from('project_edit_requests')
        .select('id, project_id, title, created_at, status')
        .in('project_id', projectIds)
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(limit)
    ]);
    const projectById = new Map((projects ?? []).map((p) => [String(p.id), p]));
    const phaseIds = (phaseRequests ?? []).map((r) => String(r.id));
    const updateIds = (updateRequests ?? []).map((r) => String(r.id));
    const editIds = (editRequests ?? []).map((r) => String(r.id));
    const [phaseVotes, updateVotes, editVotes] = await Promise.all([
      loadVoteMap(db, 'project_phase_change_votes', phaseIds),
      loadVoteMap(db, 'project_update_request_votes', updateIds),
      loadVoteMap(db, 'project_edit_request_votes', editIds)
    ]);

    // Phase-change votes
    for (const req of phaseRequests ?? []) {
      if (viewerAlreadyVoted(phaseVotes.get(String(req.id)), userId)) continue;
      const project = projectById.get(String(req.project_id));
      if (!project) continue;
      const tallies = summarizeRows(phaseVotes.get(String(req.id)) ?? []);
      items.push({
        id: String(req.id),
        subjectId: String(project.id),
        kind: 'vote',
        title: `Phase change: ${project.title}`,
        href: voteHref('projects', String(project.slug), 'phase_change', String(req.id)),
        meta: `Advance to ${String(req.target_phase_id).replace(/-/g, ' ')}?`,
        createdAt: String(req.created_at),
        countLabel: countLabel(tallies.yes, tallies.no),
        voteEntityKind: 'project',
        voteKindLabel: 'phase_change',
        voteTargetId: String(req.id)
      });
    }

    // Update votes
    for (const req of updateRequests ?? []) {
      if (viewerAlreadyVoted(updateVotes.get(String(req.id)), userId)) continue;
      const project = projectById.get(String(req.project_id));
      if (!project) continue;
      const tallies = summarizeRows(updateVotes.get(String(req.id)) ?? []);
      items.push({
        id: String(req.id),
        subjectId: String(project.id),
        kind: 'vote',
        title: `Update: ${project.title}`,
        href: voteHref('projects', String(project.slug), 'update', String(req.id)),
        meta: String(req.body ?? 'Proposed update').slice(0, 120),
        createdAt: String(req.created_at),
        countLabel: countLabel(tallies.yes, tallies.no),
        voteEntityKind: 'project',
        voteKindLabel: 'update',
        voteTargetId: String(req.id)
      });
    }

    // Edit votes
    for (const req of editRequests ?? []) {
      if (viewerAlreadyVoted(editVotes.get(String(req.id)), userId)) continue;
      const project = projectById.get(String(req.project_id));
      if (!project) continue;
      const tallies = summarizeRows(editVotes.get(String(req.id)) ?? []);
      items.push({
        id: String(req.id),
        subjectId: String(project.id),
        kind: 'vote',
        title: `Edit: ${project.title}`,
        href: voteHref('projects', String(project.slug), 'edit', String(req.id)),
        meta: String(req.title ?? 'Proposed edit').slice(0, 120),
        createdAt: String(req.created_at),
        countLabel: countLabel(tallies.yes, tallies.no),
        voteEntityKind: 'project',
        voteKindLabel: 'edit',
        voteTargetId: String(req.id)
      });
    }

    // Plan votes for planning phases — assess first, then overall
    const planningProjectIds = (projects ?? [])
      .filter((p) => p.current_phase_id === 'phase-2' || p.current_phase_id === 'phase-3')
      .map((p) => String(p.id));
    if (planningProjectIds.length > 0) {
      const { data: plans } = await db
        .from('project_plans')
        .select('id, project_id, title, created_at, status, phase_kind')
        .in('project_id', planningProjectIds)
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(limit);
      const planIds = (plans ?? []).map((p) => String(p.id));
      const [planVotes, ratedPlanIds] = await Promise.all([
        loadVoteMap(db, 'project_plan_votes', planIds, 'plan_id'),
        loadRatedPlanIds(db, 'project_plan_criterion_ratings', planIds, userId)
      ]);
      for (const plan of plans ?? []) {
        if (viewerAlreadyVoted(planVotes.get(String(plan.id)), userId)) continue;
        const project = projectById.get(String(plan.project_id));
        if (!project) continue;
        const tallies = summarizeRows(planVotes.get(String(plan.id)) ?? []);
        const planPhaseId =
          project.current_phase_id === 'phase-3' ? ('phase-3' as const) : ('phase-2' as const);
        const voteSubKind = ratedPlanIds.has(String(plan.id)) ? ('overall' as const) : ('criterion' as const);
        items.push({
          id: String(plan.id),
          subjectId: String(project.id),
          kind: 'vote',
          title: `Plan: ${project.title}`,
          href: voteHref(
            'projects',
            String(project.slug),
            'plan',
            String(plan.id),
            voteSubKind === 'overall' ? 'voteSubKind=overall&assess=1' : 'voteSubKind=criterion'
          ),
          meta:
            voteSubKind === 'criterion'
              ? 'Assess and approve this plan'
              : `Approve “${String(plan.title ?? 'this plan')}”?`,
          createdAt: String(plan.created_at),
          countLabel: countLabel(tallies.yes, tallies.no),
          voteEntityKind: 'project',
          voteKindLabel: 'plan',
          voteTargetId: String(plan.id),
          voteSubKind,
          planPhaseId
        });
      }
    }
  }

  if (eventIds.length > 0) {
    const [
      { data: events },
      { data: phaseRequests },
      { data: updateRequests },
      { data: editRequests }
    ] = await Promise.all([
      db.from('events').select('id, slug, title, current_phase_id').in('id', eventIds),
      db
        .from('event_phase_change_requests')
        .select('id, event_id, target_phase_id, created_at, status')
        .in('event_id', eventIds)
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(limit),
      db
        .from('event_update_requests')
        .select('id, event_id, body, created_at, status')
        .in('event_id', eventIds)
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(limit),
      db
        .from('event_edit_requests')
        .select('id, event_id, title, created_at, status')
        .in('event_id', eventIds)
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(limit)
    ]);
    const eventById = new Map((events ?? []).map((e) => [String(e.id), e]));
    const phaseIds = (phaseRequests ?? []).map((r) => String(r.id));
    const updateIds = (updateRequests ?? []).map((r) => String(r.id));
    const editIds = (editRequests ?? []).map((r) => String(r.id));
    const [phaseVotes, updateVotes, editVotes] = await Promise.all([
      loadVoteMap(db, 'event_phase_change_votes', phaseIds),
      loadVoteMap(db, 'event_update_request_votes', updateIds),
      loadVoteMap(db, 'event_edit_request_votes', editIds)
    ]);

    for (const req of phaseRequests ?? []) {
      if (viewerAlreadyVoted(phaseVotes.get(String(req.id)), userId)) continue;
      const event = eventById.get(String(req.event_id));
      if (!event) continue;
      const tallies = summarizeRows(phaseVotes.get(String(req.id)) ?? []);
      items.push({
        id: String(req.id),
        subjectId: String(event.id),
        kind: 'vote',
        title: `Phase change: ${event.title}`,
        href: voteHref('events', String(event.slug), 'phase_change', String(req.id)),
        meta: `Advance to ${String(req.target_phase_id).replace(/-/g, ' ')}?`,
        createdAt: String(req.created_at),
        countLabel: countLabel(tallies.yes, tallies.no),
        voteEntityKind: 'event',
        voteKindLabel: 'phase_change',
        voteTargetId: String(req.id)
      });
    }

    for (const req of updateRequests ?? []) {
      if (viewerAlreadyVoted(updateVotes.get(String(req.id)), userId)) continue;
      const event = eventById.get(String(req.event_id));
      if (!event) continue;
      const tallies = summarizeRows(updateVotes.get(String(req.id)) ?? []);
      items.push({
        id: String(req.id),
        subjectId: String(event.id),
        kind: 'vote',
        title: `Update: ${event.title}`,
        href: voteHref('events', String(event.slug), 'update', String(req.id)),
        meta: String(req.body ?? 'Proposed update').slice(0, 120),
        createdAt: String(req.created_at),
        countLabel: countLabel(tallies.yes, tallies.no),
        voteEntityKind: 'event',
        voteKindLabel: 'update',
        voteTargetId: String(req.id)
      });
    }

    for (const req of editRequests ?? []) {
      if (viewerAlreadyVoted(editVotes.get(String(req.id)), userId)) continue;
      const event = eventById.get(String(req.event_id));
      if (!event) continue;
      const tallies = summarizeRows(editVotes.get(String(req.id)) ?? []);
      items.push({
        id: String(req.id),
        subjectId: String(event.id),
        kind: 'vote',
        title: `Edit: ${event.title}`,
        href: voteHref('events', String(event.slug), 'edit', String(req.id)),
        meta: String(req.title ?? 'Proposed edit').slice(0, 120),
        createdAt: String(req.created_at),
        countLabel: countLabel(tallies.yes, tallies.no),
        voteEntityKind: 'event',
        voteKindLabel: 'edit',
        voteTargetId: String(req.id)
      });
    }

    const planningEventIds = (events ?? [])
      .filter((e) => e.current_phase_id === 'event-plan')
      .map((e) => String(e.id));
    if (planningEventIds.length > 0) {
      const { data: plans } = await db
        .from('event_plans')
        .select('id, event_id, title, created_at, status')
        .in('event_id', planningEventIds)
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(limit);
      const planIds = (plans ?? []).map((p) => String(p.id));
      const [planVotes, ratedPlanIds] = await Promise.all([
        loadVoteMap(db, 'event_plan_votes', planIds, 'plan_id'),
        loadRatedPlanIds(db, 'event_plan_criterion_ratings', planIds, userId)
      ]);
      for (const plan of plans ?? []) {
        if (viewerAlreadyVoted(planVotes.get(String(plan.id)), userId)) continue;
        const event = eventById.get(String(plan.event_id));
        if (!event) continue;
        const tallies = summarizeRows(planVotes.get(String(plan.id)) ?? []);
        const voteSubKind = ratedPlanIds.has(String(plan.id)) ? ('overall' as const) : ('criterion' as const);
        items.push({
          id: String(plan.id),
          subjectId: String(event.id),
          kind: 'vote',
          title: `Plan: ${event.title}`,
          href: voteHref(
            'events',
            String(event.slug),
            'plan',
            String(plan.id),
            voteSubKind === 'overall' ? 'voteSubKind=overall&assess=1' : 'voteSubKind=criterion'
          ),
          meta:
            voteSubKind === 'criterion'
              ? 'Assess and approve this plan'
              : `Approve “${String(plan.title ?? 'this plan')}”?`,
          createdAt: String(plan.created_at),
          countLabel: countLabel(tallies.yes, tallies.no),
          voteEntityKind: 'event',
          voteKindLabel: 'plan',
          voteTargetId: String(plan.id),
          voteSubKind
        });
      }
    }
  }

  // Open link / sever-link requests the viewer can vote on (either side).
  const { data: linkRequests } = await db
    .from('detail_link_requests')
    .select(
      'id, created_at, summary, request_type, source_kind, target_kind, source_project_id, source_event_id, target_project_id, target_event_id'
    )
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(limit * 3);

  if ((linkRequests ?? []).length > 0) {
    const projectIdSet = new Set(projectIds);
    const eventIdSet = new Set(eventIds);
    const linkIds = (linkRequests ?? []).map((r) => String(r.id));
    const { data: linkVoteRows } = await db
      .from('detail_link_request_votes')
      .select('request_id, voter_id, vote, vote_scope')
      .in('request_id', linkIds);

    const votesByRequestScope = new Map<
      string,
      Array<{ vote?: string | number | null; voter_id?: string }>
    >();
    const talliesByRequest = new Map<string, { yes: number; no: number }>();
    for (const row of linkVoteRows ?? []) {
      const requestId = String(row.request_id);
      const scopeKey = `${requestId}:${row.vote_scope}`;
      const scoped = votesByRequestScope.get(scopeKey) ?? [];
      scoped.push({ vote: row.vote as string | number | null, voter_id: row.voter_id as string });
      votesByRequestScope.set(scopeKey, scoped);
      const tally = talliesByRequest.get(requestId) ?? { yes: 0, no: 0 };
      if (row.vote === 'yes' || row.vote === 1 || row.vote === '1') tally.yes += 1;
      else if (row.vote === 'no' || row.vote === -1 || row.vote === '-1') tally.no += 1;
      talliesByRequest.set(requestId, tally);
    }

    const neededProjectIds = new Set<string>();
    const neededEventIds = new Set<string>();
    for (const req of linkRequests ?? []) {
      if (req.source_kind === 'project' && req.source_project_id) {
        neededProjectIds.add(String(req.source_project_id));
      }
      if (req.target_kind === 'project' && req.target_project_id) {
        neededProjectIds.add(String(req.target_project_id));
      }
      if (req.source_kind === 'event' && req.source_event_id) {
        neededEventIds.add(String(req.source_event_id));
      }
      if (req.target_kind === 'event' && req.target_event_id) {
        neededEventIds.add(String(req.target_event_id));
      }
    }

    const { data: linkProjects } = neededProjectIds.size
      ? await db.from('projects').select('id, slug, title').in('id', [...neededProjectIds])
      : { data: [] as Array<{ id: string; slug: string; title: string }> };
    const { data: linkEvents } = neededEventIds.size
      ? await db.from('events').select('id, slug, title').in('id', [...neededEventIds])
      : { data: [] as Array<{ id: string; slug: string; title: string }> };
    const projectMeta = new Map((linkProjects ?? []).map((p) => [String(p.id), p]));
    const eventMeta = new Map((linkEvents ?? []).map((e) => [String(e.id), e]));

    for (const req of linkRequests ?? []) {
      const sourceIsProject = req.source_kind === 'project';
      const targetIsProject = req.target_kind === 'project';
      const sourceId = String(
        (sourceIsProject ? req.source_project_id : req.source_event_id) ?? ''
      );
      const targetId = String(
        (targetIsProject ? req.target_project_id : req.target_event_id) ?? ''
      );
      const viewerOnSource = sourceIsProject
        ? projectIdSet.has(sourceId)
        : eventIdSet.has(sourceId);
      const viewerOnTarget = targetIsProject
        ? projectIdSet.has(targetId)
        : eventIdSet.has(targetId);
      if (!viewerOnSource && !viewerOnTarget) continue;

      const scopes: Array<{
        voteScope: 'source' | 'target';
        entityKind: 'project' | 'event';
        entityId: string;
      }> = [];
      if (viewerOnSource) {
        scopes.push({
          voteScope: 'source',
          entityKind: sourceIsProject ? 'project' : 'event',
          entityId: sourceId
        });
      }
      if (viewerOnTarget) {
        scopes.push({
          voteScope: 'target',
          entityKind: targetIsProject ? 'project' : 'event',
          entityId: targetId
        });
      }

      const requestType = String(req.request_type ?? 'create');
      const tallies = talliesByRequest.get(String(req.id)) ?? { yes: 0, no: 0 };

      for (const scope of scopes) {
        if (
          viewerAlreadyVoted(
            votesByRequestScope.get(`${req.id}:${scope.voteScope}`),
            userId
          )
        ) {
          continue;
        }
        const subject =
          scope.entityKind === 'project'
            ? projectMeta.get(scope.entityId)
            : eventMeta.get(scope.entityId);
        if (!subject) continue;
        const counterpartId = scope.voteScope === 'source' ? targetId : sourceId;
        const counterpartKind =
          scope.voteScope === 'source'
            ? targetIsProject
              ? 'project'
              : 'event'
            : sourceIsProject
              ? 'project'
              : 'event';
        const counterpart =
          counterpartKind === 'project'
            ? projectMeta.get(counterpartId)
            : eventMeta.get(counterpartId);
        const surface = scope.entityKind === 'project' ? 'projects' : 'events';
        items.push({
          id: `${req.id}:${scope.voteScope}`,
          subjectId: String(subject.slug),
          kind: 'vote',
          title: String(subject.title),
          href: `/${surface}/${subject.slug}?tab=links&linkRequest=${req.id}`,
          meta: `${requestType === 'sever' ? 'Sever link' : 'Link vote'} · ${counterpart?.title ?? 'linked record'}`,
          createdAt: String(req.created_at),
          countLabel: countLabel(tallies.yes, tallies.no),
          voteEntityKind: scope.entityKind,
          voteKindLabel: requestType === 'sever' ? 'link_sever' : 'link',
          voteTargetId: String(req.id)
        });
      }
    }
  }

  // Software governance votes for projects the viewer belongs to.
  if (projectIds.length > 0) {
    const { data: projects } = await db
      .from('projects')
      .select('id, slug, title')
      .in('id', projectIds)
      .eq('is_closed', false);
    const projectById = new Map((projects ?? []).map((p) => [String(p.id), p]));

    const { data: pullRequests } = await db
      .from('project_pull_requests')
      .select('id, project_id, title, summary, stage, created_at')
      .in('project_id', projectIds)
      .in('stage', ['approval', 'confirmation', 'awaiting-merge'])
      .order('created_at', { ascending: false })
      .limit(limit);
    const prIds = (pullRequests ?? []).map((p) => String(p.id));
    const prVotes = await loadVoteMap(db, 'project_pull_request_votes', prIds);
    const { data: mergeMembers } = await db
      .from('project_merge_capability_members')
      .select('project_id, user_id')
      .eq('user_id', userId)
      .in('project_id', projectIds);
    const mergeCapableProjects = new Set(
      (mergeMembers ?? []).map((row) => String(row.project_id))
    );

    for (const pr of pullRequests ?? []) {
      const project = projectById.get(String(pr.project_id));
      if (!project) continue;
      const stage = String(pr.stage);
      if (stage === 'awaiting-merge') {
        if (!mergeCapableProjects.has(String(pr.project_id))) continue;
        items.push({
          id: String(pr.id),
          subjectId: String(project.id),
          kind: 'vote',
          title: `Merge needed: ${project.title}`,
          href: voteHref('projects', String(project.slug), 'pull_request_merge', String(pr.id)),
          meta: String(pr.title ?? 'Record merge').slice(0, 120),
          createdAt: String(pr.created_at),
          voteEntityKind: 'project',
          voteKindLabel: 'pull_request_merge',
          voteTargetId: String(pr.id)
        });
        continue;
      }
      if (viewerAlreadyVoted(prVotes.get(String(pr.id)), userId)) continue;
      const tallies = summarizeRows(prVotes.get(String(pr.id)) ?? []);
      items.push({
        id: String(pr.id),
        subjectId: String(project.id),
        kind: 'vote',
        title: `Pull request: ${project.title}`,
        href: voteHref('projects', String(project.slug), 'pull_request', String(pr.id)),
        meta: String(pr.title ?? pr.summary ?? 'Pull request vote').slice(0, 120),
        createdAt: String(pr.created_at),
        countLabel: countLabel(tallies.yes, tallies.no),
        voteEntityKind: 'project',
        voteKindLabel: 'pull_request',
        voteTargetId: String(pr.id)
      });
    }

    const { data: mergeRequests } = await db
      .from('project_merge_capability_change_requests')
      .select('id, project_id, action, created_at, status')
      .in('project_id', projectIds)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(limit);
    const mergeReqIds = (mergeRequests ?? []).map((r) => String(r.id));
    const mergeVotes = await loadVoteMap(db, 'project_merge_capability_change_votes', mergeReqIds);
    for (const req of mergeRequests ?? []) {
      if (viewerAlreadyVoted(mergeVotes.get(String(req.id)), userId)) continue;
      const project = projectById.get(String(req.project_id));
      if (!project) continue;
      const tallies = summarizeRows(mergeVotes.get(String(req.id)) ?? []);
      items.push({
        id: String(req.id),
        subjectId: String(project.id),
        kind: 'vote',
        title: `Merge capability: ${project.title}`,
        href: voteHref('projects', String(project.slug), 'merge_capability', String(req.id)),
        meta: req.action === 'grant' ? 'Grant merge capability' : 'Revoke merge capability',
        createdAt: String(req.created_at),
        countLabel: countLabel(tallies.yes, tallies.no),
        voteEntityKind: 'project',
        voteKindLabel: 'merge_capability',
        voteTargetId: String(req.id)
      });
    }

    const { data: repoRequests } = await db
      .from('project_repository_replacement_requests')
      .select('id, project_id, repository_url, reason, created_at, status')
      .in('project_id', projectIds)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(limit);
    const repoReqIds = (repoRequests ?? []).map((r) => String(r.id));
    const repoVotes = await loadVoteMap(db, 'project_repository_replacement_votes', repoReqIds);
    for (const req of repoRequests ?? []) {
      if (viewerAlreadyVoted(repoVotes.get(String(req.id)), userId)) continue;
      const project = projectById.get(String(req.project_id));
      if (!project) continue;
      const tallies = summarizeRows(repoVotes.get(String(req.id)) ?? []);
      items.push({
        id: String(req.id),
        subjectId: String(project.id),
        kind: 'vote',
        title: `Repository: ${project.title}`,
        href: voteHref('projects', String(project.slug), 'repository_replacement', String(req.id)),
        meta: String(req.repository_url ?? req.reason ?? 'Repository replacement').slice(0, 120),
        createdAt: String(req.created_at),
        countLabel: countLabel(tallies.yes, tallies.no),
        voteEntityKind: 'project',
        voteKindLabel: 'repository_replacement',
        voteTargetId: String(req.id)
      });
    }
  }

  const [helpRail, activityRailItems] = await Promise.all([
    loadHelpRequestRail(db, userId),
    loadScheduledActivityRail(db, userId, projectIds, eventIds)
  ]);

  items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return {
    activityRail: [...activityRailItems.activityRail, ...helpRail.activityRail, ...items.slice(0, 24)],
    activityRailHistory: [...activityRailItems.activityRailHistory, ...helpRail.activityRailHistory]
  };
}

export async function buildActivityRail(
  db: SupabaseClient,
  userId: string | null
): Promise<{ activityRail: RailItem[]; activityRailHistory: RailItem[] }> {
  return measureServerSpan(
    'activity-rail.build',
    () => buildActivityRailImpl(db, userId),
    { authenticated: Boolean(userId) }
  );
}
