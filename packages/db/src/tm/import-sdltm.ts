/**
 * Native Trados `.sdltm` → `.ctm` import (tm-format-spec.md §8a; backlog
 * #18b Phase 2b).
 *
 * `@cat-tool/core`'s `parseSdltm` does the format decoding; this module is
 * the one place a parsed Trados memory becomes `tu`/`tuv`/`tu_attr` rows,
 * as a single transaction so a large import never leaves the file
 * half-written — the same split, and the same guarantee, as `importTmx`.
 *
 * **The bilingual-to-multilingual step is the whole point.** One
 * `translation_units` row carries both sides of the memory's single
 * language pair; it lands here as one language-neutral `tu` with one
 * `tuv` per language. That is §7's merge story made concrete: two Trados
 * memories sharing a source language cannot be combined at all, and the
 * same two imported here are one memory with three languages in it.
 *
 * Two decisions this module is responsible for, both argued in
 * tm-format-spec.md §8a:
 *
 * 1. **Trados context is carried as provenance, never as `prev_hash`/
 *    `next_hash`.** Writing it into those columns would be a category
 *    error twice over: Trados hashes the neighbouring segment with an
 *    algorithm we have not decoded, so a value there would never equal
 *    §4's SHA-256-of-normalised-text for the same neighbour; and
 *    `translation_unit_contexts` records a *left* context only, where §5's
 *    ICE tier needs both neighbours. A foreign value in `prev_hash` is
 *    indistinguishable at read time from a real one, so the memory would
 *    claim an ICE-capability it does not have. The occurrences go into
 *    `tu_attr` under `x-sdltm-contexts` instead, intact, for the day the
 *    algorithm *is* known.
 * 2. **An imported unit whose source has no text is dropped.** Its `hash`
 *    would be the hash of the empty string, which every other empty-source
 *    unit in the memory also has — it cannot be retrieved as anything but
 *    noise.
 */

import { randomUUID } from 'node:crypto';

import {
  normalizeTokens,
  parseSdltm,
  primarySubtag,
  sdltmSegmentToTokens,
  validateTagStructure,
  type ParsedSdltm,
  type ParsedSdltmUnit,
  type SdltmSegment,
  type TmToken,
} from '@cat-tool/core';
import Database from 'better-sqlite3';

import { DEFAULT_IMPORTED_QUALITY } from './import-common.js';
import { refreshLangs } from './write.js';
import { TmError } from './errors.js';

export interface ImportSdltmResult {
  readonly tuCount: number;
  readonly tuvCount: number;
  /** Units read from the file but not written, with the reason warned. */
  readonly skippedCount: number;
  /** Context rows carried across as provenance (never as §5 context). */
  readonly contextOccurrences: number;
  readonly warnings: readonly string[];
}

/** `tu_attr` key holding the source file's own unit id. */
const ATTR_SDLTM_ID = 'x-sdltm-id';
/** `tu_attr` key holding Trados's context occurrences, verbatim. */
const ATTR_SDLTM_CONTEXTS = 'x-sdltm-contexts';

/**
 * Imports a `.sdltm` file into an already-open `.ctm` connection.
 *
 * The Trados file is opened read-only: an import must never be able to
 * write to the translator's original memory.
 */
