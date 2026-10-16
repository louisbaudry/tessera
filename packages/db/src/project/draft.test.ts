import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assembleFile,
  createFakeEngine,
  plainText,
  rulesFor,
  toTmTokens,
  type DraftEngineAdapter,
  type EngineDecision,
  type Segment,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents, verifyAudit } from '../audit/events.js';
import { createGlossary } from '../glossary/index.js';
import { addVariant, insertTerm } from '../glossary/terms.js';
import { createTm, writeBack } from '../tm/index.js';
import { acceptDraftSuggestion, NoSuggestionError } from './draft-accept.js';
import { DEFAULT_DRAFT_TOKEN_CEILING, draftSuggestions } from './draft.js';
import { editSegmentTarget, TargetConflictError } from './edit-target.js';
import {
  getDraftSuggestion,
  listDraftSuggestions,
  purgeDraftSuggestions,
  putDraftSuggestion,
} from './draft-suggestions.js';
import { insertFile } from './files.js';
import { addGlossaryRef } from './glossary-refs.js';
import { openProjectDb } from './index.js';
import { createProject } from './project.js';
import {
  getSegment,
  listAllSegments,
  listSegments,
  setSegmentTarget,
} from './segments.js';
import { addTmRef } from './tm-refs.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const allowed: () => EngineDecision = () => ({ engine: 'tessera' });
const echo = (req: { sourceText: string }) => req.sourceText;
const NOW = new Date('2026-10-15T12:00:00.000Z');

function project(): Database.Database {
  dir = mkdtempSync(join(tmpdir(), 'cat-draft-'));
  const db = openProjectDb(join(dir, 'project.catdb'));
  createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'es' });
  const bytes = new Uint8Array(readFileSync(join(FIXTURES, 'prose-long.docx')));
  insertFile(db, 'prose-long.docx', assembleFile(bytes, rulesFor('en')), {
    actor: TEST_ACTOR,
  });
  return db;
}

