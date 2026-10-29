import { describe, expect, it } from 'vitest';

import { checkClientInput, checkRateInput } from './admin-input.js';

describe('checkClientInput', () => {
  it('trims a good client', () => {
    expect(checkClientInput({ name: '  Org  ', email: ' a@example.com ' })).toEqual({
      name: 'Org',
      email: 'a@example.com',
    });
  });

  it('names what is wrong with a bad one', () => {
    const problem = (body: unknown) =>
      (checkClientInput(body) as { problem?: string }).problem;
    expect(problem(undefined)).toMatch(/name/);
    expect(problem({ email: 'a@example.com' })).toMatch(/name/);
    expect(problem({ name: '   ', email: 'a@example.com' })).toMatch(/name/);
    expect(problem({ name: 'x'.repeat(201), email: 'a@example.com' })).toMatch(/200/);
    for (const email of [undefined, 3, '', 'nobody', 'a@b', 'a b@c.d', '@example.com']) {
      expect(problem({ name: 'Org', email }), String(email)).toMatch(/email/);
    }
    expect(problem({ name: 'Org', email: `${'a'.repeat(250)}@example.com` })).toMatch(
      /254/,
    );
  });
});

describe('checkRateInput', () => {
  const good = { srcLang: 'en', tgtLang: 'pt-BR', ratePerWord: 0.1, minimumPrice: 40 };

  it('accepts a good rate and trims the tags', () => {
    expect(checkRateInput({ ...good, srcLang: ' en ' })).toEqual(good);
    expect(checkRateInput({ ...good, minimumPrice: 0 })).toMatchObject({
      minimumPrice: 0,
    });
  });

  it('refuses what is not a language tag, the same language twice, and bad numbers', () => {
    const problem = (body: unknown) =>
      (checkRateInput(body) as { problem?: string }).problem;
    for (const bad of ['', 'english', 'e', 'en_US', '<i>', 'en-', 3]) {
      expect(problem({ ...good, tgtLang: bad }), String(bad)).toMatch(/language tags/);
    }
    expect(problem({ ...good, tgtLang: 'EN' })).toMatch(/different/);
    for (const bad of [0, -1, NaN, Infinity, '0.1', null, undefined]) {
      expect(problem({ ...good, ratePerWord: bad }), String(bad)).toMatch(/ratePerWord/);
    }
    for (const bad of [-1, NaN, '40', null, undefined]) {
      expect(problem({ ...good, minimumPrice: bad }), String(bad)).toMatch(
        /minimumPrice/,
      );
    }
    expect(problem(undefined)).toMatch(/language tags/);
  });
});
