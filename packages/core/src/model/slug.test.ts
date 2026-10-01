import { describe, expect, it } from 'vitest';

import { isSlug, slugify } from './slug.js';

describe('isSlug', () => {
  it('accepts lowercase letters, digits and inner hyphens, up to 64', () => {
    for (const name of ['a', 'job-2026', '0', 'a'.repeat(64)])
      expect(isSlug(name), name).toBe(true);
  });

  it('refuses anything that could reach outside a directory, or nothing', () => {
    for (const name of [
      '',
      '-a',
      'a-',
      '../x',
      'a/b',
      'a.b',
      'A',
      'a b',
      'a'.repeat(65),
      'é',
    ]) {
      expect(isSlug(name), name).toBe(false);
    }
  });
});

describe('slugify', () => {
  it('suggests a slug from a title', () => {
    expect(slugify('Client Brief \u2014 Q3 2026')).toBe('client-brief-q3-2026');
    expect(slugify('  Résumé Übersetzung ')).toBe('resume-ubersetzung');
    expect(slugify('legal/../etc')).toBe('legal-etc');
  });

  it('always suggests a slug or nothing', () => {
    for (const title of [
      '\u65E5\u672C\u8A9E',
      '---',
      '',
      'x'.repeat(70) + ' y',
      'a'.repeat(63) + ' b',
    ]) {
      const slug = slugify(title);
      expect(slug === '' || isSlug(slug), JSON.stringify(title)).toBe(true);
    }
    expect(slugify('\u65E5\u672C\u8A9E')).toBe('');
  });
});
