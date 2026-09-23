/**
 * Native Trados Studio `.sdltm` parsing (tm-format-spec.md §8a; backlog #18b).
 *
 * `.sdltm` files are SQLite databases holding a translation memory in
 * Trados Studio's native format. Unlike TMX — an interchange format that
 * has already lost things on the way out — the native file carries:
 * - `CanHide` on every tag (the only tag-visibility signal any import
 *   path this product has ever had; TMX's `bpt`/`ept` has no equivalent)
 * - per-occurrence context rows (`translation_unit_contexts`)
 * - Trados's own custom-field metadata (`attributes`/`string_attributes`)
 *
 * This module is the pure-parsing half: it reads the native schema and
 * produces {@link ParsedSdltm}, which `db/tm/import-sdltm.ts` turns into
 * `tu`/`tuv`/`tu_attr` rows. Per CLAUDE.md's headless rule it takes an
 * already-open Database handle, never a path — the db layer owns file I/O.
 *
 * **The schema is reverse-engineered from one real Trados memory** (Studio
 * `parameters.VERSION = 8.06`), not from published documentation, so every
 * read here is written to survive a file that differs: the unit columns
 * are discovered via `PRAGMA table_info` rather than assumed, a missing
 * side table degrades to a warning rather than an exception, and a tag
 * `<Type>` this format was never observed to use is carried as a
 * placeholder rather than silently dropped. Validating that against a
 * second real file (ideally a different Studio version and language pair)
 * is the open half of backlog #18b.
 */

import type { TmToken } from '../model/token.js';

export class SdltmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SdltmError';
  }
}

/**
 * `<Type>` on a native `<Tag>`. `Start`/`End` are the only two values the
 * sample file used; anything else is normalised to `Standalone` and
 * reported, so an unobserved Studio tag type becomes a placeholder we can
 * see rather than content that vanishes.
 */
export type SdltmTagType = 'Start' | 'End' | 'Standalone';

export interface SdltmSegmentTag {
  readonly type: SdltmTagType;
  /** `<Type>` exactly as the file spelled it, for reporting. */
  readonly rawType: string;
  /** Pairs a `Start` with its `End`. `null` on a standalone tag. */
  readonly anchor: number | null;
  readonly tagId: number | null;
  readonly canHide: boolean;
}

export interface SdltmSegmentText {
  readonly value: string;
}

/**
 * One `<Elements>` child, **in document order**.
 *
 * The ordered list is the segment's real content; {@link SdltmSegment}'s
 * `tags`/`texts` are projections of it. Keeping tags and texts only as two
 * separate arrays loses the interleaving — `<Tag>Page </Tag>` and
 * `Page <Tag></Tag>` reduce to the same pair of arrays — which is exactly
 * the information a token stream is.
 */
export type SdltmSegmentElement =
  | { readonly kind: 'text'; readonly text: SdltmSegmentText }
  | { readonly kind: 'tag'; readonly tag: SdltmSegmentTag };

export interface SdltmSegment {
  /** Tags and texts interleaved, in document order. */
  readonly elements: readonly SdltmSegmentElement[];
  /** Every tag in `elements`, in order. A projection, not the content. */
  readonly tags: readonly SdltmSegmentTag[];
  /** Every text run in `elements`, in order. A projection, not the content. */
  readonly texts: readonly SdltmSegmentText[];
  readonly culture: string;
}

/**
 * One occurrence of a translation unit in a document — a row from
 * `translation_unit_contexts`.
 *
 * These are Trados's own hashes of the preceding segment, computed by an
 * algorithm this project does not know, and there is a *left* context only.
 * They are therefore provenance, not §5 context — see `import-sdltm.ts`,
 * which is where that decision is enforced and explained.
 */
export interface SdltmContextOccurrence {
  readonly leftSourceContext: string | null;
  readonly leftTargetContext: string | null;
}

/**
 * A parsed translation unit. `.sdltm` is bilingual (tm-format-spec.md §8a):
 * one row holds both sides of the memory's single language pair, where
 * `.ctm` has a language-neutral `tu` with one `tuv` per language.
 */
export interface ParsedSdltmUnit {
  /** `translation_units.id` — this unit's identity *in the source file*. */
  readonly id: number;
  readonly sourceSegment: SdltmSegment;
  readonly targetSegment: SdltmSegment;
  readonly sourceLang: string;
  readonly targetLang: string;
  /** Per-occurrence context; a segment used in many places has many rows. */
  readonly contexts: readonly SdltmContextOccurrence[];
  readonly usageCount?: number;
  readonly lastUsedAt?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly createdBy?: string;
  readonly updatedBy?: string;
  readonly attributes?: readonly { key: string; value: string }[];
}

