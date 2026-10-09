import { describe, expect, it } from 'vitest';

import { mismatchFinder, type GlossaryTermEntry } from './mismatch.js';
import { asTextTokens, isStaleUse } from './stale.js';

const form = (text: string) => ({ text, plain: text.toLocaleLowerCase() });

/** `account` → preferred `Konto`, acceptable `Zugang`, forbidden `Account`. */
const entries: GlossaryTermEntry[] = [
  {
    termId: 1,
    source: [form('account')],
    preferred: form('Konto'),
    alternatives: [form('Zugang')],
    forbidden: [form('Account')],
  },
];
const langs = { srcLang: 'en', tgtLang: 'de' };
const stale = (source: string, target: string) => {
  const find = mismatchFinder(entries, langs);
  return find(asTextTokens(source), asTextTokens(target)).filter(isStaleUse);
};

describe('isStaleUse', () => {
  it('reports a forbidden rendering', () => {
    expect(stale('Open your account.', 'Öffnen Sie Ihren Account.')).toMatchObject([
      { termId: 1, kind: 'forbidden', found: 'Account' },
    ]);
  });

  it('reports an acceptable rendering used instead of the preferred one', () => {
    expect(stale('Open your account.', 'Öffnen Sie Ihren Zugang.')).toMatchObject([
      { termId: 1, kind: 'missing_preferred', found: 'Zugang', preferred: 'Konto' },
    ]);
  });

  it('does not report a target that uses the preferred rendering', () => {
    expect(stale('Open your account.', 'Öffnen Sie Ihr Konto.')).toEqual([]);
  });

  it('does not report a paraphrase that uses none of the known renderings', () => {
    // Lacks the preferred, and nothing says it is old: it is not rework.
    expect(stale('Open your account.', 'Öffnen Sie Ihr Profil.')).toEqual([]);
  });

  it('does not report a unit whose source does not hold the term', () => {
    expect(stale('Open the door.', 'Öffnen Sie die Tür.')).toEqual([]);
  });
});
