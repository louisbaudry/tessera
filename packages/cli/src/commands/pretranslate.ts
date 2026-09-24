import { getFile, pretranslate as runPretranslate } from '@cat-tool/db';

import {
  CliError,
  cliActor,
  integer,
  openExistingProject,
  parse,
  positional,
  type CliIo,
} from '../support.js';

export const PRETRANSLATE_USAGE = 'cat-tool pretranslate <project.catdb> [--file <id>]';

/** The exact matcher over every eligible segment (v1-spec.md §6.1). */
export function pretranslate(args: readonly string[], io: CliIo): number {
  const { values, positionals } = parse(args, { file: { type: 'string' } });
  const projectPath = positional(positionals, 0, 'project path', PRETRANSLATE_USAGE);
  const fileId = integer(values.file, '--file');

  const { db } = openExistingProject(projectPath);
  try {
    if (fileId !== undefined && !getFile(db, fileId)) {
      throw new CliError(`no file #${fileId} in this project`);
    }
    const s = runPretranslate(db, {
      actor: cliActor(),
      ...(fileId === undefined ? {} : { fileId }),
    });
    io.stdout(
      `Pre-translated: ${s.exact} exact, ${s.tagdiff} tag-diff (draft), ` +
        `${s.propagated} propagated, ${s.unmatched} unmatched, ` +
        `${s.skipped} skipped (confirmed or locked)`,
    );
  } finally {
    db.close();
  }
  return 0;
}
