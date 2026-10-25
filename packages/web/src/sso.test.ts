import { describe, expect, it } from 'vitest';

import { makeBinding, parseSsoFragment, PROVIDER_LABEL } from './sso.js';

describe('parseSsoFragment', () => {
  it('reads the hand-off code the callback host put in the fragment', () => {
    const code = 'A'.repeat(43);
    expect(parseSsoFragment(`#sso=${code}`)).toEqual({ kind: 'code', code });
    expect(parseSsoFragment(`#sso=ab-_${'z'.repeat(30)}`)).toEqual({
      kind: 'code',
      code: `ab-_${'z'.repeat(30)}`,
    });
  });

  it('reads a refusal as one', () => {
    expect(parseSsoFragment('#sso=refused')).toEqual({ kind: 'refused' });
  });

  it('is nothing for any other hash, so no other screen is taken for a sign-in', () => {
    for (const hash of [
      '',
      '#',
      '#/',
      '#/p/job',
      '#/invite/abc',
      '#sso',
      '#sso=',
      '#sso=short',
    ]) {
      expect(parseSsoFragment(hash), hash).toBeNull();
    }
  });

  it('refuses a code with anything a code cannot hold', () => {
    for (const bad of [
      'a b',
      '<script>',
      'x/y',
      '../x',
      `${'A'.repeat(43)}&x=1`,
      'A'.repeat(201),
    ]) {
      expect(parseSsoFragment(`#sso=${bad}`), bad).toBeNull();
    }
  });
});

describe('makeBinding', () => {
  it('makes a URL-safe secret long enough for the server to take', () => {
    const secret = makeBinding((n) => new Uint8Array(n).fill(255));
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(secret.length).toBeGreaterThanOrEqual(32);
  });

  it('is made from the random bytes it is given, so two differ', () => {
    let seed = 0;
    const next = (n: number) => Uint8Array.from({ length: n }, () => (seed += 7) % 256);
    expect(makeBinding(next)).not.toBe(makeBinding(next));
  });
});

describe('PROVIDER_LABEL', () => {
  it('names each provider the way a person knows it', () => {
    expect(PROVIDER_LABEL).toEqual({ google: 'Google', microsoft: 'Microsoft' });
  });
});
