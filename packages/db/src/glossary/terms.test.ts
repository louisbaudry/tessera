import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { capturePlans, scansOf } from '../query-plan.fixture.js';
import { SchemaAliasError } from '../schema-alias.js';
import {
  addVariant,
  createGlossary,
  findRendering,
  insertTerm,
  listDecisions,
  listVariants,
  preferredVariant,
  recordDecision,
  TermError,
  tombstoneTerm,
  updateVariant,
} from './index.js';

let dir: string;
const open = (): Database.Database => {
  dir = mkdtempSync(join(tmpdir(), 'cat-glossary-terms-'));
  return createGlossary(join(dir, 'g.ctg'), { name: 'g', generator: 'test' });
};

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('addVariant', () => {
  it('keeps the text verbatim and stores its termKey as plain', () => {
    const db = open();
    const term = insertTerm(db);
    // NBSP and a capital: both must fold for matching, neither for display.
    const v = addVariant(db, {
      termId: term.id,
      lang: 'fr',
      text: 'Logiciel\u00A0libre',
    });
    expect(v.text).toBe('Logiciel\u00A0libre');
    expect(v.plain).toBe('logiciel libre');
    expect(v.rev).toBe(1);
    expect(v.forbidden).toBe(false);
    db.close();
  });

  it('maintains glossary.langs on write, in first-seen order', () => {
    const db = open();
    const term = insertTerm(db);
    addVariant(db, { termId: term.id, lang: 'en', text: 'invoice' });
    addVariant(db, { termId: term.id, lang: 'es', text: 'factura' });
    addVariant(db, { termId: term.id, lang: 'es', text: 'recibo' });
    const { langs } = db.prepare('SELECT langs FROM glossary').get() as { langs: string };
    expect(JSON.parse(langs)).toEqual(['en', 'es']);
    db.close();
  });

  it('refuses text that normalises to nothing', () => {
    const db = open();
    const term = insertTerm(db);
    expect(() =>
      addVariant(db, { termId: term.id, lang: 'en', text: ' \u00A0 ' }),
    ).toThrow(TermError);
    db.close();
  });

  it('refuses a second variant with the same plain in the same language', () => {
    const db = open();
    const term = insertTerm(db);
    addVariant(db, { termId: term.id, lang: 'es', text: 'Factura' });
    expect(() =>
      addVariant(db, { termId: term.id, lang: 'es', text: 'factura' }),
    ).toThrow(/UNIQUE/);
    db.close();
  });
});

describe('updateVariant', () => {
  it('bumps rev and keeps the previous row in history', () => {
    const db = open();
    const term = insertTerm(db);
    const v = addVariant(db, {
      termId: term.id,
      lang: 'es',
      text: 'factura',
      note: 'old',
    });
    const updated = updateVariant(db, v.id, {
      text: 'Factura',
      note: null,
      updatedBy: 'lb',
    });
    expect(updated.rev).toBe(2);
    expect(updated.text).toBe('Factura');
    expect(updated.plain).toBe('factura');
    expect(updated.note).toBe(null);
    expect(updated.updatedBy).toBe('lb');

    const history = db
      .prepare('SELECT * FROM term_variant_history WHERE term_variant_id = ?')
      .all(v.id) as Array<Record<string, unknown>>;
    expect(history).toHaveLength(1);
    expect(history[0]!['rev']).toBe(1);
    expect(history[0]!['text']).toBe('factura');
    expect(history[0]!['note']).toBe('old');
    expect(history[0]!['changed_by']).toBe('lb');
    db.close();
  });

  it('an omitted field is kept, a null note is cleared', () => {
    const db = open();
    const term = insertTerm(db);
    const v = addVariant(db, { termId: term.id, lang: 'es', text: 'factura', note: 'n' });
    expect(updateVariant(db, v.id, { forbidden: true }).note).toBe('n');
    expect(updateVariant(db, v.id, { forbidden: true }).forbidden).toBe(true);
    db.close();
  });

  it('refuses an unknown variant', () => {
    const db = open();
    expect(() => updateVariant(db, 999, { text: 'x' })).toThrow(TermError);
    db.close();
  });
});

describe('recordDecision / listDecisions', () => {
  it('stores termKeys and never lists the chosen rendering among the rejected', () => {
    const db = open();
    const term = insertTerm(db);
    const d = recordDecision(db, {
      termId: term.id,
      lang: 'es',
      chosen: 'Factura',
      rejected: ['factura', 'Recibo', 'nota\u00A0de venta', 'recibo'],
      kind: 'accepted_suggestion',
      sourceProject: 'acme-2026-09',
      sourceSegment: 14,
      decidedBy: 'lb',
    });
    expect(d.chosen).toBe('factura');
    expect(d.rejected).toEqual(['recibo', 'nota de venta']);
    expect(d.sourceSegment).toBe(14);
    expect(listDecisions(db, term.id, 'es-MX')).toEqual([d]);
    expect(listDecisions(db, term.id, 'fr')).toEqual([]);
    db.close();
  });
});

