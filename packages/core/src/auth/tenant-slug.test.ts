import { describe, expect, it } from 'vitest';

import { isTenantSlug, RESERVED_TENANT_SLUGS, tenantSlugProblem } from './tenant-slug.js';

describe('tenantSlugProblem', () => {
  it('accepts a DNS label of lower-case letters, digits and inner hyphens', () => {
    for (const ok of ['acme', 'a', 'a1', 'north-star', 'x'.repeat(40), '1abc']) {
      expect(tenantSlugProblem(ok), ok).toBeNull();
    }
  });

  it('refuses what is not a label: case, dots, underscores, outer hyphens, empty and too long', () => {
    for (const bad of [
      'Acme',
      'a.b',
      'a_b',
      '-a',
      'a-',
      '',
      'x'.repeat(41),
      'a b',
      'café',
    ]) {
      expect(tenantSlugProblem(bad), bad).toMatch(/lower-case/);
    }
  });

  it('refuses every name the platform keeps, with the name in the message', () => {
    for (const reserved of RESERVED_TENANT_SLUGS) {
      expect(tenantSlugProblem(reserved), reserved).toBe(
        `"${reserved}" is kept for the platform`,
      );
      expect(isTenantSlug(reserved)).toBe(false);
    }
    expect(isTenantSlug('acme')).toBe(true);
  });

  it('keeps the reserved list itself well-formed, so a reserved name is refused for being reserved', () => {
    for (const reserved of RESERVED_TENANT_SLUGS)
      expect(reserved).toMatch(/^[a-z0-9-]+$/);
    expect(new Set(RESERVED_TENANT_SLUGS).size).toBe(RESERVED_TENANT_SLUGS.length);
  });
});
