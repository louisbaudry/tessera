/**
 * Command dispatch (v1-spec.md §2.4; backlog #25).
 *
 * Each command is one repository call with argument parsing and
 * printing around it — never a second implementation of anything
 * `core` or `db` does. `runCli` is synchronous because every call it
 * makes is; a test drives a whole job through it with no process
 * spawned.
 */

import { addFile, ADD_FILE_USAGE } from './commands/add-file.js';
import { addTm, ADD_TM_USAGE } from './commands/add-tm.js';
import { auditVerify, AUDIT_VERIFY_USAGE } from './commands/audit-verify.js';
import { exportCommand, EXPORT_USAGE } from './commands/export.js';
import { history, HISTORY_USAGE } from './commands/history.js';
import { init, INIT_USAGE } from './commands/init.js';
import { pretranslate, PRETRANSLATE_USAGE } from './commands/pretranslate.js';
import { qa, QA_USAGE } from './commands/qa.js';
import type { CliIo } from './support.js';

export type { CliIo } from './support.js';
export { CliError } from './support.js';

export type Command = (args: readonly string[], io: CliIo) => number;

const COMMANDS: ReadonlyMap<string, Command> = new Map<string, Command>([
  ['init', init],
  ['add-file', addFile],
  ['add-tm', addTm],
  ['pretranslate', pretranslate],
  ['qa', qa],
  ['export', exportCommand],
  ['history', history],
  ['audit-verify', auditVerify],
]);

export const USAGE = [
  'usage: cat-tool <command> [arguments]',
  '',
  `  ${INIT_USAGE}`,
  `  ${ADD_FILE_USAGE}`,
  `  ${ADD_TM_USAGE}`,
  `  ${PRETRANSLATE_USAGE}`,
  `  ${QA_USAGE}`,
  `  ${EXPORT_USAGE}`,
  `  ${HISTORY_USAGE}`,
  `  ${AUDIT_VERIFY_USAGE}`,
].join('\n');

/** Runs one command; returns the process exit status. */
export function runCli(argv: readonly string[], io: CliIo): number {
  const [name, ...rest] = argv;
  if (name === undefined || name === '--help' || name === '-h') {
    io.stdout(USAGE);
    return name === undefined ? 1 : 0;
  }
  const command = COMMANDS.get(name);
  if (!command) {
    io.stderr(`unknown command "${name}"\n${USAGE}`);
    return 1;
  }
  try {
    return command(rest, io);
  } catch (err) {
    io.stderr(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
