/**
 * Backend-side pure parity tests for vote/moderation/region helpers.
 * These mirror supabase/functions/_shared without importing Deno URLs.
 * Numbers must match FastAPI (see docs/FASTAPI_ORACLE.md).
 */
import { describe, expect, it } from 'vitest';

function requiredVotes(n: number): number {
  if (n <= 0) return 0;
  let errorMargin: number;
  if (n < 100) errorMargin = 0.1 - (0.03 * (n - 1)) / 99;
  else if (n < 500) errorMargin = 0.07 - (0.02 * (n - 100)) / 400;
  else errorMargin = Math.max(0.02, 0.05 - (0.03 * Math.log10(n / 500)) / Math.log10(2000));
  const baseSampleSize = 0.9604 / errorMargin ** 2;
  const cochran = Math.ceil(baseSampleSize / (1 + (baseSampleSize - 1) / n));
  return Math.min(Math.ceil(0.75 * n), cochran);
}

function summarizeVotes(rows: Array<{ vote?: string | number | null }>) {
  let yesCount = 0;
  let noCount = 0;
  for (const row of rows) {
    if (row.vote === 'yes' || row.vote === 1) yesCount += 1;
    if (row.vote === 'no' || row.vote === -1) noCount += 1;
  }
  const voteCount = yesCount + noCount;
  return { yesCount, noCount, voteCount, approvalRatio: voteCount ? yesCount / voteCount : 0 };
}

function isPassing(voteCount: number, approvalRatio: number, population: number) {
  return voteCount >= requiredVotes(population) && approvalRatio >= 0.66;
}

function deleteQuorum(audienceSize: number, reason: string, targetType = '') {
  if (targetType === 'message' && audienceSize <= 1) return 1;
  const base = Math.max(0, requiredVotes(Math.max(0, audienceSize)));
  if (reason === 'serious-harm') return base <= 0 ? 5 : Math.max(5, Math.ceil(base * 0.66));
  return base <= 0 ? 3 : Math.max(3, base);
}

function hideQuorum(audienceSize: number, targetType = '') {
  if (targetType === 'message' && audienceSize <= 1) return 1;
  const base = Math.max(0, requiredVotes(Math.max(0, audienceSize)));
  return base <= 0 ? 3 : Math.max(3, Math.ceil(base * 0.33));
}

function ageBoostPercent(ageDays: number): number {
  if (ageDays < 1) return 0;
  if (ageDays < 7) return 10;
  if (ageDays < 30) return 20;
  if (ageDays < 180) return 30;
  return 35;
}

function popularityBoostPercent(score: number): number {
  if (score < 2) return 0;
  if (score < 8) return 5;
  if (score < 20) return 10;
  if (score < 50) return 15;
  return 20;
}

function deleteYesShare(reason: string, ageDays: number, engagementScore: number): number {
  const age = ageBoostPercent(ageDays);
  const popularity = popularityBoostPercent(engagementScore);
  if (reason === 'serious-harm') {
    const boost = Math.floor((age + popularity) / 2);
    return Math.min(0.85, 0.66 + boost / 100);
  }
  return Math.min(0.9, 0.66 + (age + popularity) / 100);
}

function hideYesShare(reason: string, ageDays: number, engagementScore: number): number {
  if (reason !== 'serious-harm') return 1;
  const age = ageBoostPercent(ageDays);
  const popularity = popularityBoostPercent(engagementScore);
  const boost = Math.floor((age + popularity) / 4);
  return Math.min(0.8, 0.66 + boost / 100);
}

function normalizeRadiusKm(raw: number | null | undefined) {
  const value = Number(raw ?? 25);
  if (!Number.isFinite(value)) return 25;
  return Math.min(Math.max(Math.trunc(value), 1), 20000);
}

function signalUnlocked(demand: number, opposition: number, platform: boolean, population: number) {
  const total = demand + opposition;
  if (total <= 0) return false;
  const ratioMet = (demand / total) * 100 >= 66;
  if (!platform) return ratioMet;
  return ratioMet && demand >= requiredVotes(population);
}

