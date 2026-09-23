/**
 * The reverse-engineered `.sdltm` schema, as executable DDL.
 *
 * Test scaffolding, not shipped code (`*.fixture.ts` is excluded from the
 * build, included in the typecheck) — but deliberately one module rather
 * than a `CREATE TABLE` block copy-pasted into each test file. This *is*
 * this project's written-down belief about what Trados Studio 8.06 stores
 * (tm-format-spec.md §8a), and a belief with two copies is one that drifts.
 *
 * Everything here is synthetic. Backlog #18b's remaining work is checking
 * the same reader against real files — which is what makes the knobs below
 * (omit a table, omit a column, lie about `tucount`, use another
 * `application_id`) worth having: they stand in for the Studio version this
 * schema was *not* observed on, until a second real file exists.
 */

import Database from 'better-sqlite3';

/** Trados's `application_id`, observed on the sample file. */
export const SDLTM_APPLICATION_ID = 1112754007;

/** One `<Elements>` child of a synthetic `<Segment>`. */
export type SegmentPart =
  | string
  | {
      readonly tag: string;
      readonly anchor?: number | null;
      readonly tagId?: number;
      readonly canHide?: boolean;
    };

/** Builds a native `<Segment>` fragment — the shape §8a records. */
export function segmentXml(parts: readonly SegmentPart[], culture = 'en-US'): string {
  const elements = parts
    .map((part) => {
      if (typeof part === 'string') return `<Text><Value>${part}</Value></Text>`;
      const anchor = part.anchor === null ? '' : `<Anchor>${part.anchor ?? 1}</Anchor>`;
      return (
        `<Tag><Type>${part.tag}</Type>${anchor}` +
        `<TagID>${part.tagId ?? 52}</TagID>` +
        `<CanHide>${part.canHide ?? false}</CanHide></Tag>`
      );
    })
    .join('');
  return `<Segment><Elements>${elements}</Elements><CultureName>${culture}</CultureName></Segment>`;
}

/** A plain text-only segment, the common case in a real memory. */
export function textSegment(text: string, culture = 'en-US'): string {
  return segmentXml([text], culture);
}

