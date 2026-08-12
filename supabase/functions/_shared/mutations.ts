/**
 * Real mutation handlers for membership, signals, lifecycle, messaging, invites.
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import {
  canViewEntity,
  canViewPrivateEvent,
  isEventMember,
  isProjectMember,
  isScopeMember
} from './access.ts';
import { applyProjectClose } from './conversion.ts';
import { displayStageLabel, nextPhaseIdForProject } from './phases.ts';
import { recordMeaningfulAction } from './votes.ts';

async function getProjectBySlug(db: SupabaseClient, slug: string) {
  const { data } = await db.from('projects').select('*').eq('slug', slug).maybeSingle();
  return data;
}

async function getEventBySlug(db: SupabaseClient, slug: string) {
  const { data } = await db.from('events').select('*').eq('slug', slug).maybeSingle();
  return data;
}

async function resolveUserIdsByUsernames(
  db: SupabaseClient,
  usernames: string[],
  currentUserId: string
): Promise<Array<{ id: string; username: string }>> {
  const normalized = [...new Set(usernames.map((u) => u.trim()).filter(Boolean))];
  if (!normalized.length) return [];
  const { data } = await db.from('users').select('id, username').in('username', normalized);
  const byLower = new Map((data ?? []).map((u) => [String(u.username).toLowerCase(), u]));
  const resolved: Array<{ id: string; username: string }> = [];
  for (const name of normalized) {
    const row = byLower.get(name.toLowerCase());
    if (!row) throw new Error(`unknown_username:${name}`);
    if (row.id === currentUserId) continue;
    resolved.push({ id: row.id, username: row.username });
  }
  return resolved;
}

/** FastAPI-parity event create including private / organizer-controlled seeding. */
export async function createEvent(
  db: SupabaseClient,
  userId: string,
  body: Record<string, unknown>,
  persistTags: (
    db: SupabaseClient,
    userId: string,
    kind: 'event',
    entityId: string,
    body: Record<string, unknown>,
    opts: { requireAny: boolean }
  ) => Promise<void>
) {
  const audiences = new Set(['public', 'private_community', 'invite_only']);
  const governances = new Set(['collaborative', 'organizer_controlled']);

  let audience = String(body.audience ?? '').trim().toLowerCase();
  if (!audience) {
    audience = body.isPrivate ? 'invite_only' : 'public';
  }
  if (!audiences.has(audience)) throw new Error('invalid_audience');

  let governance = String(body.governance ?? '').trim().toLowerCase() || 'collaborative';
  if (!governances.has(governance)) throw new Error('invalid_governance');
  if (audience === 'public' && governance !== 'collaborative') {
    throw new Error('public_must_be_collaborative');
  }

  const isPrivate = audience !== 'public';
  const directToActivity = isPrivate && governance === 'organizer_controlled';

  let homeCommunityId: string | null = null;
  const homeCommunitySlug = String(body.homeCommunitySlug ?? body.home_community_slug ?? '').trim();
  if (audience === 'private_community') {
    if (!homeCommunitySlug) throw new Error('home_community_required');
    const { data: community } = await db
      .from('communities')
      .select('id, slug')
      .eq('slug', homeCommunitySlug)
      .maybeSingle();
    if (!community) throw new Error('unknown_community');
    if (!(await isScopeMember(db, 'community', community.id, userId))) {
      throw new Error('forbidden');
    }
    homeCommunityId = community.id;
  }

  const invitees =
    audience === 'invite_only'
      ? await resolveUserIdsByUsernames(db, (body.invitedUsernames as string[]) ?? [], userId)
      : [];
  const editors =
    isPrivate && Array.isArray(body.editorUsernames)
      ? await resolveUserIdsByUsernames(db, body.editorUsernames as string[], userId)
      : [];

  const title = String(body.title ?? '').trim() || 'Event';
  const description = String(body.description ?? '').trim();
  const planPayload = (body.planPayload as Record<string, unknown>) ?? {};
  const schedulePayload = (body.schedulePayload as Record<string, unknown>) ?? {};
  const planPhases = (planPayload.planPhases ?? planPayload.plan_phases ?? []) as unknown[];

  let currentPhaseId = 'proposal';
  let planTitleValue = String(body.planTitle ?? '').trim();
  let planDescriptionValue = String(body.planDescription ?? '').trim();
  if (directToActivity) {
    currentPhaseId = 'activity';
    planTitleValue = planTitleValue || title;
    planDescriptionValue = planDescriptionValue || description;
    if (!Array.isArray(planPhases) || planPhases.length === 0) {
      throw new Error('organizer_requires_plan_stages');
    }
    if (!schedulePayload || Object.keys(schedulePayload).length === 0) {
      throw new Error('organizer_requires_schedule');
    }
  } else if (governance === 'organizer_controlled') {
    currentPhaseId = 'event-plan';
  }

  const slug =
    (body.slug as string | undefined) ??
    `${title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 60)}-${crypto.randomUUID().slice(0, 8)}`;

  const memberIds = new Set<string>([userId, ...invitees.map((i) => i.id)]);
  for (const editor of editors) memberIds.add(editor.id);

  const { data, error: insertError } = await db
    .from('events')
    .insert({
      slug,
      title,
      description,
      created_by: userId,
      is_private: isPrivate,
      audience,
      governance,
      home_community_id: homeCommunityId ?? body.homeCommunityId ?? body.home_community_id ?? null,
      current_phase_id: currentPhaseId,
      time_label: body.timeLabel ?? body.scheduledAt ?? '',
      location_label: body.locationLabel ?? '',
      location_id: body.locationId ?? body.location_id ?? null,
      scheduled_at: body.scheduledAt ?? null,
      ends_at: body.endsAt ?? null,
      member_count: memberIds.size,
      last_activity_at: new Date().toISOString()
    })
    .select('id, slug')
    .single();
  if (insertError) throw insertError;

  await persistTags(db, userId, 'event', data.id, body, { requireAny: !isPrivate });

  const now = new Date().toISOString();
  const membershipRows = [...memberIds].map((id) => ({
    event_id: data.id,
    user_id: id,
    joined_at: now
  }));
  const { error: memberErr } = await db.from('event_memberships').insert(membershipRows);
  if (memberErr) throw memberErr;

  for (const editor of editors) {
    await db.from('event_editors').upsert({
      event_id: data.id,
      user_id: editor.id,
      granted_by: userId,
      granted_at: now
    });
  }

  if (directToActivity) {
    const { error: planErr } = await db.from('event_plans').insert({
      event_id: data.id,
      title: planTitleValue,
      description: planDescriptionValue,
      author_id: userId,
      demand_consideration_note: '',
      location_label: body.locationLabel ?? '',
      location_id: body.locationId ?? body.location_id ?? null,
      schedule_payload: schedulePayload,
      plan_payload: planPayload,
      is_leading: true,
      status: 'approved'
    });
    if (planErr) throw planErr;
  }

  for (const invitee of invitees) {
    await db.from('notifications').insert({
      recipient_id: invitee.id,
      actor_id: userId,
      kind: 'evt-invite',
      surface: 'event',
      subject_type: 'event',
      subject_id: data.id,
      target_id: data.id,
      title,
      body: `You were invited to an event: ${title}`,
      href: `/events/${data.slug}`,
      is_unread: true
    });
  }

  await recordMeaningfulAction(db, userId, 'create-event', { event_id: data.id, slug: data.slug });
  return { ok: true, id: data.id, slug: data.slug };
}

