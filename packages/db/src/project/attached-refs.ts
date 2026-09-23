/**
 * `ATTACH`/`DETACH` plumbing shared by TM references and glossary
 * references — the two are the same mechanism (a priority-ordered list
 * of SQLite files reachable from the project connection), so the
 * mechanism lives once and each reference type supplies only its alias
 * scheme.
 */

import type Database from 'better-sqlite3';

export interface AttachableRef {
  readonly id: number;
  readonly path: string;
  readonly priority: number;
  readonly enabled: boolean;
}

const attachedNames = (db: Database.Database): Set<string> =>
  new Set((db.pragma('database_list') as Array<{ name: string }>).map((d) => d.name));

/**
 * `ATTACH`es every enabled ref's file onto this connection, in priority
 * order, under `alias(ref.id)`. Safe to call more than once — an alias
 * already attached (checked via `PRAGMA database_list`, since attachment
 * is a property of the connection, not something tracked here) is left
 * alone rather than re-attached, which SQLite would refuse.
 *
 * Returns the refs actually attached, in the order they were attached.
 */
export function attachRefs<R extends AttachableRef>(
  db: Database.Database,
  refs: readonly R[],
  alias: (id: number) => string,
): R[] {
  const already = attachedNames(db);
  const enabled = [...refs]
    .filter((r) => r.enabled)
    .sort((a, b) => a.priority - b.priority);
  const attached: R[] = [];
  for (const ref of enabled) {
    const name = alias(ref.id);
    if (!already.has(name)) {
      db.prepare(`ATTACH DATABASE ? AS ${name}`).run(ref.path);
      already.add(name);
    }
    attached.push(ref);
  }
  return attached;
}

/** Detaches every schema {@link attachRefs} could have attached for `refs`. */
export function detachRefs(
  db: Database.Database,
  refs: readonly AttachableRef[],
  alias: (id: number) => string,
): void {
  const attached = attachedNames(db);
  for (const ref of refs) {
    const name = alias(ref.id);
    if (attached.has(name)) db.prepare(`DETACH DATABASE ${name}`).run();
  }
}
