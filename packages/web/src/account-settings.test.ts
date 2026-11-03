import { describe, expect, it } from 'vitest';

import { canUnlink, draftOf, policyOf, policyProblem } from './account-settings.js';

describe('the policy form', () => {
  const blank = { requireSso: false, microsoftTid: '', googleHd: '' };

  it('sends a blank lock as none, and trims what is typed', () => {
    expect(
      policyOf({ requireSso: true, microsoftTid: '  ', googleHd: ' example.org ' }),
    ).toEqual({
      requireSso: true,
      microsoftTid: null,
      googleHd: 'example.org',
    });
  });

  it('round-trips what is stored', () => {
    const stored = { requireSso: true, microsoftTid: null, googleHd: 'example.org' };
    expect(policyOf(draftOf(stored))).toEqual(stored);
  });

  it('says what is wrong with a directory id or a domain before sending', () => {
    expect(policyProblem(blank)).toBeNull();
    expect(
      policyProblem({ ...blank, microsoftTid: '6f1b2c3d-1111-4222-8333-944455556666' }),
    ).toBeNull();
    expect(policyProblem({ ...blank, microsoftTid: 'my-company' })).toMatch(
      /directory id/,
    );
    expect(policyProblem({ ...blank, googleHd: 'example' })).toMatch(/domain/);
    expect(policyProblem({ ...blank, googleHd: 'not a domain.org' })).toMatch(/domain/);
  });
});

describe('canUnlink', () => {
  it('keeps the last way in', () => {
    expect(canUnlink(1, false)).toBe(false);
    expect(canUnlink(2, false)).toBe(true);
    expect(canUnlink(1, true)).toBe(true);
  });
});