export async function toggleProjectMembership(db: SupabaseClient, userId: string, slug: string) {
  const project = await getProjectBySlug(db, slug);
  if (!project) throw new Error('not_found');
  if (!(await canViewEntity(db, userId, 'project', project.id))) throw new Error('not_found');
  const member = await isProjectMember(db, project.id, userId);
  if (member) {
    await db.from('project_memberships').delete().eq('project_id', project.id).eq('user_id', userId);
    await db
      .from('projects')
      .update({ member_count: Math.max(0, (project.member_count ?? 1) - 1) })
      .eq('id', project.id);
  } else {
    await db.from('project_memberships').insert({
      project_id: project.id,
      user_id: userId,
      joined_at: new Date().toISOString()
    });
    await db
      .from('projects')
      .update({ member_count: (project.member_count ?? 0) + 1 })
      .eq('id', project.id);
  }
  return { ok: true, viewerIsMember: !member };
}

export async function toggleEventMembership(db: SupabaseClient, userId: string, slug: string) {
  const event = await getEventBySlug(db, slug);
  if (!event) throw new Error('not_found');
  const member = await isEventMember(db, event.id, userId);
  // Leaving is always allowed for members; joining requires viewability.
  if (!member) {
    if (!(await canViewPrivateEvent(db, userId, event))) throw new Error('not_found');
    if (!(await canViewEntity(db, userId, 'event', event.id))) throw new Error('not_found');
  }
  if (member) {
    await db.from('event_memberships').delete().eq('event_id', event.id).eq('user_id', userId);
    await db
      .from('events')
      .update({ member_count: Math.max(0, (event.member_count ?? 1) - 1) })
      .eq('id', event.id);
  } else {
    await db.from('event_memberships').insert({
      event_id: event.id,
      user_id: userId,
      joined_at: new Date().toISOString()
    });
    await db
      .from('events')
      .update({ member_count: (event.member_count ?? 0) + 1 })
      .eq('id', event.id);
  }
  return { ok: true, viewerIsMember: !member };
}

function normalizeSignalType(signal: string | null | undefined): 'demand' | 'opposition' | null {
  if (!signal) return null;
  const value = String(signal).trim().toLowerCase();
  if (value === 'opposition' || value === 'oppose') return 'opposition';
  if (value === 'demand' || value === 'support') return 'demand';
  return null;
}

