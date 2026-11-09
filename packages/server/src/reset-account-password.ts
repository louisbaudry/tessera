/**
 * Recovers a CAT app account's password (issue #364, `planning/v1-spec.md` §4.1a). Run on the
 * host, like `create-account`, for someone who has lost theirs:
 *
 *   pnpm --filter @cat-tool/server run reset-account-password -- <email>
 *
 * The new password is asked for twice at a hidden prompt, or read from a pipe; it is never an
 * argument. Every session of that account ends, and `account.password_reset` names whoever ran it
 * (`cli:<OS user>`, self-asserted like every shell entry point).
 */
import { osUserActor, PasswordInputError, readNewPassword } from '@cat-tool/db';

import { RecoveryError, resetAccountPassword } from './account-recovery.js';
import { loadConfig } from './config.js';

// pnpm forwards the `--` that separates its own flags from the script's arguments.
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const [email] = args;
if (!email || args.length !== 1) {
  console.error('usage: reset-account-password <email>');
  process.exit(1);
}

try {
  // Resolved before the prompt: no user name, no reset (spec decision 3).
  const actor = osUserActor();
  const password = await readNewPassword();
  const { sessionsEnded } = resetAccountPassword({
    dbPath: loadConfig().dbPath,
    email,
    password,
    actor,
  });
  console.log(`Password set for <${email}>; ${sessionsEnded} session(s) ended.`);
} catch (error) {
  if (error instanceof RecoveryError || error instanceof PasswordInputError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
