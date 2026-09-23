import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addVariant,
  createGlossary,
  GLOSSARY_APPLICATION_ID,
  GlossaryError,
  insertTerm,
  openGlossary,
  recordDecision,
} from './index.js';
import { NORMALIZER_VERSION } from './schema.js';

let dir: string;
const dbPath = () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-glossary-'));
  return join(dir, 'client.ctg');
};

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('createGlossary / openGlossary', () => {
  it('writes a single identity row carrying the client label', () => {
    const db = createGlossary(dbPath(), {
      name: 'Acme',
      generator: 'cat-tool/test',
      client: 'acme',
    });
    const row = db.prepare('SELECT * FROM glossary').get() as Record<string, unknown>;
    expect(row['id']).toBe(1);
    expect(row['name']).toBe('Acme');
    expect(row['client']).toBe('acme');
    expect(row['langs']).toBe('[]');
    expect(typeof row['uuid']).toBe('string');
    db.close();
  });

  it('a base glossary has no client', () => {
    const db = createGlossary(dbPath(), { name: 'base', generator: 'test' });
    expect(
      (db.prepare('SELECT client FROM glossary').get() as { client: null }).client,
    ).toBe(null);
    db.close();
  });

  it('stamps the real normalizer version from core', () => {
    const db = createGlossary(dbPath(), { name: 'x', generator: 'test' });
    const { normalizer_version } = db
      .prepare('SELECT normalizer_version FROM glossary')
      .get() as { normalizer_version: number };
    expect(normalizer_version).toBe(NORMALIZER_VERSION);
    db.close();
  });

  it('refuses to re-create an already-initialised file', () => {
    const path = dbPath();
    createGlossary(path, { name: 'first', generator: 'test' }).close();
    expect(() => createGlossary(path, { name: 'second', generator: 'test' })).toThrow(
      GlossaryError,
    );
    const db = openGlossary(path);
    expect((db.prepare('SELECT name FROM glossary').get() as { name: string }).name).toBe(
      'first',
    );
    db.close();
  });

  it('creates every table the spec calls for', () => {
    const db = createGlossary(dbPath(), { name: 'x', generator: 'test' });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(
      [
        'glossary',
        'term',
        'term_decision',
        'term_variant',
        'term_variant_history',
      ].sort(),
    );
    db.close();
  });

  it('is identified as CATG by its raw file header alone', () => {
    const path = dbPath();
    createGlossary(path, { name: 'x', generator: 'test' }).close();
    // application_id lives at byte offset 68, big-endian — read without SQLite.
    const bytes = readFileSync(path);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(68, false)).toBe(GLOSSARY_APPLICATION_ID);
  });
});

describe('term_decision is append-only', () => {
  it('refuses UPDATE and DELETE at the schema level', () => {
    const db = createGlossary(dbPath(), { name: 'x', generator: 'test' });
    const term = insertTerm(db);
    addVariant(db, { termId: term.id, lang: 'es', text: 'factura' });
    const d = recordDecision(db, {
      termId: term.id,
      lang: 'es',
      chosen: 'factura',
      rejected: [],
      kind: 'custom',
    });
    expect(() =>
      db.prepare("UPDATE term_decision SET chosen = 'recibo' WHERE id = ?").run(d.id),
    ).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM term_decision WHERE id = ?').run(d.id)).toThrow(
      /append-only/,
    );
    db.close();
  });

  it('a term with decisions cannot be hard-deleted — only tombstoned', () => {
    const db = createGlossary(dbPath(), { name: 'x', generator: 'test' });
    const term = insertTerm(db);
    recordDecision(db, {
      termId: term.id,
      lang: 'es',
      chosen: 'factura',
      rejected: [],
      kind: 'custom',
    });
    expect(() => db.prepare('DELETE FROM term WHERE id = ?').run(term.id)).toThrow(
      /FOREIGN KEY/,
    );
    db.close();
  });

  it('rejects a decision kind outside DECISION_KINDS', () => {
    const db = createGlossary(dbPath(), { name: 'x', generator: 'test' });
    const term = insertTerm(db);
    expect(() =>
      recordDecision(db, {
        termId: term.id,
        lang: 'es',
        chosen: 'factura',
        rejected: [],
        kind: 'guess' as never,
      }),
    ).toThrow(/CHECK/);
    db.close();
  });
});