async function countSignals(
  db: SupabaseClient,
  table: 'project_signals' | 'event_signals',
  idCol: 'project_id' | 'event_id',
  entityId: string
) {
  const { data } = await db.from(table).select('signal_type').eq(idCol, entityId);
  const demand = (data ?? []).filter((row) => row.signal_type === 'demand').length;
  const opposition = (data ?? []).filter((row) => row.signal_type === 'opposition').length;
  return {
    demand,
    opposition,
    total: demand + opposition
  };
}

export async function setProjectSignal(
  db: SupabaseClient,
  userId: string,
  slug: string,
  signal: string | null
) {
  const project = await getProjectBySlug(db, slug);
  if (!project) throw new Error('not_found');
  if (!(await canViewEntity(db, userId, 'project', project.id))) throw new Error('not_found');

  const requested = normalizeSignalType(signal);
  const { data: existing } = await db
    .from('project_signals')
    .select('id, signal_type')
    .eq('project_id', project.id)
    .eq('user_id', userId)
    .maybeSingle();

  let action: 'added' | 'removed' | 'switched' | 'none' = 'none';
  let signalType: 'demand' | 'opposition' = requested ?? 'demand';

  if (!requested) {
    if (existing) {
      await db.from('project_signals').delete().eq('id', existing.id);
      action = 'removed';
      signalType = existing.signal_type === 'opposition' ? 'opposition' : 'demand';
    }
  } else if (!existing) {
    await db.from('project_signals').insert({
      project_id: project.id,
      user_id: userId,
      signal_type: requested
    });
    action = 'added';
    signalType = requested;
  } else if (existing.signal_type === requested) {
    await db.from('project_signals').delete().eq('id', existing.id);
    action = 'removed';
    signalType = requested;
  } else {
    await db
      .from('project_signals')
      .update({ signal_type: requested })
      .eq('id', existing.id);
    action = 'switched';
    signalType = requested;
  }

  const signals = await countSignals(db, 'project_signals', 'project_id', project.id);
  await db.from('projects').update({ signal_count: signals.total }).eq('id', project.id);
  return {
    ok: true,
    slug: project.slug,
    action,
    signalType,
    signals
  };
}

export async function setEventSignal(
  db: SupabaseClient,
  userId: string,
  slug: string,
  signal: string | null
) {
  const event = await getEventBySlug(db, slug);
  if (!event) throw new Error('not_found');
  if (!(await canViewEntity(db, userId, 'event', event.id))) throw new Error('not_found');

  const requested = normalizeSignalType(signal);
  const { data: existing } = await db
    .from('event_signals')
    .select('id, signal_type')
    .eq('event_id', event.id)
    .eq('user_id', userId)
    .maybeSingle();

  let action: 'added' | 'removed' | 'switched' | 'none' = 'none';
  let signalType: 'demand' | 'opposition' = requested ?? 'demand';

  if (!requested) {
    if (existing) {
      await db.from('event_signals').delete().eq('id', existing.id);
      action = 'removed';
      signalType = existing.signal_type === 'opposition' ? 'opposition' : 'demand';
    }
  } else if (!existing) {
    await db.from('event_signals').insert({
      event_id: event.id,
      user_id: userId,
      signal_type: requested
    });
    action = 'added';
    signalType = requested;
  } else if (existing.signal_type === requested) {
    await db.from('event_signals').delete().eq('id', existing.id);
    action = 'removed';
    signalType = requested;
  } else {
    await db.from('event_signals').update({ signal_type: requested }).eq('id', existing.id);
    action = 'switched';
    signalType = requested;
  }

  const signals = await countSignals(db, 'event_signals', 'event_id', event.id);
  return {
    ok: true,
    slug: event.slug,
    action,
    signalType,
    signals
  };
}

export async function commitHelpRole(
  db: SupabaseClient,
  userId: string,
  helpRequestId: string,
  roleId: string,
  commit: boolean
) {
  const { data: role } = await db
    .from('help_request_roles')
    .select('id, help_request_id, slots')
    .eq('id', roleId)
    .maybeSingle();
  if (!role || role.help_request_id !== helpRequestId) throw new Error('not_found');

  if (commit) {
    const { count } = await db
      .from('help_request_role_assignments')
      .select('*', { count: 'exact', head: true })
      .eq('role_id', roleId);
    if ((count ?? 0) >= Number(role.slots ?? 1)) throw new Error('role_full');

    // One role per user per help request
    const { data: otherRoles } = await db
      .from('help_request_roles')
      .select('id')
      .eq('help_request_id', helpRequestId);
    const otherIds = (otherRoles ?? []).map((r) => r.id as string).filter((id) => id !== roleId);
    if (otherIds.length) {
      await db
        .from('help_request_role_assignments')
        .delete()
        .eq('user_id', userId)
        .in('role_id', otherIds);
    }

    await db.from('help_request_role_assignments').upsert({
      role_id: roleId,
      user_id: userId
    });
  } else {
    await db
      .from('help_request_role_assignments')
      .delete()
      .eq('role_id', roleId)
      .eq('user_id', userId);
  }
  return { ok: true };
}

