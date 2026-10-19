import { describe, expect, it } from 'vitest';
import { readProductionLicenses } from './check-licenses.mjs';
import { checkLicenses, licenseAllowed } from './license-policy.mjs';

describe('licenseAllowed', () => {
  it('accepts the permissive licenses', () => {
    for (const id of ['MIT', 'ISC', 'Apache-2.0', 'BSD-3-Clause', 'MIT-0']) {
      expect(licenseAllowed(id), id).toBe(true);
    }
  });

  it('refuses copyleft, source-available and missing licenses', () => {
    for (const id of [
      'GPL-3.0-only',
      'AGPL-3.0-or-later',
      'LGPL-2.1',
      'MPL-2.0',
      'BUSL-1.1',
      'UNLICENSED',
      'SEE LICENSE IN LICENSE.md',
      '',
    ]) {
      expect(licenseAllowed(id), id).toBe(false);
    }
  });

  it('lets an OR pass on either side and an AND only on both', () => {
    expect(licenseAllowed('(MIT OR GPL-3.0-only)')).toBe(true);
    expect(licenseAllowed('(GPL-3.0-only OR MIT)')).toBe(true);
    expect(licenseAllowed('MIT AND GPL-3.0-only')).toBe(false);
    expect(licenseAllowed('MIT AND ISC')).toBe(true);
    expect(licenseAllowed('(BSD-2-Clause OR MIT OR Apache-2.0)')).toBe(true);
  });

  it('fails closed on what it does not understand', () => {
    expect(licenseAllowed('MIT WITH Classpath-exception-2.0')).toBe(false);
    expect(licenseAllowed('MIT+')).toBe(false);
    expect(licenseAllowed('(MIT')).toBe(false);
    expect(licenseAllowed('MIT OR')).toBe(false);
  });
});

describe('checkLicenses', () => {
  it('names each refused package and nothing else', () => {
    const violations = checkLicenses({
      MIT: [{ name: 'fine', versions: ['1.0.0'] }],
      'GPL-3.0-only': [
        { name: 'bad-a', versions: ['2.0.0'] },
        { name: 'bad-b', versions: ['3.1.0'] },
      ],
    });
    expect(violations.map((v) => v.name)).toEqual(['bad-a', 'bad-b']);
    expect(violations[0]?.license).toBe('GPL-3.0-only');
  });
});

describe('the production dependencies', () => {
  // The enforcement point: CI runs `pnpm test`, so a copyleft package added to
  // a production dependency fails here without a workflow of its own.
  it('are all within the license policy', () => {
    expect(checkLicenses(readProductionLicenses())).toEqual([]);
  });
});