describe('preferredVariant', () => {
  it('with no decisions, is the earliest non-forbidden variant', () => {
    const db = open();
    const term = insertTerm(db);
    addVariant(db, { termId: term.id, lang: 'es', text: 'recibo', forbidden: true });
    const factura = addVariant(db, { termId: term.id, lang: 'es', text: 'factura' });
    addVariant(db, { termId: term.id, lang: 'es', text: 'nota' });
    expect(preferredVariant(db, term.id, 'es')?.id).toBe(factura.id);
    db.close();
  });

  it('follows the most recent decision', () => {
    const db = open();
    const term = insertTerm(db);
    const factura = addVariant(db, { termId: term.id, lang: 'es', text: 'factura' });
    const nota = addVariant(db, { termId: term.id, lang: 'es', text: 'nota de venta' });
    recordDecision(db, {
      termId: term.id,
      lang: 'es',
      chosen: 'nota de venta',
      rejected: ['factura'],
      kind: 'accepted_suggestion',
    });
    expect(preferredVariant(db, term.id, 'es')?.id).toBe(nota.id);
    recordDecision(db, {
      termId: term.id,
      lang: 'es-ES',
      chosen: 'Factura',
      rejected: [],
      kind: 'override',
    });
    expect(preferredVariant(db, term.id, 'es')?.id).toBe(factura.id);
    db.close();
  });

  it('never returns a forbidden variant, even one a past decision chose', () => {
    const db = open();
    const term = insertTerm(db);
    const factura = addVariant(db, { termId: term.id, lang: 'es', text: 'factura' });
    const recibo = addVariant(db, { termId: term.id, lang: 'es', text: 'recibo' });
    recordDecision(db, {
      termId: term.id,
      lang: 'es',
      chosen: 'recibo',
      rejected: [],
      kind: 'custom',
    });
    expect(preferredVariant(db, term.id, 'es')?.id).toBe(recibo.id);
    // The client says "never call it recibo": deprecate it.
    updateVariant(db, recibo.id, { forbidden: true });
    recordDecision(db, {
      termId: term.id,
      lang: 'es',
      chosen: 'recibo',
      rejected: [],
      kind: 'deprecation',
    });
    expect(preferredVariant(db, term.id, 'es')?.id).toBe(factura.id);
    db.close();
  });

  it('is null for a language the term has no usable rendering in', () => {
    const db = open();
    const term = insertTerm(db);
    addVariant(db, { termId: term.id, lang: 'es', text: 'recibo', forbidden: true });
    expect(preferredVariant(db, term.id, 'es')).toBe(null);
    expect(preferredVariant(db, term.id, 'de')).toBe(null);
    db.close();
  });
});

describe('findRendering', () => {
  const seed = (db: Database.Database) => {
    const term = insertTerm(db);
    addVariant(db, { termId: term.id, lang: 'en', text: 'invoice' });
    addVariant(db, { termId: term.id, lang: 'es', text: 'factura' });
    return term;
  };

  it('matches by termKey, region-insensitively, in both directions', () => {
    const db = open();
    const term = seed(db);
    const forward = findRendering(db, {
      srcLang: 'en-GB',
      srcText: 'Invoice',
      tgtLang: 'es-419',
    });
    expect(forward).toHaveLength(1);
    expect(forward[0]!.termId).toBe(term.id);
    expect(forward[0]!.target.text).toBe('factura');

    const reverse = findRendering(db, {
      srcLang: 'es',
      srcText: 'factura',
      tgtLang: 'en',
    });
    expect(reverse[0]!.target.text).toBe('invoice');
    db.close();
  });

  it('omits tombstoned terms and terms with no target rendering', () => {
    const db = open();
    const term = seed(db);
    expect(
      findRendering(db, { srcLang: 'en', srcText: 'invoice', tgtLang: 'de' }),
    ).toEqual([]);
    tombstoneTerm(db, term.id);
    expect(
      findRendering(db, { srcLang: 'en', srcText: 'invoice', tgtLang: 'es' }),
    ).toEqual([]);
    expect(() => tombstoneTerm(db, 999)).toThrow(TermError);
    db.close();
  });

  it('returns one rendering per term when several terms share a source key', () => {
    // Two legitimately different terms with the same source spelling
    // (tm-format-spec.md §7's "same hash, different uuid — both kept").
    const db = open();
    const a = seed(db);
    const b = insertTerm(db);
    addVariant(db, { termId: b.id, lang: 'en', text: 'invoice' });
    addVariant(db, { termId: b.id, lang: 'es', text: 'facturar', note: 'verb' });
    const found = findRendering(db, { srcLang: 'en', srcText: 'invoice', tgtLang: 'es' });
    expect(found.map((r) => r.termId)).toEqual([a.id, b.id]);
    expect(listVariants(db, b.id).map((v) => v.text)).toEqual(['invoice', 'facturar']);
    db.close();
  });

  it('seeks the (lang, plain) index for the source term (backlog #19a)', () => {
    const db = open();
    seed(db);
    const plans = capturePlans(db, () =>
      findRendering(db, { srcLang: 'en-GB', srcText: 'invoice', tgtLang: 'es' }),
    );
    expect(plans[0]).toContain(
      'SEARCH v USING INDEX term_variant_lookup (lang=? AND plain=?)',
    );
    expect(
      scansOf(plans, ['term_variant', 'term', 'term_decision', 'v', 't', 'd']),
    ).toEqual([]);
    // Language lookups come from the table, not the glossary.langs projection.
    db.prepare(`UPDATE glossary SET langs = '[]' WHERE id = 1`).run();
    expect(
      findRendering(db, { srcLang: 'en', srcText: 'invoice', tgtLang: 'es' }),
    ).toHaveLength(1);
    db.close();
  });

  it('refuses a schema alias that is not an identifier', () => {
    const db = open();
    expect(() =>
      findRendering(
        db,
        { srcLang: 'en', srcText: 'x', tgtLang: 'es' },
        { schema: 'gl_1; DROP TABLE term' },
      ),
    ).toThrow(SchemaAliasError);
    db.close();
  });
});
