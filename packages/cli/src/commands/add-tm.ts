import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';

import {
  addTmRef,
  createTm,
  importSdltm,
  importTmx,
  listTmRefs,
  setWriteTarget,
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
  if (existsSync(ctmPath)) {
    throw new CliError(
      `${ctmPath} already exists — attach it directly, or move it aside to import again`,
    );
  }

  const tm = createTm(ctmPath, { name: basename(path, ext), generator: GENERATOR });
  try {
    const result =
      ext === '.tmx' ? importTmx(tm, readFileSync(path, 'utf8')) : importSdltm(tm, path);
    for (const warning of result.warnings) io.stderr(`warning: ${warning}`);
    io.stdout(
      `Imported ${path} into ${ctmPath}: ${result.tuCount} units, ${result.tuvCount} variants` +
        (result.warnings.length > 0 ? `, ${result.warnings.length} warnings` : ''),
    );
  } catch (err) {
    // An import that failed must not leave an empty memory behind for
    // the next attempt to refuse as "already exists".
    tm.close();
    rmSync(ctmPath, { force: true });
    throw err;
  }
  tm.close();
  return ctmPath;
}