const textOf = (s: Segment): string => plainText(s.sourceTokens).trim();
/** A plain-text segment whose words need no escaping and whose source is unique in the project. */
const plainOnly = (s: Segment, all: readonly Segment[]): boolean =>
  !s.locked &&
  s.sourceTokens.every((t) => t.t === 'text') &&
  /^[A-Za-z0-9 ,.'’-]+$/.test(textOf(s)) &&
  all.filter((o) => o.sourceHash === s.sourceHash).length === 1;
const actions = (db: Database.Database, action: string) =>
  listEvents(db, { subjectType: 'segment' }).filter((e) => e.action === action);

/** What a run over `db` should ask about, given segments excluded by hash. */
const askable = (db: Database.Database, excludeHashes: ReadonlySet<string>): Segment[] =>
  listAllSegments(db).filter(
    (s) =>
      !s.locked &&
      s.status !== 'confirmed' &&
      s.targetTokens === null &&
      textOf(s) !== '' &&
      !excludeHashes.has(s.sourceHash),
  );

describe('draftSuggestions', () => {
  it('stores a suggestion per askable segment, outside the segment, and logs each send', async () => {
    const db = project();
    const engine = createFakeEngine(echo, { model: 'm-1' });
    const expected = askable(db, new Set());
    expect(expected.length).toBeGreaterThan(3);

    const summary = await draftSuggestions(db, {
      actor: TEST_ACTOR,
      adapter: engine,
      gate: allowed,
      now: () => NOW,
    });

    expect(summary).toMatchObject({
      stop: 'done',
      error: null,
      requested: expected.length,
      stored: expected.length,
    });
    expect(engine.calls).toHaveLength(expected.length);
    expect(summary.tokens).toEqual({
      input: 100 * expected.length,
      output: 20 * expected.length,
    });

    // A suggestion is not a write: no target set, no segment event at all.
    expect(listAllSegments(db).every((s) => s.targetTokens === null)).toBe(true);
    expect(actions(db, 'segment.target_set')).toHaveLength(0);
    const saved = listDraftSuggestions(db);
    expect(saved).toHaveLength(expected.length);
    expect(saved[0]).toMatchObject({
      engine: 'tessera',
      model: 'fake-model'.replace('fake-model', 'm-1'),
      promptVersion: 'tessera-draft-v1',
      createdAt: NOW.toISOString(),
    });

    // One ai.requested per send, the digest of what was sent, the actor named.
    const sent = actions(db, 'ai.requested');
    expect(sent).toHaveLength(expected.length);
    const first = sent[0]!;
    expect(first.actor).toBe('cli:test');
    expect(JSON.parse(first.detail as string)).toEqual({
      engine: 'tessera',
      model: 'm-1',
      prompt_version: 'tessera-draft-v1',
      input_sha256: engine.calls[0]!.prompt.inputSha256,
    });
    expect(verifyAudit(db)).toMatchObject({ brokenAt: null });
    db.close();
  });

  it('asks nothing and logs nothing for a client that has not consented', async () => {
    const db = project();
    const engine = createFakeEngine(echo);
    const summary = await draftSuggestions(db, {
      actor: TEST_ACTOR,
      adapter: engine,
      gate: () => ({ engine: 'off', reason: 'client_default_off' }),
    });
    expect(summary).toMatchObject({ stop: 'gate_closed', requested: 0, stored: 0 });
    expect(engine.calls).toHaveLength(0);
    expect(actions(db, 'ai.requested')).toHaveLength(0);
    expect(listDraftSuggestions(db)).toHaveLength(0);
    db.close();
  });

  it('treats an engine other than the adapter’s as off', async () => {
    const db = project();
    const engine = createFakeEngine(echo, { engine: 'tessera' });
    const summary = await draftSuggestions(db, {
      actor: TEST_ACTOR,
      adapter: engine,
      gate: () => ({ engine: 'deepl' }),
    });
    expect(summary.stop).toBe('gate_closed');
    expect(engine.calls).toHaveLength(0);
    db.close();
  });

  it('refuses a pair the engine does not serve before asking, building or logging anything (D40)', async () => {
    const db = project();
    const base = createFakeEngine(echo, { engine: 'deepl' });
    const asked: Array<[string, string]> = [];
    const engine: DraftEngineAdapter = {
      engine: 'deepl',
      model: base.model,
      supports: (src, tgt) => {
        asked.push([src, tgt]);
        return false;
      },
      draft: (request) => base.draft(request),
    };
    const summary = await draftSuggestions(db, {
      actor: TEST_ACTOR,
      adapter: engine,
      gate: () => ({ engine: 'deepl' }),
    });
    expect(summary).toMatchObject({
      stop: 'engine_error',
      requested: 0,
      stored: 0,
      error: expect.stringContaining('deepl engine does not translate'),
    });
    expect(asked).toHaveLength(1);
    expect(base.calls).toHaveLength(0);
    expect(actions(db, 'ai.requested')).toHaveLength(0);
    db.close();
  });

  it('stops the remaining segments when the client is switched off between segments', async () => {
    const db = project();
    const engine = createFakeEngine(echo);
    let open = true;
    const summary = await draftSuggestions(db, {
      actor: TEST_ACTOR,
      adapter: engine,
      gate: () =>
        open ? { engine: 'tessera' } : { engine: 'off', reason: 'not_consented' },
      // The consent is withdrawn once the second segment is done.
      onProgress: (done) => {
        if (done === 2) open = false;
      },
    });
    expect(summary).toMatchObject({
      stop: 'gate_closed',
      requested: 2,
      stored: 2,
      discarded: 0,
    });
    expect(engine.calls).toHaveLength(2);
    expect(actions(db, 'ai.requested')).toHaveLength(2);
    db.close();
  });

  it('drops a reply that lands after the consent was withdrawn, so nothing is stored for an opted-out client (D15)', async () => {
    const db = project();
    let open = true;
    const inFlight: DraftEngineAdapter = {
      engine: 'tessera',
      model: 'm-1',
      // The owner withdraws consent while this very call is out.
      draft: (request) => {
        open = false;
        return Promise.resolve({ text: request.sourceText, model: 'm-1' });
      },
    };
    const summary = await draftSuggestions(db, {
      actor: TEST_ACTOR,
      adapter: inFlight,
      gate: () =>
        open ? { engine: 'tessera' } : { engine: 'off', reason: 'not_consented' },
    });
    expect(summary).toMatchObject({
      stop: 'gate_closed',
      requested: 1,
      stored: 0,
      discarded: 1,
    });
    // The send is on the record, and the reply it earned is nowhere.
    expect(actions(db, 'ai.requested')).toHaveLength(1);
    expect(listDraftSuggestions(db)).toHaveLength(0);
    db.close();
  });

  it('never sends what a memory or a confirmed sibling places, nor what already has a target', async () => {
    const db = project();
    const segments = listAllSegments(db);
    const [exactSeg, confirmedSeg, typedSeg, siblingSeg] = segments.filter(
      (s) => plainOnly(s, segments) && textOf(s).split(/\s+/).length >= 3,
    );
    // Hashes the run must leave alone: an exact memory hit, a confirmed donor.
    const tm = createTm(join(dir, 'm.ctm'), { name: 'm', generator: 'test' });
    writeBack(tm, {
      source: {
        lang: 'en',
        tokens: toTmTokens(exactSeg!.sourceTokens, exactSeg!.formatTable),
      },
      target: { lang: 'es', tokens: [{ t: 'text', v: 'EXACT TARGET' }] },
    });
    tm.close();
    addTmRef(db, { path: join(dir, 'm.ctm'), priority: 1, actor: TEST_ACTOR });
    setSegmentTarget(db, confirmedSeg!.id, {
      targetTokens: [{ t: 'text', v: 'Confirmado' }],
      status: 'confirmed',
      origin: null,
      actor: TEST_ACTOR,
    });
    setSegmentTarget(db, typedSeg!.id, {
      targetTokens: [{ t: 'text', v: 'Escrito a mano' }],
      status: 'translated',
      origin: null,
      actor: TEST_ACTOR,
    });

    // A second segment with the confirmed one's source: internal propagation's.
    db.prepare('UPDATE segment SET source_hash = ? WHERE id = ?').run(
      confirmedSeg!.sourceHash,
      siblingSeg!.id,
    );

    const engine = createFakeEngine(echo);
    const summary = await draftSuggestions(db, {
      actor: TEST_ACTOR,
      adapter: engine,
      gate: allowed,
    });

    const sent = new Set(engine.calls.map((c) => c.sourceText.trim()));
    for (const s of [exactSeg!, confirmedSeg!, typedSeg!, siblingSeg!]) {
      expect(sent.has(textOf(s))).toBe(false);
      expect(getDraftSuggestion(db, s.id)).toBeNull();
    }
    expect(summary.skipped.covered).toBe(2); // the exact hit and the sibling
    expect(summary.skipped.protected).toBeGreaterThanOrEqual(1); // confirmed, and locked ones
    expect(summary.skipped.hasTarget).toBeGreaterThanOrEqual(1);
    expect(summary.requested).toBe(
      askable(db, new Set([exactSeg!.sourceHash, confirmedSeg!.sourceHash])).length,
    );
    db.close();
  });

  it('puts the closest memory units and the glossary terms into the prompt', async () => {
    const db = project();
    const everything = listAllSegments(db);
    const long = everything.find(
      (s) => plainOnly(s, everything) && textOf(s).split(/\s+/).length >= 8,
    )!;
    const words = textOf(long).split(/\s+/);
    // A near copy of the segment: one word fewer, so a fuzzy match and no exact one.
    const near = words.slice(0, -1).join(' ');
    const tm = createTm(join(dir, 'm.ctm'), { name: 'm', generator: 'test' });
    writeBack(tm, {
      source: { lang: 'en', tokens: [{ t: 'text', v: near }] },
      target: { lang: 'es', tokens: [{ t: 'text', v: 'REFERENCIA CERCANA' }] },
    });
    tm.close();
    addTmRef(db, { path: join(dir, 'm.ctm'), priority: 1, actor: TEST_ACTOR });

    const term = words.find((w) => /^[A-Za-z]{5,}$/.test(w))!;
    const glossary = createGlossary(join(dir, 'g.ctg'), { name: 'g', generator: 'test' });
    const entry = insertTerm(glossary);
    addVariant(glossary, { termId: entry.id, lang: 'en', text: term });
    addVariant(glossary, { termId: entry.id, lang: 'es', text: 'TERMINO FIJO' });
    glossary.close();
    addGlossaryRef(db, {
      path: join(dir, 'g.ctg'),
      priority: 1,
      isWriteTarget: true,
      actor: TEST_ACTOR,
    });

    const engine = createFakeEngine(echo);
    await draftSuggestions(db, { actor: TEST_ACTOR, adapter: engine, gate: allowed });

    const prompt = engine.calls.find((c) => c.sourceText.startsWith(words[0]!))!.prompt
      .user;
    expect(prompt).toContain(`<source>${near}</source>`);
    expect(prompt).toContain('<target>REFERENCIA CERCANA</target>');
    expect(prompt).toContain(
      `<term><source>${term}</source><preferred>TERMINO FIJO</preferred></term>`,
    );
    db.close();
  });

  it('counts a refused reply, stores nothing for it, and still logs that it was sent', async () => {
    const db = project();
    const engine = createFakeEngine('<t9/> not a draft');
    const summary = await draftSuggestions(db, {
      actor: TEST_ACTOR,
      adapter: engine,
      gate: allowed,
    });
    expect(summary.stored).toBe(0);
    expect(summary.requested).toBe(engine.calls.length);
    expect(summary.rejected.unknown_tag).toBe(engine.calls.length);
    expect(listDraftSuggestions(db)).toHaveLength(0);
    expect(actions(db, 'ai.requested')).toHaveLength(engine.calls.length);
    // The tokens of a refused reply were spent all the same.
    expect(summary.tokens.input).toBe(100 * engine.calls.length);
    db.close();
  });

  it('stops at the token ceiling, and a rerun resumes where it stopped', async () => {
    const db = project();
    const engine = createFakeEngine(echo); // 120 tokens a reply
    const first = await draftSuggestions(db, {
      actor: TEST_ACTOR,
      adapter: engine,
      gate: allowed,
      tokenCeiling: 250,
    });
    // 120, 240 (under), 360 (over): the third is asked, then the ceiling holds.
    expect(first.stop).toBe('ceiling');
    expect(first.requested).toBe(3);

    const rest = await draftSuggestions(db, {
      actor: TEST_ACTOR,
      adapter: engine,
      gate: allowed,
    });
    expect(rest.stop).toBe('done');
    expect(rest.skipped.suggested).toBe(3);
    expect(first.requested + rest.requested).toBe(askable(db, new Set()).length);
    expect(DEFAULT_DRAFT_TOKEN_CEILING).toBeGreaterThan(0);
    db.close();
  });

  it('reports an engine failure, keeps the log of the attempt, and stops', async () => {
    const db = project();
    const broken: DraftEngineAdapter = {
      engine: 'tessera',
      model: 'm-1',
      draft: () => Promise.reject(new Error('401 from the engine')),
    };
    const summary = await draftSuggestions(db, {
      actor: TEST_ACTOR,
      adapter: broken,
      gate: allowed,
    });
    expect(summary).toMatchObject({
      stop: 'engine_error',
      error: '401 from the engine',
      requested: 1,
      stored: 0,
    });
    expect(actions(db, 'ai.requested')).toHaveLength(1);
    db.close();
  });

  it('ends cleanly when told to stop, between segments', async () => {
    const db = project();
    const engine = createFakeEngine(echo);
    const progress: Array<[number, number]> = [];
    const summary = await draftSuggestions(db, {
      actor: TEST_ACTOR,
      adapter: engine,
      gate: allowed,
      shouldStop: () => engine.calls.length >= 2,
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(summary).toMatchObject({ stop: 'cancelled', requested: 2, stored: 2 });
    expect(progress.map(([done]) => done)).toEqual([1, 2]);
    expect(progress[0]![1]).toBe(askable(db, new Set()).length);
    db.close();
  });

  it('leaves a locked or confirmed segment alone and drafts only the file asked for', async () => {
    const db = project();
    const engine = createFakeEngine(echo);
    const summary = await draftSuggestions(db, {
      actor: TEST_ACTOR,
      adapter: engine,
      gate: allowed,
      fileId: 999,
    });
    expect(summary).toMatchObject({ stop: 'done', requested: 0 });
    expect(listSegments(db, 1).some((s) => s.locked)).toBeDefined();
    db.close();
  });
});

describe('the suggestion store', () => {
  it('hides a suggestion once the segment’s source is no longer the one it was made for', async () => {
    const db = project();
    await draftSuggestions(db, {
      actor: TEST_ACTOR,
      adapter: createFakeEngine(echo),
      gate: allowed,
    });
    const [one] = listDraftSuggestions(db);
    expect(getDraftSuggestion(db, one!.segmentId)).not.toBeNull();
    db.prepare("UPDATE segment SET source_hash = 'changed' WHERE id = ?").run(
      one!.segmentId,
    );
    expect(getDraftSuggestion(db, one!.segmentId)).toBeNull();
    expect(listDraftSuggestions(db).some((s) => s.segmentId === one!.segmentId)).toBe(
      false,
    );
    db.close();
  });

  it('goes with its segment, so a restructure cannot be blocked by one', async () => {
    const db = project();
    await draftSuggestions(db, {
      actor: TEST_ACTOR,
      adapter: createFakeEngine(echo),
      gate: allowed,
    });
    const [one] = listDraftSuggestions(db);
    db.prepare('DELETE FROM segment WHERE id = ?').run(one!.segmentId);
    expect(
      db
        .prepare('SELECT 1 FROM draft_suggestion WHERE segment_id = ?')
        .get(one!.segmentId),
    ).toBeUndefined();
    db.close();
  });
});

describe('purging suggestions on a withdrawn consent (D15)', () => {
  /** Stores a run's suggestions, then makes the first one a `deepl` draft. */
  async function stored() {
    const db = project();
    await draftSuggestions(db, {
      actor: TEST_ACTOR,
      adapter: createFakeEngine(echo),
      gate: allowed,
    });
    const all = listDraftSuggestions(db);
    putDraftSuggestion(db, { ...all[0]!, engine: 'deepl' });
    return { db, total: all.length };
  }

  it('deletes one engine’s suggestions and no other’s, and logs the count once', async () => {
    const { db, total } = await stored();
    expect(purgeDraftSuggestions(db, { engine: 'tessera', actor: TEST_ACTOR })).toBe(
      total - 1,
    );
    const left = listDraftSuggestions(db);
    expect(left).toHaveLength(1);
    expect(left[0]!.engine).toBe('deepl');

    const events = listEvents(db, { subjectType: 'project' }).filter(
      (e) => e.action === 'draft.purged',
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.actor).toBe('cli:test');
    expect(JSON.parse(events[0]!.detail as string)).toEqual({
      engine: 'tessera',
      count: total - 1,
      reason: 'consent_withdrawn',
    });
    expect(verifyAudit(db)).toMatchObject({ brokenAt: null });
    db.close();
  });

  it('logs nothing when there was nothing to delete', async () => {
    const { db } = await stored();
    purgeDraftSuggestions(db, { engine: 'tessera', actor: TEST_ACTOR });
    expect(purgeDraftSuggestions(db, { engine: 'tessera', actor: TEST_ACTOR })).toBe(0);
    expect(
      listEvents(db, { subjectType: 'project' }).filter(
        (e) => e.action === 'draft.purged',
      ),
    ).toHaveLength(1);
    db.close();
  });

  it('deletes a stale suggestion too, since a hidden row is still derived text, and leaves accepted targets alone', async () => {
    const { db, total } = await stored();
    const [first] = listDraftSuggestions(db);
    db.prepare("UPDATE segment SET source_hash = 'changed' WHERE id = ?").run(
      first!.segmentId,
    );
    // An accepted target: a segment with a written target, which is not a suggestion.
    const accepted = listAllSegments(db).find(
      (s) => s.targetTokens === null && textOf(s) !== '',
    )!;
    setSegmentTarget(db, accepted.id, {
      targetTokens: [{ t: 'text', v: 'Aceptado' }],
      status: 'draft',
      origin: 'mt_draft',
      actor: TEST_ACTOR,
    });

    purgeDraftSuggestions(db, { engine: 'tessera', actor: TEST_ACTOR });
    purgeDraftSuggestions(db, { engine: 'deepl', actor: TEST_ACTOR });
    expect(db.prepare('SELECT COUNT(*) AS n FROM draft_suggestion').get()).toEqual({
      n: 0,
    });
    expect(total).toBeGreaterThan(1);
    expect(listAllSegments(db).find((s) => s.id === accepted.id)!.targetTokens).toEqual([
      { t: 'text', v: 'Aceptado' },
    ]);
    db.close();
  });
});

describe('draftSuggestions for named segments', () => {
  it('asks only about the segments named, still skipping what has a suggestion', async () => {
    const db = project();
    const [a, b] = askable(db, new Set());
    const engine = createFakeEngine(echo);
    const first = await draftSuggestions(db, {
      actor: TEST_ACTOR,
      adapter: engine,
      gate: allowed,
      segmentIds: [b!.id],
    });
    expect(first).toMatchObject({ stop: 'done', requested: 1, stored: 1 });
    expect(getDraftSuggestion(db, b!.id)).not.toBeNull();
    expect(getDraftSuggestion(db, a!.id)).toBeNull();

    const again = await draftSuggestions(db, {
      actor: TEST_ACTOR,
      adapter: engine,
      gate: allowed,
      segmentIds: [b!.id],
    });
    expect(again).toMatchObject({ requested: 0 });
    expect(again.skipped.suggested).toBe(1);
    db.close();
  });
});

describe('acceptDraftSuggestion', () => {
  /** A project whose first askable segment has a suggestion; returns that segment. */
  async function withSuggestion() {
    const db = project();
    const segment = askable(db, new Set())[0]!;
    await draftSuggestions(db, {
      actor: TEST_ACTOR,
      adapter: createFakeEngine(echo, { model: 'm-1' }),
      gate: allowed,
      segmentIds: [segment.id],
    });
    return { db, segment };
  }

  it('writes the draft as a draft with the machine origin, the accepting person as actor and the provenance logged', async () => {
    const { db, segment } = await withSuggestion();
    const suggestion = getDraftSuggestion(db, segment.id)!;
    const result = acceptDraftSuggestion(db, segment.id, {
      actor: TEST_ACTOR,
      baseUpdatedAt: segment.updatedAt,
    });

    expect(result.changed).toBe(true);
    expect(result.segment).toMatchObject({ status: 'draft', origin: 'mt_draft' });
    expect(plainText(result.segment.targetTokens!)).toBe(
      plainText(suggestion.targetTokens),
    );
    expect(result.segment.updatedAt).not.toBe(segment.updatedAt);
    // Consumed: it is the target now.
    expect(getDraftSuggestion(db, segment.id)).toBeNull();

    const event = listEvents(db, {
      subjectType: 'segment',
      subjectId: String(segment.id),
    })
      .filter((e) => e.action === 'segment.target_set')
      .at(-1)!;
    expect(event.actor).toBe('cli:test');
    expect(JSON.parse(event.detail as string)).toMatchObject({
      status: 'draft',
      origin: 'mt_draft',
      provenance: {
        engine: 'tessera',
        model: 'm-1',
        prompt_version: 'tessera-draft-v1',
        input_sha256: suggestion.inputSha256,
      },
    });
    expect(verifyAudit(db)).toMatchObject({ brokenAt: null });
    db.close();
  });

  it('refuses a stale version, keeps the suggestion and writes nothing', async () => {
    const { db, segment } = await withSuggestion();
    expect(() =>
      acceptDraftSuggestion(db, segment.id, {
        actor: TEST_ACTOR,
        baseUpdatedAt: '2000-01-01T00:00:00.000Z',
      }),
    ).toThrow(TargetConflictError);
    expect(getDraftSuggestion(db, segment.id)).not.toBeNull();
    expect(getSegment(db, segment.id)!.targetTokens).toBeNull();
    db.close();
  });

  it('never replaces a target the translator already has', async () => {
    const { db, segment } = await withSuggestion();
    setSegmentTarget(db, segment.id, {
      targetTokens: [{ t: 'text', v: 'Mi propia traducción' }],
      status: 'translated',
      origin: null,
      actor: TEST_ACTOR,
    });
    expect(() => acceptDraftSuggestion(db, segment.id, { actor: TEST_ACTOR })).toThrow(
      TargetConflictError,
    );
    expect(plainText(getSegment(db, segment.id)!.targetTokens!)).toBe(
      'Mi propia traducción',
    );
    expect(getDraftSuggestion(db, segment.id)).not.toBeNull();
    db.close();
  });

  it('has nothing to accept without a current suggestion: none made, or made for another source', async () => {
    const { db, segment } = await withSuggestion();
    const other = askable(db, new Set([segment.sourceHash]))[0]!;
    expect(() => acceptDraftSuggestion(db, other.id, { actor: TEST_ACTOR })).toThrow(
      NoSuggestionError,
    );
    db.prepare("UPDATE segment SET source_hash = 'changed' WHERE id = ?").run(segment.id);
    expect(() => acceptDraftSuggestion(db, segment.id, { actor: TEST_ACTOR })).toThrow(
      NoSuggestionError,
    );
    db.close();
  });

  it('is the translator’s own once they change anything visible, and still the draft’s if they change nothing', async () => {
    const { db, segment } = await withSuggestion();
    const accepted = acceptDraftSuggestion(db, segment.id, { actor: TEST_ACTOR }).segment;

    const same = editSegmentTarget(db, segment.id, {
      tokens: accepted.targetTokens!,
      actor: TEST_ACTOR,
      baseUpdatedAt: accepted.updatedAt,
    });
    expect(same.changed).toBe(false);
    expect(getSegment(db, segment.id)).toMatchObject({
      status: 'draft',
      origin: 'mt_draft',
    });

    const edited = editSegmentTarget(db, segment.id, {
      tokens: [{ t: 'text', v: 'Otra versión' }],
      actor: TEST_ACTOR,
      baseUpdatedAt: accepted.updatedAt,
    });
    expect(edited.segment).toMatchObject({ status: 'translated', origin: null });
    db.close();
  });
});
