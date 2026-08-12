import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { nextPhaseIdForProject } from './phases.ts';
import { eventPopulation, projectPopulation, requiredVotes } from './votes.ts';

export async function resolveProjectSubtype(
  db: SupabaseClient,
  project: Record<string, unknown>
): Promise<string | null> {
  if (project.project_subtype) return String(project.project_subtype);
  const { data } = await db
    .from('project_plans')
    .select('project_subtype, plan_payload')
    .eq('project_id', String(project.id))
    .eq('is_leading', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const payload = (data?.plan_payload ?? {}) as Record<string, unknown>;
  const subtype =
    data?.project_subtype ?? payload.projectSubtype ?? payload.project_subtype ?? null;
  return subtype ? String(subtype) : null;
}

async function ensureSignalGate(
  db: SupabaseClient,
  table: 'project_signals' | 'event_signals',
  idColumn: 'project_id' | 'event_id',
  entityId: string,
  population: number,
  requireDemandQuorum: boolean
) {
  const { data, error } = await db.from(table).select('signal_type').eq(idColumn, entityId);
  if (error) throw error;
  const demand = (data ?? []).filter((row) => row.signal_type === 'demand').length;
  const opposition = (data ?? []).filter((row) => row.signal_type === 'opposition').length;
  const total = demand + opposition;
  const ratioMet = total > 0 && demand / total >= 0.66;
  const demandMet = !requireDemandQuorum || demand >= requiredVotes(Math.max(0, population));
  if (!ratioMet || !demandMet) throw new Error('signal_gate_locked');
}

async function ensureLeadingPlan(
  db: SupabaseClient,
  entityColumn: 'project_id' | 'event_id',
  entityId: string,
  phaseKinds: string[]
) {
  const table = entityColumn === 'project_id' ? 'project_plans' : 'event_plans';
  let query = db
    .from(table)
    .select('id')
    .eq(entityColumn, entityId)
    .eq('is_leading', true)
    .limit(1);
  if (phaseKinds.length) query = query.in('phase_kind', phaseKinds);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('plan_gate_locked');
}

export async function ensureProjectAdvanceAllowed(
  db: SupabaseClient,
  project: Record<string, unknown>,
  targetPhaseId: string
) {
  const mode = String(project.project_mode ?? 'productive');
  if (mode === 'personal-service') throw new Error('personal_service_governance_disabled');
  const subtype = await resolveProjectSubtype(db, project);
  const currentPhaseId = String(project.current_phase_id ?? 'phase-1');
  const expected = nextPhaseIdForProject(mode, subtype, currentPhaseId);
  if (targetPhaseId !== expected) throw new Error('invalid_phase');

  if (currentPhaseId === 'phase-1') {
    await ensureSignalGate(
      db,
      'project_signals',
      'project_id',
      String(project.id),
      await projectPopulation(db, String(project.id)),
      Boolean(project.is_platform_tagged)
    );
  } else if (currentPhaseId === 'phase-2') {
    await ensureLeadingPlan(
      db,
      'project_id',
      String(project.id),
      mode === 'collective-service' ? ['organisation', 'production'] : ['production']
    );
  } else if (currentPhaseId === 'phase-3') {
    await ensureLeadingPlan(db, 'project_id', String(project.id), ['distribution', 'access']);
  }
}

export async function ensureEventAdvanceAllowed(
  db: SupabaseClient,
  event: Record<string, unknown>,
  targetPhaseId: string
) {
  const currentPhaseId = String(event.current_phase_id ?? 'proposal');
  const nextByPhase: Record<string, string | null> = {
    proposal: 'event-plan',
    'event-plan': 'activity',
    activity: 'closed',
    closed: null
  };
  if (targetPhaseId !== nextByPhase[currentPhaseId]) throw new Error('invalid_phase');
  if (currentPhaseId === 'proposal') {
    await ensureSignalGate(
      db,
      'event_signals',
      'event_id',
      String(event.id),
      await eventPopulation(db, String(event.id)),
      Boolean(event.is_platform_tagged)
    );
  } else if (currentPhaseId === 'event-plan') {
    await ensureLeadingPlan(db, 'event_id', String(event.id), []);
  }
}
