import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { exportFile, getFile, listFiles } from '@cat-tool/db';

import {
  CliError,
  integer,
  openExistingProject,
  parse,
  positional,
  type CliIo,
} from '../support.js';

export const EXPORT_USAGE = 'cat-tool export <project.catdb> [--out <dir>] [--file <id>]';

/**
 * Writes every file (or one) back to DOCX under its original `rel_path`
 * in `--out`, targets spliced in per v1-spec.md §3.4's fold rule.
 */
export function exportCommand(args: readonly string[], io: CliIo): number {
  const { values, positionals } = parse(args, {
    out: { type: 'string' },
    file: { type: 'string' },
  });
  const projectPath = positional(positionals, 0, 'project path', EXPORT_USAGE);
  const fileId = integer(values.file, '--file');
  const outDir = resolve(values.out ?? '.');

  const { db } = openExistingProject(projectPath);
  try {
    let ids: number[];
    if (fileId === undefined) {
      ids = listFiles(db).map((f) => f.id);
    } else {
      if (!getFile(db, fileId)) throw new CliError(`no file #${fileId} in this project`);
      ids = [fileId];
    }
    if (ids.length === 0) {
      throw new CliError('project has no files to export');
    }

    for (const id of ids) {
      const { file, bytes, summary } = exportFile(db, id);
      const outPath = join(outDir, file.relPath);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, bytes);
      io.stdout(
        `Wrote ${outPath}: ${summary.paragraphsRendered}/${summary.paragraphs} paragraphs ` +
          `rebuilt, ${summary.segmentsWithTarget}/${summary.segments} segments with a target`,
      );
    }
  } finally {
    db.close();
  }
  return 0;
}
