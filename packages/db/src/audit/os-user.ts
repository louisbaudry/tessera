/**
 * The actor for a command someone runs from a shell (audit-spec.md
 * §2.1: `cli:<OS user>`, self-asserted — there is no login to check it
 * against). One definition for every shell entry point: the CLI and the
 * server's `create-account` script. `core` never calls `os`, so the
 * lookup lives here, with the other I/O.
 */

import { userInfo } from 'node:os';

import { formatActor, type AuditActor } from '@cat-tool/core';

export class OsUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OsUserError';
  }
}

/** Throws rather than recording an anonymous row (spec decision 3). */
export function osUserActor(): AuditActor {
  let name: string | undefined;
  try {
    name = userInfo().username;
  } catch {
    name = process.env['USER'] ?? process.env['USERNAME'];
  }
  const actor = { kind: 'cli', name: name ?? '' } as const;
  try {
    formatActor(actor);
  } catch {
    throw new OsUserError(
      `cannot record who is running this: no usable OS user name (${JSON.stringify(name ?? null)})`,
    );
  }
  return { actor, label: actor.name };
}
