/**
 * The segmentation corpus (issue #267, `segmentation-spec.md` §9): per
 * language, texts organised by what makes them hard, each with the sentences a
 * translator should get.
 *
 * Three kinds of case (`corpus/types.fixture.ts`): correct today, a deliberate
 * conservative `policy`, and a `gap` where the segmenter is wrong. A gap is
 * asserted to *still be wrong*, so fixing the segmenter fails this file until
 * the case is promoted. That is the point: a corpus that only holds passing
 * cases says nothing about what is missing.
 */
import { describe, expect, it } from 'vitest';

import { CORPUS } from './corpus/index.fixture.js';
import { rulesFor, SUPPORTED_LANGUAGES } from './rules.js';
import { findBoundaries } from './segmenter.js';

/** What the segmenter cuts `text` into, trimmed, in order. */
function cut(text: string, lang: string): string[] {
  const cuts = findBoundaries(text, rulesFor(lang));
  const out: string[] = [];
  let from = 0;
  for (const at of cuts) {
    out.push(text.slice(from, at).trim());
    from = at;
  }
  out.push(text.slice(from).trim());
  return out.filter((s) => s.length > 0);
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

describe('the corpus itself', () => {
  it('has cases for every language the segmenter supports', () => {
    expect(Object.keys(CORPUS).sort()).toEqual([...SUPPORTED_LANGUAGES].sort());
  });

  for (const [lang, cases] of Object.entries(CORPUS)) {
    describe(lang, () => {
      it('has no duplicate texts', () => {
        const texts = cases.map((c) => c.text);
        expect(texts.filter((t, i) => texts.indexOf(t) !== i)).toEqual([]);
      });

      it('lists sentences that add up to the text', () => {
        // Catches a typo in the expectation, which would otherwise make a
        // case pass or fail for the wrong reason.
        const broken = cases.filter(
          (c) => squash(c.sentences.join(' ')) !== squash(c.text),
        );
        expect(broken.map((c) => c.text)).toEqual([]);
      });

      it('explains every policy and every gap, and tracks every gap', () => {
        const unexplained = cases.filter(
          (c) => c.status !== undefined && (c.note === undefined || c.note.length < 20),
        );
        expect(unexplained.map((c) => c.text)).toEqual([]);
        const untracked = cases.filter(
          (c) => c.status === 'gap' && c.issue === undefined,
        );
        expect(untracked.map((c) => c.text)).toEqual([]);
        const stray = cases.filter((c) => c.status !== 'gap' && c.issue !== undefined);
        expect(stray.map((c) => c.text)).toEqual([]);
      });
    });
  }
});

for (const [lang, cases] of Object.entries(CORPUS)) {
  describe(`segmentation corpus — ${lang}`, () => {
    for (const c of cases) {
      const name = `${c.category}${c.status ? ` [${c.status}]` : ''}: ${JSON.stringify(c.text)}`;
      if (c.status === 'gap') {
        it(name, () => {
          expect(
            cut(c.text, lang),
            `gap #${c.issue} is closed: delete the status, note and issue from this case`,
          ).not.toEqual(c.sentences);
        });
      } else {
        it(name, () => {
          expect(cut(c.text, lang)).toEqual(c.sentences);
        });
      }
    }
  });
}
