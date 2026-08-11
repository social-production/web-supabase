/**
 * Phase helper parity — mirrors supabase/functions/_shared/phases.ts without Deno imports.
 */
import { describe, expect, it } from 'vitest';

const PHASE_ORDER: Record<string, number> = {
  'phase-1': 1,
  'phase-2': 2,
  'phase-3': 3,
  'phase-4': 4,
  'phase-5': 5,
  'phase-6': 6,
  'phase-7': 7
};

function skipsDistributionPhase(projectMode: string, projectSubtype: string | null): boolean {
  return projectMode === 'collective-service' || projectSubtype === 'software';
}

function nextPhaseIdForProject(
  projectMode: string,
  projectSubtype: string | null,
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

describe('phase helpers', () => {
  it('computes productive next phases skipping acquisition/pending', () => {
    expect(nextPhaseIdForProject('productive', 'standard', 'phase-1')).toBe('phase-2');
    expect(nextPhaseIdForProject('productive', 'standard', 'phase-2')).toBe('phase-3');
    expect(nextPhaseIdForProject('productive', 'standard', 'phase-3')).toBe('phase-5');
    expect(nextPhaseIdForProject('productive', 'standard', 'phase-5')).toBe('phase-7');
    expect(nextPhaseIdForProject('productive', 'standard', 'phase-7')).toBeNull();
  });

  it('skips distribution for software and collective-service', () => {
    expect(nextPhaseIdForProject('productive', 'software', 'phase-2')).toBe('phase-5');
    expect(nextPhaseIdForProject('collective-service', null, 'phase-2')).toBe('phase-5');
  });

  it('personal-service closes at phase-2', () => {
    expect(nextPhaseIdForProject('personal-service', null, 'phase-1')).toBe('phase-2');
    expect(nextPhaseIdForProject('personal-service', null, 'phase-2')).toBeNull();
  });
});
