/**
 * The portal admin's password recovery (issue #364, `planning/portal-v0-spec.md` §7a): the work
 * behind `reset-admin-password`. A script cannot be tested, so the command is this function and a
 * thin entry point that reads the password and the tenant.
 */
import { existsSync } from 'node:fs';

import { hashPassword, passwordProblem, type AuditActor } from '@cat-tool/core';
import { openPortalDb, setAdminPassword } from '@cat-tool/db';

/** A refusal the operator can act on; its message never contains a password. */
export class RecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryError';
  }
}

export interface ResetAdminPasswordParams {
  readonly dbPath: string;
  readonly email: string;
  readonly password: string;
  readonly actor: AuditActor;
}

/**
 * Sets a new password for the admin with `email` in the portal file at `dbPath` and ends its
 * sessions. The file must already exist: opening a mistyped path would make an empty portal and
 * report success on nothing. Opening runs any pending migration, as every start does.
 *
 * @returns how many sessions were ended.
 * @throws RecoveryError for a weak password, a missing file or an address no admin has.
 */
export function resetAdminPassword(params: ResetAdminPasswordParams): {
  readonly sessionsEnded: number;
} {
  const problem = passwordProblem(params.password);
  if (problem !== null) throw new RecoveryError(problem);
  if (!existsSync(params.dbPath)) {
    throw new RecoveryError(`no portal database at ${params.dbPath}`);
  }
  const db = openPortalDb(params.dbPath);
  try {
    const result = setAdminPassword(db, params.email, hashPassword(params.password), {
      actor: params.actor,
    });
    if (result === null) throw new RecoveryError('no admin account has this address');
    return result;
  } finally {
    db.close();
  }
}
