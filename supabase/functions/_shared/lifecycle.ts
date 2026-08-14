/**
 * Real project/event lifecycle mutations replacing persistedAsActivityLog stubs.
 * Quorum/decision math mirrors FastAPI governance_votes helpers.
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { closeAndMaybeConvert } from './conversion.ts';
import { displayStageLabel } from './phases.ts';
import {
  ensureEventAdvanceAllowed,
  ensureProjectAdvanceAllowed,
  resolveProjectSubtype
} from './lifecycleGates.ts';
import {
  canStillPass,
  eventPopulation,
  isPassing,
  normalizeYesNo,
  projectPopulation,
  recordMeaningfulAction,
  summarizeVotes
} from './votes.ts';

async function getProject(db: SupabaseClient, slug: string) {
  const { data } = await db.from('projects').select('*').eq('slug', slug).maybeSingle();
  if (!data) throw new Error('not_found');
  return data;
}

async function getEvent(db: SupabaseClient, slug: string) {
  const { data } = await db.from('events').select('*').eq('slug', slug).maybeSingle();
  if (!data) throw new Error('not_found');
  return data;
}

async function projectMembership(db: SupabaseClient, projectId: string, userId: string) {
  const { data } = await db
    .from('project_memberships')
    .select('user_id, is_manager')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .maybeSingle();
  return data;
}

async function governedProjectForMember(db: SupabaseClient, slug: string, userId: string) {
  const project = await getProject(db, slug);
  if (String(project.project_mode) === 'personal-service') {
    throw new Error('personal_service_governance_disabled');
  }
  if (!(await projectMembership(db, project.id, userId))) throw new Error('forbidden');
  return project;
}

function voteLabel(vote: unknown): 'yes' | 'no' {
  const n = normalizeYesNo(vote);
  if (n === 0) throw new Error('invalid_vote');
  return n === 1 ? 'yes' : 'no';
}

function isClearVote(vote: unknown): boolean {
  return (
    vote == null ||
    vote === '' ||
    vote === 'neutral' ||
    vote === 0 ||
    vote === '0'
  );
}

async function upsertScopedVote(
  db: SupabaseClient,
  table: string,
  conflict: string,
  row: Record<string, unknown>
) {
  const { error } = await db.from(table).upsert(row, { onConflict: conflict });
  if (error) throw error;
}

async function castOverallPlanVote(
  db: SupabaseClient,
  table: 'project_plan_votes' | 'event_plan_votes',
  planId: string,
  userId: string,
  vote: unknown
) {
  if (isClearVote(vote)) {
    const { error } = await db.from(table).delete().eq('plan_id', planId).eq('voter_id', userId);
    if (error) throw error;
    return;
  }
  await upsertScopedVote(db, table, 'plan_id,voter_id', {
    plan_id: planId,
    voter_id: userId,
    vote: voteLabel(vote)
  });
}

export async function castProjectPlanVote(
  db: SupabaseClient,
  userId: string,
  slug: string,
  planId: string,
  vote: unknown
) {
  const project = await governedProjectForMember(db, slug, userId);
  await castOverallPlanVote(db, 'project_plan_votes', planId, userId, vote);
  const { data: votes } = await db.from('project_plan_votes').select('vote').eq('plan_id', planId);
  const stats = summarizeVotes(votes ?? []);
  const population = await projectPopulation(db, project.id);
  if (isPassing(stats, population)) {
    await db.from('project_plans').update({ status: 'approved', is_leading: true }).eq('id', planId);
    await db
      .from('project_plans')
      .update({ is_leading: false })
      .eq('project_id', project.id)
      .neq('id', planId);
    const { data: leading } = await db
      .from('project_plans')
      .select('author_id, project_subtype, repository_url, plan_payload')
      .eq('id', planId)
      .maybeSingle();
    const payload = (leading?.plan_payload ?? {}) as Record<string, unknown>;
    const isSoftware =
      String(leading?.project_subtype ?? '') === 'software' ||
      String(payload.projectSubtype ?? '') === 'software' ||
      Boolean(leading?.repository_url ?? payload.repositoryUrl);
    if (isSoftware && leading?.author_id) {
      await db.from('project_merge_capability_members').upsert({
        project_id: project.id,
        user_id: leading.author_id,
        source_label: 'leading-plan-author'
      });
    }
  } else if (!canStillPass(stats, population)) {
    await db.from('project_plans').update({ status: 'rejected' }).eq('id', planId);
  }
  await recordMeaningfulAction(db, userId, 'project-plan-vote', { planId, slug });
  return { ok: true, ...stats, passed: isPassing(stats, population) };
}

export async function syncEventScheduleFromLeadingPlan(
  db: SupabaseClient,
  eventId: string,
  planId: string
) {
  const { data: plan } = await db
    .from('event_plans')
    .select('schedule_payload, location_label, location_id')
    .eq('id', planId)
    .maybeSingle();
  if (!plan) return;
  const payload = (plan.schedule_payload ?? {}) as Record<string, unknown>;
  const scheduledAt = String(payload.startAtUtc ?? payload.start_at_utc ?? '').trim();
  const endsAt = String(payload.endAtUtc ?? payload.end_at_utc ?? '').trim();
  const update: Record<string, unknown> = {};
  if (scheduledAt) update.scheduled_at = scheduledAt;
  if (endsAt) {
    if (scheduledAt && Date.parse(endsAt) <= Date.parse(scheduledAt)) {
      throw new Error('ends_at must be after scheduled_at');
    }
    update.ends_at = endsAt;
  }
  const locationLabel = String(plan.location_label ?? '').trim();
  if (locationLabel) update.location_label = locationLabel;
  if (plan.location_id) update.location_id = plan.location_id;
  if (Object.keys(update).length === 0) return;
  const { error } = await db.from('events').update(update).eq('id', eventId);
  if (error) throw error;
}

export async function castEventPlanVote(
  db: SupabaseClient,
  userId: string,
  slug: string,
  planId: string,
  vote: unknown
) {
  const event = await getEvent(db, slug);
  await castOverallPlanVote(db, 'event_plan_votes', planId, userId, vote);
  const { data: votes } = await db.from('event_plan_votes').select('vote').eq('plan_id', planId);
  const stats = summarizeVotes(votes ?? []);
  const population = await eventPopulation(db, event.id);
  if (isPassing(stats, population)) {
    await db.from('event_plans').update({ status: 'approved', is_leading: true }).eq('id', planId);
    await db.from('event_plans').update({ is_leading: false }).eq('event_id', event.id).neq('id', planId);
    await syncEventScheduleFromLeadingPlan(db, event.id, planId);
  } else if (!canStillPass(stats, population)) {
    await db.from('event_plans').update({ status: 'rejected' }).eq('id', planId);
  }
  return { ok: true, ...stats, passed: isPassing(stats, population) };
}

export async function castProjectPlanValueVote(
  db: SupabaseClient,
  userId: string,
  slug: string,
  planId: string,
  valueId: string,
  vote: unknown
) {
  await governedProjectForMember(db, slug, userId);
  if (isClearVote(vote)) {
    const { error } = await db
      .from('project_plan_value_votes')
      .delete()
      .eq('plan_id', planId)
      .eq('value_id', valueId)
      .eq('voter_id', userId);
    if (error) throw error;
    return { ok: true, cleared: true };
  }
  await upsertScopedVote(db, 'project_plan_value_votes', 'plan_id,value_id,voter_id', {
    plan_id: planId,
    value_id: valueId,
    voter_id: userId,
    vote: voteLabel(vote)
  });
  return { ok: true };
}

export async function castEventPlanValueVote(
  db: SupabaseClient,
  userId: string,
  slug: string,
  planId: string,
  valueId: string,
  vote: unknown
) {
  await getEvent(db, slug);
  if (isClearVote(vote)) {
    const { error } = await db
      .from('event_plan_value_votes')
      .delete()
      .eq('plan_id', planId)
      .eq('value_id', valueId)
      .eq('voter_id', userId);
    if (error) throw error;
    return { ok: true, cleared: true };
  }
  await upsertScopedVote(db, 'event_plan_value_votes', 'plan_id,value_id,voter_id', {
    plan_id: planId,
    value_id: valueId,
    voter_id: userId,
    vote: voteLabel(vote)
  });
  return { ok: true };
}

export async function castProjectPlanCriterionRating(
  db: SupabaseClient,
  userId: string,
  slug: string,
  planId: string,
  criterionId: string,
  rating: unknown
) {
  await governedProjectForMember(db, slug, userId);
  if (rating == null || rating === '' || rating === 0 || rating === '0') {
    const { error } = await db
      .from('project_plan_criterion_ratings')
      .delete()
      .eq('plan_id', planId)
      .eq('criterion_id', criterionId)
      .eq('voter_id', userId);
    if (error) throw error;
    return { ok: true, cleared: true };
  }
  const value = Math.max(1, Math.min(10, Number(rating) || 1));
  await upsertScopedVote(db, 'project_plan_criterion_ratings', 'plan_id,criterion_id,voter_id', {
    plan_id: planId,
    criterion_id: String(criterionId),
    voter_id: userId,
    rating: value
  });
  return { ok: true, rating: value };
}

export async function castEventPlanCriterionRating(
  db: SupabaseClient,
  userId: string,
  slug: string,
  planId: string,
  criterionId: string,
  rating: unknown
) {
  await getEvent(db, slug);
  if (rating == null || rating === '' || rating === 0 || rating === '0') {
    const { error } = await db
      .from('event_plan_criterion_ratings')
      .delete()
      .eq('plan_id', planId)
      .eq('criterion_id', criterionId)
      .eq('voter_id', userId);
    if (error) throw error;
    return { ok: true, cleared: true };
  }
  const value = Math.max(1, Math.min(10, Number(rating) || 1));
  await upsertScopedVote(db, 'event_plan_criterion_ratings', 'plan_id,criterion_id,voter_id', {
    plan_id: planId,
    criterion_id: String(criterionId),
    voter_id: userId,
    rating: value
  });
  return { ok: true, rating: value };
}

export async function voteProjectValueImportance(
  db: SupabaseClient,
  userId: string,
  slug: string,
  valueId: string,
  importance: unknown
) {
  await governedProjectForMember(db, slug, userId);
  const value = Math.max(1, Math.min(10, Number(importance) || 0));
  if (value < 1) throw new Error('invalid_importance');
  const { error } = await db.from('project_value_importance_votes').upsert(
    {
      value_id: valueId,
      voter_id: userId,
      importance: value
    },
    { onConflict: 'value_id,voter_id' }
  );
  if (error) throw error;
  return { ok: true, importance: value };
}

export async function voteEventValueImportance(
  db: SupabaseClient,
  userId: string,
  slug: string,
  valueId: string,
  importance: unknown
) {
  await getEvent(db, slug);
  const value = Math.max(1, Math.min(10, Number(importance) || 0));
  if (value < 1) throw new Error('invalid_importance');
  const { error } = await db.from('event_value_importance_votes').upsert(
    {
      value_id: valueId,
      voter_id: userId,
      importance: value
    },
    { onConflict: 'value_id,voter_id' }
  );
  if (error) throw error;
  return { ok: true, importance: value };
}

export async function voteProjectPhaseChange(
  db: SupabaseClient,
  userId: string,
  slug: string,
  requestId: string,
  vote: unknown
) {
  const project = await getProject(db, slug);
  if (isClearVote(vote)) {
    const { error } = await db
      .from('project_phase_change_votes')
      .delete()
      .eq('request_id', requestId)
      .eq('voter_id', userId);
    if (error) throw error;
  } else {
    await upsertScopedVote(db, 'project_phase_change_votes', 'request_id,voter_id', {
      request_id: requestId,
      voter_id: userId,
      vote: voteLabel(vote)
    });
  }
  const { data: votes } = await db
    .from('project_phase_change_votes')
    .select('vote, voter_id')
    .eq('request_id', requestId);
  const stats = summarizeVotes(votes ?? []);
  const population = await projectPopulation(db, project.id);
  const { data: request } = await db
    .from('project_phase_change_requests')
    .select('*')
    .eq('id', requestId)
    .maybeSingle();
  if (!request) throw new Error('not_found');
  if (isPassing(stats, population)) {
    const targetPhaseId = String(request.target_phase_id);
    if (request.change_kind !== 'return') {
      await ensureProjectAdvanceAllowed(db, project, targetPhaseId);
    }
    if (targetPhaseId === 'phase-7' || targetPhaseId === 'closed') {
      await closeAndMaybeConvert(db, project, request, userId);
    } else {
      const subtype = await resolveProjectSubtype(db, project);
      await db
        .from('projects')
        .update({
          current_phase_id: targetPhaseId,
          stage_label: displayStageLabel(String(project.project_mode), subtype, targetPhaseId),
          ...(subtype && subtype !== project.project_subtype
            ? { project_subtype: subtype }
            : {}),
          is_closed: false,
          last_activity_at: new Date().toISOString()
        })
        .eq('id', project.id);
    }
    await db.from('project_phase_change_requests').update({ status: 'approved' }).eq('id', requestId);
    await db
      .from('project_phase_change_requests')
      .update({ status: 'closed' })
      .eq('project_id', project.id)
      .eq('status', 'open')
      .neq('id', requestId);
    if (request.change_kind === 'return') {
      await db.from('project_revert_history').insert({
        project_id: project.id,
        target_phase_id: targetPhaseId,
        reason: request.reason ?? '',
        author_id: userId
      });
    }
  } else if (!canStillPass(stats, population)) {
    await db.from('project_phase_change_requests').update({ status: 'rejected' }).eq('id', requestId);
  }
  const passed = isPassing(stats, population);
  return {
    ok: true,
    ...stats,
    passed,
    targetPhaseId: passed ? String(request.target_phase_id) : null
  };
}

export async function voteEventPhaseChange(
  db: SupabaseClient,
  userId: string,
  slug: string,
  requestId: string,
  vote: unknown
) {
  const event = await getEvent(db, slug);
  if (isClearVote(vote)) {
    const { error } = await db
      .from('event_phase_change_votes')
      .delete()
      .eq('request_id', requestId)
      .eq('voter_id', userId);
    if (error) throw error;
  } else {
    await upsertScopedVote(db, 'event_phase_change_votes', 'request_id,voter_id', {
      request_id: requestId,
      voter_id: userId,
      vote: voteLabel(vote)
    });
  }
  const { data: votes } = await db
    .from('event_phase_change_votes')
    .select('vote, voter_id')
    .eq('request_id', requestId);
  const stats = summarizeVotes(votes ?? []);
  const population = await eventPopulation(db, event.id);
  const { data: request } = await db
    .from('event_phase_change_requests')
    .select('*')
    .eq('id', requestId)
    .maybeSingle();
  if (!request) throw new Error('not_found');
  if (isPassing(stats, population)) {
    if (request.change_kind !== 'return') {
      await ensureEventAdvanceAllowed(db, event, String(request.target_phase_id));
    }
    await db
      .from('events')
      .update({
        current_phase_id: request.target_phase_id,
        last_activity_at: new Date().toISOString()
      })
      .eq('id', event.id);
    await db.from('event_phase_change_requests').update({ status: 'approved' }).eq('id', requestId);
    await db
      .from('event_phase_change_requests')
      .update({ status: 'closed' })
      .eq('event_id', event.id)
      .eq('status', 'open')
      .neq('id', requestId);
  } else if (!canStillPass(stats, population)) {
    await db.from('event_phase_change_requests').update({ status: 'rejected' }).eq('id', requestId);
  }
  const passed = isPassing(stats, population);
  return {
    ok: true,
    ...stats,
    passed,
    targetPhaseId: passed ? String(request.target_phase_id) : null
  };
}

export async function voteProjectUpdateRequest(
  db: SupabaseClient,
  userId: string,
  slug: string,
  requestId: string,
  vote: unknown
) {
  const project = await getProject(db, slug);
  await upsertScopedVote(db, 'project_update_request_votes', 'request_id,voter_id', {
    request_id: requestId,
    voter_id: userId,
    vote: voteLabel(vote)
  });
  const { data: votes } = await db
    .from('project_update_request_votes')
    .select('vote')
    .eq('request_id', requestId);
  const stats = summarizeVotes(votes ?? []);
  const population = await projectPopulation(db, project.id);
  const { data: request } = await db
    .from('project_update_requests')
    .select('*')
    .eq('id', requestId)
    .maybeSingle();
  if (!request) throw new Error('not_found');
  if (isPassing(stats, population)) {
    await db.from('project_updates').insert({
      project_id: project.id,
      title: 'Approved update request',
      body: request.body,
      author_id: request.author_id ?? userId
    });
    await db.from('project_update_requests').update({ status: 'approved' }).eq('id', requestId);
    await db.from('projects').update({ last_activity_at: new Date().toISOString() }).eq('id', project.id);
  } else if (!canStillPass(stats, population)) {
    await db.from('project_update_requests').update({ status: 'rejected' }).eq('id', requestId);
  }
  return { ok: true, ...stats, passed: isPassing(stats, population) };
}

export async function voteEventUpdateRequest(
  db: SupabaseClient,
  userId: string,
  slug: string,
  requestId: string,
  vote: unknown
) {
  const event = await getEvent(db, slug);
  await upsertScopedVote(db, 'event_update_request_votes', 'request_id,voter_id', {
    request_id: requestId,
    voter_id: userId,
    vote: voteLabel(vote)
  });
  const { data: votes } = await db
    .from('event_update_request_votes')
    .select('vote')
    .eq('request_id', requestId);
  const stats = summarizeVotes(votes ?? []);
  const population = await eventPopulation(db, event.id);
  const { data: request } = await db
    .from('event_update_requests')
    .select('*')
    .eq('id', requestId)
    .maybeSingle();
  if (!request) throw new Error('not_found');
  if (isPassing(stats, population)) {
    await db.from('event_updates').insert({
      event_id: event.id,
      title: 'Approved update request',
      body: request.body,
      author_id: request.author_id ?? userId
    });
    await db.from('event_update_requests').update({ status: 'approved' }).eq('id', requestId);
    await db.from('events').update({ last_activity_at: new Date().toISOString() }).eq('id', event.id);
  } else if (!canStillPass(stats, population)) {
    await db.from('event_update_requests').update({ status: 'rejected' }).eq('id', requestId);
  }
  return { ok: true, ...stats, passed: isPassing(stats, population) };
}

export async function voteProjectEditRequest(
  db: SupabaseClient,
  userId: string,
  slug: string,
  requestId: string,
  vote: unknown
) {
  const project = await getProject(db, slug);
  await upsertScopedVote(db, 'project_edit_request_votes', 'request_id,voter_id', {
    request_id: requestId,
    voter_id: userId,
    vote: voteLabel(vote)
  });
  const { data: votes } = await db
    .from('project_edit_request_votes')
    .select('vote')
    .eq('request_id', requestId);
  const stats = summarizeVotes(votes ?? []);
  const population = await projectPopulation(db, project.id);
  const { data: request } = await db
    .from('project_edit_requests')
    .select('*')
    .eq('id', requestId)
    .maybeSingle();
  if (!request) throw new Error('not_found');
  if (isPassing(stats, population)) {
    await db
      .from('projects')
      .update({
        title: request.title ?? project.title,
        description: request.description ?? project.description,
        last_activity_at: new Date().toISOString()
      })
      .eq('id', project.id);
    await db.from('project_edit_requests').update({ status: 'approved' }).eq('id', requestId);
  } else if (!canStillPass(stats, population)) {
    await db.from('project_edit_requests').update({ status: 'rejected' }).eq('id', requestId);
  }
  return { ok: true, ...stats, passed: isPassing(stats, population) };
}

export async function voteEventEditRequest(
  db: SupabaseClient,
  userId: string,
  slug: string,
  requestId: string,
  vote: unknown
) {
  const event = await getEvent(db, slug);
  await upsertScopedVote(db, 'event_edit_request_votes', 'request_id,voter_id', {
    request_id: requestId,
    voter_id: userId,
    vote: voteLabel(vote)
  });
  const { data: votes } = await db
    .from('event_edit_request_votes')
    .select('vote')
    .eq('request_id', requestId);
  const stats = summarizeVotes(votes ?? []);
  const population = await eventPopulation(db, event.id);
  const { data: request } = await db
    .from('event_edit_requests')
    .select('*')
    .eq('id', requestId)
    .maybeSingle();
  if (!request) throw new Error('not_found');
  if (isPassing(stats, population)) {
    await db
      .from('events')
      .update({
        title: request.title ?? event.title,
        description: request.description ?? event.description,
        last_activity_at: new Date().toISOString()
      })
      .eq('id', event.id);
    await db.from('event_edit_requests').update({ status: 'approved' }).eq('id', requestId);
  } else if (!canStillPass(stats, population)) {
    await db.from('event_edit_requests').update({ status: 'rejected' }).eq('id', requestId);
  }
  return { ok: true, ...stats, passed: isPassing(stats, population) };
}

export async function createDetailLinkRequest(
  db: SupabaseClient,
  userId: string,
  sourceKind: 'project' | 'event',
  sourceSlug: string,
  body: Record<string, unknown>
) {
  const source =
    sourceKind === 'project' ? await getProject(db, sourceSlug) : await getEvent(db, sourceSlug);
  const targetKind = String(body.targetKind ?? body.target_kind ?? 'project');
  let targetId = String(body.targetId ?? body.target_id ?? '');
  const targetSlug = String(body.targetSlug ?? body.target_slug ?? '');
  if (!targetId && targetSlug) {
    const table = targetKind === 'event' ? 'events' : 'projects';
    const { data: target } = await db.from(table).select('id').eq('slug', targetSlug).maybeSingle();
    if (!target) throw new Error('not_found');
    targetId = target.id as string;
  }
  if (!targetId) throw new Error('not_found');
  const insertRow: Record<string, unknown> = {
    source_kind: sourceKind,
    target_kind: targetKind,
    relationship_label: body.label ?? body.relationshipLabel ?? 'related',
    summary: body.note ?? body.description ?? body.summary ?? '',
    request_type: 'create',
    proposed_by: userId,
    status: 'open'
  };
  if (sourceKind === 'project') insertRow.source_project_id = source.id;
  else insertRow.source_event_id = source.id;
  if (targetKind === 'project') insertRow.target_project_id = targetId;
  else insertRow.target_event_id = targetId;
  const { data, error } = await db.from('detail_link_requests').insert(insertRow).select('id').single();
  if (error) throw error;
  return { ok: true, id: data.id };
}

export async function voteDetailLinkRequest(
  db: SupabaseClient,
  userId: string,
  requestId: string,
  vote: unknown,
  voteScope: 'source' | 'target' = 'source'
) {
  await upsertScopedVote(db, 'detail_link_request_votes', 'request_id,voter_id,vote_scope', {
    request_id: requestId,
    voter_id: userId,
    vote_scope: voteScope,
    vote: voteLabel(vote)
  });
  const { data: request } = await db
    .from('detail_link_requests')
    .select('*')
    .eq('id', requestId)
    .maybeSingle();
  if (!request) throw new Error('not_found');

  const { data: sourceVotes } = await db
    .from('detail_link_request_votes')
    .select('vote')
    .eq('request_id', requestId)
    .eq('vote_scope', 'source');
  const { data: targetVotes } = await db
    .from('detail_link_request_votes')
    .select('vote')
    .eq('request_id', requestId)
    .eq('vote_scope', 'target');
  const sourceStats = summarizeVotes(sourceVotes ?? []);
  const targetStats = summarizeVotes(targetVotes ?? []);
  const sourceId = request.source_project_id ?? request.source_event_id;
  const population =
    request.source_kind === 'project'
      ? await projectPopulation(db, sourceId)
      : await eventPopulation(db, sourceId);
  if (isPassing(sourceStats, population) && isPassing(targetStats, population)) {
    if (String(request.request_type) === 'sever' && request.link_id) {
      await db
        .from('detail_links')
        .update({ status: 'inactive' })
        .eq('id', request.link_id);
    } else {
      await db.from('detail_links').insert({
        source_kind: request.source_kind,
        source_project_id: request.source_project_id,
        source_event_id: request.source_event_id,
        target_kind: request.target_kind,
        target_project_id: request.target_project_id,
        target_event_id: request.target_event_id,
        relationship_label: request.relationship_label,
        summary: request.summary,
        link_kind: 'manual',
        status: 'active'
      });
    }
    await db.from('detail_link_requests').update({ status: 'approved' }).eq('id', requestId);
  }
  return { ok: true, sourceStats, targetStats };
}

export async function createDetailLinkSeverRequest(
  db: SupabaseClient,
  userId: string,
  sourceKind: 'project' | 'event',
  sourceSlug: string,
  linkId: string,
  summary?: string
) {
  const source =
    sourceKind === 'project' ? await getProject(db, sourceSlug) : await getEvent(db, sourceSlug);
  const { data: link } = await db.from('detail_links').select('*').eq('id', linkId).maybeSingle();
  if (!link) throw new Error('not_found');
  if (link.status !== 'active') throw new Error('conflict');

  const ownerIsSource =
    String(link.source_kind) === sourceKind &&
    ((sourceKind === 'project' && link.source_project_id === source.id) ||
      (sourceKind === 'event' && link.source_event_id === source.id));
  const ownerIsTarget =
    String(link.target_kind) === sourceKind &&
    ((sourceKind === 'project' && link.target_project_id === source.id) ||
      (sourceKind === 'event' && link.target_event_id === source.id));
  if (!ownerIsSource && !ownerIsTarget) throw new Error('forbidden');

  const { data: existingOpen } = await db
    .from('detail_link_requests')
    .select('id')
    .eq('link_id', linkId)
    .eq('request_type', 'sever')
    .eq('status', 'open')
    .maybeSingle();
  if (existingOpen) return { ok: true, id: existingOpen.id, requestId: existingOpen.id };

  const cleaned = String(summary || '').trim() || 'Propose severing this link.';
  const { data, error } = await db
    .from('detail_link_requests')
    .insert({
      source_kind: link.source_kind,
      source_project_id: link.source_project_id,
      source_event_id: link.source_event_id,
      target_kind: link.target_kind,
      target_project_id: link.target_project_id,
      target_event_id: link.target_event_id,
      relationship_label: link.relationship_label,
      summary: cleaned,
      request_type: 'sever',
      link_id: linkId,
      proposed_by: userId,
      status: 'open'
    })
    .select('id')
    .single();
  if (error) throw error;
  return { ok: true, id: data.id, requestId: data.id };
}

export async function createSettingsChangeRequest(
  db: SupabaseClient,
  userId: string,
  slug: string,
  body: Record<string, unknown>
) {
  const project = await getProject(db, slug);
  const enabled = Boolean(body.enabled);
  const requestMode = String(body.requestMode ?? body.request_mode ?? 'open').trim().toLowerCase();
  const allowOff =
    body.allowOffScheduleRequests ?? body.allow_off_schedule_requests ?? false;
  const reason = String(body.reason ?? '').trim();

  if (String(project.project_mode) === 'personal-service') {
    const membership = await projectMembership(db, project.id, userId);
    if (project.author_id !== userId && !membership?.is_manager) throw new Error('forbidden');
    const { error } = await db.from('project_service_request_settings').upsert(
      {
        project_id: project.id,
        enabled,
        request_mode: requestMode,
        allow_off_schedule_requests: Boolean(allowOff)
      },
      { onConflict: 'project_id' }
    );
    if (error) throw error;
    return {
      ok: true,
      applied: true,
      settings: {
        enabled,
        request_mode: requestMode,
        allow_off_schedule_requests: Boolean(allowOff)
      }
    };
  }

  if (!(await projectMembership(db, project.id, userId))) throw new Error('forbidden');
  if (!reason) throw new Error('invalid_reason');
  const { data, error } = await db
    .from('project_service_request_setting_changes')
    .insert({
      project_id: project.id,
      author_id: userId,
      reason,
      enabled,
      request_mode: requestMode,
      allow_off_schedule_requests: Boolean(allowOff),
      status: 'open'
    })
    .select('id')
    .single();
  if (error) throw error;
  return { ok: true, id: data.id, requestId: data.id };
}

export async function voteSettingsChangeRequest(
  db: SupabaseClient,
  userId: string,
  slug: string,
  requestId: string,
  vote: unknown
) {
  const project = await getProject(db, slug);
  if (!(await projectMembership(db, project.id, userId))) throw new Error('forbidden');
  await upsertScopedVote(db, 'project_service_request_setting_change_votes', 'request_id,voter_id', {
    request_id: requestId,
    voter_id: userId,
    vote: voteLabel(vote)
  });
  const { data: votes } = await db
    .from('project_service_request_setting_change_votes')
    .select('vote')
    .eq('request_id', requestId);
  const stats = summarizeVotes(votes ?? []);
  const population = await projectPopulation(db, project.id);
  const { data: request } = await db
    .from('project_service_request_setting_changes')
    .select('*')
    .eq('id', requestId)
    .eq('project_id', project.id)
    .maybeSingle();
  if (!request) throw new Error('not_found');
  if (isPassing(stats, population)) {
    await db.from('project_service_request_settings').upsert(
      {
        project_id: project.id,
        enabled: request.enabled,
        request_mode: request.request_mode,
        allow_off_schedule_requests: request.allow_off_schedule_requests
      },
      { onConflict: 'project_id' }
    );
    await db
      .from('project_service_request_setting_changes')
      .update({ status: 'approved' })
      .eq('id', requestId);
  } else if (!canStillPass(stats, population)) {
    await db
      .from('project_service_request_setting_changes')
      .update({ status: 'rejected' })
      .eq('id', requestId);
  }
  return { ok: true, ...stats, passed: isPassing(stats, population) };
}

export async function toggleServiceHistoryCompletion(
  db: SupabaseClient,
  userId: string,
  slug: string,
  body: Record<string, unknown>
) {
  const project = await getProject(db, slug);
  const historyItemKey = String(body.historyItemKey ?? body.history_item_key ?? '');
  const role = String(body.role ?? '').trim().toLowerCase();
  const selectionRaw = body.selection;
  const selection =
    selectionRaw == null || selectionRaw === ''
      ? null
      : String(selectionRaw).trim().toLowerCase();
  if (!historyItemKey) throw new Error('not_found');
  if (role !== 'requester' && role !== 'participants') throw new Error('invalid_role');
  if (selection != null && selection !== 'completed' && selection !== 'uncompleted') {
    throw new Error('invalid_selection');
  }

  const { data: activity } = await db
    .from('project_activities')
    .select('*')
    .eq('id', historyItemKey)
    .eq('project_id', project.id)
    .maybeSingle();
  if (!activity) throw new Error('not_found');
  if (activity.ends_at && new Date(activity.ends_at).getTime() > Date.now()) {
    throw new Error('activity_not_ended');
  }

  if (selection == null || selection === 'uncompleted') {
    let q = db
      .from('project_service_history_completions')
      .delete()
      .eq('project_id', project.id)
      .eq('history_item_key', historyItemKey)
      .eq('role', role);
    q = role === 'requester' ? q.eq('requester_user_id', userId) : q.eq('participant_user_id', userId);
    const { error } = await q;
    if (error) throw error;
    return { ok: true, completed: false };
  }

  const row: Record<string, unknown> = {
    project_id: project.id,
    history_item_key: historyItemKey,
    role,
    selection: 'completed',
    requester_user_id: role === 'requester' ? userId : null,
    participant_user_id: role === 'participants' ? userId : null
  };
  const { error } = await db.from('project_service_history_completions').upsert(row, {
    onConflict: 'project_id,history_item_key,role,requester_user_id,participant_user_id'
  });
  if (error) throw error;
  return { ok: true, completed: true };
}

export async function toggleEventHistoryCompletion(
  db: SupabaseClient,
  userId: string,
  slug: string,
  body: Record<string, unknown>
) {
  const event = await getEvent(db, slug);
  const historyItemKey = String(body.historyItemKey ?? body.history_item_key ?? '');
  const role = String(body.role ?? 'participants').trim().toLowerCase();
  const selectionRaw = body.selection;
  const selection =
    selectionRaw == null || selectionRaw === ''
      ? null
      : String(selectionRaw).trim().toLowerCase();
  if (!historyItemKey) throw new Error('not_found');
  if (role !== 'participants') throw new Error('invalid_role');
  if (selection != null && selection !== 'completed' && selection !== 'uncompleted') {
    throw new Error('invalid_selection');
  }

  const { data: activity } = await db
    .from('event_activities')
    .select('*')
    .eq('id', historyItemKey)
    .eq('event_id', event.id)
    .maybeSingle();
  if (!activity) throw new Error('not_found');
  if (activity.ends_at && new Date(activity.ends_at).getTime() > Date.now()) {
    throw new Error('activity_not_ended');
  }

  if (selection == null || selection === 'uncompleted') {
    const { error } = await db
      .from('event_activity_history_completions')
      .delete()
      .eq('event_id', event.id)
      .eq('history_item_key', historyItemKey)
      .eq('role', role)
      .eq('participant_user_id', userId);
    if (error) throw error;
    return { ok: true, completed: false };
  }

  const { error } = await db.from('event_activity_history_completions').upsert(
    {
      event_id: event.id,
      history_item_key: historyItemKey,
      role,
      selection: 'completed',
      participant_user_id: userId
    },
    { onConflict: 'event_id,history_item_key,role,participant_user_id' }
  );
  if (error) throw error;
  return { ok: true, completed: true };
}

export async function createServiceRequest(
  db: SupabaseClient,
  userId: string,
  slug: string,
  body: Record<string, unknown>
) {
  const project = await getProject(db, slug);
  const { data, error } = await db
    .from('project_service_requests')
    .insert({
      project_id: project.id,
      title: body.title ?? 'Service request',
      body: body.description ?? body.body ?? '',
      requester_id: userId,
      status: 'open'
    })
    .select('id')
    .single();
  if (error) throw error;
  return { ok: true, id: data.id };
}

export async function planServiceRequest(
  db: SupabaseClient,
  userId: string,
  slug: string,
  requestId: string,
  body: Record<string, unknown>
) {
  const project = await getProject(db, slug);
  const now = new Date();
  await db.from('project_activities').insert({
    project_id: project.id,
    title: body.title ?? 'Planned service activity',
    author_id: userId,
    scheduled_at: body.scheduledAt ?? now.toISOString(),
    ends_at: body.endsAt ?? new Date(now.getTime() + 3600000).toISOString(),
    location_label: body.locationLabel ?? '',
    note: body.description ?? '',
    is_online: Boolean(body.isOnline)
  });
  await db.from('project_service_requests').update({ status: 'planned' }).eq('id', requestId);
  return { ok: true };
}

export async function submitPullRequest(
  db: SupabaseClient,
  userId: string,
  slug: string,
  body: Record<string, unknown>
) {
  const project = await getProject(db, slug);
  const prId = String(body.pullRequestId ?? body.pull_request_id ?? crypto.randomUUID());
  const { data, error } = await db
    .from('project_pull_requests')
    .insert({
      project_id: project.id,
      title: body.title ?? 'Pull request',
      summary: body.description ?? body.summary ?? '',
      author_id: userId,
      pull_request_id: prId,
      pull_request_url: body.pullRequestUrl ?? body.pull_request_url ?? `https://example.invalid/pr/${prId}`,
      stage: 'approval'
    })
    .select('id')
    .single();
  if (error) throw error;
  return { ok: true, id: data.id };
}

export async function votePullRequest(
  db: SupabaseClient,
  userId: string,
  slug: string,
  pullRequestId: string,
  vote: unknown
) {
  const project = await getProject(db, slug);
  await upsertScopedVote(db, 'project_pull_request_votes', 'request_id,voter_id', {
    request_id: pullRequestId,
    voter_id: userId,
    vote: voteLabel(vote)
  });
  const { data: votes } = await db
    .from('project_pull_request_votes')
    .select('vote')
    .eq('request_id', pullRequestId);
  const stats = summarizeVotes(votes ?? []);
  const population = await projectPopulation(db, project.id);
  if (isPassing(stats, population)) {
    await db.from('project_pull_requests').update({ stage: 'awaiting-merge' }).eq('id', pullRequestId);
  }
  return { ok: true, ...stats, passed: isPassing(stats, population) };
}

export async function recordPullRequestMerge(
  db: SupabaseClient,
  userId: string,
  slug: string,
  pullRequestId: string,
  body: Record<string, unknown>
) {
  const project = await getProject(db, slug);
  const { data: capability } = await db
    .from('project_merge_capability_members')
    .select('user_id')
    .eq('project_id', project.id)
    .eq('user_id', userId)
    .maybeSingle();
  if (!capability) throw new Error('forbidden');
  const { data: pr } = await db
    .from('project_pull_requests')
    .select('id, stage')
    .eq('id', pullRequestId)
    .eq('project_id', project.id)
    .maybeSingle();
  if (!pr) throw new Error('not_found');
  if (pr.stage !== 'awaiting-merge') throw new Error('invalid_stage');
  await db
    .from('project_pull_requests')
    .update({
      stage: 'confirmation',
      merge_id: body.mergeId ?? body.merge_id ?? null,
      merge_url: body.mergeUrl ?? body.merge_url ?? null,
      merged_by_user_id: userId
    })
    .eq('id', pullRequestId);
  await db.from('project_pull_request_votes').delete().eq('request_id', pullRequestId);
  return { ok: true, stage: 'confirmation' };
}

export async function requestMergeCapabilityChange(
  db: SupabaseClient,
  userId: string,
  slug: string,
  body: Record<string, unknown>
) {
  const project = await getProject(db, slug);
  const targetUserId = String(body.targetUserId ?? body.target_user_id ?? '');
  if (!targetUserId) throw new Error('invalid_target');
  const action = String(body.action ?? 'grant').toLowerCase() === 'revoke' ? 'revoke' : 'grant';
  const { data, error } = await db
    .from('project_merge_capability_change_requests')
    .insert({
      project_id: project.id,
      decision_id: crypto.randomUUID(),
      action,
      target_user_id: targetUserId,
      author_id: userId,
      status: 'open'
    })
    .select('id')
    .single();
  if (error) throw error;
  return { ok: true, id: data.id };
}

export async function voteMergeCapabilityChange(
  db: SupabaseClient,
  userId: string,
  slug: string,
  requestId: string,
  vote: unknown
) {
  const project = await getProject(db, slug);
  await upsertScopedVote(db, 'project_merge_capability_change_votes', 'request_id,voter_id', {
    request_id: requestId,
    voter_id: userId,
    vote: voteLabel(vote)
  });
  const { data: request } = await db
    .from('project_merge_capability_change_requests')
    .select('*')
    .eq('id', requestId)
    .eq('project_id', project.id)
    .maybeSingle();
  if (!request) throw new Error('not_found');
  const { data: votes } = await db
    .from('project_merge_capability_change_votes')
    .select('vote')
    .eq('request_id', requestId);
  const stats = summarizeVotes(votes ?? []);
  const population = await projectPopulation(db, project.id);
  if (isPassing(stats, population)) {
    if (request.action === 'revoke') {
      await db
        .from('project_merge_capability_members')
        .delete()
        .eq('project_id', project.id)
        .eq('user_id', request.target_user_id);
    } else {
      await db.from('project_merge_capability_members').upsert({
        project_id: project.id,
        user_id: request.target_user_id,
        source_label: 'approved-request'
      });
    }
    await db
      .from('project_merge_capability_change_requests')
      .update({ status: 'approved' })
      .eq('id', requestId);
  } else if (!canStillPass(stats, population)) {
    await db
      .from('project_merge_capability_change_requests')
      .update({ status: 'rejected' })
      .eq('id', requestId);
  }
  return { ok: true, ...stats, passed: isPassing(stats, population) };
}

export async function requestRepositoryReplacement(
  db: SupabaseClient,
  userId: string,
  slug: string,
  body: Record<string, unknown>
) {
  const project = await getProject(db, slug);
  const repositoryUrl = String(body.repositoryUrl ?? body.repository_url ?? '').trim();
  const relatedPullRequestId = String(
    body.relatedPullRequestId ?? body.related_pull_request_id ?? body.pullRequestId ?? ''
  );
  if (!repositoryUrl || !relatedPullRequestId) throw new Error('invalid_request');
  const { data: leading } = await db
    .from('project_plans')
    .select('repository_url')
    .eq('project_id', project.id)
    .eq('is_leading', true)
    .maybeSingle();
  const { data, error } = await db
    .from('project_repository_replacement_requests')
    .insert({
      project_id: project.id,
      decision_id: crypto.randomUUID(),
      repository_url: repositoryUrl,
      previous_repository_url: leading?.repository_url ?? '',
      reason: body.reason ?? '',
      related_pull_request_id: relatedPullRequestId,
      author_id: userId,
      status: 'open'
    })
    .select('id')
    .single();
  if (error) throw error;
  return { ok: true, id: data.id };
}

export async function voteRepositoryReplacement(
  db: SupabaseClient,
  userId: string,
  slug: string,
  requestId: string,
  vote: unknown
) {
  const project = await getProject(db, slug);
  await upsertScopedVote(db, 'project_repository_replacement_votes', 'request_id,voter_id', {
    request_id: requestId,
    voter_id: userId,
    vote: voteLabel(vote)
  });
  const { data: request } = await db
    .from('project_repository_replacement_requests')
    .select('*')
    .eq('id', requestId)
    .eq('project_id', project.id)
    .maybeSingle();
  if (!request) throw new Error('not_found');
  const { data: votes } = await db
    .from('project_repository_replacement_votes')
    .select('vote')
    .eq('request_id', requestId);
  const stats = summarizeVotes(votes ?? []);
  const population = await projectPopulation(db, project.id);
  if (isPassing(stats, population)) {
    await db
      .from('project_plans')
      .update({ repository_url: request.repository_url })
      .eq('project_id', project.id)
      .eq('is_leading', true);
    await db
      .from('project_repository_replacement_requests')
      .update({ status: 'approved' })
      .eq('id', requestId);
  } else if (!canStillPass(stats, population)) {
    await db
      .from('project_repository_replacement_requests')
      .update({ status: 'rejected' })
      .eq('id', requestId);
  }
  return { ok: true, ...stats, passed: isPassing(stats, population) };
}

export async function upsertActivityRating(
  db: SupabaseClient,
  userId: string,
  kind: 'project' | 'event',
  activityId: string,
  rating: number,
  comment?: string | null
) {
  const table = kind === 'project' ? 'project_activity_ratings' : 'event_activity_ratings';
  const value = Math.max(1, Math.min(5, Number(rating) || 1));
  await db.from(table).upsert(
    {
      activity_id: activityId,
      user_id: userId,
      rating: value,
      comment: String(comment ?? '').trim() || null
    },
    { onConflict: 'activity_id,user_id' }
  );
  return { ok: true, rating: value };
}

export async function commitActivityRole(
  db: SupabaseClient,
  userId: string,
  kind: 'project' | 'event',
  activityId: string,
  roleId: string,
  commit: boolean
) {
  void activityId;
  const table = kind === 'project' ? 'project_activity_assignments' : 'event_activity_assignments';
  if (commit) {
    await db.from(table).upsert(
      {
        role_id: roleId,
        user_id: userId
      },
      { onConflict: 'role_id,user_id' }
    );
  } else {
    await db.from(table).delete().eq('role_id', roleId).eq('user_id', userId);
  }
  return { ok: true, committed: commit };
}

/** Resolve role by label (AppAdapter sends roleLabel, not roleId). */
export async function commitActivityRoleByLabel(
  db: SupabaseClient,
  userId: string,
  kind: 'project' | 'event',
  activityId: string,
  roleLabel: string | null,
  commit: boolean
) {
  const roleTable = kind === 'project' ? 'project_activity_roles' : 'event_activity_roles';
  const assignTable = kind === 'project' ? 'project_activity_assignments' : 'event_activity_assignments';

  if (!commit || roleLabel == null || roleLabel === '') {
    const { data: roles } = await db.from(roleTable).select('id').eq('activity_id', activityId);
    const roleIds = (roles ?? []).map((r) => r.id as string);
    if (roleIds.length) {
      await db.from(assignTable).delete().eq('user_id', userId).in('role_id', roleIds);
    }
    return { ok: true, committed: false };
  }

  let { data: role } = await db
    .from(roleTable)
    .select('id')
    .eq('activity_id', activityId)
    .eq('label', roleLabel)
    .maybeSingle();
  if (!role) {
    const { data: created, error } = await db
      .from(roleTable)
      .insert({ activity_id: activityId, label: roleLabel, required_count: 1 })
      .select('id')
      .single();
    if (error) throw error;
    role = created;
  }
  return commitActivityRole(db, userId, kind, activityId, role.id, true);
}

export async function createEventUpdateRequest(
  db: SupabaseClient,
  userId: string,
  slug: string,
  body: Record<string, unknown>
) {
  const event = await getEvent(db, slug);
  const population = await eventPopulation(db, event.id);
  // Single-member events auto-apply the update (FastAPI parity).
  if (population <= 1) {
    await db.from('event_updates').insert({
      event_id: event.id,
      title: 'Update',
      body: body.body ?? '',
      author_id: userId
    });
    await db.from('events').update({ last_activity_at: new Date().toISOString() }).eq('id', event.id);
    return { ok: true, autoApproved: true };
  }
  await db.from('event_update_requests').insert({
    event_id: event.id,
    body: body.body ?? '',
    author_id: userId,
    status: 'open'
  });
  return { ok: true };
}

export async function createEventEditRequest(
  db: SupabaseClient,
  userId: string,
  slug: string,
  body: Record<string, unknown>
) {
  const event = await getEvent(db, slug);
  await db.from('event_edit_requests').insert({
    event_id: event.id,
    title: body.title,
    description: body.description,
    author_id: userId,
    status: 'open'
  });
  return { ok: true };
}
