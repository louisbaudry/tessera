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

export const PRETRANSLATE_USAGE =
  'cat-tool pretranslate <project.catdb> [--file <id>] [--fuzzy <50-99|off>]';

/**
 * The exact matcher over every eligible segment (v1-spec.md §6.1), then fuzzy
 * matches from a threshold up: the project's setting (default 75), or this run's `--fuzzy <50-99|off>` (§6.1a).
 */
export function pretranslate(args: readonly string[], io: CliIo): number {
  const { values, positionals } = parse(args, {
    file: { type: 'string' },
    fuzzy: { type: 'string' },
  });
  const projectPath = positional(positionals, 0, 'project path', PRETRANSLATE_USAGE);
  const fileId = integer(values.file, '--file');
  const fuzzyThreshold =
    values.fuzzy === undefined
      ? undefined
      : values.fuzzy === 'off'
        ? null
        : integer(values.fuzzy, '--fuzzy');

  const { db } = openExistingProject(projectPath);
  try {
    if (fileId !== undefined && !getFile(db, fileId)) {
      throw new CliError(`no file #${fileId} in this project`);
    }
    const s = runPretranslate(db, {
      actor: cliActor(),
      ...(fileId === undefined ? {} : { fileId }),
      ...(fuzzyThreshold === undefined ? {} : { fuzzyThreshold }),
    });
    io.stdout(
      `Pre-translated: ${s.exact} exact, ${s.tagdiff} tag-diff (draft), ` +
        `${s.fuzzy} fuzzy (draft), ` +
        `${s.propagated} propagated, ${s.unmatched} unmatched, ` +
        `${s.skipped} skipped (confirmed or locked)`,
    );
  } finally {
    db.close();
  }
  return 0;
}
