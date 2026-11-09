/**
 * The CAT app account's password recovery (issue #364, `planning/v1-spec.md` §4.1a): the work
 * behind `reset-account-password`. The command is this function and a thin entry point.
 */
import { existsSync } from 'node:fs';

import { hashPassword, passwordProblem, type AuditActor } from '@cat-tool/core';
import { openPlatformDb, setAccountPassword } from '@cat-tool/db';

/** A refusal the operator can act on; its message never contains a password. */
export class RecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryError';
  }
}

export interface ResetAccountPasswordParams {
  readonly dbPath: string;
  readonly email: string;
  readonly password: string;
  readonly actor: AuditActor;
}

/**
 * Sets a new password for the account with `email` in `platform.sqlite` at `dbPath` and ends its
 * sessions. The file must already exist: opening a mistyped path would make an empty platform
 * database and report success on nothing.
 *
 * @returns how many sessions were ended.
 * @throws RecoveryError for a weak password, a missing file or an address no account has.
 */
export function resetAccountPassword(params: ResetAccountPasswordParams): {
  readonly sessionsEnded: number;
} {
  const problem = passwordProblem(params.password);
  if (problem !== null) throw new RecoveryError(problem);
  if (!existsSync(params.dbPath)) {
    throw new RecoveryError(`no platform database at ${params.dbPath}`);
  }
  const db = openPlatformDb(params.dbPath);
  try {
    const result = setAccountPassword(db, params.email, hashPassword(params.password), {
      actor: params.actor,
    });
    if (result === null) throw new RecoveryError('no account has this address');
    return result;
  } finally {
    db.close();
  }
}
