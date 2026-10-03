import { describe, expect, it } from 'vitest';

import {
  CAPACITY_STATUSES,
  isCapacityStatus,
  isRateTier,
  normalizeSpecialty,
  RATE_TIERS,
} from './profile.js';

describe('the closed sets', () => {
  it('name each tier and status once', () => {
    expect(new Set(RATE_TIERS).size).toBe(RATE_TIERS.length);
    expect(new Set(CAPACITY_STATUSES).size).toBe(CAPACITY_STATUSES.length);
  });

  it('cover the spec’s tiers: no match, fuzzy bands, exact and ICE', () => {
    expect(RATE_TIERS).toContain('no_match');
    expect(RATE_TIERS).toContain('exact');
    expect(RATE_TIERS).toContain('ice');
    expect(RATE_TIERS.filter((t) => t.startsWith('fuzzy_')).length).toBeGreaterThan(1);
  });

  it('guards admit only members', () => {
    expect(isRateTier('ice')).toBe(true);
    expect(isRateTier('fuzzy')).toBe(false);
    expect(isCapacityStatus('away')).toBe(true);
    expect(isCapacityStatus('offline')).toBe(false);
  });
});

describe('normalizeSpecialty', () => {
  it('trims, lower-cases and collapses inner whitespace', () => {
    expect(normalizeSpecialty('  Legal  ')).toBe('legal');
    expect(normalizeSpecialty('Medical   Devices')).toBe('medical devices');
    expect(normalizeSpecialty('   ')).toBe('');
  });
});
