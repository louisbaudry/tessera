/**
 * Test scaffolding: the `EXPLAIN QUERY PLAN` of every statement a
 * repository call runs, with the parameters it actually bound. Shared by
 * the tests that pin a lookup to an index (backlog #19a) rather than
 * each keeping its own copy of the `prepare` wrapper.
 */

import type Database from 'better-sqlite3';

/** Runs `call` and returns each executed statement's plan, one detail line per step. */
export function capturePlans(db: Database.Database, call: () => void): string[][] {
  const executed: Array<{ sql: string; args: unknown[] }> = [];
  const original = db.prepare.bind(db);
  (db as { prepare: unknown }).prepare = (sql: string) => {
    const stmt = original(sql);
    for (const method of ['all', 'get', 'iterate'] as const) {
      const run = (stmt[method] as (...args: unknown[]) => unknown).bind(stmt);
      (stmt as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
        executed.push({ sql, args });
        return run(...args);
      };
    }
    return stmt;
  };
  try {
    call();
  } finally {
    (db as { prepare: unknown }).prepare = original;
  }
  return executed.map(({ sql, args }) =>
    (
      db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>
    ).map((r) => r.detail),
  );
}

/**
 * Plan steps that read every row of `table` (or of an alias for it):
 * `SCAN tuv`, `SCAN s`, `SCAN v USING INDEX …` — a scan through an
 * index is still a scan.
 */
export function scansOf(plans: readonly string[][], names: readonly string[]): string[] {
  const scan = new RegExp(`^SCAN (${names.join('|')})\\b`);
  return plans.flat().filter((detail) => scan.test(detail));
}