export async function addProjectValue(db: SupabaseClient, userId: string, slug: string, label: string) {
  const project = await getProjectBySlug(db, slug);
  if (!project) throw new Error('not_found');
  await db.from('project_values').insert({
    project_id: project.id,
    label,
    author_id: userId
  });
  return { ok: true };
}

export async function addEventValue(db: SupabaseClient, userId: string, slug: string, label: string) {
  const event = await getEventBySlug(db, slug);
  if (!event) throw new Error('not_found');
  await db.from('event_values').insert({
    event_id: event.id,
    label,
    author_id: userId
  });
  return { ok: true };
}

export async function addProjectUpdate(
  db: SupabaseClient,
  userId: string,
  slug: string,
  title: string,
  body: string
) {
  const project = await getProjectBySlug(db, slug);
  if (!project) throw new Error('not_found');
  await db.from('project_updates').insert({
    project_id: project.id,
    title,
    body,
    author_id: userId
  });
  await db
    .from('projects')
    .update({ last_activity_at: new Date().toISOString() })
    .eq('id', project.id);
  return { ok: true };
}

export async function updateProjectDetails(
  db: SupabaseClient,
  userId: string,
  slug: string,
  title: string,
  description: string
) {
  const project = await getProjectBySlug(db, slug);
  if (!project) throw new Error('not_found');
  if (project.author_id !== userId && !(await isProjectMember(db, project.id, userId))) {
    throw new Error('forbidden');
  }
  await db.from('projects').update({ title, description }).eq('id', project.id);
  return { ok: true };
}

export async function requestProjectPhaseChange(
  db: SupabaseClient,
  userId: string,
  slug: string,
  body: Record<string, unknown>
) {
  const project = await getProjectBySlug(db, slug);
  if (!project) throw new Error('not_found');
  const targetPhaseId = String(body.targetPhaseId ?? body.target_phase_id ?? '');
  if (!targetPhaseId) throw new Error('invalid_phase');
  const changeKind = String(body.changeKind ?? body.change_kind ?? 'advance');
  const { data: openExisting } = await db
    .from('project_phase_change_requests')
    .select('id')
    .eq('project_id', project.id)
    .eq('status', 'open')
    .limit(1)
    .maybeSingle();
  if (openExisting) throw new Error('conflict');

  const conversion = (body.conversionTarget ?? body.conversion_target ?? null) as
    | Record<string, unknown>
    | null;
  const closeOutcome = body.closeOutcome ?? body.close_outcome ?? null;

  const { data, error } = await db
    .from('project_phase_change_requests')
    .insert({
      project_id: project.id,
      from_phase_id: project.current_phase_id,
      target_phase_id: targetPhaseId,
      change_kind: changeKind,
      close_outcome: closeOutcome,
      conversion_target_mode:
        conversion?.projectMode ?? body.conversion_target_mode ?? null,
      conversion_target_subtype:
        conversion?.projectSubtype ?? body.conversion_target_subtype ?? null,
      conversion_successor_title:
        conversion?.successorTitle ?? body.conversion_successor_title ?? null,
      conversion_successor_description:
        conversion?.successorDescription ?? body.conversion_successor_description ?? null,
      reason: body.reason ?? '',
      author_id: userId,
      status: 'open'
    })
    .select('id')
    .single();
  if (error) throw error;
  return { ok: true, id: data.id };
}

export async function requestProjectPhaseRevert(
  db: SupabaseClient,
  userId: string,
  slug: string,
  body: Record<string, unknown>
) {
  const project = await getProjectBySlug(db, slug);
  if (!project) throw new Error('not_found');
  const targetPhaseId = String(body.targetPhaseId ?? body.target_phase_id ?? '');
  if (!targetPhaseId) throw new Error('invalid_phase');

  const order: Record<string, number> = {
    'phase-1': 1,
    'phase-2': 2,
    'phase-3': 3,
    'phase-4': 4,
    'phase-5': 5,
    'phase-6': 6,
    'phase-7': 7
  };
  const currentOrder = order[String(project.current_phase_id)] ?? 1;
  const targetOrder = order[targetPhaseId] ?? 0;
  if (targetOrder <= 0 || targetOrder >= currentOrder) throw new Error('invalid_phase');

  return requestProjectPhaseChange(db, userId, slug, {
    targetPhaseId,
    reason: body.reason ?? '',
    changeKind: 'return'
  });
}

