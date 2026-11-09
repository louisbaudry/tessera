/**
 * Recovers the portal admin's password (issue #364, `planning/portal-v0-spec.md` §7a). Run on the
 * host, like `create-admin`, for an admin who has lost theirs:
 *
 *   pnpm --filter @cat-tool/portal-server run reset-admin-password -- [--tenant <id>] <email>
 *
 * The new password is asked for twice at a hidden prompt, or read from a pipe; it is never an
 * argument. Every session of that admin ends, and `admin.password_reset` names whoever ran it
 * (`cli:<OS user>`, self-asserted like every shell entry point).
 */
import { osUserActor, PasswordInputError, readNewPassword } from '@cat-tool/db';

import { RecoveryError, resetAdminPassword } from './admin-recovery.js';
import { tenantCommand } from './tenant-cli.js';

const { tenant, args } = tenantCommand(process.argv.slice(2));
const [email] = args;
if (!email || args.length !== 1) {
  console.error('usage: reset-admin-password [--tenant <id>] <email>');
  process.exit(1);
}

try {
  // Resolved before the prompt: no user name, no reset (spec decision 3).
  const actor = osUserActor();
  const password = await readNewPassword();
  const { sessionsEnded } = resetAdminPassword({
    dbPath: tenant.dbPath,
    email,
    password,
    actor,
  });
  console.log(
    `Password set for the admin <${email}>; ${sessionsEnded} session(s) ended.`,
  );
} catch (error) {
  if (error instanceof RecoveryError || error instanceof PasswordInputError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
