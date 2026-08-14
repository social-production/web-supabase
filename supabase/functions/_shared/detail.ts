/**
 * Minimal AppAdapter-compatible detail lifecycle builders.
 * Enough structure for detail pages to render without crashing;
 * full FastAPI-depth hydration remains incremental.
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { eventPhaseCopy, projectPhaseCopy } from './lifecycle_copy.ts';
import {
  nextPhaseIdForProject,
  visiblePhaseIdForProject,
  visiblePhaseIdsForProject
} from './phases.ts';
import { eventPopulation, isPlatformEvent, projectPopulation, requiredVotes, summarizeVotes } from './votes.ts';

function emptySignalSummary(
  supportCount = 0,
  opposeCount = 0,
  viewerSignal: 'demand' | 'opposition' | null = null,
  population = 0,
  usesPlatformVoteContext = false
) {
  const totalCount = supportCount + opposeCount;
  const signalRatioPercent = totalCount > 0 ? Math.round((supportCount / totalCount) * 100) : 0;
  const ratioRequirementMet = totalCount > 0 && signalRatioPercent >= 66;
  const requiredDemandCount = Math.max(0, requiredVotes(Math.max(0, population)));
  const demandRequirementMet = requiredDemandCount <= 0 || supportCount >= requiredDemandCount;
  const advancementUnlocked =
    ratioRequirementMet && (population <= 0 || demandRequirementMet);
  return {
    demandCount: supportCount,
    oppositionCount: opposeCount,
    totalCount,
    viewerSignal,
    signalRatioPercent,
    ratioRequirementMet,
    requiredDemandCount,
    demandRequirementMet,
    advancementUnlocked,
    usesPlatformVoteContext,
    voteContextLabel: usesPlatformVoteContext
      ? 'weekly active users'
      : population > 0
        ? 'weekly active members'
        : 'open',
    voteContextPopulation: population
  };
}

const PROJECT_PHASES = [
  {
    id: 'phase-1',
    order: 1,
    shortLabel: '1',
    title: 'Proposal',
    summary: 'Signal demand and gather values.',
    projectStatus: 'Proposal'
  },
  {
    id: 'phase-2',
    order: 2,
    shortLabel: '2',
    title: 'Production plan',
    summary: 'Choose how the work gets done.',
    projectStatus: 'Planning'
  },
  {
    id: 'phase-3',
    order: 3,
    shortLabel: '3',
    title: 'Distribution plan',
    summary: 'Decide how outputs are shared.',
    projectStatus: 'Planning'
  },
  {
    id: 'phase-5',
    order: 5,
    shortLabel: '5',
    title: 'Activity',
    summary: 'Run the work.',
    projectStatus: 'Active'
  },
  {
    id: 'phase-7',
    order: 7,
    shortLabel: '7',
    title: 'Closed',
    summary: 'Project closed.',
    projectStatus: 'Closed'
  }
] as const;

const EVENT_PHASES = [
  {
    id: 'proposal',
    order: 1,
    shortLabel: '1',
    title: 'Proposal',
    summary: 'Signal interest and gather values.',
    eventStatus: 'Proposal'
  },
  {
    id: 'event-plan',
    order: 2,
    shortLabel: '2',
    title: 'Event plan',
    summary: 'Choose the event plan.',
    eventStatus: 'Planning'
  },
  {
    id: 'activity',
    order: 3,
    shortLabel: '3',
    title: 'Activity',
    summary: 'Run the event.',
    eventStatus: 'Active'
  },
  {
    id: 'closed',
    order: 4,
    shortLabel: '4',
    title: 'Closed',
    summary: 'Event closed.',
    eventStatus: 'Closed'
  }
] as const;

function progressState(
  currentOrder: number,
  order: number
): 'complete' | 'current' | 'upcoming' {
  if (order < currentOrder) return 'complete';
  if (order === currentOrder) return 'current';
  return 'upcoming';
}

async function loadSignalState(
  db: SupabaseClient,
  table: 'project_signals' | 'event_signals',
  idCol: 'project_id' | 'event_id',
  entityId: string,
  userId: string | null
) {
  const { data } = await db.from(table).select('user_id, signal_type').eq(idCol, entityId);
  let supportCount = 0;
  let opposeCount = 0;
  let viewerSignal: 'demand' | 'opposition' | null = null;
  for (const row of data ?? []) {
    if (row.signal_type === 'demand' || row.signal_type === 'support') supportCount += 1;
    if (row.signal_type === 'opposition' || row.signal_type === 'oppose') opposeCount += 1;
    if (userId && row.user_id === userId) {
      viewerSignal =
        row.signal_type === 'opposition' || row.signal_type === 'oppose' ? 'opposition' : 'demand';
    }
  }
  return { supportCount, opposeCount, viewerSignal };
}

function importanceLabelFromAvg(avg: number, voteCount: number): string {
  if (voteCount <= 0) return 'Unset';
  if (avg >= 7) return 'high';
  if (avg >= 4) return 'medium';
  return 'low';
}

async function hydrateValueImportance(
  db: SupabaseClient,
  valuesTable: 'project_values' | 'event_values',
  votesTable: 'project_value_importance_votes' | 'event_value_importance_votes',
  entityCol: 'project_id' | 'event_id',
  entityId: string,
  userId: string | null
) {
  const authorFk =
    valuesTable === 'project_values'
      ? 'users!fk_project_values_author_id_users(username)'
      : 'users!fk_event_values_author_id_users(username)';
  const { data: values } = await db
    .from(valuesTable)
    .select(`id, label, author_id, ${authorFk}`)
    .eq(entityCol, entityId);
  const valueIds = (values ?? []).map((v) => v.id as string);
  const votesByValue = new Map<string, Array<{ voter_id: string; importance: number }>>();
  if (valueIds.length > 0) {
    const { data: votes } = await db
      .from(votesTable)
      .select('value_id, voter_id, importance')
      .in('value_id', valueIds);
    for (const row of votes ?? []) {
      const list = votesByValue.get(row.value_id as string) ?? [];
      list.push({ voter_id: row.voter_id as string, importance: Number(row.importance) });
      votesByValue.set(row.value_id as string, list);
    }
  }

  return (values ?? []).map((value) => {
    const author = Array.isArray(value.users) ? value.users[0] : value.users;
    const votes = votesByValue.get(value.id as string) ?? [];
    const voteCount = votes.length;
    const avg = voteCount > 0 ? votes.reduce((sum, v) => sum + v.importance, 0) / voteCount : 0;
    let activeImportanceVote = 0;
    if (userId) {
      const mine = votes.find((v) => v.voter_id === userId);
      if (mine) activeImportanceVote = mine.importance;
    }
    return {
      id: value.id,
      label: value.label,
      authorUsername: author?.username ?? 'unknown',
      voteCount,
      importanceScore: Math.round(avg * 100) / 100,
      importanceLabel: importanceLabelFromAvg(avg, voteCount),
      activeImportanceVote
    };
  });
}

function buildPlanVoteSummary(
  voteRows: Array<{ vote?: string | number | null; voter_id?: string }>,
  userId: string | null,
  population: number
) {
  const stats = summarizeVotes(voteRows);
  const votesRequired = requiredVotes(Math.max(0, population));
  const approvalPercent = Math.round(stats.approvalRatio * 100);
  let activeVote: 'yes' | 'no' | null = null;
  if (userId) {
    const mine = voteRows.find((row) => row.voter_id === userId);
    if (mine) {
      if (mine.vote === 'yes' || mine.vote === 1 || mine.vote === '1') activeVote = 'yes';
      else if (mine.vote === 'no' || mine.vote === -1 || mine.vote === '-1') activeVote = 'no';
    }
  }
  const remainingEligibleVotes = Math.max(0, population - stats.voteCount);
  return {
    yesCount: stats.yesCount,
    noCount: stats.noCount,
    totalVotes: stats.voteCount,
    approvalPercent,
    activeVote,
    meetsQuorum: stats.voteCount >= votesRequired && stats.voteCount > 0,
    eligibleVoterCount: population,
    quorumThresholdPercent: 66,
    votesRequired,
    votesRemaining: Math.max(0, votesRequired - stats.voteCount),
    remainingEligibleVotes
  };
}

const SHARED_RUBRIC = [
  { id: 'rubric:title-clarity', label: 'Is the title clear and specific?' },
  {
    id: 'rubric:description-clarity',
    label: 'Does the description explain what will actually happen and why?'
  },
  {
    id: 'rubric:demand-response',
    label: 'Does this plan respond well to the current demand signal?'
  },
  { id: 'rubric:achievability', label: 'Does this plan seem realistically achievable?' },
  { id: 'rubric:stages-coherent', label: 'Are the stages coherent and in a sensible order?' }
];
const EVENT_RUBRIC = [
  { id: 'rubric:timing-suitable', label: 'Is the timing suitable?' },
  { id: 'rubric:duration-realistic', label: 'Is the duration/schedule realistic?' },
  { id: 'rubric:location-appropriate', label: 'Is the location appropriate and accessible?' }
];
const PROJECT_PRODUCTION_RUBRIC = [
  { id: 'rubric:production-approach', label: 'Is the proposed production approach appropriate?' },
  { id: 'rubric:materials-realistic', label: 'Are the listed materials/resources realistic?' }
];
const PROJECT_SOFTWARE_RUBRIC = [
  { id: 'rubric:repository-clear', label: 'Is the repository/setup clear enough?' }
];
const PROJECT_DISTRIBUTION_RUBRIC = [
  { id: 'rubric:access-approach', label: 'Is the access/distribution approach appropriate?' },
  { id: 'rubric:request-settings', label: 'Are the request settings sensible?' },
  { id: 'rubric:off-schedule', label: 'Is off-schedule handling appropriate?' }
];

function assessmentCriteriaForPlan(
  planKind: string,
  prominentValues: Array<{ id: string; label: string }>,
  projectSubtype?: string | null
) {
  const criteria: Array<Record<string, unknown>> = SHARED_RUBRIC.map((item) => ({
    criterionId: item.id,
    kind: 'rubric',
    label: item.label
  }));
  if (planKind === 'event') {
    for (const item of EVENT_RUBRIC) {
      criteria.push({ criterionId: item.id, kind: 'rubric', label: item.label });
    }
  } else if (planKind === 'production' || planKind === 'organisation') {
    for (const item of PROJECT_PRODUCTION_RUBRIC) {
      criteria.push({ criterionId: item.id, kind: 'rubric', label: item.label });
    }
    if (projectSubtype === 'software') {
      for (const item of PROJECT_SOFTWARE_RUBRIC) {
        criteria.push({ criterionId: item.id, kind: 'rubric', label: item.label });
      }
    }
  } else if (planKind === 'distribution') {
    for (const item of PROJECT_DISTRIBUTION_RUBRIC) {
      criteria.push({ criterionId: item.id, kind: 'rubric', label: item.label });
    }
  }
  for (const value of prominentValues) {
    criteria.push({
      criterionId: `value:${value.id}`,
      kind: 'value',
      label: `How well does this plan satisfy "${value.label}"?`,
      valueId: value.id
    });
  }
  return criteria;
}

function serializeCriterionAssessments(
  criteria: Array<Record<string, unknown>>,
  ratingsByCriterion: Map<string, Array<{ rating: number; voter_id: string }>>,
  userId: string | null
) {
  return criteria.map((criterion) => {
    const criterionId = String(criterion.criterionId);
    const rows = ratingsByCriterion.get(criterionId) ?? [];
    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let total = 0;
    let activeRating: number | null = null;
    for (const row of rows) {
      const rating = Number(row.rating);
      if (rating < 1 || rating > 5) continue;
      distribution[rating] += 1;
      total += rating;
      if (userId && row.voter_id === userId) activeRating = rating;
    }
    const ratingCount = Object.values(distribution).reduce((a, b) => a + b, 0);
    return {
      ...criterion,
      activeRating,
      averageRating: ratingCount > 0 ? Math.round((total / ratingCount) * 100) / 100 : 0,
      ratingCount,
      ratingDistribution: distribution
    };
  });
}

function planLeaderStatus(
  isLeading: boolean,
  passes: boolean,
  approvalPercent: number,
  passingPlans: Array<{ id: string; approvalPercent: number }>
) {
  if (isLeading) return 'leading';
  if (!passes) return null;
  if (!passingPlans.length) return 'passing';
  const best = Math.max(...passingPlans.map((p) => p.approvalPercent));
  return approvalPercent >= best ? 'tied' : 'passing';
}

function extractPlanPhases(planPayload: Record<string, unknown>) {
  const raw = (planPayload.planPhases ?? planPayload.plan_phases ?? []) as Array<
    Record<string, unknown>
  >;
  return raw.map((item, idx) => ({
    id: String(item.id ?? `phase-${idx + 1}`),
    title: String(item.title ?? `Phase ${idx + 1}`),
    details: String(item.details ?? ''),
    materialsLabel: String(item.materialsLabel ?? ''),
    costLabel: String(item.costLabel ?? '')
  }));
}

function scheduleFromPayload(schedulePayload: Record<string, unknown>) {
  const mode = String(schedulePayload.mode ?? 'any-day');
  return {
    mode,
    startDate: schedulePayload.startDate ?? schedulePayload.start_date ?? null,
    endDate: schedulePayload.endDate ?? schedulePayload.end_date ?? null,
    startTimeLabel: schedulePayload.startTimeLabel ?? schedulePayload.start_time_label ?? null,
    finishTimeLabel: schedulePayload.finishTimeLabel ?? schedulePayload.finish_time_label ?? null,
    label: schedulePayload.label ?? mode.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  };
}

async function hydrateProjectPlans(
  db: SupabaseClient,
  projectId: string,
  userId: string | null,
  population: number,
  prominentValues: Array<{ id: string; label: string }> = []
) {
  const { data: plans } = await db
    .from('project_plans')
    .select(
      'id, title, description, phase_kind, status, author_id, project_subtype, repository_url, demand_consideration_note, total_cost_label, location_id, plan_payload, is_leading, created_at, users!fk_project_plans_author_id_users(username)'
    )
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  const planIds = (plans ?? []).map((p) => p.id as string);
  const votesByPlan = new Map<string, Array<{ vote?: string | null; voter_id?: string }>>();
  const ratingsByPlan = new Map<string, Map<string, Array<{ rating: number; voter_id: string }>>>();
  if (planIds.length > 0) {
    const { data: votes } = await db
      .from('project_plan_votes')
      .select('plan_id, voter_id, vote')
      .in('plan_id', planIds);
    for (const row of votes ?? []) {
      const list = votesByPlan.get(row.plan_id as string) ?? [];
      list.push({ vote: row.vote as string, voter_id: row.voter_id as string });
      votesByPlan.set(row.plan_id as string, list);
    }
    const { data: ratings } = await db
      .from('project_plan_criterion_ratings')
      .select('plan_id, criterion_id, rating, voter_id')
      .in('plan_id', planIds);
    for (const row of ratings ?? []) {
      const byCriterion =
        ratingsByPlan.get(row.plan_id as string) ??
        new Map<string, Array<{ rating: number; voter_id: string }>>();
      const list = byCriterion.get(row.criterion_id as string) ?? [];
      list.push({ rating: Number(row.rating), voter_id: row.voter_id as string });
      byCriterion.set(row.criterion_id as string, list);
      ratingsByPlan.set(row.plan_id as string, byCriterion);
    }
  }

  const passingByKind = new Map<string, Array<{ id: string; approvalPercent: number }>>();
  for (const plan of plans ?? []) {
    const summary = buildPlanVoteSummary(votesByPlan.get(plan.id as string) ?? [], userId, population);
    const passes = summary.meetsQuorum && summary.approvalPercent >= 66;
    if (passes) {
      const kind = String(plan.phase_kind ?? 'production');
      const list = passingByKind.get(kind) ?? [];
      list.push({ id: plan.id as string, approvalPercent: summary.approvalPercent });
      passingByKind.set(kind, list);
    }
  }

  return (plans ?? []).map((plan) => {
    const author = Array.isArray(plan.users) ? plan.users[0] : plan.users;
    const planPayload = (plan.plan_payload ?? {}) as Record<string, unknown>;
    const overallApproval = buildPlanVoteSummary(
      votesByPlan.get(plan.id as string) ?? [],
      userId,
      population
    );
    const passes = overallApproval.meetsQuorum && overallApproval.approvalPercent >= 66;
    const phaseKind = String(plan.phase_kind ?? 'production');
    const subtype =
      plan.project_subtype ??
      planPayload.projectSubtype ??
      planPayload.project_subtype ??
      'standard';
    const criterionAssessments = serializeCriterionAssessments(
      assessmentCriteriaForPlan(phaseKind, prominentValues, String(subtype)),
      ratingsByPlan.get(plan.id as string) ?? new Map(),
      userId
    );
    const base = {
      id: plan.id,
      title: plan.title,
      description: plan.description ?? '',
      phaseKind,
      status: plan.status,
      authorUsername: author?.username ?? 'unknown',
      createdAt: plan.created_at,
      repositoryUrl: plan.repository_url ?? null,
      demandSignalSnapshot: null,
      demandConsiderationNote: plan.demand_consideration_note ?? '',
      valueConsiderationNotes: (planPayload.valueConsiderationNotes as Record<string, string>) ?? {},
      totalCostLabel: plan.total_cost_label ?? '',
      planPhases: extractPlanPhases(planPayload),
      valueAssessments: [],
      criterionAssessments,
      overallApproval,
      voteSummary: overallApproval,
      isLeading: !!plan.is_leading,
      leaderStatus: planLeaderStatus(
        !!plan.is_leading,
        passes,
        overallApproval.approvalPercent,
        passingByKind.get(phaseKind) ?? []
      ),
      locationId: plan.location_id ?? null,
      locationLabel: String(planPayload.locationLabel ?? ''),
      phases: extractPlanPhases(planPayload)
    };
    if (phaseKind === 'distribution') {
      return {
        ...base,
        distributionSummary: String(planPayload.distributionSummary ?? ''),
        accessSummary: String(planPayload.accessSummary ?? ''),
        reserveSummary: String(planPayload.reserveSummary ?? ''),
        requestSystemEnabled: Boolean(planPayload.requestSystemEnabled),
        requestMode: planPayload.requestMode ?? 'both',
        allowOffScheduleRequests: Boolean(planPayload.allowOffScheduleRequests),
        projectLocationId: planPayload.projectLocationId ?? null,
        projectLocationLabel: String(planPayload.projectLocationLabel ?? '')
      };
    }
    return {
      ...base,
      projectSubtype: subtype,
      projectSubtypeLabel: String(subtype).replace(/-/g, ' '),
      outputSummary: String(planPayload.outputSummary ?? ''),
      materialsSummary: String(planPayload.materialsSummary ?? ''),
      acquisitionsSummary: String(planPayload.acquisitionsSummary ?? ''),
      acquisitionBundles: Array.isArray(planPayload.acquisitionBundles)
        ? planPayload.acquisitionBundles
        : [],
      purchaseRows: Array.isArray(planPayload.purchaseRows) ? planPayload.purchaseRows : [],
      viewerCanEdit: Boolean(userId) && plan.author_id === userId
    };
  });
}

async function hydrateEventPlans(
  db: SupabaseClient,
  eventId: string,
  userId: string | null,
  population: number,
  prominentValues: Array<{ id: string; label: string }> = []
) {
  const { data: plans } = await db
    .from('event_plans')
    .select(
      'id, title, description, status, author_id, demand_consideration_note, location_label, location_id, schedule_payload, plan_payload, is_leading, created_at, users!fk_event_plans_author_id_users(username)'
    )
    .eq('event_id', eventId)
    .order('created_at', { ascending: false });
  const planIds = (plans ?? []).map((p) => p.id as string);
  const votesByPlan = new Map<string, Array<{ vote?: string | null; voter_id?: string }>>();
  const ratingsByPlan = new Map<string, Map<string, Array<{ rating: number; voter_id: string }>>>();
  if (planIds.length > 0) {
    const { data: votes } = await db
      .from('event_plan_votes')
      .select('plan_id, voter_id, vote')
      .in('plan_id', planIds);
    for (const row of votes ?? []) {
      const list = votesByPlan.get(row.plan_id as string) ?? [];
      list.push({ vote: row.vote as string, voter_id: row.voter_id as string });
      votesByPlan.set(row.plan_id as string, list);
    }
    const { data: ratings } = await db
      .from('event_plan_criterion_ratings')
      .select('plan_id, criterion_id, rating, voter_id')
      .in('plan_id', planIds);
    for (const row of ratings ?? []) {
      const byCriterion =
        ratingsByPlan.get(row.plan_id as string) ??
        new Map<string, Array<{ rating: number; voter_id: string }>>();
      const list = byCriterion.get(row.criterion_id as string) ?? [];
      list.push({ rating: Number(row.rating), voter_id: row.voter_id as string });
      byCriterion.set(row.criterion_id as string, list);
      ratingsByPlan.set(row.plan_id as string, byCriterion);
    }
  }

  const passingPlans: Array<{ id: string; approvalPercent: number }> = [];
  for (const plan of plans ?? []) {
    const summary = buildPlanVoteSummary(votesByPlan.get(plan.id as string) ?? [], userId, population);
    if (summary.meetsQuorum && summary.approvalPercent >= 66) {
      passingPlans.push({ id: plan.id as string, approvalPercent: summary.approvalPercent });
    }
  }

  return (plans ?? []).map((plan) => {
    const author = Array.isArray(plan.users) ? plan.users[0] : plan.users;
    const planPayload = (plan.plan_payload ?? {}) as Record<string, unknown>;
    const schedulePayload = (plan.schedule_payload ?? {}) as Record<string, unknown>;
    const overallApproval = buildPlanVoteSummary(
      votesByPlan.get(plan.id as string) ?? [],
      userId,
      population
    );
    const passes = overallApproval.meetsQuorum && overallApproval.approvalPercent >= 66;
    const planPhases = extractPlanPhases(planPayload);
    return {
      id: plan.id,
      title: plan.title,
      description: plan.description ?? '',
      status: plan.status,
      authorUsername: author?.username ?? 'unknown',
      createdAt: plan.created_at,
      demandSignalSnapshot: null,
      demandConsiderationNote: plan.demand_consideration_note ?? '',
      valueConsiderationNotes: (planPayload.valueConsiderationNotes as Record<string, string>) ?? {},
      locationLabel: plan.location_label ?? '',
      locationId: plan.location_id ?? null,
      schedule: scheduleFromPayload(schedulePayload),
      planPhases,
      phases: planPhases,
      valueAssessments: [],
      criterionAssessments: serializeCriterionAssessments(
        assessmentCriteriaForPlan('event', prominentValues),
        ratingsByPlan.get(plan.id as string) ?? new Map(),
        userId
      ),
      overallApproval,
      voteSummary: overallApproval,
      isLeading: !!plan.is_leading,
      leaderStatus: planLeaderStatus(
        !!plan.is_leading,
        passes,
        overallApproval.approvalPercent,
        passingPlans
      )
    };
  });
}

export async function hydrateActivities(
  db: SupabaseClient,
  kind: 'project' | 'event',
  ownerId: string,
  userId: string | null
) {
  const activityTable = kind === 'project' ? 'project_activities' : 'event_activities';
  const roleTable = kind === 'project' ? 'project_activity_roles' : 'event_activity_roles';
  const assignTable =
    kind === 'project' ? 'project_activity_assignments' : 'event_activity_assignments';
  const ownerCol = kind === 'project' ? 'project_id' : 'event_id';

  const authorFk =
    kind === 'project'
      ? 'users!fk_project_activities_author_id_users(username)'
      : 'users!fk_event_activities_author_id_users(username)';
  const { data: activities } = await db
    .from(activityTable)
    .select(
      `id, title, note, scheduled_at, ends_at, location_label, location_id, is_online, linked_plan_phase_id, author_id, ${authorFk}`
    )
    .eq(ownerCol, ownerId)
    .order('scheduled_at', { ascending: true });
  const rows = activities ?? [];

  const activityIds = rows.map((a) => a.id as string);
  const { data: roles } = activityIds.length
    ? await db.from(roleTable).select('id, activity_id, label, required_count, maximum_count').in('activity_id', activityIds)
    : { data: [] as Array<Record<string, unknown>> };
  const roleIds = (roles ?? []).map((r) => r.id as string);
  const { data: assignments } = roleIds.length
    ? await db.from(assignTable).select('role_id, user_id').in('role_id', roleIds)
    : { data: [] as Array<Record<string, unknown>> };
  const assigneeUserIds = [...new Set((assignments ?? []).map((a) => a.user_id as string))];
  const { data: assigneeUsers } = assigneeUserIds.length
    ? await db.from('users').select('id, username, profile_image_url').in('id', assigneeUserIds)
    : { data: [] as Array<{ id: string; username: string; profile_image_url: string | null }> };
  const userById = new Map((assigneeUsers ?? []).map((u) => [u.id, u]));

  const assigneesByRole = new Map<string, Array<{ username: string; profileImageUrl: string | null }>>();
  const userIdsByRole = new Map<string, string[]>();
  for (const row of assignments ?? []) {
    const user = userById.get(row.user_id as string);
    const list = assigneesByRole.get(row.role_id as string) ?? [];
    list.push({
      username: user?.username ?? 'unknown',
      profileImageUrl: user?.profile_image_url ?? null
    });
    assigneesByRole.set(row.role_id as string, list);
    const ids = userIdsByRole.get(row.role_id as string) ?? [];
    ids.push(row.user_id as string);
    userIdsByRole.set(row.role_id as string, ids);
  }

  const typedRoles = (roles ?? []) as Array<{
    id: string;
    activity_id: string;
    label: string;
    required_count: number;
    maximum_count: number | null;
  }>;
  const rolesByActivity = new Map<string, typeof typedRoles>();
  for (const role of typedRoles) {
    const list = rolesByActivity.get(role.activity_id as string) ?? [];
    list.push(role);
    rolesByActivity.set(role.activity_id as string, list);
  }

  const now = Date.now();
  return rows.map((a) => {
    const author = Array.isArray(a.users) ? a.users[0] : a.users;
    const activityRoles = rolesByActivity.get(a.id as string) ?? [];
    let minimumParticipants = 0;
    let maximumParticipants: number | null = 0;
    const committed = new Set<string>();
    let viewerAssignedRoleLabel: string | null = null;
    const rolePayload = activityRoles.map((role) => {
      const assigneeIds = userIdsByRole.get(role.id as string) ?? [];
      for (const id of assigneeIds) committed.add(id);
      const isViewerAssigned = Boolean(userId && assigneeIds.includes(userId));
      if (isViewerAssigned) viewerAssignedRoleLabel = String(role.label);
      minimumParticipants += Number(role.required_count ?? 0);
      if (role.maximum_count == null) maximumParticipants = null;
      else if (maximumParticipants != null) maximumParticipants += Number(role.maximum_count);
      return {
        id: role.id,
        label: role.label,
        filledCount: assigneeIds.length,
        requiredCount: Number(role.required_count ?? 0),
        maximumCount: role.maximum_count ?? null,
        isViewerAssigned,
        assignees: assigneesByRole.get(role.id as string) ?? []
      };
    });
    const endsAtMs = a.ends_at ? new Date(String(a.ends_at)).getTime() : NaN;
    return {
      id: a.id,
      title: a.title,
      description: a.note ?? '',
      note: a.note ?? '',
      authorUsername: author?.username ?? 'unknown',
      scheduledAt: a.scheduled_at,
      startAt: a.scheduled_at,
      endsAt: a.ends_at,
      endAt: a.ends_at,
      locationLabel: a.location_label ?? '',
      locationId: a.location_id ?? null,
      isOnline: !!a.is_online,
      linkedPlanPhaseLabel: a.linked_plan_phase_id ?? null,
      roles: rolePayload,
      committedCount: committed.size,
      minimumParticipants,
      maximumParticipants,
      viewerAssignedRoleLabel,
      viewerIsCommitted: Boolean(userId && committed.has(userId)),
      isActive: !(Number.isFinite(endsAtMs) && endsAtMs <= now),
      statusTone: committed.size >= minimumParticipants && minimumParticipants > 0 ? 'ready' : 'open'
    };
  });
}

async function hydrateSoftwareGovernance(
  db: SupabaseClient,
  project: Record<string, unknown>,
  userId: string | null,
  viewerIsMember: boolean,
  population: number
) {
  const projectId = String(project.id);
  const { data: leadingPlan } = await db
    .from('project_plans')
    .select('repository_url, plan_payload, author_id')
    .eq('project_id', projectId)
    .eq('is_leading', true)
    .limit(1)
    .maybeSingle();
  const planPayload = (leadingPlan?.plan_payload ?? {}) as Record<string, unknown>;
  const repositoryUrl = String(leadingPlan?.repository_url ?? planPayload.repositoryUrl ?? '');

  const { data: mergeMembers } = await db
    .from('project_merge_capability_members')
    .select('user_id, source_label')
    .eq('project_id', projectId);
  const mergeUserIds = (mergeMembers ?? []).map((m) => m.user_id as string);
  const { data: memberships } = await db
    .from('project_memberships')
    .select('user_id')
    .eq('project_id', projectId);
  const memberIds = (memberships ?? []).map((m) => m.user_id as string);
  const relatedUserIds = [...new Set([...mergeUserIds, ...memberIds])];
  const { data: relatedUsers } = relatedUserIds.length
    ? await db.from('users').select('id, username, bio, profile_image_url').in('id', relatedUserIds)
    : { data: [] as Array<{ id: string; username: string; bio: string | null; profile_image_url: string | null }> };
  const userById = new Map((relatedUsers ?? []).map((u) => [u.id, u]));

  const mergeCapabilityMembers = (mergeMembers ?? []).map((row) => {
    const user = userById.get(row.user_id as string);
    return {
      id: row.user_id,
      username: user?.username ?? 'unknown',
      bio: user?.bio ?? '',
      sourceLabel: row.source_label ?? 'member'
    };
  });
  const mergeIds = new Set(mergeCapabilityMembers.map((m) => m.id as string));
  const availableMergeCapabilityCandidates = memberIds
    .filter((id) => !mergeIds.has(id))
    .map((id) => {
      const user = userById.get(id);
      return {
        id,
        username: user?.username ?? 'unknown',
        bio: user?.bio ?? '',
        profileImageUrl: user?.profile_image_url ?? null
      };
    });

  const { data: prRows } = await db
    .from('project_pull_requests')
    .select(
      'id, decision_id, title, summary, pull_request_id, pull_request_url, author_id, stage, merge_id, merge_url, merged_by_user_id, approval_threshold_percent, created_at'
    )
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  const prIds = (prRows ?? []).map((p) => p.id as string);
  const authorIds = [...new Set((prRows ?? []).map((p) => p.author_id as string).filter(Boolean))];
  const { data: prAuthors } = authorIds.length
    ? await db.from('users').select('id, username').in('id', authorIds)
    : { data: [] as Array<{ id: string; username: string }> };
  const authorById = new Map((prAuthors ?? []).map((u) => [u.id, u.username]));
  const votesByPr = new Map<string, Array<{ vote?: string | null; voter_id?: string }>>();
  if (prIds.length) {
    const { data: votes } = await db
      .from('project_pull_request_votes')
      .select('request_id, voter_id, vote')
      .in('request_id', prIds);
    for (const row of votes ?? []) {
      const list = votesByPr.get(row.request_id as string) ?? [];
      list.push({ vote: row.vote as string, voter_id: row.voter_id as string });
      votesByPr.set(row.request_id as string, list);
    }
  }

  const stageLabel = (stage: string) => {
    switch (stage) {
      case 'approval':
        return 'Awaiting approval';
      case 'awaiting-merge':
        return 'Awaiting merge';
      case 'confirmation':
        return 'Awaiting confirmation';
      case 'confirmed':
        return 'Confirmed';
      case 'rejected':
        return 'Rejected';
      case 'replaced':
        return 'Replaced';
      default:
        return stage.replace(/-/g, ' ');
    }
  };

  const pullRequests = (prRows ?? []).map((row) => {
    const built = buildGovernanceVoteSummary(
      votesByPr.get(row.id as string) ?? [],
      userId,
      population
    );
    const stage = String(row.stage ?? 'approval');
    return {
      id: row.id,
      decisionId: row.decision_id ?? null,
      title: row.title,
      summary: row.summary ?? '',
      pullRequestId: row.pull_request_id,
      pullRequestUrl: row.pull_request_url,
      authorUsername: authorById.get(row.author_id as string) ?? 'unknown',
      stage,
      stageLabel: stageLabel(stage),
      mergeId: row.merge_id ?? null,
      mergeUrl: row.merge_url ?? null,
      mergedByUsername: null,
      approvalThresholdPercent: Number(row.approval_threshold_percent ?? 66),
      createdAt: row.created_at,
      voteSummary: built.summary,
      passesApprovalThreshold: built.passes,
      canStillPass: built.canStillPass,
      viewerCanVote: viewerIsMember && (stage === 'approval' || stage === 'confirmation'),
      viewerCanRecordMerge:
        Boolean(userId) && stage === 'awaiting-merge' && mergeIds.has(userId as string)
    };
  });

  const { data: mergeRequests } = await db
    .from('project_merge_capability_change_requests')
    .select(
      'id, decision_id, target_user_id, action, author_id, status, approval_threshold_percent, created_at'
    )
    .eq('project_id', projectId)
    .eq('status', 'open');
  const mergeRequestIds = (mergeRequests ?? []).map((r) => String(r.id));
  const mergeVotesByRequest = new Map<string, Array<{ vote?: string | null; voter_id?: string }>>();
  if (mergeRequestIds.length) {
    const { data: votes } = await db
      .from('project_merge_capability_change_votes')
      .select('request_id, voter_id, vote')
      .in('request_id', mergeRequestIds);
    for (const row of votes ?? []) {
      const list = mergeVotesByRequest.get(String(row.request_id)) ?? [];
      list.push({ vote: row.vote as string, voter_id: row.voter_id as string });
      mergeVotesByRequest.set(String(row.request_id), list);
    }
  }

  const { data: repoRequests } = await db
    .from('project_repository_replacement_requests')
    .select(
      'id, decision_id, repository_url, previous_repository_url, reason, related_pull_request_id, author_id, status, approval_threshold_percent, created_at, updated_at'
    )
    .eq('project_id', projectId);

  const openRepoRequests = (repoRequests ?? []).filter((r) => r.status === 'open');
  const approvedRepoRequests = (repoRequests ?? []).filter((r) => r.status === 'approved');
  const repoRequestIds = openRepoRequests.map((r) => String(r.id));
  const repoVotesByRequest = new Map<string, Array<{ vote?: string | null; voter_id?: string }>>();
  if (repoRequestIds.length) {
    const { data: votes } = await db
      .from('project_repository_replacement_votes')
      .select('request_id, voter_id, vote')
      .in('request_id', repoRequestIds);
    for (const row of votes ?? []) {
      const list = repoVotesByRequest.get(String(row.request_id)) ?? [];
      list.push({ vote: row.vote as string, voter_id: row.voter_id as string });
      repoVotesByRequest.set(String(row.request_id), list);
    }
  }

  const relatedUserIdsForRequests = [
    ...new Set(
      [
        ...(mergeRequests ?? []).flatMap((r) => [r.target_user_id as string, r.author_id as string]),
        ...openRepoRequests.map((r) => r.author_id as string),
        ...approvedRepoRequests.map((r) => r.author_id as string)
      ].filter(Boolean)
    )
  ];
  const names = await usernameMap(db, relatedUserIdsForRequests);

  const mergeCapabilityChangeRequests = (mergeRequests ?? []).map((row) => {
    const built = buildGovernanceVoteSummary(
      mergeVotesByRequest.get(String(row.id)) ?? [],
      userId,
      population
    );
    const target = userById.get(row.target_user_id as string);
    return {
      id: row.id,
      decisionId: row.decision_id,
      action: row.action,
      actionLabel:
        row.action === 'grant' ? 'Grant merge capability' : 'Revoke merge capability',
      targetMember: {
        id: row.target_user_id,
        username: target?.username ?? names.get(String(row.target_user_id)) ?? 'unknown',
        bio: target?.bio ?? ''
      },
      authorUsername: names.get(String(row.author_id)) ?? 'unknown',
      createdAt: row.created_at,
      approvalThresholdPercent: Number(row.approval_threshold_percent ?? 66),
      voteSummary: built.summary,
      passesApprovalThreshold: built.passes,
      canStillPass: built.canStillPass,
      viewerCanVote: viewerIsMember && !built.passes
    };
  });

  const repositoryReplacementRequests = openRepoRequests.map((row) => {
    const built = buildGovernanceVoteSummary(
      repoVotesByRequest.get(String(row.id)) ?? [],
      userId,
      population
    );
    return {
      id: row.id,
      decisionId: row.decision_id,
      repositoryUrl: row.repository_url,
      previousRepositoryUrl: row.previous_repository_url ?? '',
      reason: row.reason ?? '',
      relatedPullRequestId: row.related_pull_request_id,
      authorUsername: names.get(String(row.author_id)) ?? 'unknown',
      createdAt: row.created_at,
      approvalThresholdPercent: Number(row.approval_threshold_percent ?? 66),
      voteSummary: built.summary,
      passesApprovalThreshold: built.passes,
      canStillPass: built.canStillPass,
      viewerCanVote: viewerIsMember && !built.passes
    };
  });

  const repositoryHistory = approvedRepoRequests.map((row) => ({
    id: row.id,
    repositoryUrl: row.repository_url,
    previousRepositoryUrl: row.previous_repository_url ?? '',
    reason: row.reason ?? '',
    relatedPullRequestId: row.related_pull_request_id,
    replacedAt: row.updated_at ?? row.created_at,
    replacedByUsername: names.get(String(row.author_id)) ?? 'unknown'
  }));

  return {
    repositoryUrl,
    licenseLabel: String(planPayload.licenseLabel ?? (repositoryUrl ? 'AGPL v3' : 'Unspecified')),
    isPlatformTagged: Boolean(project.is_platform_tagged),
    mergeCapabilityManagedByPlatform: Boolean(project.is_platform_tagged),
    mergeCapabilityMembers,
    availableMergeCapabilityCandidates,
    mergeCapabilityChangeRequests,
    repositoryReplacementRequests,
    replaceablePullRequests: pullRequests
      .filter((p) => p.stage === 'awaiting-merge')
      .map((p) => ({
        id: p.id,
        title: p.title,
        pullRequestId: p.pullRequestId,
        stage: p.stage,
        stageLabel: p.stageLabel
      })),
    repositoryHistory,
    pullRequests,
    viewerCanCreatePullRequests: viewerIsMember,
    viewerCanRequestMergeCapabilityChanges:
      viewerIsMember && !Boolean(project.is_platform_tagged),
    viewerCanRequestRepositoryReplacement: viewerIsMember
  };
}

function buildGovernanceVoteSummary(
  voteRows: Array<{ vote?: string | number | null; voter_id?: string }>,
  userId: string | null,
  population: number
) {
  const stats = summarizeVotes(voteRows);
  const votesRequired = requiredVotes(Math.max(0, population));
  const approvalPercent = Math.round(stats.approvalRatio * 1000) / 10;
  let activeVote: 'yes' | 'no' | null = null;
  if (userId) {
    const mine = voteRows.find((row) => row.voter_id === userId);
    if (mine) {
      if (mine.vote === 'yes' || mine.vote === 1 || mine.vote === '1') activeVote = 'yes';
      else if (mine.vote === 'no' || mine.vote === -1 || mine.vote === '-1') activeVote = 'no';
    }
  }
  const remainingEligible = Math.max(0, population - stats.voteCount);
  const meetsQuorum = stats.voteCount >= votesRequired;
  const passes = meetsQuorum && stats.voteCount > 0 && stats.approvalRatio >= 0.66;
  const maxYes = stats.yesCount + remainingEligible;
  const maxTotal = stats.voteCount + remainingEligible;
  const canStillPass =
    !passes && maxTotal >= votesRequired && maxTotal > 0 && maxYes / maxTotal >= 0.66;
  return {
    summary: {
      yesCount: stats.yesCount,
      noCount: stats.noCount,
      totalVotes: stats.voteCount,
      approvalPercent,
      activeVote,
      meetsQuorum,
      eligibleVoterCount: population,
      quorumThresholdPercent:
        population > 0 ? Math.round((votesRequired / population) * 1000) / 10 : 0,
      votesRequired,
      votesRemaining: Math.max(0, votesRequired - stats.voteCount),
      remainingEligibleVotes: remainingEligible
    },
    passes,
    canStillPass
  };
}

async function hydrateProjectPhaseChangeRequests(
  db: SupabaseClient,
  projectId: string,
  userId: string | null,
  population: number
) {
  const phaseTitleMap = Object.fromEntries(PROJECT_PHASES.map((p) => [p.id, p.title]));
  const { data: rows } = await db
    .from('project_phase_change_requests')
    .select(
      'id, target_phase_id, reason, author_id, created_at, change_kind, close_outcome, conversion_target_mode, conversion_target_subtype, status, users!fk_project_phase_change_requests_author_id_users(username)'
    )
    .eq('project_id', projectId)
    .eq('status', 'open')
    .order('created_at', { ascending: false });

  const requestIds = (rows ?? []).map((r) => r.id as string);
  const votesByRequest = new Map<string, Array<{ vote?: string | null; voter_id?: string }>>();
  if (requestIds.length > 0) {
    const { data: votes } = await db
      .from('project_phase_change_votes')
      .select('request_id, voter_id, vote')
      .in('request_id', requestIds);
    for (const row of votes ?? []) {
      const list = votesByRequest.get(row.request_id as string) ?? [];
      list.push({ vote: row.vote as string, voter_id: row.voter_id as string });
      votesByRequest.set(row.request_id as string, list);
    }
  }

  return (rows ?? []).map((req) => {
    const author = Array.isArray(req.users) ? req.users[0] : req.users;
    const { summary, passes, canStillPass } = buildGovernanceVoteSummary(
      votesByRequest.get(req.id as string) ?? [],
      userId,
      population
    );
    let conversionTarget = null;
    if (req.conversion_target_mode) {
      const mode = String(req.conversion_target_mode);
      const subtype = req.conversion_target_subtype
        ? String(req.conversion_target_subtype)
        : null;
      conversionTarget = {
        projectMode: mode,
        projectSubtype: subtype,
        projectModeLabel: mode.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        projectSubtypeLabel: (subtype || 'n/a').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        entryPhaseId: 'phase-1',
        entryPhaseLabel: phaseTitleMap['phase-1'] ?? 'Proposal'
      };
    }
    return {
      id: req.id,
      targetPhaseId: req.target_phase_id,
      targetPhaseLabel: phaseTitleMap[req.target_phase_id as string] ?? req.target_phase_id,
      reason: req.reason ?? '',
      authorUsername: author?.username ?? 'unknown',
      createdAt: req.created_at,
      kind: req.change_kind,
      closeOutcome: req.close_outcome ?? null,
      conversionTarget,
      approvalThresholdPercent: 66,
      voteSummary: summary,
      passesApprovalThreshold: passes,
      canStillPass
    };
  });
}

async function hydrateProjectRevertHistory(db: SupabaseClient, projectId: string) {
  const { data: rows } = await db
    .from('project_revert_history')
    .select(
      'id, target_phase_id, reason, author_id, created_at, users!fk_project_revert_history_author_id_users(username)'
    )
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  return (rows ?? []).map((item) => {
    const author = Array.isArray(item.users) ? item.users[0] : item.users;
    return {
      id: item.id,
      targetPhaseId: item.target_phase_id,
      reason: item.reason ?? '',
      authorUsername: author?.username ?? 'unknown',
      createdAt: item.created_at
    };
  });
}

async function hydrateProjectRequestSystem(
  db: SupabaseClient,
  projectId: string,
  userId: string | null,
  viewerIsMember: boolean,
  viewerIsManager: boolean,
  projectMode: string,
  population: number
) {
  const [{ data: settings }, { data: requests }, { data: changes }] = await Promise.all([
    db
      .from('project_service_request_settings')
      .select('*')
      .eq('project_id', projectId)
      .maybeSingle(),
    db
      .from('project_service_requests')
      .select(
        'id, title, body, requester_id, status, scheduled_at, ends_at, linked_activity_id, created_at, users!fk_project_service_requests_requester_id_users(username)'
      )
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(100),
    db
      .from('project_service_request_setting_changes')
      .select(
        'id, reason, author_id, enabled, request_mode, allow_off_schedule_requests, created_at, users!fk_project_service_request_setting_changes_author_id_users(username)'
      )
      .eq('project_id', projectId)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
  ]);
  const changeIds = (changes ?? []).map((change) => String(change.id));
  const votesByRequest = new Map<string, Array<{ vote?: string | null; voter_id?: string }>>();
  if (changeIds.length) {
    const { data: votes } = await db
      .from('project_service_request_setting_change_votes')
      .select('request_id, voter_id, vote')
      .in('request_id', changeIds);
    for (const vote of votes ?? []) {
      const requestId = String(vote.request_id);
      const rows = votesByRequest.get(requestId) ?? [];
      rows.push({ vote: vote.vote, voter_id: vote.voter_id });
      votesByRequest.set(requestId, rows);
    }
  }
  const enabled = Boolean(settings?.enabled);
  const requestMode = String(settings?.request_mode ?? 'both');
  return {
    enabled,
    requestCount: (requests ?? []).length,
    requests: (requests ?? []).map((request) => {
      const requester = Array.isArray(request.users) ? request.users[0] : request.users;
      return {
        id: request.id,
        title: request.title,
        body: request.body,
        requesterUsername: requester?.username ?? 'unknown',
        createdAt: request.created_at,
        status: request.status,
        scheduledAt: request.scheduled_at ?? undefined,
        endsAt: request.ends_at ?? undefined,
        linkedActivityId: request.linked_activity_id ?? null
      };
    }),
    viewerCanSubmitRequests: Boolean(userId) && enabled,
    viewerCanReviewRequests: viewerIsManager,
    viewerCanRequestSettingsChanges:
      viewerIsMember && projectMode !== 'personal-service',
    viewerCanVoteOnSettingsChanges:
      viewerIsMember && projectMode !== 'personal-service',
    requiresSchedule: requestMode === 'calendar',
    settings: {
      enabled,
      requestMode,
      allowOffScheduleRequests: Boolean(settings?.allow_off_schedule_requests),
      summary: String(settings?.summary ?? '')
    },
    settingsChangeRequests: (changes ?? []).map((change) => {
      const author = Array.isArray(change.users) ? change.users[0] : change.users;
      const { summary, passes, canStillPass } = buildGovernanceVoteSummary(
        votesByRequest.get(String(change.id)) ?? [],
        userId,
        population
      );
      return {
        id: change.id,
        reason: change.reason,
        authorUsername: author?.username ?? 'unknown',
        createdAt: change.created_at,
        proposedSettings: {
          enabled: Boolean(change.enabled),
          requestMode: change.request_mode,
          allowOffScheduleRequests: Boolean(change.allow_off_schedule_requests),
          summary: ''
        },
        approvalThresholdPercent: 66,
        voteSummary: summary,
        passesApprovalThreshold: passes,
        canStillPass
      };
    })
  };
}

async function hydrateEventPhaseChangeRequests(
  db: SupabaseClient,
  eventId: string,
  userId: string | null,
  population: number
) {
  const phaseTitleMap = Object.fromEntries(EVENT_PHASES.map((p) => [p.id, p.title]));
  const { data: rows } = await db
    .from('event_phase_change_requests')
    .select(
      'id, target_phase_id, reason, author_id, created_at, change_kind, status, users!fk_event_phase_change_requests_author_id_users(username)'
    )
    .eq('event_id', eventId)
    .eq('status', 'open')
    .order('created_at', { ascending: false });

  const requestIds = (rows ?? []).map((r) => r.id as string);
  const votesByRequest = new Map<string, Array<{ vote?: string | null; voter_id?: string }>>();
  if (requestIds.length > 0) {
    const { data: votes } = await db
      .from('event_phase_change_votes')
      .select('request_id, voter_id, vote')
      .in('request_id', requestIds);
    for (const row of votes ?? []) {
      const list = votesByRequest.get(row.request_id as string) ?? [];
      list.push({ vote: row.vote as string, voter_id: row.voter_id as string });
      votesByRequest.set(row.request_id as string, list);
    }
  }

  return (rows ?? []).map((req) => {
    const author = Array.isArray(req.users) ? req.users[0] : req.users;
    const { summary, passes, canStillPass } = buildGovernanceVoteSummary(
      votesByRequest.get(req.id as string) ?? [],
      userId,
      population
    );
    return {
      id: req.id,
      targetPhaseId: req.target_phase_id,
      targetPhaseLabel: phaseTitleMap[req.target_phase_id as string] ?? req.target_phase_id,
      reason: req.reason ?? '',
      authorUsername: author?.username ?? 'unknown',
      createdAt: req.created_at,
      kind: req.change_kind,
      approvalThresholdPercent: 66,
      voteSummary: summary,
      passesApprovalThreshold: passes,
      canStillPass
    };
  });
}

export async function buildProjectLifecycle(
  db: SupabaseClient,
  project: Record<string, unknown>,
  userId: string | null,
  viewerIsMember: boolean,
  activities: unknown[]
) {
  const storedCurrentPhaseId = String(project.current_phase_id ?? 'phase-1') as
    | 'phase-1'
    | 'phase-2'
    | 'phase-3'
    | 'phase-4'
    | 'phase-5'
    | 'phase-6'
    | 'phase-7';
  const projectMode = String(project.project_mode ?? 'productive');
  const projectSubtype = project.project_subtype ? String(project.project_subtype) : null;
  const visiblePhaseIds = visiblePhaseIdsForProject(projectMode, projectSubtype);
  const visiblePhases = visiblePhaseIds
    .map((phaseId, index) => {
      const phase = PROJECT_PHASES.find((candidate) => candidate.id === phaseId);
      return phase ? { ...phase, order: index + 1, shortLabel: String(index + 1) } : null;
    })
    .filter((phase): phase is NonNullable<typeof phase> => Boolean(phase));
  const currentPhaseId = visiblePhaseIdForProject(
    projectMode,
    projectSubtype,
    storedCurrentPhaseId
  ) as typeof storedCurrentPhaseId;
  const currentOrder = visiblePhases.find((phase) => phase.id === currentPhaseId)?.order ?? 1;
  const nextPhaseId = nextPhaseIdForProject(projectMode, projectSubtype, storedCurrentPhaseId);
  const next = nextPhaseId
    ? visiblePhases.find((phase) => phase.id === nextPhaseId) ?? null
    : null;
  const usesPlatformVoteContext = Boolean(project.is_platform_tagged);
  const [population, signals, phaseOneValues, membershipRes] = await Promise.all([
    projectPopulation(db, String(project.id)),
    loadSignalState(db, 'project_signals', 'project_id', String(project.id), userId),
    hydrateValueImportance(
      db,
      'project_values',
      'project_value_importance_votes',
      'project_id',
      String(project.id),
      userId
    ),
    userId
      ? db
          .from('project_memberships')
          .select('is_manager')
          .eq('project_id', String(project.id))
          .eq('user_id', userId)
          .maybeSingle()
      : Promise.resolve({ data: null })
  ]);
  const quorumVotesRequired = requiredVotes(Math.max(0, population));
  const voteContextLabel = usesPlatformVoteContext ? 'weekly active users' : 'weekly active members';
  const prominentValues = phaseOneValues
    .filter((v: { importanceScore?: number }) => Number(v.importanceScore ?? 0) >= 5)
    .map((v: { id: string; label: string }) => ({ id: v.id, label: v.label }));
  const mappedPlans = await hydrateProjectPlans(
    db,
    String(project.id),
    userId,
    population,
    prominentValues
  );
  const productionPlans = mappedPlans.filter((p) => p.phaseKind !== 'distribution');
  const distributionPlans = mappedPlans.filter((p) => p.phaseKind === 'distribution');
  const productionWinning =
    productionPlans.find((p) => p.isLeading)?.id ??
    productionPlans.find((p) => p.overallApproval?.meetsQuorum && p.overallApproval.approvalPercent >= 66)
      ?.id ??
    null;
  const distributionWinning =
    distributionPlans.find((p) => p.isLeading)?.id ??
    distributionPlans.find((p) => p.overallApproval?.meetsQuorum && p.overallApproval.approvalPercent >= 66)
      ?.id ??
    null;
  const winningPlan =
    mappedPlans.find((p) => p.id === (distributionWinning ?? productionWinning)) ??
    mappedPlans.find((p) => p.isLeading) ??
    null;
  const selectablePlanPhases = (winningPlan?.planPhases ?? []).map(
    (phase: { id: string; title: string }) => ({
      id: phase.id,
      label: phase.title
    })
  );
  const viewerMembership = membershipRes.data;
  const viewerIsManager =
    Boolean(userId) &&
    (String(project.author_id ?? '') === userId || Boolean(viewerMembership?.is_manager));
  const isSoftware =
    String(project.project_subtype ?? '') === 'software' ||
    String((winningPlan as Record<string, unknown> | null)?.projectSubtype ?? '') === 'software' ||
    Boolean((winningPlan as Record<string, unknown> | null)?.repositoryUrl);
  const [phaseChangeRequests, revertHistory, requestSystem, softwareGovernance] = await Promise.all([
    hydrateProjectPhaseChangeRequests(db, String(project.id), userId, population),
    hydrateProjectRevertHistory(db, String(project.id)),
    hydrateProjectRequestSystem(
      db,
      String(project.id),
      userId,
      viewerIsMember,
      viewerIsManager,
      projectMode,
      population
    ),
    isSoftware
      ? hydrateSoftwareGovernance(db, project, userId, viewerIsMember, population)
      : Promise.resolve(null)
  ]);

  return {
    projectMode,
    currentSubtype: project.project_subtype ?? null,
    currentSubtypeLabel: project.project_subtype ?? null,
    usesPlatformLifecycle: true,
    supportsDemandSignals: true,
    supportsPlanning: true,
    currentPhaseId,
    quorumThresholdPercent: 66,
    quorumVotesRequired,
    voteContextLabel,
    voteContextPopulation: population,
    notes: [],
    phases: visiblePhases.map((phase) => {
      const copy = projectPhaseCopy(
        phase.id,
        String(project.project_mode ?? 'productive'),
        phase.summary
      );
      const title =
        projectMode === 'personal-service' && phase.id === 'phase-1'
          ? 'Activity'
          : projectMode === 'personal-service' && phase.id === 'phase-2'
            ? 'Closed'
            : projectMode === 'collective-service' && phase.id === 'phase-2'
              ? 'Operations plan'
              : phase.title;
      return {
        ...phase,
        title,
        summary: copy.summary || phase.summary,
        progressState: progressState(currentOrder, phase.order),
        mechanics: copy.mechanics,
        note: copy.note ?? undefined,
        betaLocked: false
      };
    }),
    viewerCanRequestPhaseChanges: viewerIsMember && projectMode !== 'personal-service',
    viewerCanVoteOnPhaseChanges: viewerIsMember && projectMode !== 'personal-service',
    phaseChangeRequests,
    viewerCanAdvancePhase: viewerIsManager,
    nextPhaseId: next?.id ?? null,
    nextPhaseLabel: next?.title ?? null,
    viewerCanRevertPhase: viewerIsManager && projectMode !== 'personal-service',
    revertablePhaseIds: visiblePhases
      .filter((phase) => phase.order < currentOrder && phase.id !== 'phase-7')
      .map((phase) => phase.id),
    revertHistory,
    requestSystem,
    personalService:
      project.project_mode === 'personal-service'
        ? {
            availabilitySummary: requestSystem.settings.summary,
            travelRadiusLabel: '',
            usesCalendar:
              requestSystem.settings.requestMode === 'calendar' ||
              requestSystem.settings.requestMode === 'both',
            requestMode: requestSystem.settings.requestMode
          }
        : null,
    phaseOne: {
      values: phaseOneValues,
      viewerCanSignalDemand: Boolean(userId),
      viewerHasDemandSignal: signals.viewerSignal === 'demand',
      viewerCanSignalOpposition: Boolean(userId),
      viewerHasOppositionSignal: signals.viewerSignal === 'opposition',
      signalSummary: emptySignalSummary(
        signals.supportCount,
        signals.opposeCount,
        signals.viewerSignal,
        population,
        usesPlatformVoteContext
      ),
      viewerCanAddValue: viewerIsMember,
      viewerCanVoteOnValues: viewerIsMember
    },
    phaseTwo: {
      plans: productionPlans,
      winningPlanId: productionWinning,
      viewerCanSubmitPlans: viewerIsMember,
      viewerCanVoteOnPlans: viewerIsMember,
      availableAssetManagementServices: []
    },
    phaseThree: {
      plans: distributionPlans,
      winningPlanId: distributionWinning,
      viewerCanSubmitPlans: viewerIsMember,
      viewerCanVoteOnPlans: viewerIsMember,
      requestSystemEnabled: false
    },
    phaseFour: null,
    phaseFive: {
      activities,
      history: [],
      viewerCanCreateActivities: viewerIsMember,
      selectablePlanPhases,
      softwareGovernance
    }
  };
}

export async function buildEventLifecycle(
  db: SupabaseClient,
  event: Record<string, unknown>,
  userId: string | null,
  viewerIsMember: boolean,
  activities: unknown[]
) {
  const currentPhaseId = String(event.current_phase_id ?? 'proposal') as
    | 'proposal'
    | 'event-plan'
    | 'activity'
    | 'closed';
  const currentOrder = EVENT_PHASES.find((p) => p.id === currentPhaseId)?.order ?? 1;
  const next = EVENT_PHASES.find((p) => p.order === currentOrder + 1) ?? null;
  const previous = EVENT_PHASES.find((p) => p.order === currentOrder - 1) ?? null;
  const usesPlatformVoteContext = await isPlatformEvent(db, String(event.id));
  const [population, signals, phaseOneValues] = await Promise.all([
    eventPopulation(db, String(event.id)),
    loadSignalState(db, 'event_signals', 'event_id', String(event.id), userId),
    hydrateValueImportance(
      db,
      'event_values',
      'event_value_importance_votes',
      'event_id',
      String(event.id),
      userId
    )
  ]);
  const quorumVotesRequired = requiredVotes(Math.max(0, population));
  const voteContextLabel = usesPlatformVoteContext ? 'weekly active users' : 'weekly active members';
  const prominentValues = phaseOneValues
    .filter((v: { importanceScore?: number }) => Number(v.importanceScore ?? 0) >= 5)
    .map((v: { id: string; label: string }) => ({ id: v.id, label: v.label }));
  const mappedPlans = await hydrateEventPlans(
    db,
    String(event.id),
    userId,
    population,
    prominentValues
  );
  const winningPlanId =
    mappedPlans.find((p) => p.isLeading)?.id ??
    mappedPlans.find((p) => p.overallApproval?.meetsQuorum && p.overallApproval.approvalPercent >= 66)
      ?.id ??
    null;
  const winningPlan = mappedPlans.find((p) => p.id === winningPlanId) ?? null;
  const selectablePlanPhases = (winningPlan?.planPhases ?? []).map(
    (phase: { id: string; title: string }) => ({
      id: phase.id,
      label: phase.title
    })
  );
  const phaseChangeRequests = await hydrateEventPhaseChangeRequests(
    db,
    String(event.id),
    userId,
    population
  );
  const isOrganizerControlled = String(event.governance) === 'organizer_controlled';
  const canPlanVote = viewerIsMember && currentPhaseId === 'event-plan' && !isOrganizerControlled;

  return {
    currentPhaseId,
    quorumThresholdPercent: 66,
    quorumVotesRequired,
    voteContextLabel,
    voteContextPopulation: population,
    phases: EVENT_PHASES.map((phase) => {
      const copy = eventPhaseCopy(phase.id, phase.summary);
      return {
        ...phase,
        summary: copy.summary || phase.summary,
        progressState: progressState(currentOrder, phase.order),
        mechanics: copy.mechanics,
        note: copy.note ?? undefined,
        betaLocked: false
      };
    }),
    phaseOne: {
      values: phaseOneValues,
      viewerCanSignalDemand: Boolean(userId) && currentPhaseId === 'proposal',
      viewerHasDemandSignal: signals.viewerSignal === 'demand',
      viewerCanSignalOpposition: Boolean(userId) && currentPhaseId === 'proposal',
      viewerHasOppositionSignal: signals.viewerSignal === 'opposition',
      signalSummary: emptySignalSummary(
        signals.supportCount,
        signals.opposeCount,
        signals.viewerSignal,
        population,
        usesPlatformVoteContext
      ),
      viewerCanAddValue: viewerIsMember && currentPhaseId === 'proposal',
      viewerCanVoteOnValues: viewerIsMember && currentPhaseId === 'proposal'
    },
    phaseTwo: {
      plans: mappedPlans,
      winningPlanId,
      viewerCanSubmitPlans: viewerIsMember && currentPhaseId === 'event-plan',
      viewerCanVoteOnPlans: canPlanVote
    },
    activity: {
      activities,
      history: [],
      viewerCanCreateActivities: viewerIsMember && currentPhaseId === 'activity',
      selectablePlanPhases
    },
    viewerCanRequestPhaseChanges: viewerIsMember,
    viewerCanVoteOnPhaseChanges: viewerIsMember,
    phaseChangeRequests,
    revertablePhaseIds: EVENT_PHASES.filter((p) => p.order < currentOrder).map((p) => p.id),
    previousPhaseId: previous?.id ?? null,
    previousPhaseLabel: previous?.title ?? null,
    nextPhaseId: next?.id ?? null,
    nextPhaseLabel: next?.title ?? null
  };
}

export { emptySignalSummary };

async function usernameMap(db: SupabaseClient, ids: Array<string | null | undefined>) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return new Map<string, string>();
  const { data } = await db.from('users').select('id, username').in('id', unique);
  return new Map((data ?? []).map((u) => [u.id as string, u.username as string]));
}

function voteSummaryPayload(
  votes: Array<{ vote?: string | number | null; voter_id?: string | null }>,
  viewerId: string | null,
  population = 0
) {
  const { summary, passes, canStillPass } = buildGovernanceVoteSummary(
    votes.map((row) => ({
      vote: row.vote,
      voter_id: row.voter_id ?? undefined
    })),
    viewerId,
    population
  );
  return {
    ...summary,
    // Keep legacy aliases some older clients still read.
    requiredVotes: summary.votesRequired,
    quorumMet: summary.meetsQuorum,
    passesApprovalThreshold: passes,
    canStillPass
  };
}

async function hydrateOpenRequests(
  db: SupabaseClient,
  table: string,
  voteTable: string,
  foreignKey: 'project_id' | 'event_id',
  entityId: string,
  bodyKeys: string[],
  viewerId: string | null,
  population = 0
) {
  const { data: rows } = await db
    .from(table)
    .select('*')
    .eq(foreignKey, entityId)
    .eq('status', 'open')
    .order('created_at', { ascending: false });
  const names = await usernameMap(
    db,
    (rows ?? []).map((r) => r.author_id as string | null)
  );
  const requestIds = (rows ?? []).map((r) => r.id as string);
  const { data: voteRows } = requestIds.length
    ? await db.from(voteTable).select('request_id, vote, voter_id').in('request_id', requestIds)
    : { data: [] as Array<{ request_id: string; vote: unknown; voter_id: string | null }> };
  const votesByRequest = new Map<string, Array<{ vote: unknown; voter_id: string | null }>>();
  for (const vote of voteRows ?? []) {
    const list = votesByRequest.get(String(vote.request_id)) ?? [];
    list.push(vote);
    votesByRequest.set(String(vote.request_id), list);
  }
  const out: Array<Record<string, unknown>> = [];
  for (const req of rows ?? []) {
    const votes = votesByRequest.get(String(req.id)) ?? [];
    const summary = voteSummaryPayload(votes, viewerId, population);
    const payload: Record<string, unknown> = {
      id: req.id,
      authorUsername: names.get(String(req.author_id)) ?? 'unknown',
      createdAt: req.created_at,
      approvalThresholdPercent: 66,
      voteSummary: summary,
      passesApprovalThreshold: Boolean(summary.passesApprovalThreshold),
      canStillPass: Boolean(summary.canStillPass)
    };
    for (const key of bodyKeys) {
      payload[key] = req[key] ?? req[key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)] ?? '';
    }
    out.push(payload);
  }
  return out;
}

export async function hydrateProjectUpdateRequests(
  db: SupabaseClient,
  projectId: string,
  viewerId: string | null,
  population = 0
) {
  return hydrateOpenRequests(
    db,
    'project_update_requests',
    'project_update_request_votes',
    'project_id',
    projectId,
    ['body'],
    viewerId,
    population
  );
}

export async function hydrateProjectEditRequests(
  db: SupabaseClient,
  projectId: string,
  viewerId: string | null,
  population = 0
) {
  return hydrateOpenRequests(
    db,
    'project_edit_requests',
    'project_edit_request_votes',
    'project_id',
    projectId,
    ['title', 'description'],
    viewerId,
    population
  );
}

export async function hydrateEventUpdateRequests(
  db: SupabaseClient,
  eventId: string,
  viewerId: string | null,
  population = 0
) {
  return hydrateOpenRequests(
    db,
    'event_update_requests',
    'event_update_request_votes',
    'event_id',
    eventId,
    ['body'],
    viewerId,
    population
  );
}

export async function hydrateEventEditRequests(
  db: SupabaseClient,
  eventId: string,
  viewerId: string | null,
  population = 0
) {
  return hydrateOpenRequests(
    db,
    'event_edit_requests',
    'event_edit_request_votes',
    'event_id',
    eventId,
    ['title', 'description'],
    viewerId,
    population
  );
}

async function mapLinkRow(
  db: SupabaseClient,
  row: Record<string, unknown>,
  direction: 'active' | 'historical'
) {
  let targetTitle = 'Linked record';
  let href = '#';
  if (row.target_kind === 'project' && row.target_project_id) {
    const { data } = await db
      .from('projects')
      .select('slug, title')
      .eq('id', row.target_project_id)
      .maybeSingle();
    if (data) {
      targetTitle = data.title;
      href = `/projects/${data.slug}`;
    }
  } else if (row.target_kind === 'event' && row.target_event_id) {
    const { data } = await db
      .from('events')
      .select('slug, title')
      .eq('id', row.target_event_id)
      .maybeSingle();
    if (data) {
      targetTitle = data.title;
      href = `/events/${data.slug}`;
    }
  }
  return {
    id: row.id,
    title: targetTitle,
    relationshipLabel: row.relationship_label,
    summary: row.summary ?? '',
    href,
    status: row.status,
    linkKind: row.link_kind,
    publicItem: null,
    openSeverRequest: null,
    governanceTally: null,
    historical: direction === 'historical'
  };
}

async function linkSideVoteState(
  db: SupabaseClient,
  requestId: string,
  voteScope: 'source' | 'target',
  title: string,
  memberCount: number,
  viewerId: string | null,
  viewerIsMember: boolean,
  subjectKind: 'project' | 'event',
  subjectSlug: string,
  statusLabel: string
) {
  const { data: votes } = await db
    .from('detail_link_request_votes')
    .select('vote, voter_id, vote_scope')
    .eq('request_id', requestId)
    .eq('vote_scope', voteScope);
  const stats = summarizeVotes(votes ?? []);
  const votesRequired = requiredVotes(Math.max(0, memberCount));
  const approvalPercent = Math.round(stats.approvalRatio * 1000) / 10;
  let viewerVote: 'yes' | 'no' | null = null;
  if (viewerId) {
    const mine = (votes ?? []).find((row) => row.voter_id === viewerId);
    if (mine) {
      if (mine.vote === 'yes' || mine.vote === 1 || mine.vote === '1') viewerVote = 'yes';
      else if (mine.vote === 'no' || mine.vote === -1 || mine.vote === '-1') viewerVote = 'no';
    }
  }
  const passes = stats.voteCount >= votesRequired && stats.voteCount > 0 && stats.approvalRatio >= 0.66;
  const remainingEligible = Math.max(0, memberCount - stats.voteCount);
  const maxYes = stats.yesCount + remainingEligible;
  const maxTotal = stats.voteCount + remainingEligible;
  const canStillPass =
    !passes && maxTotal >= votesRequired && maxTotal > 0 && maxYes / maxTotal >= 0.66;
  return {
    projectTitle: title,
    yesCount: stats.yesCount,
    noCount: stats.noCount,
    memberCount,
    approvalsRequired: votesRequired,
    approvalsRemaining: Math.max(0, votesRequired - stats.voteCount),
    approvalPercent,
    statusLabel,
    resultNote: passes
      ? 'Approved on this side.'
      : canStillPass
        ? 'Waiting for more approvals.'
        : 'This side can no longer approve the request.',
    viewerCanVote: Boolean(viewerId) && viewerIsMember && viewerVote == null,
    viewerVote,
    voteScope,
    subjectKind,
    subjectSlug,
    passesApprovalThreshold: passes,
    canStillPass
  };
}

async function resolveLinkSubject(
  db: SupabaseClient,
  kind: string | null | undefined,
  projectId: string | null | undefined,
  eventId: string | null | undefined
) {
  if (kind === 'project' && projectId) {
    const { data } = await db
      .from('projects')
      .select('id, slug, title, member_count, project_mode, stage_label, description, location_label')
      .eq('id', projectId)
      .maybeSingle();
    if (data) {
      return {
        kind: 'project' as const,
        id: String(data.id),
        slug: String(data.slug),
        title: String(data.title),
        memberCount: Number(data.member_count ?? 0),
        detail: {
          kind: 'project',
          slug: data.slug,
          title: data.title,
          description: data.description ?? '',
          href: `/projects/${data.slug}`,
          memberCount: Number(data.member_count ?? 0),
          locationLabel: data.location_label ?? '',
          projectMode: data.project_mode ?? 'productive',
          stageLabel: data.stage_label ?? ''
        }
      };
    }
  }
  if (kind === 'event' && eventId) {
    const { data } = await db
      .from('events')
      .select('id, slug, title, member_count, current_phase_id, time_label, scheduled_at, description, location_label')
      .eq('id', eventId)
      .maybeSingle();
    if (data) {
      return {
        kind: 'event' as const,
        id: String(data.id),
        slug: String(data.slug),
        title: String(data.title),
        memberCount: Number(data.member_count ?? 0),
        detail: {
          kind: 'event',
          slug: data.slug,
          title: data.title,
          description: data.description ?? '',
          href: `/events/${data.slug}`,
          memberCount: Number(data.member_count ?? 0),
          locationLabel: data.location_label ?? '',
          stageLabel: String(data.current_phase_id ?? '').replace(/-/g, ' '),
          timeLabel: data.time_label ?? '',
          scheduledAt: data.scheduled_at ?? null
        }
      };
    }
  }
  return null;
}

export async function buildLinksFrame(
  db: SupabaseClient,
  ownerKind: 'project' | 'event',
  owner: Record<string, unknown>,
  viewerIsMember: boolean,
  viewerId: string | null
) {
  const ownerId = owner.id as string;
  const ownerSlug = String(owner.slug ?? '');
  const ownerTitle = String(owner.title ?? 'Record');
  const ownerMemberCount = Number(owner.member_count ?? 0);
  const sourceCol = ownerKind === 'project' ? 'source_project_id' : 'source_event_id';
  const { data: links } = await db.from('detail_links').select('*').eq(sourceCol, ownerId);
  const activeLinks = [];
  const historicalLinks = [];
  for (const link of links ?? []) {
    if (link.status === 'active') activeLinks.push(await mapLinkRow(db, link, 'active'));
    else historicalLinks.push(await mapLinkRow(db, link, 'historical'));
  }

  const { data: pending } = await db
    .from('detail_link_requests')
    .select('*')
    .or(
      ownerKind === 'project'
        ? `source_project_id.eq.${ownerId},target_project_id.eq.${ownerId}`
        : `source_event_id.eq.${ownerId},target_event_id.eq.${ownerId}`
    )
    .eq('status', 'open');

  const pendingLinkRequests: Array<Record<string, unknown>> = [];
  for (const req of pending ?? []) {
    const source = await resolveLinkSubject(
      db,
      String(req.source_kind ?? ''),
      req.source_project_id as string | null,
      req.source_event_id as string | null
    );
    const target = await resolveLinkSubject(
      db,
      String(req.target_kind ?? ''),
      req.target_project_id as string | null,
      req.target_event_id as string | null
    );
    if (!source || !target) continue;

    const ownerIsSource =
      (ownerKind === 'project' && req.source_project_id === ownerId) ||
      (ownerKind === 'event' && req.source_event_id === ownerId);
    const counterpart = ownerIsSource ? target : source;
    const thisScope = ownerIsSource ? ('source' as const) : ('target' as const);
    const otherScope = ownerIsSource ? ('target' as const) : ('source' as const);
    const requestType = String(req.request_type ?? 'create');
    const statusLabel =
      requestType === 'sever' ? 'Sever open' : String(req.status ?? 'open').replace(/_/g, ' ');

    let otherViewerIsMember = false;
    if (viewerId) {
      if (counterpart.kind === 'project') {
        const { count } = await db
          .from('project_memberships')
          .select('*', { count: 'exact', head: true })
          .eq('project_id', counterpart.id)
          .eq('user_id', viewerId);
        otherViewerIsMember = (count ?? 0) > 0;
      } else {
        const { count } = await db
          .from('event_memberships')
          .select('*', { count: 'exact', head: true })
          .eq('event_id', counterpart.id)
          .eq('user_id', viewerId);
        otherViewerIsMember = (count ?? 0) > 0;
      }
    }

    const thisRecordVote = await linkSideVoteState(
      db,
      String(req.id),
      thisScope,
      ownerTitle,
      ownerMemberCount,
      viewerId,
      viewerIsMember,
      ownerKind,
      ownerSlug,
      statusLabel
    );
    const otherRecordVote = await linkSideVoteState(
      db,
      String(req.id),
      otherScope,
      counterpart.title,
      counterpart.memberCount,
      viewerId,
      otherViewerIsMember,
      counterpart.kind,
      counterpart.slug,
      statusLabel
    );
    const yesCount = thisRecordVote.yesCount + otherRecordVote.yesCount;
    const noCount = thisRecordVote.noCount + otherRecordVote.noCount;
    const total = yesCount + noCount;
    const approvalPercent = total > 0 ? Math.round((yesCount / total) * 1000) / 10 : 0;
    const names = await usernameMap(db, [req.proposed_by as string | null]);

    pendingLinkRequests.push({
      id: req.id,
      requestType,
      linkId: req.link_id ?? null,
      title: counterpart.title,
      relationshipLabel: req.relationship_label,
      summary: req.summary ?? '',
      statusLabel,
      proposedByUsername: names.get(String(req.proposed_by)) ?? 'unknown',
      createdAtLabel: req.created_at,
      createdAt: req.created_at,
      targetHref: counterpart.detail.href,
      targetKind: counterpart.kind,
      targetDetail: counterpart.detail,
      governanceTally: {
        yesCount,
        noCount,
        approvalPercent,
        label: total === 0 ? 'No votes yet' : `${Math.round(approvalPercent)}% · ${yesCount} yes / ${noCount} no`
      },
      sourceTitle: source.title,
      targetTitle: target.title,
      sourceVoteLabel: `${Math.round(Number(thisScope === 'source' ? thisRecordVote.approvalPercent : otherRecordVote.approvalPercent))}% · ${(thisScope === 'source' ? thisRecordVote : otherRecordVote).yesCount} yes / ${(thisScope === 'source' ? thisRecordVote : otherRecordVote).noCount} no`,
      targetVoteLabel: `${Math.round(Number(thisScope === 'target' ? thisRecordVote.approvalPercent : otherRecordVote.approvalPercent))}% · ${(thisScope === 'target' ? thisRecordVote : otherRecordVote).yesCount} yes / ${(thisScope === 'target' ? thisRecordVote : otherRecordVote).noCount} no`,
      thisRecordVote,
      otherRecordVote,
      targetProjectHref: counterpart.kind === 'project' ? counterpart.detail.href : null,
      thisProjectVote: thisRecordVote,
      otherProjectVote: otherRecordVote,
      status: req.status
    });
  }

  let conversionNote = '';
  let conversionWorkflow: Array<Record<string, unknown>> = [];
  let conversionLineage: Record<string, unknown> | null = null;

  if (ownerKind === 'project') {
    if (owner.close_outcome === 'convert' || owner.is_closed) {
      conversionNote = String(owner.close_outcome || '');
    }
    const { data: phaseRows } = await db
      .from('project_phase_change_requests')
      .select('*')
      .eq('project_id', ownerId)
      .eq('status', 'open')
      .eq('close_outcome', 'convert');
    for (const req of phaseRows ?? []) {
      const { data: votes } = await db
        .from('project_phase_change_votes')
        .select('vote, voter_id')
        .eq('request_id', req.id);
      conversionWorkflow.push({
        id: req.id,
        title: req.conversion_successor_title || 'Convert project',
        statusLabel: 'Open conversion vote',
        summary: req.reason,
        inventoryNote:
          'Inventory, open requests, plans, signals, and roles stay on the predecessor.',
        canVote: viewerIsMember,
        voteSummary: voteSummaryPayload(votes ?? [], viewerId, Number(owner.member_count ?? 0)),
        approvalThresholdPercent: 66,
        target: {
          projectMode: req.conversion_target_mode,
          projectSubtype: req.conversion_target_subtype,
          entryPhaseId: 'phase-1',
          entryPhaseLabel: 'Proposal'
        },
        predecessor: {
          id: ownerId,
          title: owner.title,
          relationshipLabel: 'Converted from',
          summary: req.reason,
          href: `/projects/${owner.slug}`,
          publicItem: null
        },
        successor: null
      });
    }

    const { data: conversion } = await db
      .from('project_conversions')
      .select('*')
      .or(`predecessor_project_id.eq.${ownerId},successor_project_id.eq.${ownerId}`)
      .limit(1)
      .maybeSingle();
    if (conversion) {
      const { data: pred } = await db
        .from('projects')
        .select('id, slug, title')
        .eq('id', conversion.predecessor_project_id)
        .maybeSingle();
      const { data: succ } = await db
        .from('projects')
        .select('id, slug, title')
        .eq('id', conversion.successor_project_id)
        .maybeSingle();
      if (pred && succ) {
        conversionLineage = {
          title: 'Conversion lineage',
          statusLabel: 'Permanent',
          summary: conversion.summary,
          permanenceNote: conversion.permanence_note,
          inventoryNote: conversion.inventory_note,
          predecessor: {
            id: pred.id,
            title: pred.title,
            relationshipLabel: 'Converted from',
            summary: conversion.summary,
            href: `/projects/${pred.slug}`,
            publicItem: null
          },
          successor: {
            id: succ.id,
            title: succ.title,
            relationshipLabel: 'Converted to',
            summary: conversion.summary,
            href: `/projects/${succ.slug}`,
            publicItem: null
          }
        };
      }
    }
  }

  return {
    ownerKind,
    ownerSlug: owner.slug,
    intro: '',
    activeLinks,
    pendingLinkRequests,
    historicalLinks,
    historicalLinkRequests: [],
    linkableRecords: [],
    viewerCanProposeLinks: viewerIsMember,
    conversionNote,
    conversionWorkflow,
    conversionLineage
  };
}

export function emptyLinksFrame(ownerKind: 'project' | 'event', ownerSlug: string) {
  return {
    ownerKind,
    ownerSlug,
    intro: '',
    activeLinks: [],
    pendingLinkRequests: [],
    historicalLinks: [],
    historicalLinkRequests: [],
    linkableRecords: [],
    viewerCanProposeLinks: false,
    conversionNote: '',
    conversionWorkflow: [],
    conversionLineage: null
  };
}

export async function hydrateProjectHistory(
  db: SupabaseClient,
  projectId: string,
  userId: string | null = null,
  population = 0,
  viewerIsMember = false
) {
  type HistoryEntry = Record<string, unknown>;
  const entries: Array<{ createdAt: string; entry: HistoryEntry }> = [];
  const phaseTitleMap = Object.fromEntries(PROJECT_PHASES.map((p) => [p.id, p.title]));

  const { data: updateRequests } = await db
    .from('project_update_requests')
    .select('id, body, author_id, status, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  const updateIds = (updateRequests ?? []).map((r) => String(r.id));
  const updateVotes = new Map<string, Array<{ vote?: string | null; voter_id?: string }>>();
  if (updateIds.length) {
    const { data: votes } = await db
      .from('project_update_request_votes')
      .select('request_id, voter_id, vote')
      .in('request_id', updateIds);
    for (const row of votes ?? []) {
      const list = updateVotes.get(String(row.request_id)) ?? [];
      list.push({ vote: row.vote as string, voter_id: row.voter_id as string });
      updateVotes.set(String(row.request_id), list);
    }
  }

  const { data: editRequests } = await db
    .from('project_edit_requests')
    .select('id, title, description, author_id, status, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  const editIds = (editRequests ?? []).map((r) => String(r.id));
  const editVotes = new Map<string, Array<{ vote?: string | null; voter_id?: string }>>();
  if (editIds.length) {
    const { data: votes } = await db
      .from('project_edit_request_votes')
      .select('request_id, voter_id, vote')
      .in('request_id', editIds);
    for (const row of votes ?? []) {
      const list = editVotes.get(String(row.request_id)) ?? [];
      list.push({ vote: row.vote as string, voter_id: row.voter_id as string });
      editVotes.set(String(row.request_id), list);
    }
  }

  const { data: phaseRequests } = await db
    .from('project_phase_change_requests')
    .select(
      'id, from_phase_id, target_phase_id, change_kind, reason, author_id, status, created_at'
    )
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  const phaseIds = (phaseRequests ?? []).map((r) => String(r.id));
  const phaseVotes = new Map<string, Array<{ vote?: string | null; voter_id?: string }>>();
  if (phaseIds.length) {
    const { data: votes } = await db
      .from('project_phase_change_votes')
      .select('request_id, voter_id, vote')
      .in('request_id', phaseIds);
    for (const row of votes ?? []) {
      const list = phaseVotes.get(String(row.request_id)) ?? [];
      list.push({ vote: row.vote as string, voter_id: row.voter_id as string });
      phaseVotes.set(String(row.request_id), list);
    }
  }

  const authorIds = [
    ...(updateRequests ?? []).map((r) => r.author_id as string | null),
    ...(editRequests ?? []).map((r) => r.author_id as string | null),
    ...(phaseRequests ?? []).map((r) => r.author_id as string | null)
  ];
  const names = await usernameMap(db, authorIds);

  for (const req of updateRequests ?? []) {
    const built = buildGovernanceVoteSummary(
      updateVotes.get(String(req.id)) ?? [],
      userId,
      population
    );
    entries.push({
      createdAt: String(req.created_at),
      entry: {
        id: req.id,
        entityKind: 'project',
        kind: 'project-update',
        kindLabel: 'Update decision',
        createdAt: req.created_at,
        authorUsername: names.get(String(req.author_id)) ?? 'unknown',
        status: req.status,
        approvalThresholdPercent: 66,
        voteSummary: built.summary,
        passesApprovalThreshold: built.passes,
        canStillPass: built.canStillPass,
        canVote: viewerIsMember && req.status === 'open',
        payload: { type: 'update', body: req.body, appliedUpdateId: null }
      }
    });
  }

  for (const req of editRequests ?? []) {
    const built = buildGovernanceVoteSummary(
      editVotes.get(String(req.id)) ?? [],
      userId,
      population
    );
    entries.push({
      createdAt: String(req.created_at),
      entry: {
        id: req.id,
        entityKind: 'project',
        kind: 'project-edit',
        kindLabel: 'Edit decision',
        createdAt: req.created_at,
        authorUsername: names.get(String(req.author_id)) ?? 'unknown',
        status: req.status,
        approvalThresholdPercent: 66,
        voteSummary: built.summary,
        passesApprovalThreshold: built.passes,
        canStillPass: built.canStillPass,
        canVote: viewerIsMember && req.status === 'open',
        payload: {
          type: 'edit',
          changes: [
            { label: 'Title', before: '', after: req.title },
            { label: 'Description', before: '', after: req.description }
          ]
        }
      }
    });
  }

  for (const req of phaseRequests ?? []) {
    const built = buildGovernanceVoteSummary(
      phaseVotes.get(String(req.id)) ?? [],
      userId,
      population
    );
    entries.push({
      createdAt: String(req.created_at),
      entry: {
        id: req.id,
        entityKind: 'project',
        kind: 'project-phase-change',
        kindLabel: 'Phase decision',
        createdAt: req.created_at,
        authorUsername: names.get(String(req.author_id)) ?? 'unknown',
        status: req.status,
        approvalThresholdPercent: 66,
        voteSummary: built.summary,
        passesApprovalThreshold: built.passes,
        canStillPass: built.canStillPass,
        canVote: viewerIsMember && req.status === 'open',
        payload: {
          type: 'phase-change',
          changeKind: req.change_kind,
          fromPhaseId: req.from_phase_id,
          fromPhaseLabel: phaseTitleMap[String(req.from_phase_id)] ?? req.from_phase_id,
          toPhaseId: req.target_phase_id,
          toPhaseLabel: phaseTitleMap[String(req.target_phase_id)] ?? req.target_phase_id,
          reason: req.reason
        }
      }
    });
  }

  entries.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return entries.map((item) => item.entry);
}

export async function hydrateEventHistory(
  db: SupabaseClient,
  eventId: string,
  userId: string | null = null,
  population = 0,
  viewerIsMember = false,
  isOrganizerControlled = false
) {
  type HistoryEntry = Record<string, unknown>;
  const entries: Array<{ createdAt: string; entry: HistoryEntry }> = [];
  const phaseTitleMap = Object.fromEntries(EVENT_PHASES.map((p) => [p.id, p.title]));
  const canVoteOpen = viewerIsMember && !isOrganizerControlled;

  const { data: updateRequests } = await db
    .from('event_update_requests')
    .select('id, body, author_id, status, created_at')
    .eq('event_id', eventId)
    .order('created_at', { ascending: false });
  const updateIds = (updateRequests ?? []).map((r) => String(r.id));
  const updateVotes = new Map<string, Array<{ vote?: string | null; voter_id?: string }>>();
  if (updateIds.length) {
    const { data: votes } = await db
      .from('event_update_request_votes')
      .select('request_id, voter_id, vote')
      .in('request_id', updateIds);
    for (const row of votes ?? []) {
      const list = updateVotes.get(String(row.request_id)) ?? [];
      list.push({ vote: row.vote as string, voter_id: row.voter_id as string });
      updateVotes.set(String(row.request_id), list);
    }
  }

  const { data: editRequests } = await db
    .from('event_edit_requests')
    .select('id, title, description, author_id, status, created_at')
    .eq('event_id', eventId)
    .order('created_at', { ascending: false });
  const editIds = (editRequests ?? []).map((r) => String(r.id));
  const editVotes = new Map<string, Array<{ vote?: string | null; voter_id?: string }>>();
  if (editIds.length) {
    const { data: votes } = await db
      .from('event_edit_request_votes')
      .select('request_id, voter_id, vote')
      .in('request_id', editIds);
    for (const row of votes ?? []) {
      const list = editVotes.get(String(row.request_id)) ?? [];
      list.push({ vote: row.vote as string, voter_id: row.voter_id as string });
      editVotes.set(String(row.request_id), list);
    }
  }

  const { data: phaseRequests } = await db
    .from('event_phase_change_requests')
    .select(
      'id, from_phase_id, target_phase_id, change_kind, reason, author_id, status, created_at'
    )
    .eq('event_id', eventId)
    .order('created_at', { ascending: false });
  const phaseIds = (phaseRequests ?? []).map((r) => String(r.id));
  const phaseVotes = new Map<string, Array<{ vote?: string | null; voter_id?: string }>>();
  if (phaseIds.length) {
    const { data: votes } = await db
      .from('event_phase_change_votes')
      .select('request_id, voter_id, vote')
      .in('request_id', phaseIds);
    for (const row of votes ?? []) {
      const list = phaseVotes.get(String(row.request_id)) ?? [];
      list.push({ vote: row.vote as string, voter_id: row.voter_id as string });
      phaseVotes.set(String(row.request_id), list);
    }
  }

  const names = await usernameMap(db, [
    ...(updateRequests ?? []).map((r) => r.author_id as string | null),
    ...(editRequests ?? []).map((r) => r.author_id as string | null),
    ...(phaseRequests ?? []).map((r) => r.author_id as string | null)
  ]);

  for (const req of updateRequests ?? []) {
    const built = buildGovernanceVoteSummary(
      updateVotes.get(String(req.id)) ?? [],
      userId,
      population
    );
    entries.push({
      createdAt: String(req.created_at),
      entry: {
        id: req.id,
        entityKind: 'event',
        kind: 'event-update',
        kindLabel: 'Update decision',
        createdAt: req.created_at,
        authorUsername: names.get(String(req.author_id)) ?? 'unknown',
        status: req.status,
        approvalThresholdPercent: 66,
        voteSummary: built.summary,
        passesApprovalThreshold: built.passes,
        canStillPass: built.canStillPass,
        canVote: canVoteOpen && req.status === 'open',
        payload: { type: 'update', body: req.body, appliedUpdateId: null }
      }
    });
  }

  for (const req of editRequests ?? []) {
    const built = buildGovernanceVoteSummary(
      editVotes.get(String(req.id)) ?? [],
      userId,
      population
    );
    entries.push({
      createdAt: String(req.created_at),
      entry: {
        id: req.id,
        entityKind: 'event',
        kind: 'event-edit',
        kindLabel: 'Edit decision',
        createdAt: req.created_at,
        authorUsername: names.get(String(req.author_id)) ?? 'unknown',
        status: req.status,
        approvalThresholdPercent: 66,
        voteSummary: built.summary,
        passesApprovalThreshold: built.passes,
        canStillPass: built.canStillPass,
        canVote: canVoteOpen && req.status === 'open',
        payload: {
          type: 'edit',
          changes: [
            { label: 'Title', before: '', after: req.title },
            { label: 'Description', before: '', after: req.description }
          ]
        }
      }
    });
  }

  for (const req of phaseRequests ?? []) {
    const built = buildGovernanceVoteSummary(
      phaseVotes.get(String(req.id)) ?? [],
      userId,
      population
    );
    entries.push({
      createdAt: String(req.created_at),
      entry: {
        id: req.id,
        entityKind: 'event',
        kind: 'event-phase-change',
        kindLabel: 'Phase decision',
        createdAt: req.created_at,
        authorUsername: names.get(String(req.author_id)) ?? 'unknown',
        status: req.status,
        approvalThresholdPercent: 66,
        voteSummary: built.summary,
        passesApprovalThreshold: built.passes,
        canStillPass: built.canStillPass,
        canVote: canVoteOpen && req.status === 'open',
        payload: {
          type: 'phase-change',
          changeKind: req.change_kind,
          fromPhaseId: req.from_phase_id,
          fromPhaseLabel: phaseTitleMap[String(req.from_phase_id)] ?? req.from_phase_id,
          toPhaseId: req.target_phase_id,
          toPhaseLabel: phaseTitleMap[String(req.target_phase_id)] ?? req.target_phase_id,
          reason: req.reason
        }
      }
    });
  }

  entries.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return entries.map((item) => item.entry);
}
