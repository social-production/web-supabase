/**
 * Phase helper parity — mirrors supabase/functions/_shared/phases.ts without Deno imports.
 */
import { describe, expect, it } from 'vitest';
import {
  nextPhaseIdForProject,
  visiblePhaseIdForProject,
  visiblePhaseIdsForProject
} from '../supabase/functions/_shared/phases.ts';

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

  it('never exposes acquisition or review phases', () => {
    expect(visiblePhaseIdsForProject('productive', 'standard')).toEqual([
      'phase-1',
      'phase-2',
      'phase-3',
      'phase-5',
      'phase-7'
    ]);
    expect(visiblePhaseIdsForProject('productive', 'software')).toEqual([
      'phase-1',
      'phase-2',
      'phase-5',
      'phase-7'
    ]);
    expect(visiblePhaseIdsForProject('collective-service', null)).toEqual([
      'phase-1',
      'phase-2',
      'phase-5',
      'phase-7'
    ]);
    expect(visiblePhaseIdsForProject('personal-service', null)).toEqual([
      'phase-1',
      'phase-2'
    ]);
  });

  it('maps legacy stored phases onto a visible phase', () => {
    expect(visiblePhaseIdForProject('productive', 'standard', 'phase-4')).toBe('phase-3');
    expect(visiblePhaseIdForProject('productive', 'standard', 'phase-6')).toBe('phase-5');
    expect(visiblePhaseIdForProject('productive', 'software', 'phase-4')).toBe('phase-2');
  });
});
