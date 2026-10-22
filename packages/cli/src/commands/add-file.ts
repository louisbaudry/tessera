import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

import {
  assembleFile,
  assembleXliff,
  fileKindOfName,
  rulesFor,
  XliffError,
  type AssembledFile,
  type SegmenterRules,
} from '@cat-tool/core';
import { insertFile } from '@cat-tool/db';

import {
  CliError,
  cliActor,
  openExistingProject,
  parse,
  positional,
  type CliIo,
} from '../support.js';

export const ADD_FILE_USAGE =
  'cat-tool add-file <project.catdb> <file.docx|file.xlf> [--rel-path <name>]';

/**
 * Imports a DOCX (tokenised, sentence-segmented, hashed) or an XLIFF 2.x file
 * (read as it is segmented, `v1-spec.md` §3.8; the extension picks), persisted
 * as one unit.
 */
export function addFile(args: readonly string[], io: CliIo): number {
  const { values, positionals } = parse(args, { 'rel-path': { type: 'string' } });
  const projectPath = positional(positionals, 0, 'project path', ADD_FILE_USAGE);
  const docxPath = positional(positionals, 1, 'file path', ADD_FILE_USAGE);

  const { db, project } = openExistingProject(projectPath);
  try {
    if (!existsSync(docxPath)) {
      throw new CliError(`no such file: ${docxPath}`);
    }
    const bytes = new Uint8Array(readFileSync(docxPath));
    let assembled: AssembledFile;
    if (fileKindOfName(docxPath) === 'xliff') {
      try {
        assembled = assembleXliff(bytes, {
          srcLang: project.srcLang,
          tgtLang: project.tgtLang,
        });
      } catch (err) {
        if (err instanceof XliffError)
          throw new CliError(`cannot read ${docxPath}: ${err.message}`);
        throw err;
      }
    } else {
      let rules: SegmenterRules;
      try {
        rules = rulesFor(project.srcLang);
      } catch (err) {
        // Backlog #13a: a language without segmentation rules cannot be
        // imported at all. Say so in the language's own terms.
        throw new CliError(
          `cannot segment ${project.srcLang}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      assembled = assembleFile(bytes, rules);
    }
    const relPath = values['rel-path'] ?? basename(docxPath);
    let fileId: number;
    try {
      fileId = insertFile(db, relPath, assembled, { actor: cliActor() }).id;
    } catch (err) {
      if (
        err instanceof Error &&
        /UNIQUE constraint failed: file\.rel_path/.test(err.message)
      ) {
        throw new CliError(`a file named "${relPath}" is already in this project`);
      }
      throw err;
    }

    const locked = assembled.segments.filter((s) => s.locked).length;
    io.stdout(
      `Added ${relPath} as file #${fileId}: ${assembled.segments.length} segments (${locked} locked)`,
    );
  } finally {
    db.close();
  }
  return 0;
}