export interface ParsedSdltm {
  readonly sourceLang: string;
  readonly targetLang: string;
  /** `translation_memories.name`, when the file has one. */
  readonly name?: string;
  /** `parameters.VERSION` — Trados's own schema version string. */
  readonly version?: string;
  /**
   * `translation_memories.tucount`, the file's *own* claim about how many
   * units it holds. Kept separate from `units.length` on purpose: the
   * importer compares the two, and a disagreement is the single cheapest
   * signal that this reader has misread the schema.
   */
  readonly declaredUnitCount?: number;
  readonly units: readonly ParsedSdltmUnit[];
  readonly warnings: readonly string[];
}

/**
 * Tallies repeated problems by cause so a report stays readable.
 *
 * A warning that fires once per occurrence rather than once per cause is a
 * bug even when it is individually correct — backlog #18's TMX importer
 * produced 4,615 near-identical lines on one real file before this lesson
 * was learned, and a 20k-unit `.sdltm` is exactly the same shape of input.
 */
class WarningTally {
  private readonly counts = new Map<string, number>();

  add(cause: string): void {
    this.counts.set(cause, (this.counts.get(cause) ?? 0) + 1);
  }

  /** One line per distinct cause, most frequent first. */
  drainInto(warnings: string[], line: (cause: string, count: number) => string): void {
    const entries = [...this.counts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [cause, count] of entries) warnings.push(line(cause, count));
    this.counts.clear();
  }
}

/**
 * Parses one native `<Segment>` XML fragment.
 *
 * ```xml
 * <Segment>
 *   <Elements>
 *     <Tag><Type>Start</Type><Anchor>1</Anchor><TagID>52</TagID><CanHide>true</CanHide></Tag>
 *     <Text><Value>Page </Value></Text>
 *     <Tag><Type>End</Type><Anchor>1</Anchor><TagID>52</TagID><CanHide>true</CanHide></Tag>
 *   </Elements>
 *   <CultureName>en-US</CultureName>
 * </Segment>
 * ```
 *
 * Deliberately a scanner rather than a full XML parse: this is Trados's
 * own stored output, not arbitrary third-party XML, and the shape is flat.
 */
export function parseSdltmSegment(xml: string): SdltmSegment {
  const segmentMatch = xml.match(/<Segment[^>]*>([\s\S]*)<\/Segment>/);
  if (!segmentMatch) {
    throw new SdltmError('segment XML has no <Segment> root element');
  }
  const content = segmentMatch[1]!;

  const cultureMatch = content.match(/<CultureName>([^<]*)<\/CultureName>/);
  const culture = cultureMatch ? cultureMatch[1]!.trim() : '';

  const elementsMatch = content.match(/<Elements>([\s\S]*?)<\/Elements>/);
  if (!elementsMatch) {
    // An empty segment is legitimate (Trados stores empty targets); an
    // absent <Elements> block in a non-empty segment is not.
    if (/<Elements\s*\/>/.test(content)) {
      return { elements: [], tags: [], texts: [], culture };
    }
    throw new SdltmError('segment XML has no <Elements> block');
  }

  const elements: SdltmSegmentElement[] = [];
  const tags: SdltmSegmentTag[] = [];
  const texts: SdltmSegmentText[] = [];

  const elementRegex = /<(Tag|Text)>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = elementRegex.exec(elementsMatch[1]!)) !== null) {
    const inner = match[2]!;

    if (match[1] === 'Tag') {
      const rawType = inner.match(/<Type>([^<]*)<\/Type>/)?.[1]?.trim() ?? '';
      const anchor = intOrNull(inner.match(/<Anchor>(-?\d+)<\/Anchor>/)?.[1]);
      const tagId = intOrNull(inner.match(/<TagID>(-?\d+)<\/TagID>/)?.[1]);
      const canHide =
        inner
          .match(/<CanHide>([^<]*)<\/CanHide>/)?.[1]
          ?.trim()
          .toLowerCase() === 'true';
      // A Start/End with no <Anchor> cannot be paired, so it is a
      // standalone tag whatever it calls itself.
      const type: SdltmTagType =
        anchor !== null && (rawType === 'Start' || rawType === 'End')
          ? rawType
          : 'Standalone';
      const tag: SdltmSegmentTag = { type, rawType, anchor, tagId, canHide };
      tags.push(tag);
      elements.push({ kind: 'tag', tag });
      continue;
    }

    const value = inner.match(/<Value>([\s\S]*?)<\/Value>/)?.[1];
    if (value === undefined) continue;
    const text: SdltmSegmentText = { value: decodeXmlEntities(value) };
    texts.push(text);
    elements.push({ kind: 'text', text });
  }

  return { elements, tags, texts, culture };
}

function intOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Decodes the five predefined XML entities plus numeric character
 * references. `&amp;` is resolved last, so `&amp;lt;` decodes to the text
 * `&lt;` rather than to `<`.
 */
function decodeXmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (whole, hex: string) => codePoint(whole, hex, 16))
    .replace(/&#(\d+);/g, (whole, dec: string) => codePoint(whole, dec, 10))
    .replace(/&amp;/g, '&');
}

function codePoint(whole: string, digits: string, radix: number): string {
  const n = Number.parseInt(digits, radix);
  if (!Number.isInteger(n) || n < 0 || n > 0x10ffff) return whole;
  try {
    return String.fromCodePoint(n);
  } catch {
    return whole;
  }
}

/**
 * Maps a parsed segment onto `TmToken[]` — the form `.ctm` stores.
 *
 * Two decisions, both recorded in tm-format-spec.md §8a:
 *
 * - **A hideable tag does not enter the token stream.** `CanHide: true` is
 *   Trados's own statement that the translator never places this tag, the
 *   same fact `FormatEntry.visible === false` records on our side; a
 *   receiving document re-emits its own invisible tags automatically, so
 *   carrying the origin file's would add placement obligations that
 *   correspond to nothing. A pair is kept only if *both* its `Start` and
 *   its `End` are visible, so dropping can never unbalance a pair.
 * - **No `k` hint is emitted, because `.sdltm` carries no tag kind.** A
 *   `<TagID>` is a document-local Trados id, not a structural kind, and
 *   `TmToken.k` exists to be matched against the receiving segment's own
 *   tags. Guessing one would be exactly the invented correspondence
 *   `remapTmTokens` refuses to make. The consequence is deliberate and
 *   worth knowing: a `.sdltm`-sourced match that has tags takes
 *   `v1-spec.md` §6.1's `tm_exact_tagdiff` path (target text, tags
 *   dropped, flagged for review) rather than a full tagged placement.
 *   Text-only units — the large majority of a real memory — are unaffected.
 */
export function sdltmSegmentToTokens(segment: SdltmSegment): TmToken[] {
  // Pass 1: an anchor survives only as a complete, wholly visible pair.
  const seen = new Map<number, { start: boolean; end: boolean; hideable: boolean }>();
  for (const element of segment.elements) {
    if (element.kind !== 'tag') continue;
    const { anchor, type, canHide } = element.tag;
    if (anchor === null) continue;
    const state = seen.get(anchor) ?? { start: false, end: false, hideable: false };
    if (type === 'Start') state.start = true;
    if (type === 'End') state.end = true;
    state.hideable ||= canHide;
    seen.set(anchor, state);
  }
  const keep = new Set<number>();
  for (const [anchor, state] of seen) {
    if (state.start && state.end && !state.hideable) keep.add(anchor);
  }

  // Pass 2: emit in document order, renumbering ids from 1 the way
  // `toTmTokens` does — a TM token id is positional, never the origin
  // file's.
  const tokens: TmToken[] = [];
  const idByAnchor = new Map<number, number>();
  let nextId = 1;

  for (const element of segment.elements) {
    if (element.kind === 'text') {
      if (element.text.value.length > 0)
        tokens.push({ t: 'text', v: element.text.value });
      continue;
    }
    const { type, anchor, canHide } = element.tag;
    if (canHide) continue;
    if (type === 'Standalone') {
      tokens.push({ t: 'ph', id: nextId++ });
      continue;
    }
    if (anchor === null || !keep.has(anchor)) continue;
    if (type === 'Start') {
      const id = nextId++;
      idByAnchor.set(anchor, id);
      tokens.push({ t: 'open', id });
    } else {
      const id = idByAnchor.get(anchor);
      if (id !== undefined) tokens.push({ t: 'close', id });
    }
  }

  return tokens;
}

