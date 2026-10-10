import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TmToken } from '@cat-tool/core';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents } from '../audit/events.js';
import {
  addVariant,
  createGlossary,
  insertTerm,
  recordDecision,
  tombstoneTerm,
} from '../glossary/index.js';
import { createTm } from '../tm/index.js';
import { writeBack } from '../tm/write.js';
import {
  ClientResourceError,
  createClient,
  exportClientResource,
  getClientResource,
  linkClientResource,
  listClientResources,
  openPortalDb,
  recordClientExport,
  unlinkClientResource,
} from './index.js';

let dir: string;
const path = (name: string): string => {
  if (!dir) dir = mkdtempSync(join(tmpdir(), 'cat-client-resources-'));
  return join(dir, name);
};
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

const text = (v: string): TmToken[] => [{ t: 'text', v }];
const sha = (p: string): string =>
  createHash('sha256').update(readFileSync(p)).digest('hex');

/** A memory with one unit, carrying everything a client export must not. */
function memory(name: string, source: string, target: string): string {
  const p = path(`${name}.ctm`);
  const db = createTm(p, { name, generator: 'test' });
  writeBack(db, {
    source: {
      lang: 'en',
      tokens: text(source),
      prevHash: 'prev-secret',
      nextHash: 'next-secret',
    },
    target: { lang: 'es', tokens: text(target), updatedBy: 'translator-9' },
  });
  db.exec(`
    UPDATE tu SET created_by = 'translator-9';
    UPDATE tuv SET usage_count = 7;
    INSERT INTO tu_attr (tu_id, key, value) VALUES
      (1, 'client', 'Acme'), (1, 'domain', 'legal'),
      (1, 'note', 'internal remark'), (1, 'project', 'secret-project'),
      (1, 'x-sdltm-contexts', 'blob');
  `);
  db.close();
  return p;
}

function setup() {
  const portal = openPortalDb(path('portal.sqlite'));
  const a = createClient(portal, 'A', 'a@example.test');
  const b = createClient(portal, 'B', 'b@example.test');
  return { portal, a, b };
}

describe('linking', () => {
  it('links one memory and one glossary per client, logs each, and reads them back scoped', () => {
    const { portal, a, b } = setup();
    const tm = memory('client-a', 'Save', 'Guardar');
    const link = linkClientResource(portal, {
      actor: TEST_ACTOR,
      clientId: a.id,
      kind: 'tm',
      path: tm,
    });
    expect(link.name).toBe('client-a');
    expect(getClientResource(portal, a.id, 'tm')?.id).toBe(link.id);
    expect(getClientResource(portal, a.id, 'glossary')).toBeNull();
    expect(getClientResource(portal, b.id, 'tm')).toBeNull();
    expect(listClientResources(portal, b.id)).toEqual([]);
    const events = listEvents(portal, { subjectType: 'client_resource' }).filter(
      (e) => e.action === 'resource.linked',
    );
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.detail as string)).toEqual({
      client_id: a.id,
      kind: 'tm',
    });
    portal.close();
  });

  it('refuses a second link of the same kind until the first is removed', () => {
    const { portal, a } = setup();
    const tm = memory('one', 'Save', 'Guardar');
    const opts = { actor: TEST_ACTOR, clientId: a.id, kind: 'tm' as const, path: tm };
    linkClientResource(portal, opts);
    expect(() => linkClientResource(portal, opts)).toThrow(/already has a tm linked/);
    unlinkClientResource(portal, { actor: TEST_ACTOR, clientId: a.id, kind: 'tm' });
    expect(getClientResource(portal, a.id, 'tm')).toBeNull();
    expect(() =>
      unlinkClientResource(portal, { actor: TEST_ACTOR, clientId: a.id, kind: 'tm' }),
    ).toThrow(ClientResourceError);
    linkClientResource(portal, opts);
    portal.close();
  });

  it('refuses a missing file, and a file of the other kind', () => {
    const { portal, a } = setup();
    const g = path('g.ctg');
    createGlossary(g, { name: 'g', generator: 'test' }).close();
    expect(() =>
      linkClientResource(portal, {
        actor: TEST_ACTOR,
        clientId: a.id,
        kind: 'tm',
        path: path('nope.ctm'),
      }),
    ).toThrow(ClientResourceError);
    expect(() =>
      linkClientResource(portal, {
        actor: TEST_ACTOR,
        clientId: a.id,
        kind: 'tm',
        path: g,
      }),
    ).toThrow(/not a memory/);
    expect(listClientResources(portal, a.id)).toEqual([]);
    portal.close();
  });
});

