/**
 * TBX glossary exchange, a labelled subset (Epic 8a, issue #336,
 * `planning/smart-glossary-spec.md` §8, `planning/standards-register.md`).
 *
 * Pure: text in, import rows and refusals out (`parseTbx`), and rows in,
 * text out (`glossaryTbx`). Writing the rows into a `.ctg` is `db`'s, through
 * `importGlossaryRows`, the one write path.
 *
 * **Not conformance.** ISO 30042:2019 has not been read here, and a real TBX
 * from another tool has not been checked against this code, so the dialect
 * below is what this module reads and writes, not what the standard says. A
 * file a stricter reader accepts may be refused here, and one written here may
 * need a fix once the standard and a real file are in hand (both are the open
 * checks on #336). Nothing in the product calls it TBX-compliant.
 *
 * The subset, in the common TBX-Basic shape:
 * - `<martif>` › `<text>` › `<body>` › `<termEntry>` (one concept). Each
 *   `<langSet xml:lang>` holds `<tig>`s with a `<term>`; a `<termNote
 *   type="administrativeStatus">` on the `<tig>` says whether it is
 *   `preferredTerm-admn-sts`, `admittedTerm-admn-sts` or
 *   `deprecatedTerm-admn-sts` (a missing note reads as admitted).
 * - Export writes exactly that shape, from `exportGlossaryRows`' rows, which
 *   carry no decision log, notes or people: the client rule (`forClient`).
 *
 * Import maps one `termEntry` to one row: its source-language term is the
 * `term`; in each other language the preferred (else the one admitted)
 * rendering is the `rendering`, and the deprecated terms are `avoid`. Anything
 * the mapping cannot settle (two preferred terms in one language, a language
 * with only deprecated terms, a status the subset does not know) is refused
 * with its entry number, and the file is refused whole.
 */

import { type XElement, scanTree, XliffError, elementChildren } from '../xliff/scan.js';
import type { GlossaryExportRow } from './export.js';
import {
  GLOSSARY_AVOID_SEPARATOR,
  LANG_TAG,
  MAX_GLOSSARY_IMPORT_ROWS,
  type GlossaryImportRefusal,
  type GlossaryImportRow,
} from './import.js';
import { primarySubtag } from '../model/lang.js';
import { termKey } from './key.js';

/** The `administrativeStatus` values this subset reads and writes. */
export const TBX_STATUS_VALUES = {
  preferredTerm: 'preferredTerm-admn-sts',
  admittedTerm: 'admittedTerm-admn-sts',
  deprecatedTerm: 'deprecatedTerm-admn-sts',
} as const;

export interface ParsedTbx {
  /** Valid rows, one per entry; empty when `refusals` is not. */
  readonly rows: readonly GlossaryImportRow[];
  readonly refusals: readonly GlossaryImportRefusal[];
}

/** One `<tig>` of a language set, reduced to what the mapping needs. */
interface Tig {
  readonly term: string;
  readonly status: 'preferred' | 'admitted' | 'deprecated';
}

/** The text of an element, all its descendant text joined. */
function textOf(el: XElement): string {
  let out = '';
  for (const child of el.children) {
    if (child.kind === 'text') out += child.text;
    else out += textOf(child);
  }
  return out.trim();
}

/** Every descendant element named `local`, document order. */
function descendants(el: XElement, local: string): XElement[] {
  const out: XElement[] = [];
  for (const child of elementChildren(el)) {
    if (child.local === local) out.push(child);
    out.push(...descendants(child, local));
  }
  return out;
}

/** The status a `<tig>` states, or a refusal reason. */
function statusOf(tig: XElement): Tig['status'] | string {
  const note = elementChildren(tig).find(
    (c) => c.local === 'termNote' && c.attrs.get('type') === 'administrativeStatus',
  );
  if (!note) return 'admitted';
  const value = textOf(note);
  if (value === TBX_STATUS_VALUES.preferredTerm) return 'preferred';
  if (value === TBX_STATUS_VALUES.admittedTerm) return 'admitted';
  if (value === TBX_STATUS_VALUES.deprecatedTerm) return 'deprecated';
  return `status "${value}" is not one this subset reads`;
}

/**
 * Reads a TBX file of the subset above into import rows.
 *
 * `srcLang` is the language of every entry's source term; an entry with no
 * such language is refused. Never throws: a bad file is a list of refusals.
 */