/**
 * Converts a `.sdltm` timestamp to ISO-8601 UTC, or `undefined` if it is
 * absent or in a shape this reader does not recognise.
 *
 * Trados stores these as TEXT and the sample file used a space-separated
 * `YYYY-MM-DD HH:MM:SS`; a bare date and a genuine ISO string are both
 * accepted too, since only one file has ever been seen. A space-separated
 * stamp is read as **UTC**, not local time — `new Date('2026-09-15
 * 10:00:00')` is local-time in Node, which would silently shift every
 * timestamp in an imported memory by the importing machine's offset.
 * Sub-second precision is kept to milliseconds, the most an ISO-8601
 * stamp in this format carries.
 */
export function sdltmDateToIso(date: string | null | undefined): string | undefined {
  if (date === null || date === undefined) return undefined;
  const raw = date.trim();
  if (raw === '') return undefined;

  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(\.\d+)?)?Z?$/.exec(raw);
  if (m) {
    const [, y, mo, d, h = '00', mi = '00', s = '00', fraction] = m;
    const ms = (fraction ?? '.').slice(1).padEnd(3, '0').slice(0, 3);
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`;
    return Number.isNaN(Date.parse(iso)) ? undefined : iso;
  }

  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

/** Trados's `application_id`, observed on the sample file. */
const SDLTM_APPLICATION_ID = 1112754007;

/** The three unit columns this reader cannot do without. */
const REQUIRED_UNIT_COLUMNS = ['id', 'source_segment', 'target_segment'] as const;

/** Unit columns read when present; absent ones simply go unmapped. */
const OPTIONAL_UNIT_COLUMNS = [
  'usage_counter',
  'last_used_date',
  'creation_date',
  'change_date',
  'creation_user',
  'change_user',
  'tm_id',
] as const;

/* eslint-disable @typescript-eslint/no-explicit-any */
/** An open `better-sqlite3` handle, typed structurally so `core` needs no
 *  dependency on it (CLAUDE.md: `@cat-tool/core` stays headless). */
type SqliteLike = {
  prepare(sql: string): {
    get(...params: any[]): any;
    all(...params: any[]): any[];
  };
};
/* eslint-enable @typescript-eslint/no-explicit-any */

function tableExists(db: SqliteLike, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { present: number } | undefined;
  return row !== undefined;
}

function columnsOf(db: SqliteLike, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/**
 * Reads an entire native `.sdltm` memory.
 *
 * Takes an open Database handle rather than a path so `core` stays free of
 * `better-sqlite3` and file I/O; `db/tm/import-sdltm.ts` opens the file.
 *
 * Throws {@link SdltmError} on anything that makes the file not a readable
 * `.sdltm` (wrong `application_id`, no memory row, no language pair, no
 * `translation_units` table). Everything survivable — a unit whose segment
 * XML will not parse, a missing side table, an unrecognised tag type — is
 * a warning instead, tallied by cause rather than emitted per occurrence.
 */
export function parseSdltm(db: SqliteLike): ParsedSdltm {
  const appId = db.prepare('PRAGMA application_id;').get() as
    { application_id: number } | undefined;
  if (!appId || appId.application_id !== SDLTM_APPLICATION_ID) {
    throw new SdltmError(
      `not a Trados .sdltm file: application_id is ` +
        `${appId?.application_id ?? 'unreadable'}, expected ${SDLTM_APPLICATION_ID}`,
    );
  }

  const warnings: string[] = [];

  if (!tableExists(db, 'translation_memories')) {
    throw new SdltmError('no translation_memories table — not a Trados memory');
  }
  if (!tableExists(db, 'translation_units')) {
    throw new SdltmError('no translation_units table — not a Trados memory');
  }

  const memoryColumns = columnsOf(db, 'translation_memories');
  const memories = db
    .prepare(
      `SELECT id, source_language, target_language` +
        `${memoryColumns.has('tucount') ? ', tucount' : ''}` +
        `${memoryColumns.has('name') ? ', name' : ''} ` +
        `FROM translation_memories ORDER BY id`,
    )
    .all() as Array<{
    id: number;
    source_language: string | null;
    target_language: string | null;
    tucount?: number | null;
    name?: string | null;
  }>;

  const memory = memories[0];
  if (!memory) throw new SdltmError('translation_memories is empty — no memory to read');
  if (memories.length > 1) {
    warnings.push(
      `file holds ${memories.length} memories; importing only "${memory.name ?? memory.id}" ` +
        `(a .sdltm was only ever observed to hold one — see tm-format-spec.md §8a)`,
    );
  }

  const sourceLang = memory.source_language ?? '';
  const targetLang = memory.target_language ?? '';
  if (!sourceLang || !targetLang) {
    throw new SdltmError(
      `memory "${memory.name ?? memory.id}" has no language pair ` +
        `(source_language=${JSON.stringify(memory.source_language)}, ` +
        `target_language=${JSON.stringify(memory.target_language)})`,
    );
  }

  const version = readVersion(db);
  const unitColumns = columnsOf(db, 'translation_units');
  const missing = REQUIRED_UNIT_COLUMNS.filter((c) => !unitColumns.has(c));
  if (missing.length > 0) {
    throw new SdltmError(
      `translation_units is missing required column(s) ${missing.join(', ')} — this ` +
        `reader's schema was observed on Studio 8.06 and may not match this file`,
    );
  }
  const optional = OPTIONAL_UNIT_COLUMNS.filter((c) => unitColumns.has(c));
  for (const column of OPTIONAL_UNIT_COLUMNS) {
    if (column === 'tm_id') continue;
    if (!unitColumns.has(column)) {
      warnings.push(
        `translation_units has no "${column}" column — that metadata is not imported`,
      );
    }
  }

  const scoped = memories.length > 1 && unitColumns.has('tm_id');
  const unitRows = db
    .prepare(
      `SELECT ${[...REQUIRED_UNIT_COLUMNS, ...optional].join(', ')} FROM translation_units` +
        `${scoped ? ' WHERE tm_id = ?' : ''} ORDER BY id`,
    )
    .all(...(scoped ? [memory.id] : [])) as Array<Record<string, unknown>>;

  const contexts = readContexts(db, warnings);
  const attributes = readAttributes(db, warnings);

  const unparseable = new WarningTally();
  const oddTagTypes = new WarningTally();
  const badDates = new WarningTally();
  const units: ParsedSdltmUnit[] = [];

  for (const row of unitRows) {
    const id = Number(row['id']);
    let sourceSegment: SdltmSegment;
    let targetSegment: SdltmSegment;
    try {
      sourceSegment = parseSdltmSegment(String(row['source_segment'] ?? ''));
      targetSegment = parseSdltmSegment(String(row['target_segment'] ?? ''));
    } catch (err) {
      unparseable.add(err instanceof Error ? err.message : String(err));
      continue;
    }

    for (const segment of [sourceSegment, targetSegment]) {
      for (const tag of segment.tags) {
        if (tag.type === 'Standalone' && tag.rawType !== 'Standalone') {
          oddTagTypes.add(tag.rawType === '' ? '(no <Type>)' : tag.rawType);
        }
      }
    }

    units.push({
      id,
      sourceSegment,
      targetSegment,
      sourceLang,
      targetLang,
      contexts: contexts.get(id) ?? [],
      usageCount: intOrUndefined(row['usage_counter']),
      lastUsedAt: date(row['last_used_date'], 'last_used_date', badDates),
      createdAt: date(row['creation_date'], 'creation_date', badDates),
      updatedAt: date(row['change_date'], 'change_date', badDates),
      createdBy: textOrUndefined(row['creation_user']),
      updatedBy: textOrUndefined(row['change_user']),
      attributes: attributes.get(id),
    });
  }

  unparseable.drainInto(
    warnings,
    (cause, n) => `${n} unit(s) skipped — segment XML would not parse: ${cause}`,
  );
  oddTagTypes.drainInto(
    warnings,
    (type, n) =>
      `${n} tag(s) use <Type>${type}</Type>, which this reader has never seen — ` +
      `carried as a placeholder rather than dropped (tm-format-spec.md §8a)`,
  );
  badDates.drainInto(
    warnings,
    (column, n) => `${n} unit(s) have an unreadable ${column} — left unset`,
  );

  return {
    sourceLang,
    targetLang,
    name: memory.name ?? undefined,
    version,
    declaredUnitCount: memory.tucount ?? undefined,
    units,
    warnings,
  };
}

