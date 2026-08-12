/** Phase labels and next-phase helpers — FastAPI oracle: projects/phases/labels.py */

export const PHASE_ORDER: Record<string, number> = {
  'phase-1': 1,
  'phase-2': 2,
  'phase-3': 3,
  'phase-4': 4,
  'phase-5': 5,
  'phase-6': 6,
  'phase-7': 7
};

const STAGE_LABEL_BY_PHASE_ID: Record<string, string> = {
  'phase-1': 'Proposal',
  'phase-2': 'Production Plan',
  'phase-3': 'Distribution Plan',
  'phase-4': 'Distribution Plan',
  'phase-5': 'Activity',
  'phase-6': 'Activity',
  'phase-7': 'Closed'
};

export function effectivePhaseIdForProgress(phaseId: string): string {
  if (phaseId === 'phase-4') return 'phase-3';
  if (phaseId === 'phase-6') return 'phase-5';
  return phaseId;
}

export function displayStageLabel(
  projectMode: string,
  projectSubtype: string | null | undefined,
  phaseId: string
): string {
  if (projectMode === 'personal-service') {
    if (phaseId === 'phase-1') return 'Activity';
    if (phaseId === 'phase-2') return 'Closed';
    return 'Activity';
  }
  const normalized = effectivePhaseIdForProgress(phaseId);
  return STAGE_LABEL_BY_PHASE_ID[normalized] ?? 'Proposal';
}

function skipsDistributionPhase(
  projectMode: string,
  projectSubtype: string | null | undefined
): boolean {
  return projectMode === 'collective-service' || projectSubtype === 'software';
}

export function visiblePhaseIdsForProject(
  projectMode: string,
  projectSubtype: string | null | undefined
): string[] {
  if (projectMode === 'personal-service') {
    return ['phase-1', 'phase-2'];
  }
  return skipsDistributionPhase(projectMode, projectSubtype)
    ? ['phase-1', 'phase-2', 'phase-5', 'phase-7']
    : ['phase-1', 'phase-2', 'phase-3', 'phase-5', 'phase-7'];
}

export function visiblePhaseIdForProject(
  projectMode: string,
  projectSubtype: string | null | undefined,
  phaseId: string
): string {
  const visible = visiblePhaseIdsForProject(projectMode, projectSubtype);
  if (visible.includes(phaseId)) return phaseId;
  const phaseOrder = PHASE_ORDER[phaseId] ?? 1;
  return (
    [...visible]
      .reverse()
      .find((candidate) => (PHASE_ORDER[candidate] ?? 0) <= phaseOrder) ?? visible[0]
  );
}

export function nextPhaseIdForProject(
  projectMode: string,
  projectSubtype: string | null | undefined,
  currentPhaseId: string
): string | null {
  if (projectMode === 'personal-service') {
    if (currentPhaseId === 'phase-1') return 'phase-2';
    return null;
  }

  if (currentPhaseId === 'phase-6') return 'phase-7';

  const currentOrder = PHASE_ORDER[currentPhaseId];
  if (currentOrder == null) return null;

  let nextOrder = currentOrder + 1;
  while (nextOrder <= PHASE_ORDER['phase-7']) {
    const nextPhaseId =
      Object.entries(PHASE_ORDER).find(([, order]) => order === nextOrder)?.[0] ?? null;
    if (!nextPhaseId) return null;

    if (nextPhaseId === 'phase-3' && skipsDistributionPhase(projectMode, projectSubtype)) {
      nextOrder += 1;
      continue;
    }
    if (nextPhaseId === 'phase-4' || nextPhaseId === 'phase-6') {
      nextOrder += 1;
      continue;
    }
    return nextPhaseId;
  }
  return null;
}

export const PROJECT_MODES = new Set(['productive', 'collective-service', 'personal-service']);
export const PROJECT_SUBTYPES = new Set(['standard', 'software', 'asset-management']);
