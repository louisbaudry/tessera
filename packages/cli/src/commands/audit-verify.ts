import { verifyAudit } from '@cat-tool/db';

import { openExistingProject, parse, positional, type CliIo } from '../support.js';

export const AUDIT_VERIFY_USAGE = 'cat-tool audit-verify <project.catdb>';

/**
 * Recomputes the project's audit hash chain (audit-spec.md §3); exit 1
 * if it is broken. What a green run does and does not prove is §3.1.
 */
export function auditVerify(args: readonly string[], io: CliIo): number {
  const { positionals } = parse(args, {});
  const projectPath = positional(positionals, 0, 'project path', AUDIT_VERIFY_USAGE);

  const { db } = openExistingProject(projectPath);
  try {
    const { events, brokenAt } = verifyAudit(db);
    if (brokenAt !== null) {
      io.stdout(`Audit chain BROKEN at event #${brokenAt} (${events} events)`);
      return 1;
    }
    io.stdout(`Audit chain intact: ${events} events`);
    return 0;
  } finally {
    db.close();
  }
}