describe('web-supabase shared parity math', () => {
  it('matches FastAPI required_votes formula for key sizes', () => {
    const expected: Record<number, number> = {
      0: 0,
      1: 1,
      2: 2,
      3: 3,
      5: 4,
      10: 8,
      25: 19,
      50: 37,
      100: 67,
      200: 107,
      500: 218,
      1000: 301
    };
    for (const [n, want] of Object.entries(expected)) {
      expect(requiredVotes(Number(n))).toBe(want);
    }
  });

  it('summarizes yes/no governance votes and 66% pass rule', () => {
    expect(summarizeVotes([{ vote: 'yes' }, { vote: 'yes' }, { vote: 'no' }])).toEqual({
      yesCount: 2,
      noCount: 1,
      voteCount: 3,
      approvalRatio: 2 / 3
    });
    // population 1 needs 1 vote; 2/3 >= 0.66 passes
    expect(isPassing(3, 2 / 3, 1)).toBe(true);
    expect(isPassing(3, 0.5, 1)).toBe(false);
    expect(isPassing(0, 1, 10)).toBe(false);
  });

  it('applies moderation delete/hide quorum floors', () => {
    expect(deleteQuorum(0, 'spam')).toBe(3);
    expect(deleteQuorum(0, 'serious-harm')).toBe(5);
    expect(deleteQuorum(1, 'spam', 'message')).toBe(1);
    expect(hideQuorum(0)).toBe(3);
    expect(hideQuorum(1, 'message')).toBe(1);
  });

  it('matches age/popularity boost and yes-share caps', () => {
    expect(ageBoostPercent(0.5)).toBe(0);
    expect(ageBoostPercent(3)).toBe(10);
    expect(ageBoostPercent(10)).toBe(20);
    expect(ageBoostPercent(60)).toBe(30);
    expect(ageBoostPercent(200)).toBe(35);
    expect(popularityBoostPercent(1)).toBe(0);
    expect(popularityBoostPercent(5)).toBe(5);
    expect(popularityBoostPercent(15)).toBe(10);
    expect(popularityBoostPercent(30)).toBe(15);
    expect(popularityBoostPercent(80)).toBe(20);
    // fresh spam, no popularity → 0.66
    expect(deleteYesShare('spam', 0, 0)).toBeCloseTo(0.66);
    // old popular spam caps at 0.90
    expect(deleteYesShare('spam', 200, 80)).toBe(0.9);
    // serious-harm uses half boost and 0.85 cap
    expect(deleteYesShare('serious-harm', 200, 80)).toBeLessThanOrEqual(0.85);
    expect(hideYesShare('serious-harm', 0, 0)).toBeCloseTo(0.66);
    expect(hideYesShare('spam', 10, 10)).toBe(1);
  });

  it('defaults and clamps region radius around 25 km', () => {
    expect(normalizeRadiusKm(undefined)).toBe(25);
    expect(normalizeRadiusKm(10)).toBe(10);
    expect(normalizeRadiusKm(0)).toBe(1);
    expect(normalizeRadiusKm(999999)).toBe(20000);
  });

  it('builds compact vote-summary fields without NaN/undefined gaps', () => {
    const votes = [{ vote: 'yes', voter_id: 'u1' }, { vote: 'no', voter_id: 'u2' }];
    const stats = summarizeVotes(votes);
    const population = 10;
    const votesRequired = requiredVotes(population);
    const remainingEligibleVotes = Math.max(0, population - stats.voteCount);
    const approvalPercent = Math.round(stats.approvalRatio * 1000) / 10;
    const summary = {
      yesCount: stats.yesCount,
      noCount: stats.noCount,
      totalVotes: stats.voteCount,
      approvalPercent,
      activeVote: 'yes' as const,
      meetsQuorum: stats.voteCount >= votesRequired,
      eligibleVoterCount: population,
      quorumThresholdPercent: Math.round((votesRequired / population) * 1000) / 10,
      votesRequired,
      votesRemaining: Math.max(0, votesRequired - stats.voteCount),
      remainingEligibleVotes
    };

    expect(summary.totalVotes).toBe(2);
    expect(summary.approvalPercent).toBeCloseTo(50);
    expect(Number.isFinite(summary.approvalPercent)).toBe(true);
    expect(Number.isFinite(summary.remainingEligibleVotes)).toBe(true);
    expect(summary.votesRequired).toBeGreaterThan(0);
    expect(summary.votesRemaining).toBe(summary.votesRequired - summary.totalVotes);
    expect(
      `${summary.approvalPercent}% yes · ${summary.totalVotes}/${summary.remainingEligibleVotes + summary.totalVotes} voted · 66% needed`
    ).not.toMatch(/undefined|NaN/);
  });
});
