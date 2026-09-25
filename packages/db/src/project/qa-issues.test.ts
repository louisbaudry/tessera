import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleFile, rulesFor } from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { insertFile } from './files.js';
import { openProjectDb } from './index.js';
import { createProject } from './project.js';
import {
  addQaIssue,
  dismissQaIssue,
  listFileQaIssues,
  listQaIssues,
  replaceQaIssues,
  runQaRules,
} from './qa-issues.js';
import { setRuleEnabled } from './qa-settings.js';
import { addUntranslatedAllowlistEntry } from './qa-untranslated-allowlist.js';
import { getSegment, listSegments, setSegmentTarget } from './segments.js';
import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { capturePlans, scansOf } from '../query-plan.fixture.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);
const loadDocx = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

let dir: string;
const dbPath = () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-project-repo-'));
  return join(dir, 'project.catdb');
};

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const openWithSegment = () => {
  const db = openProjectDb(dbPath());
  const file = insertFile(
    db,
    'a.docx',
    assembleFile(loadDocx('prose-short.docx'), rulesFor('en')),
    { actor: TEST_ACTOR },
  );
  const [segment] = listSegments(db, file.id);
  return { db, segmentId: segment!.id };
};

describe('addQaIssue / listQaIssues / dismissQaIssue', () => {
  it('adds an issue and lists it back for its segment', () => {
    const { db, segmentId } = openWithSegment();
    const issue = addQaIssue(db, {
      segmentId,
      rule: 'tag.missing',
      severity: 'error',
      message: 'missing <b>',
    });
    expect(listQaIssues(db, segmentId)).toEqual([issue]);
    db.close();
  });

  it('lists across every segment when none is named', () => {
    const { db, segmentId } = openWithSegment();
    addQaIssue(db, { segmentId, rule: 'seg.empty', severity: 'error', message: 'empty' });
    addQaIssue(db, {
      segmentId,
      rule: 'seg.untranslated',
      severity: 'warning',
      message: 'untranslated',
    });
    expect(listQaIssues(db)).toHaveLength(2);
    db.close();
  });

  it("lists one file's issues in document order, dismissed ones included", () => {
    const { db, segmentId } = openWithSegment();
    const other = insertFile(
      db,
      'b.docx',
      assembleFile(loadDocx('prose-short.docx'), rulesFor('en')),
      { actor: TEST_ACTOR },
    );
    const [first, second] = listSegments(db, 1);
    const [elsewhere] = listSegments(db, other.id);
    const late = addQaIssue(db, {
      segmentId: second!.id,
      rule: 'seg.empty',
      severity: 'error',
      message: 'empty',
    });
    const early = addQaIssue(db, {
      segmentId,
      rule: 'seg.untranslated',
      severity: 'warning',
      message: 'untranslated',
    });
    addQaIssue(db, {
      segmentId: elsewhere!.id,
      rule: 'seg.empty',
      severity: 'error',
      message: 'empty',
    });
    dismissQaIssue(db, early.id);

    expect(first!.id).toBe(segmentId);
    expect(listFileQaIssues(db, 1)).toEqual([{ ...early, dismissed: true }, late]);
    expect(listFileQaIssues(db, 999)).toEqual([]);
    db.close();
  });

  it('reads issues by index, never by scanning qa_issue (backlog #28)', () => {
    const { db, segmentId } = openWithSegment();
    addQaIssue(db, { segmentId, rule: 'seg.empty', severity: 'error', message: 'empty' });
    const plans = capturePlans(db, () => {
      listFileQaIssues(db, 1);
      listQaIssues(db, segmentId);
    });
    expect(plans).toHaveLength(2);
    expect(scansOf(plans, ['q', 'qa_issue'])).toEqual([]);
    db.close();
  });

  it('dismissing does not delete the issue', () => {
    const { db, segmentId } = openWithSegment();
    const issue = addQaIssue(db, {
      segmentId,
      rule: 'seg.empty',
      severity: 'error',
      message: 'empty',
    });
    dismissQaIssue(db, issue.id);
    const [after] = listQaIssues(db, segmentId);
    expect(after!.dismissed).toBe(true);
    db.close();
  });
});

