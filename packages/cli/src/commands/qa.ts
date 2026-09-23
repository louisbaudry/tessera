import { isBlocking, type QaIssue } from '@cat-tool/core';
import { getFile, listAllSegments, listSegments, runQaRules } from '@cat-tool/db';

import {
  CliError,
  integer,
  openExistingProject,
  parse,
  positional,
  type CliIo,
} from '../support.js';

export const QA_USAGE = 'cat-tool qa <project.catdb> [--file <id>]';

/**
 * Runs every enabled rule over every segment and lists what it found.
 * Exit status 1 when a blocking issue remains (`isBlocking`: severity
 * `error`, not dismissed) — the one definition of "must not ship".
 */
export function qa(args: readonly string[], io: CliIo): number {
  const { values, positionals } = parse(args, { file: { type: 'string' } });
  const projectPath = positional(positionals, 0, 'project path', QA_USAGE);
  const fileId = integer(values.file, '--file');

  const { db } = openExistingProject(projectPath);
  let issues: QaIssue[];
  let segmentCount: number;
  try {
    if (fileId !== undefined && !getFile(db, fileId)) {
      throw new CliError(`no file #${fileId} in this project`);
    }
    const segments =
      fileId === undefined ? listAllSegments(db) : listSegments(db, fileId);
    segmentCount = segments.length;
    issues = segments.flatMap((s) => runQaRules(db, s.id));
  } finally {
    db.close();
  }

  for (const issue of issues) {
    io.stdout(
      `#${issue.segmentId}\t${issue.severity}\t${issue.rule}\t${issue.message}` +
        (issue.dismissed ? '\t(dismissed)' : ''),
    );
  }
  const count = (severity: QaIssue['severity']) =>
    issues.filter((i) => i.severity === severity).length;
  const blocking = issues.filter(isBlocking).length;
  io.stdout(
    `QA: ${issues.length} issues across ${segmentCount} segments — ` +
      `${count('error')} errors, ${count('warning')} warnings, ${count('info')} info; ` +
      `${blocking} blocking`,
  );
  return blocking > 0 ? 1 : 0;
}
