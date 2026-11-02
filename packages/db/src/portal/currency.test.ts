/**
 * The currency of a portal's prices (issue #327, portal-v0-spec.md §9c): recorded at the first
 * start, and fixed once any order has a price, because an approved price is consent to an amount
 * in one currency and the price column holds a bare number.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import {
  createClient,
  createOrder,
  getPortalCurrency,
  openPortalDb,
  PortalCurrencyError,
  setWordCountAndPrice,
  settlePortalCurrency,
} from './index.js';

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-portal-currency-'));
  db = openPortalDb(join(dir, 'portal.sqlite'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function order() {
  const client = createClient(db, 'Client A', 'a@client.example', 'tok-a');
  return createOrder(
    db,
    { clientId: client.id, srcLang: 'en', tgtLangs: ['de'] },
    { actor: TEST_ACTOR },
  );
}

describe('settlePortalCurrency', () => {
  it('records the currency at the first start, and keeps it on the next', () => {
    expect(getPortalCurrency(db)).toBeNull();
    expect(settlePortalCurrency(db, 'EUR')).toBe('EUR');
    expect(settlePortalCurrency(db, 'EUR')).toBe('EUR');
    expect(getPortalCurrency(db)).toBe('EUR');
  });

  it('refuses a code that is not ISO 4217, and records nothing', () => {
    for (const code of ['eur', 'XYZ', '€', '']) {
      expect(() => settlePortalCurrency(db, code), code).toThrow(PortalCurrencyError);
    }
    expect(getPortalCurrency(db)).toBeNull();
  });

  it('moves while no order has a price', () => {
    settlePortalCurrency(db, 'USD');
    order();
    expect(settlePortalCurrency(db, 'EUR')).toBe('EUR');
    expect(getPortalCurrency(db)).toBe('EUR');
  });

  it('never moves under a priced order', () => {
    settlePortalCurrency(db, 'EUR');
    setWordCountAndPrice(db, order().id, 100, 12, { actor: TEST_ACTOR });
    expect(() => settlePortalCurrency(db, 'USD')).toThrow(/prices are in EUR/);
    expect(getPortalCurrency(db)).toBe('EUR');
    expect(settlePortalCurrency(db, 'EUR')).toBe('EUR');
  });

  it('adopts the configured currency for a file priced before it was recorded', () => {
    setWordCountAndPrice(db, order().id, 100, 12, { actor: TEST_ACTOR });
    expect(settlePortalCurrency(db, 'GBP')).toBe('GBP');
  });

  it('is held by the schema too: one row, an upper-case code of three letters', () => {
    settlePortalCurrency(db, 'EUR');
    expect(() =>
      db.prepare("INSERT INTO portal_currency (id, code) VALUES (2, 'USD')").run(),
    ).toThrow();
    expect(() => db.prepare("UPDATE portal_currency SET code = 'eur'").run()).toThrow();
  });
});
