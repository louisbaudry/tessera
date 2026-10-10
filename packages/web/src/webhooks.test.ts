import { describe, expect, it } from 'vitest';

import {
  deliverySummary,
  lastAnswer,
  leadProblem,
  leadSummary,
  MAX_ENDPOINTS,
  needsAttention,
  urlProblem,
} from './webhooks.js';

describe('deliverySummary', () => {
  it('says nothing was sent rather than listing zeros', () => {
    expect(deliverySummary({ pending: 0, delivered: 0, failed: 0 })).toBe(
      'Nothing sent yet',
    );
  });

  it('puts failures first, then what waits, then what arrived', () => {
    expect(deliverySummary({ pending: 1, delivered: 14, failed: 2 })).toBe(
      '2 failed, 1 waiting, 14 delivered',
    );
    expect(deliverySummary({ pending: 0, delivered: 3, failed: 0 })).toBe('3 delivered');
    expect(deliverySummary({ pending: 2, delivered: 0, failed: 0 })).toBe('2 waiting');
  });
});

describe('lastAnswer and needsAttention', () => {
  it('names the last status, or nothing when there was no answer', () => {
    expect(lastAnswer({ lastStatus: 503 })).toBe('last answer 503');
    expect(lastAnswer({ lastStatus: null })).toBeNull();
  });

  it('flags an endpoint only when something failed for good', () => {
    expect(needsAttention({ failed: 1 })).toBe(true);
    expect(needsAttention({ failed: 0 })).toBe(false);
  });
});

describe('urlProblem', () => {
  it('asks for an address, and for https, before the server is asked', () => {
    expect(urlProblem('', 0)).toMatch(/Enter the address/);
    expect(urlProblem('  ', 0)).toMatch(/Enter the address/);
    expect(urlProblem('http://hooks.example.com/', 0)).toMatch(/https/);
    expect(urlProblem('hooks.example.com', 0)).toMatch(/https/);
    expect(urlProblem('https://hooks.example.com/in', 0)).toBeNull();
    expect(urlProblem(' HTTPS://hooks.example.com/in ', 0)).toBeNull();
  });

  it('stops at the limit and says to remove one', () => {
    expect(urlProblem('https://hooks.example.com/', MAX_ENDPOINTS)).toMatch(/remove one/);
    expect(urlProblem('https://hooks.example.com/', MAX_ENDPOINTS - 1)).toBeNull();
  });
});

describe('leadProblem', () => {
  it('takes whole hours from 0 to 720 and says what is wrong otherwise', () => {
    for (const ok of ['0', '1', ' 24 ', '720']) expect(leadProblem(ok)).toBeNull();
    for (const bad of ['', '  ', '-1', '721', '1.5', '2h', 'abc']) {
      expect(leadProblem(bad)).not.toBeNull();
    }
    expect(leadProblem('')).toMatch(/0 for no reminder/);
    expect(leadProblem('721')).toMatch(/0 to 720/);
  });
});

describe('leadSummary', () => {
  it('reads whole days as days and everything else as hours', () => {
    expect(leadSummary(0)).toBe('No reminder before a deadline');
    expect(leadSummary(1)).toBe('Reminder 1 hour before a deadline');
    expect(leadSummary(6)).toBe('Reminder 6 hours before a deadline');
    expect(leadSummary(24)).toBe('Reminder 1 day before a deadline');
    expect(leadSummary(72)).toBe('Reminder 3 days before a deadline');
    expect(leadSummary(36)).toBe('Reminder 36 hours before a deadline');
  });
});