export function importSdltm(db: Database.Database, sdltmPath: string): ImportSdltmResult {
  let sdltm: Database.Database;
  try {
    sdltm = new Database(sdltmPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    throw new TmError(
      `cannot open "${sdltmPath}" as a Trados memory: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  try {
    return importSdltmFrom(db, sdltm);
  } finally {
    sdltm.close();
  }
}

/**
 * Imports from an already-open `.sdltm` connection.
 *
 * Exported for tests and for a caller that has its own handle; {@link
 * importSdltm} is the ordinary entry point.
 */
export function importSdltmFrom(
  db: Database.Database,
  sdltm: Database.Database,
): ImportSdltmResult {
  return writeParsedSdltm(db, parseSdltm(sdltm));
}

function writeParsedSdltm(db: Database.Database, parsed: ParsedSdltm): ImportSdltmResult {
  const warnings = [...parsed.warnings];

  if (primarySubtag(parsed.sourceLang) === primarySubtag(parsed.targetLang)) {
    throw new TmError(
      `Trados memory declares the same language on both sides ` +
        `("${parsed.sourceLang}" / "${parsed.targetLang}") — a .ctm unit holds one ` +
        `variant per language (tm-format-spec.md §2.3), so there is no pair to import`,
    );
  }

  const insertTu = db.prepare(
    `INSERT INTO tu (uuid, rev, created_at, updated_at, created_by)
     VALUES (@uuid, 1, @created_at, @updated_at, @created_by)`,
  );
  const insertTuAttr = db.prepare(
    'INSERT OR IGNORE INTO tu_attr (tu_id, key, value) VALUES (?, ?, ?)',
  );
  const insertTuv = db.prepare(
    `INSERT INTO tuv
       (tu_id, lang, rev, tokens, plain, hash, prev_hash, next_hash,
        quality, usage_count, last_used_at, created_at, updated_at, updated_by)
     VALUES
       (@tu_id, @lang, 1, @tokens, @plain, @hash, NULL, NULL,
        @quality, @usage_count, @last_used_at, @created_at, @updated_at, @updated_by)`,
  );

  const tally = new Tally();
  let tuCount = 0;
  let tuvCount = 0;
  let skippedCount = 0;
  let contextOccurrences = 0;
  let taggedUnits = 0;
  let hiddenTags = 0;

  const run = db.transaction(() => {
    const now = new Date().toISOString();

    for (const unit of parsed.units) {
      const source = toTokens(unit.sourceSegment, unit.sourceLang, tally);
      const target = toTokens(unit.targetSegment, unit.targetLang, tally);

      const sourceNorm = normalizeTokens(source.tokens);
      if (sourceNorm.plain === '') {
        tally.add('empty-source');
        skippedCount++;
        continue;
      }
      const targetNorm = normalizeTokens(target.tokens);
      if (targetNorm.plain === '') tally.add('empty-target');

      const createdAt = unit.createdAt ?? now;
      const updatedAt = unit.updatedAt ?? createdAt;
      const updatedBy = unit.updatedBy ?? unit.createdBy ?? null;

      const tuId = insertTu.run({
        uuid: randomUUID(),
        created_at: createdAt,
        updated_at: updatedAt,
        created_by: unit.createdBy ?? null,
      }).lastInsertRowid as number;
      tuCount++;

      insertTuAttr.run(tuId, ATTR_SDLTM_ID, String(unit.id));
      writeAttributes(insertTuAttr, tuId, unit, tally);
      if (unit.contexts.length > 0) {
        contextOccurrences += unit.contexts.length;
        insertTuAttr.run(
          tuId,
          ATTR_SDLTM_CONTEXTS,
          JSON.stringify(
            unit.contexts.map((c) => ({
              s: c.leftSourceContext,
              t: c.leftTargetContext,
            })),
          ),
        );
      }

      for (const side of [
        { lang: unit.sourceLang, tokens: source.tokens, norm: sourceNorm },
        { lang: unit.targetLang, tokens: target.tokens, norm: targetNorm },
      ]) {
        insertTuv.run({
          tu_id: tuId,
          lang: side.lang,
          tokens: JSON.stringify(side.tokens),
          plain: side.norm.plain,
          hash: side.norm.hash,
          quality: DEFAULT_IMPORTED_QUALITY,
          usage_count: unit.usageCount ?? 0,
          last_used_at: unit.lastUsedAt ?? null,
          created_at: createdAt,
          updated_at: updatedAt,
          updated_by: updatedBy,
        });
        tuvCount++;
        if (side.tokens.some((t) => t.t !== 'text')) taggedUnits++;
      }
      hiddenTags += source.hidden + target.hidden;
    }

    refreshLangs(db);
  });
  run();

  tally.report(warnings);
  summarise(warnings, {
    parsed,
    tuCount,
    contextOccurrences,
    taggedUnits,
    hiddenTags,
  });

  return { tuCount, tuvCount, skippedCount, contextOccurrences, warnings };
}

/**
 * Maps one native segment to TM tokens, degrading to text-only if the
 * result is not structurally valid.
 *
 * `.ctm` must never be handed a token stream with a crossed or unclosed
 * pair — `validateTagStructure` is the same check a target segment faces
 * in the editor, and a stored variant that fails it is a match that can
 * never be placed. Dropping the tags costs nothing that matching depends
 * on: §4 discards tags before hashing, so `plain`/`hash` are identical
 * either way.
 */
function toTokens(
  segment: SdltmSegment,
  lang: string,
  tally: Tally,
): { tokens: TmToken[]; hidden: number } {
  const hidden = segment.tags.filter((t) => t.canHide).length;
  if (segment.culture !== '' && primarySubtag(segment.culture) !== primarySubtag(lang)) {
    tally.add(`culture-mismatch:${segment.culture} vs ${lang}`);
  }

  const tokens = sdltmSegmentToTokens(segment);
  const structure = validateTagStructure(tokens);
  if (structure.ok) return { tokens, hidden };

  tally.add(`tag-structure:${structure.errors[0]?.code ?? 'invalid'}`);
  return { tokens: tokens.filter((t) => t.t === 'text'), hidden };
}

function writeAttributes(
  insertTuAttr: Database.Statement,
  tuId: number,
  unit: ParsedSdltmUnit,
  tally: Tally,
): void {
  const seen = new Set<string>();
  for (const attr of unit.attributes ?? []) {
    // `tu_attr` is one row per (tu_id, key) — the same collapse TMX's
    // repeated <prop> hits (backlog #18). Reported by cause, once.
    if (seen.has(attr.key)) {
      tally.add(`repeated-attribute:${attr.key}`);
      continue;
    }
    seen.add(attr.key);
    insertTuAttr.run(tuId, attr.key, attr.value);
  }
}

/**
 * Counts problems by cause during the write pass and reports one line per
 * cause afterwards — never one per occurrence (CLAUDE.md; backlog #18's
 * 4,615-line import report).
 */
class Tally {
  private readonly counts = new Map<string, number>();

  add(cause: string): void {
    this.counts.set(cause, (this.counts.get(cause) ?? 0) + 1);
  }

  report(warnings: string[]): void {
    for (const [cause, n] of [...this.counts].sort((a, b) => b[1] - a[1])) {
      warnings.push(line(cause, n));
    }
  }
}

function line(cause: string, n: number): string {
  const [kind, detail = ''] = splitOnce(cause, ':');
  switch (kind) {
    case 'empty-source':
      return `${n} unit(s) have no source text — skipped (an empty hash matches nothing useful)`;
    case 'empty-target':
      return `${n} unit(s) have an empty target — imported, but they can only ever match as blanks`;
    case 'tag-structure':
      return (
        `${n} segment(s) produced an invalid tag structure (${detail}) — imported as ` +
        `text only, tags dropped; plain/hash are unaffected (tm-format-spec.md §4)`
      );
    case 'culture-mismatch':
      return (
        `${n} segment(s) declare a <CultureName> that disagrees with the memory's own ` +
        `language pair (${detail}) — the memory's pair was used`
      );
    case 'repeated-attribute':
      return (
        `${n} unit(s) repeat the Trados attribute "${detail}"; tu_attr holds one value ` +
        `per key, so the first was kept (tm-format-spec.md §2.4)`
      );
    default:
      return `${n} occurrence(s) of: ${cause}`;
  }
}

function splitOnce(value: string, sep: string): [string, string?] {
  const at = value.indexOf(sep);
  return at === -1 ? [value] : [value.slice(0, at), value.slice(at + sep.length)];
}

function summarise(
  warnings: string[],
  facts: {
    parsed: ParsedSdltm;
    tuCount: number;
    contextOccurrences: number;
    taggedUnits: number;
    hiddenTags: number;
  },
): void {
  const { parsed, tuCount } = facts;

  // The file's own tucount against what was actually read: the cheapest
  // check there is that this reader understood the schema it was handed,
  // and the one most likely to catch a Studio version it has not seen.
  const declared = parsed.declaredUnitCount;
  if (declared !== undefined && declared !== parsed.units.length) {
    warnings.push(
      `translation_memories.tucount says ${declared} unit(s) but ${parsed.units.length} ` +
        `were read — this reader's schema was observed on Studio ` +
        `${parsed.version ?? '8.06'} and may not match this file (backlog #18b)`,
    );
  }

  if (facts.contextOccurrences > 0) {
    warnings.push(
      `${facts.contextOccurrences} Trados context occurrence(s) carried into ` +
        `tu_attr["${ATTR_SDLTM_CONTEXTS}"] as provenance, not as prev_hash/next_hash: ` +
        `Trados hashes a neighbour differently from tm-format-spec.md §4 and records a ` +
        `left context only, so these cannot make an ICE match (§5) until that algorithm ` +
        `is known. No .sdltm-sourced unit is ICE-capable.`,
    );
  } else if (tuCount > 0) {
    warnings.push(
      'no context rows in this memory — its units carry no prev_hash/next_hash and can ' +
        'never be ICE matches (tm-format-spec.md §5).',
    );
  }

  if (facts.hiddenTags > 0) {
    warnings.push(
      `${facts.hiddenTags} tag(s) marked CanHide were left out of the token stream — ` +
        `the receiving document re-emits its own invisible tags (tm-format-spec.md §8a).`,
    );
  }

  if (facts.taggedUnits > 0) {
    warnings.push(
      `${facts.taggedUnits} imported variant(s) carry tags with no kind hint — .sdltm ` +
        `records no tag kind, so a match on one takes v1-spec.md §6.1's tm_exact_tagdiff ` +
        `path (text placed, tags dropped, flagged) rather than a full tagged placement.`,
    );
  }
}
