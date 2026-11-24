/**
 * What a draft run spent, kept beside the project (issue #150, `translation-engine-spec.md`
 * D12 note): one row per reply the engine sent back, units only, never text. The owner's
 * spend view is a sum over these rows.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assembleFile,
  createFakeEngine,
  rulesFor,
  type DraftEngineAdapter,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { readAiUsage, sumAiUsage, type AiUsageRow } from './ai-usage.js';
import { draftSuggestions } from './draft.js';
import { insertFile } from './files.js';
import { openProjectDb } from './index.js';
import { createProject } from './project.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function project(): Database.Database {
  dir = mkdtempSync(join(tmpdir(), 'cat-ai-usage-'));
  const db = openProjectDb(join(dir, 'project.catdb'));
  createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'es' });
  const bytes = new Uint8Array(readFileSync(join(FIXTURES, 'prose-long.docx')));
  insertFile(db, 'prose-long.docx', assembleFile(bytes, rulesFor('en')), {
    actor: TEST_ACTOR,
  });
  return db;
}

const allowed = () => ({ engine: 'tessera' as const });
const echo = (req: { sourceText: string }) => req.sourceText;

describe('the AI usage record', () => {
  it('is empty for a project nothing was drafted in', () => {
    const db = project();
    expect(readAiUsage(db)).toEqual({ rows: [], calls: 0 });
    db.close();
  });

  it('records each reply by engine and model, in the engine’s own unit', async () => {
    const db = project();
    const engine = createFakeEngine(echo, { model: 'm-1' }); // 100 in, 20 out a reply
    const summary = await draftSuggestions(db, {
      actor: TEST_ACTOR,
      adapter: engine,
      gate: allowed,
    });
    const usage = readAiUsage(db);
    expect(usage.calls).toBe(summary.requested);
    expect(usage.rows).toEqual([
      {
        engine: 'tessera',
        model: 'm-1',
        unit: 'tokens',
        calls: summary.requested,
        inputUnits: 100 * summary.requested,
        outputUnits: 20 * summary.requested,
        stored: summary.stored,
        rejected: 0,
        discarded: 0,
      },
    ]);
    db.close();
  });

  it('counts a refused reply as spent, and says it was refused', async () => {
    const db = project();
    const engine = createFakeEngine('<t9/> not a draft');
    const summary = await draftSuggestions(db, {
      actor: TEST_ACTOR,
      adapter: engine,
      gate: allowed,
    });
    expect(readAiUsage(db).rows).toMatchObject([
      { calls: summary.requested, stored: 0, rejected: summary.requested, discarded: 0 },
    ]);
    db.close();
  });

  it('counts a reply dropped because consent was withdrawn mid-call as spent too', async () => {
    const db = project();
    let open = true;
    const inFlight: DraftEngineAdapter = {
      engine: 'tessera',
      model: 'm-1',
      draft: (request) => {
        open = false;
        return Promise.resolve({
          text: request.sourceText,
          model: 'm-1',
          usage: { inputTokens: 50, outputTokens: 5 },
        });
      },
    };
    await draftSuggestions(db, {
      actor: TEST_ACTOR,
      adapter: inFlight,
      gate: () =>
        open ? { engine: 'tessera' } : { engine: 'off', reason: 'not_consented' },
    });
    expect(readAiUsage(db).rows).toMatchObject([
      { calls: 1, inputUnits: 50, outputUnits: 5, stored: 0, discarded: 1 },
    ]);
    db.close();
  });

  it('keeps DeepL apart, counted in characters', async () => {
    const db = project();
    const engine = createFakeEngine(
      (req) => ({
        text: req.sourceText,
        model: 'deepl-1',
        usage: { inputTokens: [...req.sourceText].length, outputTokens: 0 },
      }),
      { engine: 'deepl', model: 'deepl-1' },
    );
    await draftSuggestions(db, {
      actor: TEST_ACTOR,
      adapter: engine,
      gate: () => ({ engine: 'deepl' }),
    });
    const rows = readAiUsage(db).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      engine: 'deepl',
      unit: 'characters',
      outputUnits: 0,
    });
    expect(rows[0]!.inputUnits).toBeGreaterThan(0);
    db.close();
  });

  it('adds nothing for a call that failed before any reply', async () => {
    const db = project();
    const failing: DraftEngineAdapter = {
      engine: 'tessera',
      model: 'm-1',
      draft: () => Promise.reject(new Error('network down')),
    };
    await draftSuggestions(db, { actor: TEST_ACTOR, adapter: failing, gate: allowed });
    expect(readAiUsage(db)).toEqual({ rows: [], calls: 0 });
    db.close();
  });

  it('is append-only: the schema refuses an edit or a delete', async () => {
    const db = project();
    await draftSuggestions(db, {
      actor: TEST_ACTOR,
      adapter: createFakeEngine(echo),
      gate: allowed,
      tokenCeiling: 1,
    });
    expect(() => db.prepare('UPDATE ai_usage SET input_units = 0').run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare('DELETE FROM ai_usage').run()).toThrow(/append-only/);
    db.close();
  });
});

describe('sumAiUsage', () => {
  const row = (over: Partial<AiUsageRow>): AiUsageRow => ({
    engine: 'tessera',
    model: 'm-1',
    unit: 'tokens',
    calls: 1,
    inputUnits: 10,
    outputUnits: 2,
    stored: 1,
    rejected: 0,
    discarded: 0,
    ...over,
  });

  it('merges rows of one engine, model and unit, and keeps the rest apart in order', () => {
    const total = sumAiUsage([
      {
        rows: [row({}), row({ engine: 'deepl', model: 'd', unit: 'characters' })],
        calls: 2,
      },
      {
        rows: [row({ calls: 2, inputUnits: 5, outputUnits: 1, stored: 0, rejected: 2 })],
        calls: 2,
      },
    ]);
    expect(total.calls).toBe(4);
    expect(total.rows).toEqual([
      row({ engine: 'deepl', model: 'd', unit: 'characters' }),
      row({ calls: 3, inputUnits: 15, outputUnits: 3, stored: 1, rejected: 2 }),
    ]);
  });

  it('is empty for no projects', () => {
    expect(sumAiUsage([])).toEqual({ rows: [], calls: 0 });
  });
});
