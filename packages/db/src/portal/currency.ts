/**
 * `portal_currency` repository (issue #327, `portal-v0-spec.md` §9c): which currency a portal's
 * prices are in, and the rule that keeps an approved price in the money it was approved in.
 */

import { isCurrencyCode } from '@cat-tool/core';
import type Database from 'better-sqlite3';

/** A currency the portal cannot take: not an ISO 4217 code, or a change under priced orders. */
export class PortalCurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortalCurrencyError';
  }
}

/** The currency this file's prices are in, or `null` before the portal first started with one. */
export function getPortalCurrency(db: Database.Database): string | null {
  const row = db.prepare('SELECT code FROM portal_currency WHERE id = 1').get() as
    { code: string } | undefined;
  return row?.code ?? null;
}

/**
 * Makes `code` the currency of this file's prices, as the portal starts. The first start records
 * it; a later start with the same code changes nothing. A different code is taken only while no
 * order has a price: a price is a bare number, so changing the currency under one would show a
 * client a different amount from the one they approved, which `assertCanApprove` exists to prevent.
 * Not an audit event: it is configuration read at start, not a person's write, and once a price
 * exists it cannot move, so every `order.priced` event is in the one currency this row names.
 *
 * @param db - The tenant's `portal.sqlite`.
 * @param code - The configured ISO 4217 code (`EUR`).
 * @returns The currency now recorded, which is `code`.
 * @throws {PortalCurrencyError} if `code` is not an ISO 4217 code, or differs from the recorded
 *   currency while an order has a price.
 */
export function settlePortalCurrency(db: Database.Database, code: string): string {
  if (!isCurrencyCode(code)) {
    throw new PortalCurrencyError(
      `"${code}" is not an ISO 4217 currency code, such as EUR`,
    );
  }
  return db
    .transaction(() => {
      const recorded = getPortalCurrency(db);
      if (recorded === code) return code;
      if (recorded !== null) {
        const priced = db
          .prepare('SELECT 1 FROM translation_order WHERE price IS NOT NULL LIMIT 1')
          .get();
        if (priced) {
          throw new PortalCurrencyError(
            `this portal's prices are in ${recorded} and some orders are priced; ` +
              `it cannot start in ${code}`,
          );
        }
      }
      db.prepare(
        `INSERT INTO portal_currency (id, code) VALUES (1, ?)
       ON CONFLICT (id) DO UPDATE SET code = excluded.code`,
      ).run(code);
      return code;
    })
    .immediate();
}
