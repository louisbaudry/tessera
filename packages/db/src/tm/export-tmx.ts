/**
 * `.ctm` → TMX 1.4b export (tm-format-spec.md §8; backlog #21).
 *
 * `@cat-tool/core`'s `serializeTmx` does the format encoding; this module
 * is the one place `tu`/`tuv`/`tu_attr` rows actually become a
 * `TmxExportDoc` to hand it, mirroring `import-tmx.ts`'s split the other
 * direction.
 */

import {
  serializeTmx,
  type TmToken,
  type TmxExportTu,
  type TmxExportTuv,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';

export interface ExportTmxOptions {
  /**
   * Restrict the export to these languages (region-sensitive — an exact
   * `lang` match, not `primarySubtag`, since a TMX file's `xml:lang` is
   * meant to be taken literally by whatever reads it next). Omitted:
   * every language in the memory, tm-format-spec.md §8's default.
   */
  readonly langs?: readonly string[];
  /**
   * The export a client takes away (backlog #162), not the owner's: the text,
   * languages, dates and the unit's identity, and nothing about how the
   * memory was made or by whom. Drops who created or changed a unit
   * (`creationid`/`changeid`), its note, the neighbour hashes, usage counts
   * and every property outside {@link CLIENT_TMX_PROPS} (a `x-sdltm-contexts`
   * blob, an internal project label). Default false.
   */
  readonly forClient?: boolean;
}

/**
 * The `tu_attr` keys a client export keeps: the reserved descriptive ones
 * (tm-format-spec.md §2.4) that describe the content, not the shop. `project`,
 * `note` and anything user-defined stay with the owner.
 */
export const CLIENT_TMX_PROPS: ReadonlySet<string> = new Set([
  'client',
  'domain',
  'subject',
  'register',
]);

export interface ExportTmxResult {
  readonly xml: string;
  readonly tuCount: number;
  readonly tuvCount: number;
}

interface TuRow {
  id: number;
  uuid: string;
  rev: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

interface TuAttrRow {
  tu_id: number;
  key: string;
  value: string;
}

interface TuvRow {
  tu_id: number;
  lang: string;
  rev: number;
  tokens: string;
  prev_hash: string | null;
  next_hash: string | null;
  quality: number;
  usage_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

/**
 * Exports every non-tombstoned unit in a `.ctm` file to TMX 1.4b text.
 * A unit left with zero variants after `options.langs` filters them out
 * is dropped from the export entirely (tm-format-spec.md §8's
 * implementation notes) — never written as a `<tu>` with no `<tuv>`.
 */
export function exportTmx(
  db: Database.Database,
  options: ExportTmxOptions = {},
): ExportTmxResult {
  const tm = db.prepare('SELECT generator FROM tm WHERE id = 1').get() as
    { generator: string } | undefined;
  const creationTool = tm?.generator ?? 'cat-tool';

  const tus = db
    .prepare('SELECT * FROM tu WHERE deleted = 0 ORDER BY id')
    .all() as TuRow[];
  const attrsByTu = new Map<number, TuAttrRow[]>();
  for (const row of db.prepare('SELECT * FROM tu_attr').all() as TuAttrRow[]) {
    const list = attrsByTu.get(row.tu_id);
    if (list) list.push(row);
    else attrsByTu.set(row.tu_id, [row]);
  }
  const variantsByTu = new Map<number, TuvRow[]>();
  const langFilter = options.langs ? new Set(options.langs) : undefined;
  for (const row of db
    .prepare('SELECT * FROM tuv ORDER BY tu_id, lang')
    .all() as TuvRow[]) {
    if (langFilter && !langFilter.has(row.lang)) continue;
    const list = variantsByTu.get(row.tu_id);
    if (list) list.push(row);
    else variantsByTu.set(row.tu_id, [row]);
  }

  let tuCount = 0;
  let tuvCount = 0;
  const units: TmxExportTu[] = [];
  for (const tu of tus) {
    const variants = variantsByTu.get(tu.id) ?? [];
    if (variants.length === 0) continue;

    let tuid: string | undefined;
    let note: string | undefined;
    const props: { type: string; value: string }[] = [];
    for (const a of attrsByTu.get(tu.id) ?? []) {
      if (a.key === 'tuid') tuid = a.value;
      else if (a.key === 'note') note = options.forClient ? undefined : a.value;
      else if (!options.forClient || CLIENT_TMX_PROPS.has(a.key))
        props.push({ type: a.key, value: a.value });
    }

    units.push({
      uuid: tu.uuid,
      rev: tu.rev,
      createdAt: tu.created_at,
      updatedAt: tu.updated_at,
      createdBy: options.forClient ? null : tu.created_by,
      tuid,
      note,
      props,
      variants: variants.map((v) => toExportTuv(v, options.forClient === true)),
    });
    tuCount++;
    tuvCount += variants.length;
  }

  const xml = serializeTmx({ units, creationTool });
  return { xml, tuCount, tuvCount };
}

function toExportTuv(row: TuvRow, forClient: boolean): TmxExportTuv {
  if (forClient) {
    return {
      lang: row.lang,
      tokens: JSON.parse(row.tokens) as TmToken[],
      quality: row.quality,
      rev: row.rev,
      prevHash: null,
      nextHash: null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      updatedBy: null,
      usageCount: 0,
      lastUsedAt: null,
    };
  }
  return {
    lang: row.lang,
    tokens: JSON.parse(row.tokens) as TmToken[],
    quality: row.quality,
    rev: row.rev,
    prevHash: row.prev_hash,
    nextHash: row.next_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    usageCount: row.usage_count,
    lastUsedAt: row.last_used_at,
  };
}
