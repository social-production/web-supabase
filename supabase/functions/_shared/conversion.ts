/**
 * Project close + conversion — FastAPI oracle: projects/phases/conversion.py
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import {
  displayStageLabel,
  PROJECT_MODES,
  PROJECT_SUBTYPES
} from './phases.ts';

export const CONVERSION_LINK_KIND = 'conversion';
export const CONVERSION_TO_LABEL = 'Converted to';
export const CONVERSION_FROM_LABEL = 'Converted from';
export const INVENTORY_NOTE =
  'Inventory, open requests, plans, signals, and roles stay on the predecessor. ' +
  'Only tags/scopes and memberships carry into the successor.';
export const PERMANENCE_NOTE =
  'This predecessor/successor conversion relationship is permanent and is not ' +
  'managed through manual project links.';

function uniqueSuccessorSlug(title: string): string {
  const cleaned =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'converted';
  return `${cleaned}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function applyProjectClose(
  db: SupabaseClient,
  projectRow: Record<string, unknown>,
  closeOutcome: string,
  closeNote: string | null | undefined,
  authorId: string | null
) {
  let outcome = String(closeOutcome || 'close').trim().toLowerCase();
  if (outcome !== 'close' && outcome !== 'convert') outcome = 'close';
  const subtype =
    projectRow.project_subtype != null ? String(projectRow.project_subtype) : null;
  await db
    .from('projects')
    .update({
      current_phase_id: 'phase-7',
      stage_label: displayStageLabel(String(projectRow.project_mode), subtype, 'phase-7'),
      is_closed: true,
      close_outcome: outcome,
      last_activity_at: new Date().toISOString()
    })
    .eq('id', projectRow.id);

  const note = String(closeNote || '').trim();
  if (note) {
    await db.from('project_updates').insert({
      project_id: projectRow.id,
      title: 'Closure note',
      body: note,
      author_id: authorId
    });
  }
}

async function snapshotPredecessorHistory(
  db: SupabaseClient,
  predecessor: Record<string, unknown>,
  successorId: string,
  electorateSize: number
) {
  const { data: phaseRows } = await db
    .from('project_phase_change_requests')
    .select('*')
    .eq('project_id', predecessor.id)
    .order('created_at', { ascending: true });
  for (const req of phaseRows ?? []) {
    const { data: votes } = await db
      .from('project_phase_change_votes')
      .select('vote')
      .eq('request_id', req.id);
    const yesCount = (votes ?? []).filter((v) => v.vote === 'yes').length;
    const noCount = (votes ?? []).filter((v) => v.vote === 'no').length;
    let authorUsername = 'unknown';
    if (req.author_id) {
      const { data: user } = await db
        .from('users')
        .select('username')
        .eq('id', req.author_id)
        .maybeSingle();
      if (user?.username) authorUsername = user.username;
    }
    await db.from('project_inherited_decisions').insert({
      successor_project_id: successorId,
      predecessor_project_id: predecessor.id,
      predecessor_slug: predecessor.slug,
      predecessor_title: predecessor.title,
      source_decision_id: req.id,
      kind: 'project-phase-change',
      kind_label: 'Inherited phase decision',
      status: req.status,
      author_username: authorUsername,
      original_created_at: req.created_at,
      electorate_size: electorateSize,
      yes_count: yesCount,
      no_count: noCount,
      approval_threshold_percent: 66,
      payload: {
        type: 'phase-change',
        changeKind: req.change_kind,
        fromPhaseId: req.from_phase_id,
        toPhaseId: req.target_phase_id,
        reason: req.reason,
        closeOutcome: req.close_outcome,
        conversionTargetMode: req.conversion_target_mode,
        conversionTargetSubtype: req.conversion_target_subtype
      }
    });
  }
}

export async function executeConversion(
  db: SupabaseClient,
  predecessor: Record<string, unknown>,
  requestRow: Record<string, unknown>,
  actingUserId: string
) {
  const { data: existing } = await db
    .from('project_conversions')
    .select('id')
    .eq('predecessor_project_id', predecessor.id)
    .maybeSingle();
  if (existing) throw new Error('conflict');

  let targetMode = String(requestRow.conversion_target_mode || '')
    .trim()
    .toLowerCase();
  let targetSubtypeRaw = requestRow.conversion_target_subtype;
  let targetSubtype =
    targetSubtypeRaw != null ? String(targetSubtypeRaw).trim().toLowerCase() : null;
  if (!PROJECT_MODES.has(targetMode)) throw new Error('invalid_conversion_mode');
  if (targetMode === 'personal-service') targetSubtype = null;
  else if (targetSubtype != null && !PROJECT_SUBTYPES.has(targetSubtype)) {
    throw new Error('invalid_conversion_subtype');
  }

  let title = String(requestRow.conversion_successor_title || '').trim();
  if (!title) title = `${predecessor.title} (converted)`;
  let description = String(requestRow.conversion_successor_description || '').trim();
  if (!description) {
    description = String(requestRow.reason || predecessor.description || '').trim();
  }
  const summary =
    String(requestRow.reason || '').trim() || 'Converted from predecessor project.';
  const phaseId = 'phase-1';
  const stageLabel = displayStageLabel(targetMode, targetSubtype, phaseId);
  const now = new Date().toISOString();
  const slug = uniqueSuccessorSlug(title);
  const authorId = (requestRow.author_id as string) || actingUserId;

  const { data: successor, error: succErr } = await db
    .from('projects')
    .insert({
      slug,
      title: title.slice(0, 200),
      description,
      author_id: authorId,
      project_mode: targetMode,
      project_subtype: targetSubtype,
      current_phase_id: phaseId,
      stage_label: stageLabel,
      location_label: predecessor.location_label || 'online',
      member_count: 0,
      last_activity_at: now,
      is_platform_tagged: Boolean(predecessor.is_platform_tagged),
      is_closed: false,
      close_outcome: null,
      signal_count: 0,
      vote_count: 0,
      comment_count: 0
    })
    .select('id, slug, title, description, project_mode, project_subtype')
    .single();
  if (succErr || !successor) throw succErr ?? new Error('conversion_failed');

  const { data: tagRows } = await db
    .from('project_tags')
    .select('*')
    .eq('project_id', predecessor.id);
  for (const tag of tagRows ?? []) {
    await db.from('project_tags').insert({
      project_id: successor.id,
      tag_kind: tag.tag_kind,
      channel_id: tag.channel_id,
      community_id: tag.community_id
    });
  }

  const { data: memberRows } = await db
    .from('project_memberships')
    .select('*')
    .eq('project_id', predecessor.id);
  for (const member of memberRows ?? []) {
    await db.from('project_memberships').insert({
      project_id: successor.id,
      user_id: member.user_id,
      is_manager: false,
      is_manager_candidate: false,
      joined_at: now
    });
  }
  await db
    .from('projects')
    .update({ member_count: (memberRows ?? []).length })
    .eq('id', successor.id);

  await db.from('project_conversions').insert({
    predecessor_project_id: predecessor.id,
    successor_project_id: successor.id,
    summary,
    inventory_note: INVENTORY_NOTE,
    permanence_note: PERMANENCE_NOTE
  });

  await db.from('project_links').insert([
    {
      source_project_id: predecessor.id,
      target_project_id: successor.id,
      relationship_label: CONVERSION_TO_LABEL,
      summary,
      link_kind: CONVERSION_LINK_KIND,
      status: 'active'
    },
    {
      source_project_id: successor.id,
      target_project_id: predecessor.id,
      relationship_label: CONVERSION_FROM_LABEL,
      summary,
      link_kind: CONVERSION_LINK_KIND,
      status: 'active'
    }
  ]);

  await db.from('detail_links').insert([
    {
      source_kind: 'project',
      source_project_id: predecessor.id,
      source_event_id: null,
      target_kind: 'project',
      target_project_id: successor.id,
      target_event_id: null,
      relationship_label: CONVERSION_TO_LABEL,
      summary,
      link_kind: CONVERSION_LINK_KIND,
      status: 'active'
    },
    {
      source_kind: 'project',
      source_project_id: successor.id,
      source_event_id: null,
      target_kind: 'project',
      target_project_id: predecessor.id,
      target_event_id: null,
      relationship_label: CONVERSION_FROM_LABEL,
      summary,
      link_kind: CONVERSION_LINK_KIND,
      status: 'active'
    }
  ]);

  await snapshotPredecessorHistory(
    db,
    predecessor,
    successor.id,
    Number(predecessor.member_count || (memberRows ?? []).length || 0)
  );

  return successor;
}

export async function closeAndMaybeConvert(
  db: SupabaseClient,
  projectRow: Record<string, unknown>,
  requestRow: Record<string, unknown>,
  actingUserId: string
) {
  let outcome = String(requestRow.close_outcome || 'close').trim().toLowerCase();
  if (outcome !== 'close' && outcome !== 'convert') outcome = 'close';

  await applyProjectClose(
    db,
    projectRow,
    outcome,
    String(requestRow.reason || ''),
    (requestRow.author_id as string) || actingUserId
  );

  if (outcome !== 'convert') return null;
  return executeConversion(db, projectRow, requestRow, actingUserId);
}