describe('replaceQaIssues', () => {
  it('replaces a run wholesale \u2014 old findings that no longer apply disappear', () => {
    const { db, segmentId } = openWithSegment();
    addQaIssue(db, { segmentId, rule: 'seg.empty', severity: 'error', message: 'stale' });

    const fresh = replaceQaIssues(db, segmentId, [
      { rule: 'num.missing', severity: 'error', message: 'missing a number' },
    ]);

    const stored = listQaIssues(db, segmentId);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.rule).toBe('num.missing');
    expect(stored).toEqual(fresh);
    db.close();
  });

  it('an empty findings list clears all issues for that segment', () => {
    const { db, segmentId } = openWithSegment();
    addQaIssue(db, { segmentId, rule: 'seg.empty', severity: 'error', message: 'x' });
    replaceQaIssues(db, segmentId, []);
    expect(listQaIssues(db, segmentId)).toHaveLength(0);
    db.close();
  });

  it('a dismissal survives a rerun that reproduces the same rule', () => {
    const { db, segmentId } = openWithSegment();
    const [issue] = replaceQaIssues(db, segmentId, [
      { rule: 'tag.missing', severity: 'error', message: 'missing tag 1' },
    ]);
    dismissQaIssue(db, issue!.id);

    // The rule fires again with a different message — still the same rule.
    const [rerun] = replaceQaIssues(db, segmentId, [
      { rule: 'tag.missing', severity: 'error', message: 'missing tags 1, 2' },
    ]);

    expect(rerun!.dismissed).toBe(true);
    expect(rerun!.message).toBe('missing tags 1, 2');
    db.close();
  });

  it('a dismissal does not survive once the rule stops firing', () => {
    const { db, segmentId } = openWithSegment();
    const [issue] = replaceQaIssues(db, segmentId, [
      { rule: 'tag.missing', severity: 'error', message: 'missing tag 1' },
    ]);
    dismissQaIssue(db, issue!.id);

    replaceQaIssues(db, segmentId, []); // the problem was fixed
    expect(listQaIssues(db, segmentId)).toHaveLength(0);
    db.close();
  });

  it('a dismissal on one rule never marks a different rule dismissed', () => {
    const { db, segmentId } = openWithSegment();
    const [missing] = replaceQaIssues(db, segmentId, [
      { rule: 'tag.missing', severity: 'error', message: 'missing tag 1' },
    ]);
    dismissQaIssue(db, missing!.id);

    const [, extra] = replaceQaIssues(db, segmentId, [
      { rule: 'tag.missing', severity: 'error', message: 'missing tag 1' },
      { rule: 'tag.extra', severity: 'error', message: 'extra tag 2' },
    ]);

    expect(extra!.dismissed).toBe(false);
    db.close();
  });
});

