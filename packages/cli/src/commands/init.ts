import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname } from 'node:path';

import { createProject, openProjectDb } from '@cat-tool/db';

import { CliError, parse, positional, type CliIo } from '../support.js';

export const INIT_USAGE =
  'cat-tool init <project.catdb> --src <lang> --tgt <lang> [--name <name>]';

/** Creates the project database and its one identity row. */
export function init(args: readonly string[], io: CliIo): number {
  const { values, positionals } = parse(args, {
    name: { type: 'string' },
    src: { type: 'string' },
    tgt: { type: 'string' },
  });
  const path = positional(positionals, 0, 'project path', INIT_USAGE);
  if (!values.src || !values.tgt) {
    throw new CliError(`--src and --tgt are required\nusage: ${INIT_USAGE}`);
  }
  if (existsSync(path)) {
    throw new CliError(`${path} already exists — init never touches an existing file`);
  }
  const name = values.name ?? basename(path, extname(path));

  mkdirSync(dirname(path), { recursive: true });
  const db = openProjectDb(path);
  try {
    const project = createProject(db, { name, srcLang: values.src, tgtLang: values.tgt });
    io.stdout(
      `Created project "${project.name}" (${project.srcLang} → ${project.tgtLang}) at ${path}`,
    );
  } finally {
    db.close();
  }
  return 0;
}
