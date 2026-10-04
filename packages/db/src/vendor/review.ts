/**
 * Reviewing a delivered assignment (vendor-spec.md §4 and its #51 note): the
 * PM's sign-off, gated on the project having no blocking QA issue. The gate
 * is a precondition beside `transitionAssignment`, never inside it (#47), and
 * it has no override: a PM who must close over a blocking issue dismisses it,
 * which is logged (`qa.dismissed`).
 */

import { isBlocking, type AuditActor } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { listQaIssues } from '../project/qa-issues.js';
import { getAssignment, moveAssignment, type Assignment } from './assignments.js';
import { VendorError } from './error.js';

/** The project still has a blocking QA issue: a route's 409. */
export class ReviewBlockedError extends VendorError {
  constructor(
    message: string,
    /** How many blocking issues remain. */
    readonly blocking: number,
  ) {
    super(message);
    this.name = 'ReviewBlockedError';
  }
}

/** Blocking QA issues in a project: what `qa`'s exit status counts (`isBlocking`). */
export function countBlockingQa(project: Database.Database): number {
  return listQaIssues(project).filter(isBlocking).length;
}

export interface ReviewOptions {
  readonly assignmentId: number;
  readonly note?: string | null;
  /** The PM: required (audit-spec.md decision 3). */
  readonly actor: AuditActor;
  readonly now?: Date;
}

/**
 * `delivered → reviewed`, as the PM, if the project has no blocking issue.
 * An assignment that is not `delivered` is the machine's error (409), not the
 * gate's: the gate speaks only about a job that could otherwise be closed.
 */
export function reviewAssignment(
  roster: Database.Database,
  project: Database.Database,
  options: ReviewOptions,
): Assignment {
  const before = getAssignment(roster, options.assignmentId);
  if (before?.status === 'delivered') {
    const blocking = countBlockingQa(project);
    if (blocking > 0) {
      throw new ReviewBlockedError(
        `${blocking} blocking QA issue${blocking === 1 ? '' : 's'} remain: ` +
          `fix or dismiss them before reviewing`,
        blocking,
      );
    }
  }
  return moveAssignment(roster, {
    assignmentId: options.assignmentId,
    to: 'reviewed',
    by: 'pm',
    actor: options.actor,
    note: options.note ?? null,
    now: options.now,
  });
}
