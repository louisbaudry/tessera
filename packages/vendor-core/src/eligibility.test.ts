import { describe, expect, it } from 'vitest';

import {
  exclusionReasons,
  parseTimeOff,
  TIME_OFF_MAX,
  type EligibilityProfile,
} from './eligibility.js';

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

describe('time off (issue #156)', () => {
  const job = { src: 'en', tgt: 'fr', window: { from: '2026-12-01', to: '2026-12-10' } };
  const profile = {
    languages: [{ src: 'en', tgt: 'fr' }],
    specialties: [],
    capacity: 'available' as const,
  };

  it('names a vendor whose time off shares a day with the job', () => {
    for (const timeOff of [
      [{ from: '2026-12-05', to: '2026-12-06' }], // inside
      [{ from: '2026-11-20', to: '2026-12-01' }], // ends on the first day
      [{ from: '2026-12-10', to: '2026-12-20' }], // starts on the last day
      [{ from: '2026-11-01', to: '2027-01-01' }], // around it
    ]) {
      expect(
        exclusionReasons({ ...profile, timeOff }, job),
        JSON.stringify(timeOff),
      ).toEqual(['time_off']);
    }
  });

  it('leaves a vendor whose time off is before or after the job, or who declared none', () => {
    for (const timeOff of [
      [{ from: '2026-11-20', to: '2026-11-30' }],
      [{ from: '2026-12-11', to: '2026-12-20' }],
      [],
      undefined,
    ]) {
      expect(exclusionReasons({ ...profile, timeOff }, job)).toEqual([]);
    }
  });

  it('tests nothing when the job has no window', () => {
    expect(
      exclusionReasons(
        { ...profile, timeOff: [{ from: '2026-12-05', to: '2026-12-06' }] },
        { src: 'en', tgt: 'fr' },
      ),
    ).toEqual([]);
  });

  it('keeps time off beside a status: available today, off during the job', () => {
    expect(
      exclusionReasons(
        {
          ...profile,
          capacity: 'busy',
          timeOff: [{ from: '2026-12-05', to: '2026-12-05' }],
        },
        job,
      ),
    ).toEqual(['busy', 'time_off']);
  });
});

describe('parseTimeOff', () => {
  it('reads windows and puts them in date order', () => {
    expect(
      parseTimeOff([
        { from: '2026-12-20', to: '2026-12-31' },
        { from: '2026-12-01', to: '2026-12-01' },
      ]),
    ).toEqual([
      { from: '2026-12-01', to: '2026-12-01' },
      { from: '2026-12-20', to: '2026-12-31' },
    ]);
    expect(parseTimeOff([])).toEqual([]);
  });

  it('refuses what is not a list of real, forward windows, and never repairs one', () => {
    expect(parseTimeOff('2026-12-01')).toMatch(/must be a list/);
    expect(parseTimeOff([{ from: '2026-02-30', to: '2026-03-01' }])).toMatch(/period 1/);
    expect(parseTimeOff([{ from: '2026-12-01' }])).toMatch(/period 1/);
    expect(parseTimeOff([null])).toMatch(/period 1/);
    expect(parseTimeOff([{ from: '2026-12-10', to: '2026-12-01' }])).toBe(
      'period 1 ends before it starts',
    );
    expect(
      parseTimeOff(
        Array.from({ length: TIME_OFF_MAX + 1 }, () => ({
          from: '2026-12-01',
          to: '2026-12-01',
        })),
      ),
    ).toMatch(/at most/);
  });
});
