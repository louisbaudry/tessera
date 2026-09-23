import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openProjectDb } from './index.js';
import { PROJECT_APPLICATION_ID } from './schema.js';

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
