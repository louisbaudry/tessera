/** Reviewing a delivered assignment (backlog #51; vendor-spec.md §4 and its #51 note). */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleFile, rulesFor } from '@cat-tool/core';
import { InvalidAssignmentTransitionError } from '@cat-tool/vendor-core';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { insertFile } from '../project/files.js';
import { openProjectDb } from '../project/index.js';
import { addQaIssue, dismissQaIssue } from '../project/qa-issues.js';
import { listSegments } from '../project/segments.js';
import {
  addVendor,
  countBlockingQa,
  createDirectOffer,
  createVendorFile,
  getAssignment,
  listAssignmentEvents,
  listAssignments,
  moveAssignment,
  ReviewBlockedError,
  reviewAssignment,
} from './index.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx/prose-short.docx',
);
const NOW = new Date('2026-03-01T10:00:00Z');
const owner = { ...TEST_ACTOR, label: 'owner' };
const vendorActor = { ...TEST_ACTOR, label: 'vendor' };

let dir: string;
let roster: Database;
let project: Database;
let ana: number;
let segmentId: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-review-'));
  roster = createVendorFile(join(dir, 'vendors.ctv'), { generator: 'test' });
  ana = addVendor(roster, { accountId: 10, actor: TEST_ACTOR }).id;
  project = openProjectDb(join(dir, 'project.catdb'));
  const file = insertFile(
    project,
    'a.docx',
    assembleFile(new Uint8Array(readFileSync(FIXTURE)), rulesFor('en')),
    { actor: TEST_ACTOR },
  );
  segmentId = listSegments(project, file.id)[0]!.id;
});
afterEach(() => {
  roster.close();
  project.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** An assignment taken all the way to `delivered`. */
function delivered(): number {
  const a = createDirectOffer(roster, {
    projectName: 'p',
    vendorId: ana,
    actor: owner,
    now: NOW,
  });
  for (const to of ['accepted', 'in_progress', 'delivered'] as const) {
    moveAssignment(roster, {
      assignmentId: a.id,
      vendorId: ana,
      to,
      by: 'vendor',
      actor: vendorActor,
      now: NOW,
    });
  }
  return a.id;
}

const issue = (severity: 'error' | 'warning') =>
  addQaIssue(project, {
    segmentId,
    rule: 'tag.missing',
    severity,
    message: 'x',
  });

describe('reviewAssignment', () => {
  it('closes a delivered job as the PM, with the PM in the log, when nothing blocks', () => {
    const id = delivered();
    const reviewed = reviewAssignment(roster, project, {
      assignmentId: id,
      note: 'read it, fine',
      actor: owner,
      now: NOW,
    });
    expect(reviewed.status).toBe('reviewed');
    expect(listAssignmentEvents(roster, id).at(-1)).toMatchObject({
      from: 'delivered',
      to: 'reviewed',
      actorLabel: 'owner',
      note: 'read it, fine',
    });
  });

  it('is refused, saying how many, while a blocking issue remains, and the job stays delivered', () => {
    const id = delivered();
    issue('error');
    expect(countBlockingQa(project)).toBe(1);
    let err: unknown;
    try {
      reviewAssignment(roster, project, { assignmentId: id, actor: owner, now: NOW });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ReviewBlockedError);
    expect((err as ReviewBlockedError).blocking).toBe(1);
    expect(getAssignment(roster, id)!.status).toBe('delivered');
  });

  it('lets a warning through: only an undismissed error blocks (isBlocking)', () => {
    const id = delivered();
    issue('warning');
    expect(countBlockingQa(project)).toBe(0);
    expect(
      reviewAssignment(roster, project, { assignmentId: id, actor: owner, now: NOW })
        .status,
    ).toBe('reviewed');
  });

  it('is open to a PM who dismisses the blocking issue, which is its own logged act', () => {
    const id = delivered();
    issue('error');
    dismissQaIssue(project, { segmentId, rule: 'tag.missing' }, { actor: owner });
    expect(countBlockingQa(project)).toBe(0);
    expect(
      reviewAssignment(roster, project, { assignmentId: id, actor: owner, now: NOW })
        .status,
    ).toBe('reviewed');
  });

  it('answers a job not yet delivered with the machine’s error, whatever the QA state', () => {
    issue('error');
    const a = createDirectOffer(roster, {
      projectName: 'p',
      vendorId: ana,
      actor: owner,
      now: NOW,
    });
    expect(() =>
      reviewAssignment(roster, project, { assignmentId: a.id, actor: owner }),
    ).toThrow(InvalidAssignmentTransitionError);
  });

  it('cannot be done twice: reviewed is terminal', () => {
    const id = delivered();
    reviewAssignment(roster, project, { assignmentId: id, actor: owner, now: NOW });
    expect(() =>
      reviewAssignment(roster, project, { assignmentId: id, actor: owner }),
    ).toThrow(InvalidAssignmentTransitionError);
  });
});

describe('listAssignments', () => {
  it('is every assignment on the roster, newest first', () => {
    const a = delivered();
    const b = delivered();
    expect(listAssignments(roster).map((x) => x.id)).toEqual([b, a]);
  });
});