export function parseTbx(text: string, srcLang: string): ParsedTbx {
  const whole = (message: string): ParsedTbx => ({
    rows: [],
    refusals: [{ line: 0, message }],
  });
  if (!LANG_TAG.test(srcLang)) return whole(`"${srcLang}" is not a language tag`);

  let root: XElement;
  try {
    root = scanTree(text.replace(/^﻿/, ''));
  } catch (err) {
    if (err instanceof XliffError) return whole(`not readable XML: ${err.message}`);
    throw err;
  }
  if (root.local !== 'martif') return whole('the root element is not martif');
  const bodies = descendants(root, 'body');
  if (bodies.length !== 1) return whole('the file needs exactly one text body');
  const entries = elementChildren(bodies[0]!).filter((e) => e.local === 'termEntry');
  if (entries.length === 0) return whole('the file has no termEntry');
  if (entries.length > MAX_GLOSSARY_IMPORT_ROWS) {
    return whole(
      `${entries.length} entries is more than one import takes (${MAX_GLOSSARY_IMPORT_ROWS})`,
    );
  }

  const rows: GlossaryImportRow[] = [];
  const refusals: GlossaryImportRefusal[] = [];
  const srcSub = primarySubtag(srcLang);

  entries.forEach((entry, index) => {
    const line = index + 1;
    const refuse = (message: string) => refusals.push({ line, message });
    const sets = elementChildren(entry).filter((e) => e.local === 'langSet');

    // Tigs per language, keyed by primary subtag, with the tag as written.
    const byLang = new Map<string, { tag: string; tigs: Tig[] }>();
    for (const set of sets) {
      const tag = set.attrs.get('xml:lang') ?? '';
      if (!LANG_TAG.test(tag)) {
        refuse(`a langSet has no valid xml:lang ("${tag}")`);
        return;
      }
      const sub = primarySubtag(tag);
      const slot = byLang.get(sub) ?? { tag, tigs: [] };
      if (byLang.has(sub)) {
        refuse(`language ${tag} appears in two langSets`);
        return;
      }
      for (const tig of descendants(set, 'tig')) {
        const termEl = elementChildren(tig).find((c) => c.local === 'term');
        const term = termEl ? textOf(termEl) : '';
        const status = statusOf(tig);
        if (term === '') {
          refuse(`a ${tag} tig has no term`);
          return;
        }
        if (typeof status === 'string' && status.startsWith('status')) {
          refuse(status);
          return;
        }
        slot.tigs.push({ term, status: status as Tig['status'] });
      }
      byLang.set(sub, slot);
    }

    const source = byLang.get(srcSub);
    if (!source) {
      refuse(`the entry has no ${srcLang} term`);
      return;
    }
    const sourcePreferred = source.tigs.filter((t) => t.status === 'preferred');
    const sourceTerm =
      sourcePreferred[0]?.term ??
      source.tigs.find((t) => t.status !== 'deprecated')?.term;
    if (!sourceTerm || sourcePreferred.length > 1) {
      refuse(`the ${srcLang} side needs one preferred term`);
      return;
    }

    for (const [sub, target] of byLang) {
      if (sub === srcSub) continue;
      const preferred = target.tigs.filter((t) => t.status === 'preferred');
      const admitted = target.tigs.filter((t) => t.status === 'admitted');
      const deprecated = target.tigs.filter((t) => t.status === 'deprecated');
      if (preferred.length > 1) {
        refuse(`${target.tag} has two preferred terms`);
        return;
      }
      const chosen = preferred[0] ?? (admitted.length === 1 ? admitted[0] : undefined);
      if (!chosen) {
        refuse(
          admitted.length > 1
            ? `${target.tag} has ${admitted.length} admitted terms and no preferred one`
            : `${target.tag} has no usable term`,
        );
        return;
      }
      const avoid: string[] = [];
      for (const d of deprecated) {
        if (termKey(d.term) === termKey(chosen.term)) continue;
        if (!avoid.some((a) => termKey(a) === termKey(d.term))) avoid.push(d.term);
      }
      if (avoid.some((a) => a.includes(GLOSSARY_AVOID_SEPARATOR))) {
        refuse(`a deprecated ${target.tag} term contains "${GLOSSARY_AVOID_SEPARATOR}"`);
        return;
      }
      rows.push({
        line,
        term: sourceTerm,
        lang: target.tag,
        rendering: chosen.term,
        status: 'official',
        avoid,
        keep: false,
      });
    }
  });

  return refusals.length > 0 ? { rows: [], refusals } : { rows, refusals: [] };
}

/** The rows of each concept, in the order the rows give them. */
function groupByConcept(
  rows: readonly GlossaryExportRow[],
): { concept: number; rows: GlossaryExportRow[] }[] {
  const groups: { concept: number; rows: GlossaryExportRow[] }[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last.concept === row.concept) last.rows.push(row);
    else groups.push({ concept: row.concept, rows: [row] });
  }
  return groups;
}

/** Escapes text for an XML element or attribute value. */
function xmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STATUS_OF_EXPORT: Readonly<Record<GlossaryExportRow['status'], string>> = {
  preferred: TBX_STATUS_VALUES.preferredTerm,
  allowed: TBX_STATUS_VALUES.admittedTerm,
  forbidden: TBX_STATUS_VALUES.deprecatedTerm,
};

/**
 * The glossary as the subset above, one `termEntry` per concept.
 *
 * Takes the rows `exportGlossaryRows` makes (a client's export has no decision
 * log, notes or people), so the file cannot carry what the CSV does not. The
 * document's language is `srcLang`, or the first row's language.
 */
export function glossaryTbx(
  rows: readonly GlossaryExportRow[],
  srcLang?: string,
): string {
  const lang = srcLang ?? rows[0]?.lang ?? 'und';
  const entries: string[] = [];
  // One termEntry per concept, one langSet per language within it, one tig per
  // rendering: a language with two renderings is one langSet, as TBX has it.
  for (const group of groupByConcept(rows)) {
    const langs = new Map<string, string[]>();
    for (const row of group.rows) {
      const tig =
        `<tig><term>${xmlText(row.term)}</term>` +
        `<termNote type="administrativeStatus">${STATUS_OF_EXPORT[row.status]}</termNote></tig>`;
      const tigs = langs.get(row.lang);
      if (tigs) tigs.push(tig);
      else langs.set(row.lang, [tig]);
    }
    const sets = [...langs].map(
      ([lang, tigs]) => `<langSet xml:lang="${xmlText(lang)}">${tigs.join('')}</langSet>`,
    );
    entries.push(`<termEntry id="c${group.concept}">${sets.join('')}</termEntry>`);
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<martif type="TBX" xml:lang="${xmlText(lang)}">\n` +
    `<martifHeader><fileDesc><sourceDesc><p>Tessera glossary export</p></sourceDesc></fileDesc></martifHeader>\n` +
    `<text><body>\n${entries.join('\n')}\n</body></text>\n` +
    `</martif>\n`
  );
}