export async function requestEventPhaseChange(
  db: SupabaseClient,
  userId: string,
  slug: string,
  body: Record<string, unknown>
) {
  const event = await getEventBySlug(db, slug);
  if (!event) throw new Error('not_found');
  const targetPhaseId = String(body.targetPhaseId ?? body.target_phase_id ?? '');
  if (!targetPhaseId) throw new Error('invalid_phase');

  const order: Record<string, number> = {
    proposal: 1,
    'event-plan': 2,
    activity: 3,
    closed: 4
  };
  const currentOrder = order[String(event.current_phase_id)] ?? 1;
  const targetOrder = order[targetPhaseId] ?? 0;
  if (targetOrder <= 0 || targetOrder === currentOrder) throw new Error('invalid_phase');
  const changeKind =
    body.changeKind ?? body.change_kind ?? (targetOrder < currentOrder ? 'return' : 'advance');

  // Organizer-controlled private events: creator/editors auto-apply phase changes.
  if (String(event.governance) === 'organizer_controlled') {
    if (targetPhaseId === 'proposal') throw new Error('invalid_phase');
    const isCreator = event.created_by === userId;
    const { data: editor } = await db
      .from('event_editors')
      .select('user_id')
      .eq('event_id', event.id)
      .eq('user_id', userId)
      .maybeSingle();
    if (!isCreator && !editor) throw new Error('forbidden');

    const { data: approved, error: approvedErr } = await db
      .from('event_phase_change_requests')
      .insert({
        event_id: event.id,
        from_phase_id: event.current_phase_id,
        target_phase_id: targetPhaseId,
        change_kind: changeKind,
        reason: body.reason ?? '',
        author_id: userId,
        status: 'approved'
      })
      .select('id')
      .single();
    if (approvedErr) throw approvedErr;
    await db
      .from('events')
      .update({
        current_phase_id: targetPhaseId,
        last_activity_at: new Date().toISOString()
      })
      .eq('id', event.id);
    return { ok: true, id: approved.id, applied: true, currentPhaseId: targetPhaseId };
  }

  const { data: openExisting } = await db
    .from('event_phase_change_requests')
    .select('id')
    .eq('event_id', event.id)
    .eq('status', 'open')
    .limit(1)
    .maybeSingle();
  if (openExisting) throw new Error('conflict');

  const { data, error } = await db
    .from('event_phase_change_requests')
    .insert({
      event_id: event.id,
      from_phase_id: event.current_phase_id,
      target_phase_id: targetPhaseId,
      change_kind: changeKind,
      reason: body.reason ?? '',
      author_id: userId,
      status: 'open'
    })
    .select('id')
    .single();
  if (error) throw error;
  return { ok: true, id: data.id };
}

export async function advanceProjectPhase(
  db: SupabaseClient,
  userId: string,
  slug: string,
  closeNote?: string
) {
  const project = await getProjectBySlug(db, slug);
  if (!project) throw new Error('not_found');

  if (String(project.project_mode) === 'personal-service') {
    const { data: membership } = await db
      .from('project_memberships')
      .select('is_manager')
      .eq('project_id', project.id)
      .eq('user_id', userId)
      .maybeSingle();
    if (project.author_id !== userId && !membership?.is_manager) throw new Error('forbidden');
  } else if (!(await isProjectMember(db, project.id, userId))) {
    throw new Error('forbidden');
  }

  const currentPhaseId = String(project.current_phase_id);
  const subtype = project.project_subtype != null ? String(project.project_subtype) : null;
  const next = nextPhaseIdForProject(String(project.project_mode), subtype, currentPhaseId);
  if (!next) throw new Error('conflict');

  const note = String(closeNote || '').trim();
  if (next === 'phase-7' && !note) throw new Error('close_note_required');

  let resolvedSubtype = subtype;
  if (currentPhaseId === 'phase-1' && next === 'phase-2') {
    const { data: winning } = await db
      .from('project_plans')
      .select('project_subtype, plan_payload')
      .eq('project_id', project.id)
      .eq('is_leading', true)
      .limit(1)
      .maybeSingle();
    if (winning) {
      const payload = (winning.plan_payload ?? {}) as Record<string, unknown>;
      const fromPlan =
        winning.project_subtype ||
        payload.projectSubtype ||
        payload.project_subtype ||
        null;
      if (fromPlan) resolvedSubtype = String(fromPlan);
    }
  }

  if (next === 'phase-7') {
    await applyProjectClose(db, project, 'close', note, userId);
  } else {
    const updateValues: Record<string, unknown> = {
      current_phase_id: next,
      stage_label: displayStageLabel(String(project.project_mode), resolvedSubtype, next),
      last_activity_at: new Date().toISOString()
    };
    if (resolvedSubtype && resolvedSubtype !== subtype) {
      updateValues.project_subtype = resolvedSubtype;
    }
    await db.from('projects').update(updateValues).eq('id', project.id);
  }

  return {
    ok: true,
    project_slug: project.slug,
    previous_phase_id: currentPhaseId,
    current_phase_id: next
  };
}