function readVersion(db: SqliteLike): string | undefined {
  if (!tableExists(db, 'parameters')) return undefined;
  const row = db.prepare("SELECT value FROM parameters WHERE name = 'VERSION'").get() as
    { value: string | null } | undefined;
  return row?.value ?? undefined;
}

function readContexts(
  db: SqliteLike,
  warnings: string[],
): Map<number, SdltmContextOccurrence[]> {
  const byUnit = new Map<number, SdltmContextOccurrence[]>();
  if (!tableExists(db, 'translation_unit_contexts')) {
    warnings.push(
      'no translation_unit_contexts table — this memory carries no context provenance',
    );
    return byUnit;
  }
  // One query, not one per unit: the sample file has 25,563 context rows
  // across 20,684 units, and a prepare-per-unit loop is 20k prepares.
  // Ordered by `id` when there is one rather than by `rowid`, which a
  // WITHOUT ROWID table would not have at all.
  const order = columnsOf(db, 'translation_unit_contexts').has('id')
    ? ' ORDER BY id'
    : '';
  // `CAST(... AS TEXT)` is load-bearing, not tidying. Trados stores these
  // as **signed 64-bit integers** — a real 2013 client memory carries
  // -8331597179047842233 — and no JavaScript number can hold one exactly.
  // Read as a number, `better-sqlite3` returns -8331597179047842000 with no
  // error at all, while Node's own `node:sqlite` throws ERR_OUT_OF_RANGE on
  // the same value: silent corruption on one driver, a crash on the other.
  // SQLite renders the integer to text itself, so the digits never pass
  // through a double, and the answer no longer depends on which driver or
  // which Node version is underneath.
  //
  // This matters precisely because these values are carried as provenance
  // (`db/tm/import-sdltm.ts`, `x-sdltm-contexts`): the whole argument for
  // not writing them into `prev_hash` is that nothing is lost if Trados's
  // hash algorithm is ever recovered. Truncated, they would be lost.
  const rows = db
    .prepare(
      'SELECT translation_unit_id, ' +
        'CAST(left_source_context AS TEXT) AS left_source_context, ' +
        'CAST(left_target_context AS TEXT) AS left_target_context ' +
        `FROM translation_unit_contexts${order}`,
    )
    .all() as Array<{
    translation_unit_id: number;
    left_source_context: string | null;
    left_target_context: string | null;
  }>;
  for (const row of rows) {
    const list = byUnit.get(row.translation_unit_id);
    const occurrence: SdltmContextOccurrence = {
      leftSourceContext: textOrNull(row.left_source_context),
      leftTargetContext: textOrNull(row.left_target_context),
    };
    if (list) list.push(occurrence);
    else byUnit.set(row.translation_unit_id, [occurrence]);
  }
  return byUnit;
}