export interface SyntheticUnit {
  readonly source: string;
  readonly target: string;
  readonly usageCounter?: number | null;
  readonly lastUsedDate?: string | null;
  readonly creationDate?: string | null;
  readonly changeDate?: string | null;
  readonly creationUser?: string | null;
  readonly changeUser?: string | null;
  readonly contexts?: ReadonlyArray<{
    readonly source: string | null;
    readonly target: string | null;
  }>;
  readonly attributes?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

export interface SyntheticSdltmOptions {
  /** Where to create the database. Defaults to an in-memory one. */
  readonly path?: string;
  readonly sourceLang?: string;
  readonly targetLang?: string;
  readonly name?: string;
  readonly version?: string;
  /** `translation_memories.tucount`. Defaults to the real unit count. */
  readonly declaredUnitCount?: number;
  readonly units?: readonly SyntheticUnit[];
  /** Stand in for a Studio version that lacks a table this reader expects. */
  readonly omitTables?: readonly string[];
  /** Stand in for a Studio version that lacks a unit column. */
  readonly omitUnitColumns?: readonly string[];
  /** Defaults to {@link SDLTM_APPLICATION_ID}; override to test rejection. */
  readonly applicationId?: number;
  /** A second memory row, to exercise the multi-memory warning. */
  readonly extraMemories?: readonly { readonly name: string }[];
  /** Reproduce the 2013 shape: `string_attributes` with no `id` column. */
  readonly omitStringAttributeId?: boolean;
}

const UNIT_COLUMNS = [
  'usage_counter INTEGER',
  'last_used_date TEXT',
  'creation_date TEXT',
  'creation_user TEXT',
  'change_date TEXT',
  'change_user TEXT',
  'flags INTEGER',
] as const;

/** Creates a synthetic `.sdltm` database. The caller closes it. */
export function createSyntheticSdltm(
  options: SyntheticSdltmOptions = {},
): Database.Database {
  const db = new Database(options.path ?? ':memory:');
  const omitted = new Set(options.omitTables ?? []);
  const omittedColumns = new Set(options.omitUnitColumns ?? []);

  db.exec(`PRAGMA application_id = ${options.applicationId ?? SDLTM_APPLICATION_ID};`);

  const unitColumns = UNIT_COLUMNS.filter((c) => !omittedColumns.has(c.split(' ')[0]!));
  db.exec(`
    CREATE TABLE translation_memories (
      id INTEGER PRIMARY KEY,
      guid TEXT,
      name TEXT,
      source_language TEXT,
      target_language TEXT,
      tucount INTEGER,
      created_date TEXT,
      last_updated_date TEXT
    );

    CREATE TABLE translation_units (
      id INTEGER PRIMARY KEY,
      tm_id INTEGER,
      source_segment TEXT,
      target_segment TEXT${unitColumns.length > 0 ? ',\n      ' : ''}${unitColumns.join(',\n      ')}
    );
  `);

  if (!omitted.has('translation_unit_contexts')) {
    db.exec(`
      CREATE TABLE translation_unit_contexts (
        id INTEGER PRIMARY KEY,
        translation_unit_id INTEGER,
        -- INTEGER, not TEXT. This declaration said TEXT until a real 2013
        -- memory proved otherwise, and the wrong type is exactly why every
        -- test passed: SQLite's TEXT affinity quietly converted the int64
        -- on the way in, so no test ever handed the reader the value that
        -- breaks it. A fixture that is wrong in the same direction as the
        -- code proves nothing.
        left_source_context INTEGER,
        left_target_context INTEGER
      );
    `);
  }
  if (!omitted.has('attributes')) {
    db.exec(
      'CREATE TABLE attributes (id INTEGER PRIMARY KEY, tm_id INTEGER, name TEXT);',
    );
  }
  if (!omitted.has('string_attributes')) {
    // `omitStringAttributeId` reproduces the 2013 shape, which has no `id`
    // column on this table at all — a real schema variant, not a typo.
    db.exec(
      options.omitStringAttributeId === true
        ? `CREATE TABLE string_attributes (
             translation_unit_id INTEGER,
             attribute_id INTEGER,
             value TEXT
           );`
        : `CREATE TABLE string_attributes (
             id INTEGER PRIMARY KEY,
             translation_unit_id INTEGER,
             attribute_id INTEGER,
             value TEXT
           );`,
    );
  }
  if (!omitted.has('parameters')) {
    db.exec('CREATE TABLE parameters (name TEXT PRIMARY KEY, value TEXT);');
    db.prepare("INSERT INTO parameters (name, value) VALUES ('VERSION', ?)").run(
      options.version ?? '8.06',
    );
  }

  const units = options.units ?? [];
  db.prepare(
    'INSERT INTO translation_memories (id, name, source_language, target_language, tucount) ' +
      'VALUES (1, ?, ?, ?, ?)',
  ).run(
    options.name ?? 'synthetic',
    options.sourceLang ?? 'en-US',
    options.targetLang ?? 'es-MX',
    options.declaredUnitCount ?? units.length,
  );
  let nextMemoryId = 2;
  for (const extra of options.extraMemories ?? []) {
    db.prepare(
      'INSERT INTO translation_memories (id, name, source_language, target_language, tucount) ' +
        'VALUES (?, ?, ?, ?, 0)',
    ).run(nextMemoryId++, extra.name, options.sourceLang ?? 'en-US', 'de-DE');
  }

  const attributeIds = new Map<string, number>();
  for (const unit of units) {
    const present = ['tm_id', 'source_segment', 'target_segment'];
    const values: unknown[] = [1, unit.source, unit.target];
    const optional: ReadonlyArray<[string, unknown]> = [
      ['usage_counter', unit.usageCounter ?? null],
      ['last_used_date', unit.lastUsedDate ?? null],
      ['creation_date', unit.creationDate ?? null],
      ['creation_user', unit.creationUser ?? null],
      ['change_date', unit.changeDate ?? null],
      ['change_user', unit.changeUser ?? null],
    ];
    for (const [column, value] of optional) {
      if (omittedColumns.has(column)) continue;
      present.push(column);
      values.push(value);
    }
    const unitId = db
      .prepare(
        `INSERT INTO translation_units (${present.join(', ')}) ` +
          `VALUES (${present.map(() => '?').join(', ')})`,
      )
      .run(...values).lastInsertRowid as number;

    for (const context of unit.contexts ?? []) {
      if (omitted.has('translation_unit_contexts')) break;
      // Inserted as a literal rather than a bound parameter: a bound JS
      // number cannot express an int64 in the first place, which is the
      // very value this fixture needs to be able to produce.
      const literal = (v: string | null) =>
        v === null ? 'NULL' : /^-?\d+$/.test(v) ? v : `'${v.replace(/'/g, "''")}'`;
      db.exec(
        'INSERT INTO translation_unit_contexts ' +
          '(translation_unit_id, left_source_context, left_target_context) VALUES (' +
          `${unitId}, ${literal(context.source)}, ${literal(context.target)})`,
      );
    }
    for (const attribute of unit.attributes ?? []) {
      if (omitted.has('attributes') || omitted.has('string_attributes')) break;
      let attributeId = attributeIds.get(attribute.name);
      if (attributeId === undefined) {
        attributeId = db
          .prepare('INSERT INTO attributes (tm_id, name) VALUES (1, ?)')
          .run(attribute.name).lastInsertRowid as number;
        attributeIds.set(attribute.name, attributeId);
      }
      db.prepare(
        'INSERT INTO string_attributes (translation_unit_id, attribute_id, value) ' +
          'VALUES (?, ?, ?)',
      ).run(unitId, attributeId, attribute.value);
    }
  }

  return db;
}