export async function addProjectProductionPlan(
  db: SupabaseClient,
  userId: string,
  slug: string,
  input: Record<string, unknown>
) {
  const project = await getProjectBySlug(db, slug);
  if (!project) throw new Error('not_found');
  const rawPhase = String(input.phase ?? input.phaseKind ?? input.phase_kind ?? 'production');
  const phaseKind =
    rawPhase === 'distribution' ? 'distribution' : rawPhase === 'organisation' ? 'organisation' : 'production';
  const { data, error } = await db
    .from('project_plans')
    .insert({
      project_id: project.id,
      phase_kind: phaseKind,
      title: input.title ?? (phaseKind === 'distribution' ? 'Distribution plan' : 'Production plan'),
      description: input.description ?? '',
      author_id: userId,
      project_subtype: input.projectSubtype ?? input.project_subtype ?? null,
      repository_url: input.repositoryUrl ?? input.repository_url ?? null,
      demand_consideration_note: input.demandConsiderationNote ?? '',
      total_cost_label: input.totalCostLabel ?? '',
      location_id: input.locationId ?? input.location_id ?? null,
      plan_payload: input
    })
    .select('id')
    .single();
  if (error) throw error;
  return { ok: true, id: data.id };
}

export async function addEventPlan(
  db: SupabaseClient,
  userId: string,
  slug: string,
  input: Record<string, unknown>
) {
  const event = await getEventBySlug(db, slug);
  if (!event) throw new Error('not_found');
  const schedulePayload =
    (input.schedule as Record<string, unknown> | undefined) ??
    (input.schedulePayload as Record<string, unknown> | undefined) ??
    {};
  const { data, error } = await db
    .from('event_plans')
    .insert({
      event_id: event.id,
      title: input.title ?? 'Event plan',
      description: input.description ?? '',
      author_id: userId,
      demand_consideration_note: input.demandConsiderationNote ?? '',
      location_label: input.locationLabel ?? event.location_label ?? '',
      location_id: input.locationId ?? input.location_id ?? event.location_id ?? null,
      schedule_payload: schedulePayload,
      plan_payload: input
    })
    .select('id')
    .single();
  if (error) throw error;
  return { ok: true, id: data.id };
}

export async function createScopeInvite(
  db: SupabaseClient,
  userId: string,
  kind: 'channel' | 'community',
  slug: string
) {
  const table = kind === 'channel' ? 'channels' : 'communities';
  const { data: scope } = await db.from(table).select('*').eq('slug', slug).maybeSingle();
  if (!scope) throw new Error('not_found');
  const member = await isScopeMember(db, kind, scope.id, userId);
  if (!member) throw new Error('forbidden');
  // Open scopes require manager/moderator; closed communities allow any member.
  if (!(kind === 'community' && scope.join_policy === 'closed')) {
    const { data: membership } = await db
      .from('scope_memberships')
      .select('role')
      .eq('scope_kind', kind)
      .eq('scope_id', scope.id)
      .eq('user_id', userId)
      .maybeSingle();
    const role = String(membership?.role ?? 'member').toLowerCase();
    if (role !== 'moderator' && role !== 'manager' && role !== 'owner') {
      throw new Error('forbidden');
    }
  }
  const inviteValue = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const tokenHash = await hashToken(inviteValue);
  const { data, error } = await db
    .from('scope_invites')
    .insert({
      scope_kind: kind,
      scope_id: scope.id,
      token_hash: tokenHash,
      created_by: userId,
      max_uses: 50
    })
    .select('id')
    .single();
  if (error) throw error;
  return { inviteId: data.id, inviteCode: inviteValue, inviteValue };
}

export async function inviteUserToCommunity(
  db: SupabaseClient,
  userId: string,
  slug: string,
  username: string
) {
  const { data: community } = await db.from('communities').select('*').eq('slug', slug).maybeSingle();
  if (!community) throw new Error('not_found');
  if (community.join_policy !== 'closed') throw new Error('direct_invite_closed_only');
  if (!(await isScopeMember(db, 'community', community.id, userId))) throw new Error('forbidden');

  const normalized = String(username ?? '').trim();
  if (!normalized) throw new Error('username_required');
  const { data: target } = await db
    .from('users')
    .select('id, username')
    .eq('username', normalized)
    .maybeSingle();
  if (!target || target.id === userId) throw new Error('not_found');

  if (await isScopeMember(db, 'community', community.id, target.id)) {
    return { ok: true, username: target.username, alreadyMember: true };
  }

  await db.from('scope_memberships').insert({
    scope_kind: 'community',
    scope_id: community.id,
    user_id: target.id,
    role: 'member'
  });
  await db.from('notifications').insert({
    recipient_id: target.id,
    actor_id: userId,
    kind: 'community-invite',
    surface: 'community',
    subject_type: 'community',
    subject_id: community.id,
    title: community.name,
    body: 'You were invited to join this private community.',
    href: `/communities/${community.slug}`,
    is_unread: true
  });
  return { ok: true, username: target.username, alreadyMember: false };
}

