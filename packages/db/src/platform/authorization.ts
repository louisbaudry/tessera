/**
 * `project_authorization` (vendor-spec.md §3 implementation note; backlog
 * #45): what an owner has granted another account on one of their
 * projects. A project is named as `audit.ts` names it, by its owner and
 * slug; the owner's own access is the path and has no row.
 *
 * Every write records its `authorization.granted` / `.revoked` event in
 * the same transaction, with a required actor (audit-spec.md §2.5). Nothing
 * here decides who may grant: that is the caller's rule (`#51`'s route).
 */

import { isProjectScope, type AuditActor, type ProjectScope } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';
import { projectSubjectId, type ProjectRef } from './audit.js';

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export interface ProjectAuthorization {
  /** The account that was given access. */
  readonly accountId: number;
  readonly project: ProjectRef;
  readonly scope: ProjectScope;
  readonly grantedAt: string;
}

interface Row {
  account_id: number;
  owner_id: number;
  project_name: string;
  scope: ProjectScope;
  granted_at: string;
}

const fromRow = (r: Row): ProjectAuthorization => ({
  accountId: r.account_id,
  project: { accountId: r.owner_id, name: r.project_name },
  scope: r.scope,
  grantedAt: r.granted_at,
});

export interface GrantOptions {
  readonly accountId: number;
  readonly project: ProjectRef;
  readonly scope: ProjectScope;
  /** Who granted it — required (audit-spec.md decision 3). */
  readonly actor: AuditActor;
}

/**
 * Gives `accountId` a scope on a project. Granting what the account
 * already has changes and records nothing; granting a different scope
 * replaces the old one, as a revoke and a grant in the log. The owner
 * cannot be granted their own project, and neither account may be missing.
 */
export function grantProjectAuthorization(
  db: Database.Database,
  options: GrantOptions,
): void {
  if (!isProjectScope(options.scope)) {
    throw new AuthorizationError(`unknown scope "${String(options.scope)}"`);
  }
  if (options.accountId === options.project.accountId) {
    throw new AuthorizationError('an owner already has their own project');
  }
  db.transaction(() => {
    for (const id of [options.accountId, options.project.accountId]) {
      if (!db.prepare('SELECT 1 FROM account WHERE id = ?').get(id)) {
        throw new AuthorizationError(`no account #${id}`);
      }
    }
    const existing = scopeOf(db, options.accountId, options.project);
    if (existing === options.scope) return;
    if (existing !== null)
      removeRow(db, options.accountId, options.project, existing, options.actor);
    db.prepare(
      `INSERT INTO project_authorization
         (account_id, owner_id, project_name, scope, granted_at)
       VALUES (@account_id, @owner_id, @project_name, @scope, @granted_at)`,
    ).run({
      account_id: options.accountId,
      owner_id: options.project.accountId,
      project_name: options.project.name,
      scope: options.scope,
      granted_at: new Date().toISOString(),
    });
    appendAuditEvent(db, {
      actor: options.actor,
      action: 'authorization.granted',
      subjectType: 'project',
      subjectId: projectSubjectId(options.project),
      detail: { grantee: options.accountId, scope: options.scope },
    });
  })();
}

function removeRow(
  db: Database.Database,
  accountId: number,
  project: ProjectRef,
  scope: ProjectScope,
  actor: AuditActor,
): void {
  db.prepare(
    'DELETE FROM project_authorization WHERE account_id = ? AND owner_id = ? AND project_name = ?',
  ).run(accountId, project.accountId, project.name);
  appendAuditEvent(db, {
    actor,
    action: 'authorization.revoked',
    subjectType: 'project',
    subjectId: projectSubjectId(project),
    detail: { grantee: accountId, scope },
  });
}

/** Takes access away. Revoking what was never granted does nothing and records nothing: `false`. */
export function revokeProjectAuthorization(
  db: Database.Database,
  options: { accountId: number; project: ProjectRef; actor: AuditActor },
): boolean {
  return db.transaction((): boolean => {
    const scope = scopeOf(db, options.accountId, options.project);
    if (scope === null) return false;
    removeRow(db, options.accountId, options.project, scope, options.actor);
    return true;
  })();
}

/**
 * Takes away every grant on a project, as its deletion must: a grant that
 * outlived its project would give the next project of that name, and the
 * next owner's work, to whoever held it. Returns how many it removed.
 */
export function revokeAllProjectAuthorizations(
  db: Database.Database,
  options: { project: ProjectRef; actor: AuditActor },
): number {
  return db.transaction((): number => {
    const rows = db
      .prepare(
        'SELECT * FROM project_authorization WHERE owner_id = ? AND project_name = ? ORDER BY id',
      )
      .all(options.project.accountId, options.project.name) as Row[];
    for (const r of rows) {
      removeRow(db, r.account_id, options.project, r.scope, options.actor);
    }
    return rows.length;
  })();
}

/** What `accountId` was granted on the project, or null: no row is no access. */
export function scopeOf(
  db: Database.Database,
  accountId: number,
  project: ProjectRef,
): ProjectScope | null {
  const row = db
    .prepare(
      'SELECT scope FROM project_authorization WHERE account_id = ? AND owner_id = ? AND project_name = ?',
    )
    .get(accountId, project.accountId, project.name) as
    { scope: ProjectScope } | undefined;
  return row?.scope ?? null;
}

/** Everything granted to an account, oldest first. */
export function listAuthorizationsFor(
  db: Database.Database,
  accountId: number,
): ProjectAuthorization[] {
  return (
    db
      .prepare('SELECT * FROM project_authorization WHERE account_id = ? ORDER BY id')
      .all(accountId) as Row[]
  ).map(fromRow);
}

/** Everything granted on any of one owner's projects, oldest first. */
export function listAuthorizationsByOwner(
  db: Database.Database,
  ownerId: number,
): ProjectAuthorization[] {
  return (
    db
      .prepare('SELECT * FROM project_authorization WHERE owner_id = ? ORDER BY id')
      .all(ownerId) as Row[]
  ).map(fromRow);
}

/** Everything granted on one project, oldest first. */
export function listAuthorizationsOn(
  db: Database.Database,
  project: ProjectRef,
): ProjectAuthorization[] {
  return (
    db
      .prepare(
        'SELECT * FROM project_authorization WHERE owner_id = ? AND project_name = ? ORDER BY id',
      )
      .all(project.accountId, project.name) as Row[]
  ).map(fromRow);
}
