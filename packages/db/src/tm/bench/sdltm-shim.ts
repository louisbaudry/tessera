/**
 * Shared by the bench's real-file modes (`measure.ts`, `e001.ts`).
 */

import type Database from 'better-sqlite3';

import { SDLTM_APPLICATION_ID } from '../sdltm.fixture.ts';

/**
 * Real `.sdltm` files carry `application_id` 0, and `parseSdltm` still
 * refuses anything but the one sample's value (tm-format-spec.md §8a.3:
 * "the guard rejects every real file"; dropping it is issue #68's job,
 * not this bench's). So for a file that says 0 — and only then — the
 * bench hands the reader a handle whose `PRAGMA application_id` answers
 * with the value the guard wants; every other statement goes to the
 * real, read-only connection. Nothing in the product changes, and the
 * results record that the shim was used. Once #68 lands, this never
 * triggers.
 */
export function withTradosApplicationId(h: Database.Database): {
  handle: Database.Database;
  shimmed: boolean;
} {
  if (h.pragma('application_id', { simple: true }) !== 0) {
    return { handle: h, shimmed: false };
  }
  const handle = new Proxy(h, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) =>
          /^\s*PRAGMA\s+application_id\b/i.test(sql)
            ? { get: () => ({ application_id: SDLTM_APPLICATION_ID }), all: () => [] }
            : target.prepare(sql);
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
  return { handle, shimmed: true };
}