export async function redeemScopeInvite(
  db: SupabaseClient,
  userId: string,
  kind: string,
  slug: string,
  inviteValue: string
) {
  const table = kind === 'channel' ? 'channels' : 'communities';
  const { data: scope } = await db.from(table).select('id').eq('slug', slug).maybeSingle();
  if (!scope) throw new Error('not_found');
  const tokenHash = await hashToken(inviteValue);
  const { data: invite } = await db
    .from('scope_invites')
    .select('*')
    .eq('scope_kind', kind)
    .eq('scope_id', scope.id)
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (!invite) throw new Error('invalid_invite');
  if (invite.max_uses != null && invite.uses >= invite.max_uses) {
    throw new Error('invite_exhausted');
  }
  await db.from('scope_memberships').upsert({
    scope_kind: kind,
    scope_id: scope.id,
    user_id: userId,
    role: 'member'
  });
  await db
    .from('scope_invites')
    .update({ uses: (invite.uses ?? 0) + 1 })
    .eq('id', invite.id);
  return { ok: true, redeemed: true };
}

async function hashToken(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function createChannel(db: SupabaseClient, userId: string, input: Record<string, unknown>) {
  const slug =
    (input.slug as string | undefined) ??
    `${String(input.name ?? 'channel')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40)}-${crypto.randomUUID().slice(0, 6)}`;
  const { data, error } = await db
    .from('channels')
    .insert({
      slug,
      name: input.name ?? input.title ?? slug,
      description: input.description ?? '',
      created_by: userId
    })
    .select('id, slug')
    .single();
  if (error) throw error;
  await db.from('scope_memberships').insert({
    scope_kind: 'channel',
    scope_id: data.id,
    user_id: userId,
    role: 'moderator'
  });
  await recordMeaningfulAction(db, userId, 'create-channel', { channel_id: data.id, slug: data.slug });
  return { ok: true, id: data.id, slug: data.slug };
}

export async function createCommunity(
  db: SupabaseClient,
  userId: string,
  input: Record<string, unknown>
) {
  const slug =
    (input.slug as string | undefined) ??
    `${String(input.name ?? 'community')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40)}-${crypto.randomUUID().slice(0, 6)}`;
  const { data, error } = await db
    .from('communities')
    .insert({
      slug,
      name: input.name ?? input.title ?? slug,
      description: input.description ?? '',
      join_policy: input.joinPolicy ?? input.join_policy ?? 'open',
      created_by: userId
    })
    .select('id, slug')
    .single();
  if (error) throw error;
  await db.from('scope_memberships').insert({
    scope_kind: 'community',
    scope_id: data.id,
    user_id: userId,
    role: 'moderator'
  });
  await recordMeaningfulAction(db, userId, 'create-community', {
    community_id: data.id,
    slug: data.slug
  });
  return { ok: true, id: data.id, slug: data.slug };
}

export async function createGroupConversation(
  db: SupabaseClient,
  userId: string,
  input: Record<string, unknown>
) {
  const usernames = (input.memberUsernames ??
    input.participantUsernames ??
    input.usernames ??
    []) as string[];
  const { data: users } = usernames.length
    ? await db.from('users').select('id, username').in('username', usernames)
    : { data: [] as Array<{ id: string; username: string }> };
  const { data: conversation, error } = await db
    .from('conversations')
    .insert({
      kind: 'group',
      title: input.title ?? 'Group chat',
      created_by: userId
    })
    .select('id')
    .single();
  if (error) throw error;
  const joinedAt = new Date().toISOString();
  const members = [{ conversation_id: conversation.id, user_id: userId, joined_at: joinedAt }];
  for (const user of users ?? []) {
    if (user.id !== userId) {
      members.push({ conversation_id: conversation.id, user_id: user.id, joined_at: joinedAt });
    }
  }
  const { error: memberErr } = await db.from('conversation_members').insert(members);
  if (memberErr) throw memberErr;
  if (input.body) {
    const { error: msgErr } = await db.from('messages').insert({
      conversation_id: conversation.id,
      sender_id: userId,
      encrypted_body: input.body,
      encryption_version: 0
    });
    if (msgErr) throw msgErr;
  }
  return { ok: true, conversationId: conversation.id };
}

export async function renameGroupConversation(
  db: SupabaseClient,
  userId: string,
  conversationId: string,
  title: string
) {
  const { data: membership } = await db
    .from('conversation_members')
    .select('user_id')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!membership) throw new Error('forbidden');
  await db.from('conversations').update({ title }).eq('id', conversationId);
  return { ok: true, conversationId, title };
}