function readAttributes(
  db: SqliteLike,
  warnings: string[],
): Map<number, { key: string; value: string }[]> {
  const byUnit = new Map<number, { key: string; value: string }[]>();
  if (!tableExists(db, 'attributes') || !tableExists(db, 'string_attributes')) {
    warnings.push(
      'no attributes/string_attributes tables — Trados custom fields are not imported',
    );
    return byUnit;
  }
  const order = columnsOf(db, 'string_attributes').has('id') ? ' ORDER BY sa.id' : '';
  const rows = db
    .prepare(
      'SELECT sa.translation_unit_id AS unit_id, a.name AS name, sa.value AS value ' +
        'FROM string_attributes sa JOIN attributes a ON a.id = sa.attribute_id' +
        order,
    )
    .all() as Array<{ unit_id: number; name: string | null; value: string | null }>;
  for (const row of rows) {
    if (!row.name || row.value === null || row.value === '') continue;
    const entry = { key: row.name, value: row.value };
    const list = byUnit.get(row.unit_id);
    if (list) list.push(entry);
    else byUnit.set(row.unit_id, [entry]);
  }
  return byUnit;
}

function intOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  // `isSafeInteger`, not `isInteger`: a 64-bit value past 2^53 arrives here
  // already rounded, and `Number.isInteger` cheerfully accepts the rounded
  // result. Returning undefined leaves the field unset rather than setting
  // it to a number that is quietly wrong — the same lesson the context
  // hashes above taught, in the one other place this reader converts an
  // integer.
  return Number.isSafeInteger(n) ? n : undefined;
}

function textOrUndefined(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value);
  return s === '' ? undefined : s;
}

function textOrNull(value: unknown): string | null {
  return textOrUndefined(value) ?? null;
}

function date(value: unknown, column: string, tally: WarningTally): string | undefined {
  const raw = textOrUndefined(value);
  if (raw === undefined) return undefined;
  const iso = sdltmDateToIso(raw);
  if (iso === undefined) tally.add(column);
  return iso;
}
