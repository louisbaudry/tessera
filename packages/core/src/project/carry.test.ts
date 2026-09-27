/**
 * `carryHiddenTags` against the whole fixture corpus (backlog #29): what
 * the editor's saves will actually meet, rendered and exported the way a
 * delivery is.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { importDocx, translatableSegments, type ProjectFile } from '../docx/document.js';
import { nestingErrors, runOfEachChar } from '../docx/nesting.fixture.js';
import { renderTokens } from '../docx/render.js';
import {
  carryHiddenTags,
  sameVisibleTarget,
  withoutHiddenTags,
} from '../model/hidden-tags.js';
import type { Segment } from '../model/segment.js';
import { tagSignature, validateTagStructure } from '../model/tags.js';
import { plainText, type FormatEntry, type Token } from '../model/token.js';
import { runQaChecks } from '../qa/rules.js';
import { rulesFor } from '../segment/rules.js';
import { assembleFile } from './assemble.js';
import { exportProjectFile, foldSegments } from './export.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);
const fixtureNames = readdirSync(FIXTURES).filter((f) => f.endsWith('.docx'));
const load = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

const corpus = fixtureNames.map((name) => ({
  name,
  assembled: assembleFile(load(name), rulesFor('en')),
}));
const segments = corpus.flatMap(({ name, assembled }) =>
  assembled.segments
    .filter((s) => !s.locked)
    .map((s, i) => ({ where: `${name} #${i}`, ...s })),
);

const hiddenOnly = (tokens: readonly Token[], formats: readonly FormatEntry[]) => {
  const visible = new Set(withoutHiddenTags(tokens, formats));
  return tagSignature(tokens.filter((t) => !visible.has(t)));
};

/** The three shapes a saved target starts from. */
const targetsOf = (s: (typeof segments)[number]) => ({
  // Every visible tag placed where the source had it.
  placed: withoutHiddenTags(s.sourceTokens, s.formatTable),
  // A tag-mismatched TM hit, or a translator who placed nothing.
  textOnly: [{ t: 'text' as const, v: plainText(s.sourceTokens).toUpperCase() }],
  // A copy of the source, hidden tags where the source had them.
  copied: s.sourceTokens,
});

const TAG_RULES = new Set(['tag.missing', 'tag.extra', 'tag.unbalanced'] as const);