export async function addGroupMember(
  db: SupabaseClient,
  userId: string,
  conversationId: string,
  username: string
) {
  const { data: membership } = await db
    .from('conversation_members')
    .select('user_id')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!membership) throw new Error('forbidden');
  const { data: user } = await db.from('users').select('id').eq('username', username).maybeSingle();
  if (!user) throw new Error('not_found');
  const { error } = await db.from('conversation_members').upsert({
    conversation_id: conversationId,
    user_id: user.id,
    joined_at: new Date().toISOString()
  });
  if (error) throw error;
  return { ok: true, conversationId };
}

export async function removeGroupMember(
  db: SupabaseClient,
  userId: string,
  conversationId: string,
  username: string
) {
  const { data: membership } = await db
    .from('conversation_members')
    .select('user_id')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!membership) throw new Error('forbidden');
  const { data: user } = await db.from('users').select('id').eq('username', username).maybeSingle();
  if (!user) throw new Error('not_found');
  await db
    .from('conversation_members')
    .delete()
    .eq('conversation_id', conversationId)
    .eq('user_id', user.id);
  return { ok: true, conversationId };
}

export async function markLinkedChatRead(
  db: SupabaseClient,
  userId: string,
  subjectType: string,
  subjectId: string
) {
  await db.from('subject_chat_reads').upsert({
    user_id: userId,
    subject_type: subjectType,
    subject_id: subjectId,
    last_read_at: new Date().toISOString()
  });
  return { ok: true };
}

export async function acceptFollowRequest(db: SupabaseClient, userId: string, username: string) {
  const { data: follower } = await db.from('users').select('id, username').eq('username', username).maybeSingle();
  if (!follower) throw new Error('not_found');
  const { data: updated, error } = await db
    .from('user_follows')
    .update({ status: 'accepted' })
    .eq('follower_id', follower.id)
    .eq('followed_id', userId)
    .eq('status', 'pending')
    .select('follower_id')
    .maybeSingle();
  if (error) throw error;
  if (!updated) throw new Error('not_found');

  const { data: accepter } = await db.from('users').select('username').eq('id', userId).maybeSingle();
  const accepterUsername = accepter?.username ?? 'someone';
  await db.from('notifications').insert({
    recipient_id: follower.id,
    actor_id: userId,
    kind: 'follow-accepted',
    surface: 'profile',
    subject_type: 'user',
    subject_id: userId,
    target_id: follower.id,
    title: 'Follow request accepted',
    body: `@${accepterUsername} accepted your follow request.`,
    href: `/profile/${accepterUsername}`,
    is_unread: true
  });
  // Mark any pending follow-request notification as read for the accepter.
  await db
    .from('notifications')
    .update({ is_unread: false, read_at: new Date().toISOString() })
    .eq('recipient_id', userId)
    .eq('actor_id', follower.id)
    .eq('kind', 'follow-request')
    .eq('is_unread', true);
  return { ok: true };
}

export async function rejectFollowRequest(db: SupabaseClient, userId: string, username: string) {
  const { data: follower } = await db.from('users').select('id').eq('username', username).maybeSingle();
  if (!follower) throw new Error('not_found');
  await db
    .from('user_follows')
    .delete()
    .eq('follower_id', follower.id)
    .eq('followed_id', userId)
    .eq('status', 'pending');
  return { ok: true };
}

export async function shareEntityWithUser(
  db: SupabaseClient,
  userId: string,
  entityKind: 'project' | 'event',
  slug: string,
  username: string
) {
  const { data: target } = await db
    .from('users')
    .select('id, username')
    .eq('username', username)
    .maybeSingle();
  if (!target) throw new Error('not_found');
  const table = entityKind === 'project' ? 'projects' : 'events';
  const { data: entity } = await db.from(table).select('id').eq('slug', slug).maybeSingle();
  if (!entity) throw new Error('not_found');
  if (!(await canViewEntity(db, userId, entityKind, entity.id))) throw new Error('not_found');
  await db.from('notifications').insert({
    recipient_id: target.id,
    actor_id: userId,
    kind: entityKind === 'project' ? 'prj-share' : 'evt-share',
    surface: 'personal',
    subject_type: entityKind,
    subject_id: entity.id,
    title: `Shared ${entityKind}`,
    body: `Shared ${slug} with you`,
    href: entityKind === 'project' ? `/projects/${slug}` : `/events/${slug}`,
    is_unread: true
  });
  return { ok: true, username: target.username };
}

export async function upsertSearchDocument(
  db: SupabaseClient,
  doc: {
    entityType: string;
    entityId: string;
    title: string;
    summary: string;
    meta: string;
    href: string;
  }
) {
  const { error } = await db.rpc('upsert_searchable_document', {
    p_entity_type: doc.entityType,
    p_entity_id: doc.entityId,
    p_title: doc.title,
    p_summary: doc.summary,
    p_meta: doc.meta,
    p_href: doc.href
  });
  if (error) throw error;
}
