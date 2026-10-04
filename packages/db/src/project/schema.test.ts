import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { QA_RULES } from '@cat-tool/core';
import Database from 'better-sqlite3';

import { openAndMigrate, sqlList, type Migration } from '../migrate.js';
import { openProjectDb } from './index.js';
import { setRuleEnabled } from './qa-settings.js';
import { PROJECT_APPLICATION_ID, PROJECT_MIGRATIONS } from './schema.js';

let dir: string;
const dbPath = () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-project-'));
  return join(dir, 'project.catdb');
};

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('openProjectDb', () => {
  it('is identified as its own file type by application_id alone', () => {
    const db = openProjectDb(dbPath());
    expect(db.pragma('application_id', { simple: true })).toBe(PROJECT_APPLICATION_ID);
    db.close();
  });

  it('creates every table the spec calls for', () => {
    const db = openProjectDb(dbPath());
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual([
      'audit_event',
      'file',
      'glossary_ref',
      'project',
      'qa_issue',
      'qa_rule_setting',
      'qa_untranslated_allowlist',
      'segment',
      'tm_ref',
    ]);
    db.close();
  });

  it('enforces exactly one write-target TM', () => {
    const db = openProjectDb(dbPath());
    const insert = db.prepare(
      'INSERT INTO tm_ref (path, priority, is_write_target) VALUES (?, ?, ?)',
    );
    insert.run('a.ctm', 1, 1);
    expect(() => insert.run('b.ctm', 2, 1)).toThrow();
    insert.run('b.ctm', 2, 0); // a second TM is fine as long as it is not the write target
    db.close();
  });

  it('rejects a segment status outside the closed set', () => {
    const db = openProjectDb(dbPath());
    db.prepare(
      "INSERT INTO file (id, rel_path, original_blob, skeleton, part_map, imported_at) VALUES (1, 'a.docx', x'00', '[]', '[]', '2026-01-01')",
    ).run();
    const insert = db.prepare(
      `INSERT INTO segment
         (file_id, part, ord, para_key, para_ord, source_tokens, format_table, source_hash, status, updated_at)
       VALUES (1, 'document', 0, 'p1', 0, '[]', '[]', 'hash', ?, '2026-01-01')`,
    );
    expect(() => insert.run('bogus')).toThrow();
    expect(() => insert.run('confirmed')).not.toThrow();
    db.close();
  });

  it('leaves origin unconstrained — a new TM match kind is just a value', () => {
    const db = openProjectDb(dbPath());
    db.prepare(
      "INSERT INTO file (id, rel_path, original_blob, skeleton, part_map, imported_at) VALUES (1, 'a.docx', x'00', '[]', '[]', '2026-01-01')",
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO segment
             (file_id, part, ord, para_key, para_ord, source_tokens, format_table, source_hash, status, origin, updated_at)
           VALUES (1, 'document', 0, 'p1', 0, '[]', '[]', 'hash', 'draft', 'tm_fuzzy_85', '2026-01-01')`,
        )
        .run(),
    ).not.toThrow();
    db.close();
  });

  it('rejects a qa_issue rule or severity outside the closed sets', () => {
    const db = openProjectDb(dbPath());
    db.prepare(
      "INSERT INTO file (id, rel_path, original_blob, skeleton, part_map, imported_at) VALUES (1, 'a.docx', x'00', '[]', '[]', '2026-01-01')",
    ).run();
    db.prepare(
      `INSERT INTO segment
         (id, file_id, part, ord, para_key, para_ord, source_tokens, format_table, source_hash, status, updated_at)
       VALUES (1, 1, 'document', 0, 'p1', 0, '[]', '[]', 'hash', 'new', '2026-01-01')`,
    ).run();
    const insert = db.prepare(
      'INSERT INTO qa_issue (segment_id, rule, severity, message, run_at) VALUES (1, ?, ?, ?, ?)',
    );
    expect(() => insert.run('tag.missing', 'critical', 'x', '2026-01-01')).toThrow();
    expect(() => insert.run('not.a.rule', 'error', 'x', '2026-01-01')).toThrow();
    expect(() => insert.run('tag.missing', 'error', 'x', '2026-01-01')).not.toThrow();
    db.close();
  });
});

describe('v7: qa_issue and qa_rule_setting rebuilt (backlog #64)', () => {
  /** The list v1 and v3 froze: today's, less what later migrations added. */
  const V1_QA_RULES = QA_RULES.filter((r) => r !== 'term.glossary_mismatch');
  const TAG_RULES = ['tag.missing', 'tag.extra', 'tag.unbalanced'];

  /**
   * A v6 file whose two QA CHECKs hold only the tag rules: v1–v6 as they
   * ran on a file created while the live list was that short, which is
   * what a migration reading `QA_RULES` would have left behind.
   */
  function driftedV6File(path: string): void {
    const narrowed = (m: Migration): Migration => ({
      ...m,
      up: (db) =>
        m.up(
          new Proxy(db, {
            get: (target, key) =>
              key === 'exec'
                ? (sql: string) =>
                    target.exec(sql.replaceAll(sqlList(V1_QA_RULES), sqlList(TAG_RULES)))
                : (Reflect.get(target, key) as unknown),
          }),
        ),
    });
    openAndMigrate(path, {
      applicationId: PROJECT_APPLICATION_ID,
      migrations: PROJECT_MIGRATIONS.slice(0, 6).map(narrowed),
    }).close();

    const seeded = new Database(path);
    seeded.exec(`
      INSERT INTO file (id, rel_path, original_blob, skeleton, part_map, imported_at)
        VALUES (1, 'a.docx', x'00', '[]', '[]', '2026-01-01');
      INSERT INTO segment
        (id, file_id, part, ord, para_key, para_ord, source_tokens, format_table, source_hash, status, updated_at)
        VALUES (1, 1, 'document', 0, 'p1', 0, '[]', '[]', 'h1', 'new', '2026-01-01'),
               (2, 1, 'document', 1, 'p2', 1, '[]', '[]', 'h2', 'new', '2026-01-01');
      INSERT INTO qa_issue (id, segment_id, rule, severity, message, dismissed, run_at)
        VALUES (7, 1, 'tag.missing', 'error', 'Missing tags: 1', 1, '2026-01-01'),
               (9, 2, 'tag.extra', 'error', 'Extra tags: 2', 0, '2026-01-02');
      INSERT INTO qa_rule_setting (rule, enabled) VALUES ('tag.unbalanced', 0);
    `);
    seeded.close();
  }

  const qaSchema = (db: Database.Database) =>
    db
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_master
         WHERE tbl_name IN ('qa_issue', 'qa_rule_setting') ORDER BY type, name`,
      )
      .all();

  it('the simulated drift is real: the old file rejects seg.empty in both tables', () => {
    const path = dbPath();
    driftedV6File(path);
    const db = new Database(path);
    expect(() =>
      db
        .prepare("INSERT INTO qa_rule_setting (rule, enabled) VALUES ('seg.empty', 0)")
        .run(),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO qa_issue (segment_id, rule, severity, message, run_at) VALUES (1, 'seg.empty', 'error', 'x', 't')",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('opening it accepts seg.empty, keeps every row and id, and restores qa_issue_segment', () => {
    const path = dbPath();
    driftedV6File(path);
    const before = new Database(path, { readonly: true });
    const issues = before.prepare('SELECT * FROM qa_issue ORDER BY id').all();
    const settings = before.prepare('SELECT * FROM qa_rule_setting ORDER BY rule').all();
    before.close();

    const db = openProjectDb(path);
    expect(db.pragma('user_version', { simple: true })).toBe(PROJECT_MIGRATIONS.length);
    expect(db.prepare('SELECT * FROM qa_issue ORDER BY id').all()).toEqual(issues);
    expect(db.prepare('SELECT * FROM qa_rule_setting ORDER BY rule').all()).toEqual(
      settings,
    );

    setRuleEnabled(db, 'seg.empty', false);
    db.prepare(
      "INSERT INTO qa_issue (segment_id, rule, severity, message, run_at) VALUES (1, 'seg.empty', 'error', 'x', 't')",
    ).run();

    const fresh = openProjectDb(join(dir, 'fresh.catdb'));
    expect(qaSchema(db)).toEqual(qaSchema(fresh));
    expect(qaSchema(db)).toContainEqual(
      expect.objectContaining({ type: 'index', name: 'qa_issue_segment' }),
    );
    fresh.close();
    db.close();
  });
});

describe('v11: qa_issue and qa_rule_setting widened with term.glossary_mismatch (backlog #44)', () => {
  it('a v10 file rejects the rule; opening it accepts it and keeps every row and id', () => {
    const path = dbPath();
    openAndMigrate(path, {
      applicationId: PROJECT_APPLICATION_ID,
      migrations: PROJECT_MIGRATIONS.slice(0, 10),
    }).close();
    const seeded = new Database(path);
    seeded.exec(`
      INSERT INTO file (id, rel_path, original_blob, skeleton, part_map, imported_at)
        VALUES (1, 'a.docx', x'00', '[]', '[]', '2026-01-01');
      INSERT INTO segment
        (id, file_id, part, ord, para_key, para_ord, source_tokens, format_table, source_hash, status, updated_at, fallback_copy)
        VALUES (1, 1, 'document', 0, 'p1', 0, '[]', '[]', 'h1', 'new', '2026-01-01', 0);
      INSERT INTO qa_issue (id, segment_id, rule, severity, message, dismissed, run_at)
        VALUES (7, 1, 'tag.missing', 'error', 'Missing tags: 1', 1, '2026-01-01');
      INSERT INTO qa_rule_setting (rule, enabled) VALUES ('punct.spacing', 0);
    `);
    expect(() =>
      seeded
        .prepare(
          "INSERT INTO qa_rule_setting (rule, enabled) VALUES ('term.glossary_mismatch', 0)",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    const issues = seeded.prepare('SELECT * FROM qa_issue ORDER BY id').all();
    const settings = seeded.prepare('SELECT * FROM qa_rule_setting ORDER BY rule').all();
    seeded.close();

    const db = openProjectDb(path);
    expect(db.pragma('user_version', { simple: true })).toBe(PROJECT_MIGRATIONS.length);
    expect(db.prepare('SELECT * FROM qa_issue ORDER BY id').all()).toEqual(issues);
    expect(db.prepare('SELECT * FROM qa_rule_setting ORDER BY rule').all()).toEqual(
      settings,
    );
    setRuleEnabled(db, 'term.glossary_mismatch', false);
    db.prepare(
      "INSERT INTO qa_issue (segment_id, rule, severity, message, run_at) VALUES (1, 'term.glossary_mismatch', 'warning', 'x', 't')",
    ).run();
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'qa_issue_segment'").get(),
    ).toBeDefined();
    db.close();
  });
});