describe('carryHiddenTags — the whole corpus', () => {
  it('has something to prove: most segments carry hidden tags', () => {
    const withHidden = segments.filter((s) => s.formatTable.some((f) => !f.visible));
    expect(withHidden.length).toBeGreaterThan(segments.length / 2);
  });

  it('checks nesting the way Word wrote it: every original region passes', () => {
    for (const { name } of corpus) {
      for (const skeleton of importDocx(load(name)).skeletons) {
        for (const region of skeleton.regions) {
          expect(nestingErrors(region.xml), `${name} :: ${region.key}`).toEqual([]);
        }
      }
    }
  });

  it('keeps structure valid, the visible tags as placed, and every hidden tag once', () => {
    for (const s of segments) {
      for (const [shape, target] of Object.entries(targetsOf(s))) {
        const where = `${s.where} (${shape})`;
        const carried = carryHiddenTags(target, s.sourceTokens, s.formatTable);
        expect(validateTagStructure(carried), where).toEqual({ ok: true });
        expect(sameVisibleTarget(carried, target, s.formatTable), where).toBe(true);
        expect(hiddenOnly(carried, s.formatTable), where).toEqual(
          hiddenOnly(s.sourceTokens, s.formatTable),
        );
        expect(carryHiddenTags(carried, s.sourceTokens, s.formatTable), where).toEqual(
          carried,
        );
      }
    }
  });

  it('leaves the tag rules nothing to say once every visible tag is placed', () => {
    for (const s of segments) {
      const carried = carryHiddenTags(targetsOf(s).placed, s.sourceTokens, s.formatTable);
      expect(
        runQaChecks({ source: s.sourceTokens, target: carried }, TAG_RULES),
        s.where,
      ).toEqual([]);
    }
  });

  it('renders every shape to OOXML Word accepts, text intact', () => {
    for (const s of segments) {
      for (const [shape, target] of Object.entries(targetsOf(s))) {
        const where = `${s.where} (${shape})`;
        const carried = carryHiddenTags(target, s.sourceTokens, s.formatTable);
        const xml = renderTokens(carried, s.formatTable);
        expect(nestingErrors(xml), where).toEqual([]);
      }
    }
  });

  it('gives retyped text its source formatting', () => {
    // Every text token retyped (case swapped, so a letter never matches
    // verbatim but a digit or a symbol does), every visible tag placed
    // where the source had it. Exactly the source's formatting wherever
    // each container's plain text had one; where it had several, the
    // dominant one — except a minority kept verbatim (a hand-raised note
    // number, a symbol-font checkbox), which keeps its own. What that
    // costs is counted in what a reader sees: font, size and raise, on
    // characters that are not spaces.
    let chars = 0;
    let looksDifferent = 0;
    for (const s of segments) {
      const retyped = targetsOf(s).placed.map((t) =>
        t.t === 'text' ? { t: 'text' as const, v: swapCase(t.v) } : t,
      );
      const carried = carryHiddenTags(retyped, s.sourceTokens, s.formatTable);
      const before = runOfEachChar(s.sourceTokens, s.formatTable);
      const after = runOfEachChar(carried, s.formatTable);
      if (isUniform(s.sourceTokens, s.formatTable)) {
        expect(after, s.where).toEqual(before);
      }
      const letters = [...plainText(s.sourceTokens)];
      before.forEach((run, i) => {
        if (/\s/.test(letters[i]!)) return;
        chars++;
        if (looks(run) !== looks(after[i]!)) looksDifferent++;
      });
    }
    expect(chars).toBe(RETYPED_CHARS);
    expect(looksDifferent).toBeLessThanOrEqual(LOOKS_DIFFERENT);
  });

  it("keeps the space export's fold puts between sentences in their formatting", () => {
    // A carried target begins with opens and ends with closes, so the fold
    // fuses two neighbours' identical runs and the space lands inside
    // them. Were a trailing tag after the run's close, the space would
    // get a bare run of its own — the paragraph's default font, between
    // two sentences in another (17 of the corpus's paragraphs).
    const bareSpace = new RegExp(
      '(<w:r><w:rPr>(?:(?!</w:rPr>).)*</w:rPr>)(?:(?!</w:r>).)*</w:r>' +
        '(?:<w:proofErr[^>]*/>|<w:bookmark\\w+[^>]*/>)*' +
        '<w:r><w:t xml:space="preserve">\\s+</w:t></w:r>' +
        '(?:<w:proofErr[^>]*/>|<w:bookmark\\w+[^>]*/>)*\\1',
    );
    let paragraphs = 0;
    for (const { name, assembled } of corpus) {
      const translated = assembled.segments.map((s, i): Segment => ({
        id: i + 1,
        fileId: 1,
        ...s,
        targetTokens: s.locked
          ? null
          : carryHiddenTags(
              [{ t: 'text', v: `Frase ${i}.` }],
              s.sourceTokens,
              s.formatTable,
            ),
        origin: null,
        updatedAt: '2026-09-27T00:00:00.000Z',
      }));
      for (const [part, byKey] of foldSegments(translated).replacements) {
        for (const [key, xml] of byKey) {
          paragraphs++;
          expect(bareSpace.test(xml), `${name} :: ${part} :: ${key}`).toBe(false);
        }
      }
    }
    expect(paragraphs).toBeGreaterThan(1000);
  });

  it('exports a document whose every segment was typed as plain text', () => {
    // The shape of a first real job before any tag is placed: every
    // segment a text-only target. The paragraphs keep their fonts, and
    // Word gets markup it can open.
    for (const { name, assembled } of corpus) {
      const file: ProjectFile = {
        id: 1,
        relPath: name,
        originalBlob: assembled.originalBlob,
        skeleton: assembled.skeleton,
        partMap: assembled.partMap,
        importedAt: '2026-09-27T00:00:00.000Z',
      };
      const translated = assembled.segments.map((s, i): Segment => ({
        id: i + 1,
        fileId: 1,
        ...s,
        targetTokens: s.locked
          ? null
          : carryHiddenTags(
              [{ t: 'text', v: plainText(s.sourceTokens).toUpperCase() }],
              s.sourceTokens,
              s.formatTable,
            ),
        status: s.locked ? s.status : 'translated',
        origin: null,
        updatedAt: file.importedAt,
      }));
      const { bytes } = exportProjectFile(file, translated);
      const doc = importDocx(bytes);
      for (const skeleton of doc.skeletons) {
        for (const region of skeleton.regions) {
          expect(nestingErrors(region.xml), `${name} :: ${region.key}`).toEqual([]);
        }
      }
      const before = translatableSegments(importDocx(assembled.originalBlob));
      expect(translatableSegments(doc).length, name).toBe(before.length);
    }
  });
});

/** What a reader sees of a run's properties: font, size, raise. */
const looks = (open: string): string =>
  ['rFonts', 'sz', 'position']
    .map((p) => new RegExp(`<w:${p}\\b[^>]*>`).exec(open)?.[0] ?? '')
    .join('');

/** Case swapped where that keeps one character one character. */
const swapCase = (v: string): string =>
  [...v]
    .map((c) => {
      const swapped = c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase();
      return [...swapped].length === 1 ? swapped : c;
    })
    .join('');

/** Non-space characters of the corpus's unlocked segments. */
const RETYPED_CHARS = 270_571;
/**
 * Those whose font, size or raise comes out other than the source's:
 * letters in a run the dominant one outvoted, which retyping never keeps
 * verbatim — all in two segments of one fixture, a size 12 against the
 * paragraph's other size, and an East Asian font hint on Latin text.
 * Pinned, so a change to the rule that costs more is a number to explain.
 */
const LOOKS_DIFFERENT = 45;

/** Whether each container's plain source text had a single formatting. */
function isUniform(tokens: readonly Token[], formats: readonly FormatEntry[]): boolean {
  const byId = new Map(formats.map((f) => [f.id, f]));
  const stack: FormatEntry[] = [];
  const seen = new Map<number, string>();
  for (const token of tokens) {
    if (token.t === 'open') stack.push(byId.get(token.fmt)!);
    else if (token.t === 'close') stack.pop();
    else if (token.t === 'text') {
      const container = stack.findLast((f) => f.visible)?.id ?? 0;
      const run = stack.findLast((f) => f.placement === 'run');
      if (run?.visible) continue;
      const key = run?.open ?? '';
      if ((seen.get(container) ?? key) !== key) return false;
      seen.set(container, key);
    }
  }
  return true;
}
