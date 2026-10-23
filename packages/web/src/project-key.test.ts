import { isSlug } from '@cat-tool/core/model';
import { describe, expect, it } from 'vitest';

import { parseProjectKey, projectKey } from './project-key.js';

describe('a project key', () => {
  it('is the bare name for the account’s own project, and name@tenant for another’s', () => {
    expect(projectKey('job', null)).toBe('job');
    expect(projectKey('job', 7)).toBe('job@7');
  });

  it('parses back to what made it', () => {
    expect(parseProjectKey('job')).toEqual({ name: 'job', tenantId: null });
    expect(parseProjectKey('job@7')).toEqual({ name: 'job', tenantId: 7 });
    expect(parseProjectKey(projectKey('a-b-1', 123456))).toEqual({
      name: 'a-b-1',
      tenantId: 123456,
    });
  });

  it('reads anything that is not a well-formed tenant as a plain name', () => {
    for (const odd of [
      'job@',
      'job@0',
      'job@07',
      'job@x',
      '@7',
      'job@7@8',
      'job@1234567890123456',
    ]) {
      expect(parseProjectKey(odd), odd).toEqual({ name: odd, tenantId: null });
    }
  });

  it('cannot be confused with a slug: no name the server accepts contains the separator', () => {
    expect(isSlug('job@7')).toBe(false);
    expect(isSlug('job')).toBe(true);
  });
});
