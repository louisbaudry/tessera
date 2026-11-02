import { describe, expect, it } from 'vitest';

import { isCurrencyCode } from './currency.js';

describe('isCurrencyCode', () => {
  it('accepts ISO 4217 codes', () => {
    for (const code of ['EUR', 'USD', 'GBP', 'CHF', 'JPY', 'KRW', 'VND']) {
      expect(isCurrencyCode(code), code).toBe(true);
    }
  });

  it('refuses three letters ISO does not list, which Intl would still print', () => {
    expect(isCurrencyCode('XYZ')).toBe(false);
    expect(
      new Intl.NumberFormat('en', { style: 'currency', currency: 'XYZ' }).format(1),
    ).toContain('XYZ');
  });

  it('refuses a code not written as ISO writes it', () => {
    for (const code of ['eur', 'Eur', ' EUR', 'EUR ', 'EURO', '€', '$', '']) {
      expect(isCurrencyCode(code), JSON.stringify(code)).toBe(false);
    }
  });
});
