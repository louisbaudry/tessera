import { describe, expect, it } from 'vitest';

import { exclusionReasons, type EligibilityProfile } from './eligibility.js';

const fits: EligibilityProfile = {
  languages: [{ src: 'en', tgt: 'de' }],
  specialties: ['legal', 'medical'],
  capacity: 'available',
};

describe('exclusionReasons', () => {
  it('has no reason for a vendor who fits', () => {
    expect(exclusionReasons(fits, { src: 'en', tgt: 'de' })).toEqual([]);
  });

  it('matches languages by primary subtag, and the direction matters', () => {
    expect(exclusionReasons(fits, { src: 'en-GB', tgt: 'de-AT' })).toEqual([]);
    expect(exclusionReasons(fits, { src: 'de', tgt: 'en' })).toEqual(['language_pair']);
    expect(exclusionReasons(fits, { src: 'en', tgt: 'fr' })).toEqual(['language_pair']);
  });

  it('fits no job when no pair is declared', () => {
    expect(
      exclusionReasons({ ...fits, languages: [] }, { src: 'en', tgt: 'de' }),
    ).toEqual(['language_pair']);
  });

  it('asks for a specialty only when the job names one, normalised like a stored tag', () => {
    const job = { src: 'en', tgt: 'de' };
    expect(exclusionReasons({ ...fits, specialties: [] }, job)).toEqual([]);
    expect(exclusionReasons(fits, { ...job, specialty: '  LEGAL ' })).toEqual([]);
    expect(exclusionReasons(fits, { ...job, specialty: 'finance' })).toEqual([
      'specialty',
    ]);
    expect(exclusionReasons(fits, { ...job, specialty: '   ' })).toEqual([]);
    expect(
      exclusionReasons({ ...fits, specialties: [] }, { ...job, specialty: 'legal' }),
    ).toEqual(['specialty']);
  });

  it('treats a never-set capacity as unknown, not busy; busy and away are reasons of their own', () => {
    const job = { src: 'en', tgt: 'de' };
    expect(exclusionReasons({ ...fits, capacity: null }, job)).toEqual([]);
    expect(exclusionReasons({ ...fits, capacity: 'busy' }, job)).toEqual(['busy']);
    expect(exclusionReasons({ ...fits, capacity: 'away' }, job)).toEqual(['away']);
  });

  it('names a vendor the project’s client has not approved, and nothing when there is no pool to be in', () => {
    const job = { src: 'en', tgt: 'de' };
    expect(exclusionReasons({ ...fits, inClientPool: false }, job)).toEqual([
      'not_in_client_pool',
    ]);
    expect(exclusionReasons({ ...fits, inClientPool: true }, job)).toEqual([]);
    expect(exclusionReasons({ ...fits, inClientPool: null }, job)).toEqual([]);
    expect(exclusionReasons(fits, job)).toEqual([]);
  });

  it('names every reason a vendor has, in a fixed order', () => {
    expect(
      exclusionReasons(
        { languages: [], specialties: [], capacity: 'busy', inClientPool: false },
        { src: 'en', tgt: 'de', specialty: 'legal' },
      ),
    ).toEqual(['language_pair', 'specialty', 'busy', 'not_in_client_pool']);
  });
});
