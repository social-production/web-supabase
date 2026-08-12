/**
 * Bootstrap activity-rail builder for hosted Supabase.
 * Focused on active governance votes the viewer can cast on membership surfaces.
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { measureServerSpan } from './performance.ts';

type RailItem = {
  id: string;
  subjectId: string;
  kind: 'vote';
  title: string;
  href: string;
  meta: string;
  createdAt: string;
  countLabel?: string;
  voteEntityKind: 'project' | 'event';
  voteKindLabel: string;
  voteTargetId: string;
  voteSubKind?: 'criterion' | 'overall';
  planPhaseId?: 'phase-2' | 'phase-3';
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
  requestIds: string[]
) {
  const map = new Map<string, Array<{ vote?: string | number | null; voter_id?: string }>>();
  if (requestIds.length === 0) return map;
  const { data } = await db.from(table).select('request_id, voter_id, vote').in('request_id', requestIds);
  for (const row of data ?? []) {
    const id = String(row.request_id);
    const list = map.get(id) ?? [];
    list.push({ vote: row.vote as string | number | null, voter_id: row.voter_id as string });
    map.set(id, list);
  }
  return map;
}

function viewerAlreadyVoted(
  rows: Array<{ vote?: string | number | null; voter_id?: string }> | undefined,
  userId: string
) {
  return Boolean(rows?.some((row) => row.voter_id === userId));
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

  const { data: projectMemberships } = await db
    .from('project_memberships')
    .select('project_id')
    .eq('user_id', userId);
  const projectIds = [...new Set((projectMemberships ?? []).map((row) => String(row.project_id)))];

  const { data: eventMemberships } = await db
    .from('event_memberships')
    .select('event_id')
    .eq('user_id', userId);
  const eventIds = [...new Set((eventMemberships ?? []).map((row) => String(row.event_id)))];

  if (projectIds.length > 0) {
    const { data: projects } = await db
      .from('projects')
      .select('id, slug, title, current_phase_id, is_closed')
      .in('id', projectIds)
      .eq('is_closed', false);
    const projectById = new Map((projects ?? []).map((p) => [String(p.id), p]));

    // Phase-change votes
    const { data: phaseRequests } = await db
      .from('project_phase_change_requests')
      .select('id, project_id, target_phase_id, created_at, status')
      .in('project_id', projectIds)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(limit);
    const phaseIds = (phaseRequests ?? []).map((r) => String(r.id));
    const phaseVotes = await loadVoteMap(db, 'project_phase_change_votes', phaseIds);
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
    const { data: updateRequests } = await db
      .from('project_update_requests')
      .select('id, project_id, body, created_at, status')
      .in('project_id', projectIds)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(limit);
    const updateIds = (updateRequests ?? []).map((r) => String(r.id));
    const updateVotes = await loadVoteMap(db, 'project_update_request_votes', updateIds);
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
    const { data: editRequests } = await db
      .from('project_edit_requests')
      .select('id, project_id, title, created_at, status')
      .in('project_id', projectIds)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(limit);
    const editIds = (editRequests ?? []).map((r) => String(r.id));
    const editVotes = await loadVoteMap(db, 'project_edit_request_votes', editIds);
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

    // Plan overall votes for planning phases
    const planningProjectIds = (projects ?? [])
      .filter((p) => p.current_phase_id === 'phase-2' || p.current_phase_id === 'phase-3')
      .map((p) => String(p.id));
    if (planningProjectIds.length > 0) {
      const { data: plans } = await db
        .from('project_plans')
        .select('id, project_id, title, created_at, status, phase_kind')
        .in('project_id', planningProjectIds)
        .in('status', ['open', 'proposed', 'pending'])
        .order('created_at', { ascending: false })
        .limit(limit);
      const planIds = (plans ?? []).map((p) => String(p.id));
      const planVotes = await loadVoteMap(db, 'project_plan_votes', planIds);
      for (const plan of plans ?? []) {
        if (viewerAlreadyVoted(planVotes.get(String(plan.id)), userId)) continue;
        const project = projectById.get(String(plan.project_id));
        if (!project) continue;
        const tallies = summarizeRows(planVotes.get(String(plan.id)) ?? []);
        const planPhaseId =
          project.current_phase_id === 'phase-3' ? ('phase-3' as const) : ('phase-2' as const);
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
            'voteSubKind=overall'
          ),
          meta: String(plan.title ?? 'Plan approval').slice(0, 120),
          createdAt: String(plan.created_at),
          countLabel: countLabel(tallies.yes, tallies.no),
          voteEntityKind: 'project',
          voteKindLabel: 'plan',
          voteTargetId: String(plan.id),
          voteSubKind: 'overall',
          planPhaseId
        });
      }
    }
  }

  if (eventIds.length > 0) {
    const { data: events } = await db
      .from('events')
      .select('id, slug, title, current_phase_id')
      .in('id', eventIds);
    const eventById = new Map((events ?? []).map((e) => [String(e.id), e]));

    const { data: phaseRequests } = await db
      .from('event_phase_change_requests')
      .select('id, event_id, target_phase_id, created_at, status')
      .in('event_id', eventIds)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(limit);
    const phaseIds = (phaseRequests ?? []).map((r) => String(r.id));
    const phaseVotes = await loadVoteMap(db, 'event_phase_change_votes', phaseIds);
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

    const { data: updateRequests } = await db
      .from('event_update_requests')
      .select('id, event_id, body, created_at, status')
      .in('event_id', eventIds)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(limit);
    const updateIds = (updateRequests ?? []).map((r) => String(r.id));
    const updateVotes = await loadVoteMap(db, 'event_update_request_votes', updateIds);
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

    const { data: editRequests } = await db
      .from('event_edit_requests')
      .select('id, event_id, title, created_at, status')
      .in('event_id', eventIds)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(limit);
    const editIds = (editRequests ?? []).map((r) => String(r.id));
    const editVotes = await loadVoteMap(db, 'event_edit_request_votes', editIds);
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
        .in('status', ['open', 'proposed', 'pending'])
        .order('created_at', { ascending: false })
        .limit(limit);
      const planIds = (plans ?? []).map((p) => String(p.id));
      const planVotes = await loadVoteMap(db, 'event_plan_votes', planIds);
      for (const plan of plans ?? []) {
        if (viewerAlreadyVoted(planVotes.get(String(plan.id)), userId)) continue;
        const event = eventById.get(String(plan.event_id));
        if (!event) continue;
        const tallies = summarizeRows(planVotes.get(String(plan.id)) ?? []);
        items.push({
          id: String(plan.id),
          subjectId: String(event.id),
          kind: 'vote',
          title: `Plan: ${event.title}`,
          href: voteHref('events', String(event.slug), 'plan', String(plan.id), 'voteSubKind=overall'),
          meta: String(plan.title ?? 'Plan approval').slice(0, 120),
          createdAt: String(plan.created_at),
          countLabel: countLabel(tallies.yes, tallies.no),
          voteEntityKind: 'event',
          voteKindLabel: 'plan',
          voteTargetId: String(plan.id),
          voteSubKind: 'overall'
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

  items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return {
    activityRail: items.slice(0, 24),
    activityRailHistory: []
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