describe('runQaRules', () => {
  it('throws for a segment that does not exist', () => {
    const { db } = openWithSegment();
    expect(() => runQaRules(db, 999_999)).toThrow(/no segment/);
    db.close();
  });

  /**
   * Copies the segment's real source tags into the target (so tag.missing
   * never fires), appends one tag id no source token uses — extra, and
   * left unclosed, so `tag.extra`/`tag.unbalanced` fire — and appends a
   * text token so the target no longer reads identical to the source,
   * so `seg.untranslated` does not also fire alongside them. The test
   * does not depend on which tags this fixture happens to carry.
   */
  const breakTargetTags = (db: Database.Database, segmentId: number) => {
    const source = getSegment(db, segmentId)!.sourceTokens;
    setSegmentTarget(db, segmentId, {
      actor: TEST_ACTOR,
      targetTokens: [
        ...source,
        { t: 'text', v: ' (translated)' },
        { t: 'open', id: 9999, fmt: 0 },
      ],
      status: 'translated',
      origin: null,
    });
  };

  it('detects a tag problem in the target and persists it', () => {
    const { db, segmentId } = openWithSegment();
    breakTargetTags(db, segmentId);

    const findings = runQaRules(db, segmentId);
    const rules = findings.map((f) => f.rule).sort();
    expect(rules).toEqual(['tag.extra', 'tag.unbalanced']);
    expect(listQaIssues(db, segmentId)).toHaveLength(2);
    db.close();
  });

  it('never reports a rule the project has switched off', () => {
    const { db, segmentId } = openWithSegment();
    breakTargetTags(db, segmentId);
    setRuleEnabled(db, 'tag.extra', false);

    const rules = runQaRules(db, segmentId).map((f) => f.rule);
    expect(rules).toEqual(['tag.unbalanced']);
    db.close();
  });

  it('a dismissed finding from one run stays dismissed on the next', () => {
    const { db, segmentId } = openWithSegment();
    breakTargetTags(db, segmentId);
    const [first] = runQaRules(db, segmentId);
    dismissQaIssue(db, first!.id);

    const rerun = runQaRules(db, segmentId);
    const same = rerun.find((i) => i.rule === first!.rule);
    expect(same!.dismissed).toBe(true);
    db.close();
  });

  it('fires seg.empty for a translated segment with no target', () => {
    const { db, segmentId } = openWithSegment();
    setSegmentTarget(db, segmentId, {
      actor: TEST_ACTOR,
      targetTokens: null,
      status: 'translated',
      origin: null,
    });
    const rules = runQaRules(db, segmentId).map((f) => f.rule);
    expect(rules).toContain('seg.empty');
    db.close();
  });

  it('never fires seg.empty on a locked segment with no target', () => {
    const { db, segmentId } = openWithSegment();
    db.prepare('UPDATE segment SET status = ?, locked = 1 WHERE id = ?').run(
      'locked',
      segmentId,
    );
    const rules = runQaRules(db, segmentId).map((f) => f.rule);
    expect(rules).not.toContain('seg.empty');
    db.close();
  });

  it('fires seg.untranslated when the target equals the source', () => {
    const { db, segmentId } = openWithSegment();
    const source = getSegment(db, segmentId)!.sourceTokens;
    db.prepare('UPDATE segment SET locked = 0 WHERE id = ?').run(segmentId);
    setSegmentTarget(db, segmentId, {
      actor: TEST_ACTOR,
      targetTokens: source,
      status: 'translated',
      origin: null,
    });
    const rules = runQaRules(db, segmentId).map((f) => f.rule);
    expect(rules).toContain('seg.untranslated');
    db.close();
  });

  it('suppresses seg.untranslated for a source_hash on the allow-list', () => {
    const { db, segmentId } = openWithSegment();
    const segment = getSegment(db, segmentId)!;
    db.prepare('UPDATE segment SET locked = 0 WHERE id = ?').run(segmentId);
    setSegmentTarget(db, segmentId, {
      actor: TEST_ACTOR,
      targetTokens: segment.sourceTokens,
      status: 'translated',
      origin: null,
    });
    addUntranslatedAllowlistEntry(db, segment.sourceHash);
    const rules = runQaRules(db, segmentId).map((f) => f.rule);
    expect(rules).not.toContain('seg.untranslated');
    db.close();
  });

  /** Inserts a second segment row directly, sharing `fileId`, for consistency-rule fixtures. */
  const insertSibling = (
    db: Database.Database,
    fileId: number,
    ord: number,
    sourceHash: string,
    sourceText: string,
    targetText: string | null,
  ) => {
    db.prepare(
      `INSERT INTO segment
         (file_id, part, ord, para_key, para_ord, source_tokens, format_table,
          target_tokens, source_hash, status, locked, updated_at)
       VALUES
         (@file_id, 'document', @ord, 'p', 0, @source_tokens, '[]',
          @target_tokens, @source_hash, 'translated', 0, @updated_at)`,
    ).run({
      file_id: fileId,
      ord,
      source_tokens: JSON.stringify([{ t: 'text', v: sourceText }]),
      target_tokens:
        targetText === null ? null : JSON.stringify([{ t: 'text', v: targetText }]),
      source_hash: sourceHash,
      updated_at: new Date().toISOString(),
    });
  };

  it('hands the project language pair to the locale-aware rules, once there is one', () => {
    const { db, segmentId } = openWithSegment();
    db.prepare('UPDATE segment SET locked = 0 WHERE id = ?').run(segmentId);
    setSegmentTarget(db, segmentId, {
      actor: TEST_ACTOR,
      targetTokens: [{ t: 'text', v: 'Saludo?' }],
      status: 'translated',
      origin: null,
    });
    // No identity row yet: no locale, so punct.inverted cannot know this is Spanish.
    expect(runQaRules(db, segmentId).map((f) => f.rule)).not.toContain('punct.inverted');

    createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'es' });
    expect(runQaRules(db, segmentId).map((f) => f.rule)).toContain('punct.inverted');
    db.close();
  });

  it('reads numbers under each side of the project pair: EN 1,000.50 is FR 1\u202F000,50', () => {
    const { db, segmentId } = openWithSegment();
    const { fileId } = getSegment(db, segmentId)!;
    createProject(db, { name: 'p', srcLang: 'en-GB', tgtLang: 'fr-FR' });
    const idAt = (ord: number) =>
      (db.prepare('SELECT id FROM segment WHERE ord = ?').get(ord) as { id: number }).id;

    insertSibling(
      db,
      fileId,
      9003,
      'h-ok',
      'Pay 1,000.50 now.',
      'Payez 1\u202F000,50 maintenant.',
    );
    const okRules = runQaRules(db, idAt(9003)).map((f) => f.rule);
    expect(okRules.filter((r) => r.startsWith('num.') || r.startsWith('punct.'))).toEqual(
      [],
    );

    insertSibling(
      db,
      fileId,
      9004,
      'h-alt',
      'Pay 1,000.50 now.',
      'Payez 1.000,50 maintenant.',
    );
    const altered = runQaRules(db, idAt(9004)).find((f) => f.rule === 'num.altered');
    expect(altered?.message).toBe('Number reformatted: 1,000.50 \u2192 1.000,50');
    db.close();
  });

  it('fires consistency.target_differs when the same source was rendered differently elsewhere', () => {
    const { db, segmentId } = openWithSegment();
    const segment = getSegment(db, segmentId)!;
    db.prepare('UPDATE segment SET locked = 0 WHERE id = ?').run(segmentId);
    setSegmentTarget(db, segmentId, {
      actor: TEST_ACTOR,
      targetTokens: [{ t: 'text', v: 'Rendering A' }],
      status: 'translated',
      origin: null,
    });
    insertSibling(
      db,
      segment.fileId,
      9001,
      segment.sourceHash,
      'irrelevant',
      'Rendering B',
    );

    const findings = runQaRules(db, segmentId);
    const found = findings.find((f) => f.rule === 'consistency.target_differs');
    expect(found).toBeDefined();
    expect(found!.message).toContain('Rendering B');
    db.close();
  });

  it('fires consistency.source_differs when the same rendering came from a different source', () => {
    const { db, segmentId } = openWithSegment();
    const segment = getSegment(db, segmentId)!;
    db.prepare('UPDATE segment SET locked = 0 WHERE id = ?').run(segmentId);
    setSegmentTarget(db, segmentId, {
      actor: TEST_ACTOR,
      targetTokens: [{ t: 'text', v: 'Shared rendering' }],
      status: 'translated',
      origin: null,
    });
    insertSibling(
      db,
      segment.fileId,
      9002,
      `${segment.sourceHash}-different`,
      'A different source sentence',
      'Shared rendering',
    );

    const findings = runQaRules(db, segmentId);
    const found = findings.find((f) => f.rule === 'consistency.source_differs');
    expect(found).toBeDefined();
    expect(found!.message).toContain('A different source sentence');
    db.close();
  });
});
