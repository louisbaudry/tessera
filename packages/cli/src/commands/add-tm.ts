import { existsSync, rmSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';

import {
  addTmRef,
  createTm,
  importSdltm,
  importTmxFile,
  listTmImports,
  listTmRefs,
  openTm,
  setWriteTarget,
  type TmImport,
} from '@cat-tool/db';

import {
  CliError,
  integer,
  openExistingProject,
  parse,
  positional,
  type CliIo,
  type ProjectDb,
} from '../support.js';

export const ADD_TM_USAGE =
  'cat-tool add-tm <project.catdb> <memory.ctm|file.tmx|file.sdltm> [--priority <n>] [--write-target]';

/** Written into a memory this CLI creates (tm-format-spec.md §2.1). */
const GENERATOR = 'cat-tool/cli';

/**
 * Attaches a memory in whatever form the translator has it (v1-spec.md
 * §2.4): a `.ctm` as it is (created empty first if it does not exist),
 * a `.tmx` or `.sdltm` imported into a fresh `.ctm` beside it.
 */
export function addTm(args: readonly string[], io: CliIo): number {
  const { values, positionals } = parse(args, {
    priority: { type: 'string' },
    'write-target': { type: 'boolean' },
  });
  const projectPath = positional(positionals, 0, 'project path', ADD_TM_USAGE);
  const tmPath = positional(positionals, 1, 'memory path', ADD_TM_USAGE);
  const requested = integer(values.priority, '--priority');

  const { db } = openExistingProject(projectPath);
  try {
    // Stored absolute: pre-translate re-attaches by this path from
    // wherever it is later run, not from where add-tm happened to be.
    const ctmPath = resolve(prepareMemory(tmPath, io));
    const priority = requested ?? nextPriority(db);
    const ref = addTmRef(db, { path: ctmPath, priority });
    if (values['write-target']) setWriteTarget(db, ref.id);
    io.stdout(
      `Attached ${ctmPath} as TM #${ref.id} (priority ${priority}` +
        `${values['write-target'] ? ', write target' : ''})`,
    );
  } finally {
    db.close();
  }
  return 0;
}

/** After every memory already attached, so add-tm order is consultation order. */
function nextPriority(db: ProjectDb): number {
  return listTmRefs(db).reduce((max, ref) => Math.max(max, ref.priority), 0) + 1;
}

/** Returns the path of a `.ctm` ready to attach, importing into one if needed. */
function prepareMemory(path: string, io: CliIo): string {
  const ext = extname(path).toLowerCase();

  if (ext === '.ctm') {
    if (!existsSync(path)) {
      createTm(path, { name: basename(path, ext), generator: GENERATOR }).close();
      io.stdout(`Created empty memory ${path}`);
    }
    return path;
  }

  if (ext !== '.tmx' && ext !== '.sdltm') {
    throw new CliError(
      `unsupported memory format "${ext}" — expected .ctm, .tmx or .sdltm`,
    );
  }
  if (!existsSync(path)) {
    throw new CliError(`no such file: ${path}`);
  }
  const ctmPath = path.slice(0, -ext.length) + '.ctm';
  let tm: ReturnType<typeof createTm>;
  let resume: TmImport | undefined;
  if (existsSync(ctmPath)) {
    // The one existing memory worth opening: this TMX's own interrupted
    // import (tm-format-spec.md §12.4), which running the same command
    // again continues rather than refusing.
    const refuse = (): CliError =>
      new CliError(
        `${ctmPath} already exists — attach it directly, or move it aside to import again`,
      );
    if (ext !== '.tmx') throw refuse();
    tm = openTm(ctmPath);
    resume = listTmImports(tm).find(
      (r) => r.finishedAt === null && r.sourceName === basename(path),
    );
    if (!resume) {
      tm.close();
      throw refuse();
    }
    io.stdout(`Resuming the import of ${path} after unit ${resume.unitsDone}`);
  } else {
    tm = createTm(ctmPath, { name: basename(path, ext), generator: GENERATOR });
  }
  try {
    const result =
      ext === '.tmx'
        ? importTmxFile(tm, path, { resume: resume?.id })
        : importSdltm(tm, path);
    for (const warning of result.warnings) io.stderr(`warning: ${warning}`);
    io.stdout(
      `Imported ${path} into ${ctmPath}: ${result.tuCount} units, ${result.tuvCount} variants` +
        (result.warnings.length > 0 ? `, ${result.warnings.length} warnings` : ''),
    );
  } catch (err) {
    const kept = ext === '.tmx' ? committedUnits(tm) : 0;
    tm.close();
    if (kept > 0) {
      // Whole units, and a tm_import row that says the file is not all
      // there: worth keeping, and the same command picks up from here.
      io.stderr(
        `error: import stopped after ${kept} units; ${ctmPath} keeps them and is marked ` +
          'incomplete — run the same add-tm again to resume',
      );
    } else {
      // An import that failed must not leave an empty memory behind for
      // the next attempt to refuse as "already exists".
      rmSync(ctmPath, { force: true });
    }
    throw err;
  }
  tm.close();
  return ctmPath;
}

/** Units the interrupted TMX import of this memory had committed. */
function committedUnits(tm: ReturnType<typeof createTm>): number {
  return listTmImports(tm).reduce(
    (n, r) => n + (r.finishedAt === null ? r.unitsDone : 0),
    0,
  );
}