describe('exporting a memory', () => {
  it("is the linked memory's units only: another memory's text never appears", () => {
    const { portal, a } = setup();
    const own = memory('client-a', 'Own source', 'Texto propio');
    memory('base', 'BASE-ONLY-SOURCE', 'BASE-ONLY-TARGET');
    const link = linkClientResource(portal, {
      actor: TEST_ACTOR,
      clientId: a.id,
      kind: 'tm',
      path: own,
    });
    const out = exportClientResource(link);
    const xml = out.bytes.toString('utf8');
    expect(out.filename).toBe('client-a.tmx');
    expect(out.count).toBe(1);
    expect(xml).toContain('Own source');
    expect(xml).toContain('Texto propio');
    expect(xml).not.toContain('BASE-ONLY');
    portal.close();
  });

  it('leaves out who made it, notes, neighbour hashes, usage and internal properties', () => {
    const { portal, a } = setup();
    const own = memory('client-a', 'Save', 'Guardar');
    const link = linkClientResource(portal, {
      actor: TEST_ACTOR,
      clientId: a.id,
      kind: 'tm',
      path: own,
    });
    const xml = exportClientResource(link).bytes.toString('utf8');
    for (const leaked of [
      'translator-9',
      'internal remark',
      'secret-project',
      'x-sdltm-contexts',
      'prev-secret',
      'next-secret',
      'x-catm-prev',
      'usagecount',
      'creationid',
      'changeid',
    ]) {
      expect(xml, leaked).not.toContain(leaked);
    }
    expect(xml).toContain('type="client"');
    expect(xml).toContain('type="domain"');
    portal.close();
  });

  it('refuses a memory above the unit limit, and one not brought up to date', () => {
    const { portal, a } = setup();
    const own = memory('client-a', 'Save', 'Guardar');
    const link = linkClientResource(portal, {
      actor: TEST_ACTOR,
      clientId: a.id,
      kind: 'tm',
      path: own,
    });
    expect(() => exportClientResource(link, { maxUnits: 0 })).toThrow(
      expect.objectContaining({ reason: 'too_large' }),
    );
    portal.close();

    const stale = memory('stale', 'x', 'y');
    // An older format version has not been migrated: refused, never migrated here.
    const raw = new Database(stale);
    raw.pragma('user_version = 1');
    raw.close();
    expect(() => exportClientResource({ ...link, path: stale })).toThrow(/open it once/);
  });

  it('does not write the file it reads: same bytes, no sidecars left behind', () => {
    const { portal, a } = setup();
    const own = memory('client-a', 'Save', 'Guardar');
    const link = linkClientResource(portal, {
      actor: TEST_ACTOR,
      clientId: a.id,
      kind: 'tm',
      path: own,
    });
    const before = sha(own);
    exportClientResource(link);
    expect(sha(own)).toBe(before);
    expect(readdirSync(dir).filter((f) => f.startsWith('client-a.ctm'))).toEqual([
      'client-a.ctm',
    ]);
    portal.close();
  });
});

describe('exporting a glossary', () => {
  it('lists the live renderings with their status, and nothing from the decision log or notes', () => {
    const { portal, a } = setup();
    const g = path('g.ctg');
    const db = createGlossary(g, { name: 'Acme terms', generator: 'test' });
    const t = insertTerm(db);
    addVariant(db, { termId: t.id, lang: 'en', text: 'invoice' });
    addVariant(db, { termId: t.id, lang: 'es', text: 'factura' });
    addVariant(db, { termId: t.id, lang: 'es', text: 'cuenta', note: 'INTERNAL-NOTE' });
    addVariant(db, {
      termId: t.id,
      lang: 'es',
      text: 'recibo',
      forbidden: true,
      updatedBy: 'editor-3',
    });
    recordDecision(db, {
      termId: t.id,
      lang: 'es',
      chosen: 'factura',
      rejected: ['cuenta'],
      kind: 'custom',
      decidedBy: 'editor-3',
    });
    const gone = insertTerm(db);
    addVariant(db, { termId: gone.id, lang: 'en', text: 'tombstoned' });
    tombstoneTerm(db, gone.id);
    db.close();

    const link = linkClientResource(portal, {
      actor: TEST_ACTOR,
      clientId: a.id,
      kind: 'glossary',
      path: g,
    });
    expect(link.name).toBe('Acme terms');
    const out = exportClientResource(link);
    const csv = out.bytes.toString('utf8');
    expect(out.filename).toBe('Acme terms.csv');
    expect(csv.startsWith('﻿concept,lang,term,status\r\n')).toBe(true);
    expect(csv).toContain('1,en,invoice,preferred\r\n');
    expect(csv).toContain('1,es,factura,preferred\r\n');
    expect(csv).toContain('1,es,cuenta,allowed\r\n');
    expect(csv).toContain('1,es,recibo,forbidden\r\n');
    expect(out.count).toBe(4);
    for (const leaked of ['INTERNAL-NOTE', 'editor-3', 'tombstoned']) {
      expect(csv, leaked).not.toContain(leaked);
    }
    portal.close();
  });
});

describe('recordClientExport', () => {
  it('logs who took what, with a count and a digest and none of the text', () => {
    const { portal, a } = setup();
    const own = memory('client-a', 'Secret source', 'Secreto');
    const link = linkClientResource(portal, {
      actor: TEST_ACTOR,
      clientId: a.id,
      kind: 'tm',
      path: own,
    });
    const exported = exportClientResource(link);
    recordClientExport(portal, { actor: TEST_ACTOR, resource: link, exported });
    const e = listEvents(portal, { subjectType: 'client_resource' }).find(
      (x) => x.action === 'resource.exported',
    )!;
    expect(JSON.parse(e.detail as string)).toEqual({
      client_id: a.id,
      kind: 'tm',
      count: 1,
      sha256: createHash('sha256').update(exported.bytes).digest('hex'),
    });
    expect(JSON.stringify(e)).not.toContain('Secret');
    portal.close();
  });
});
