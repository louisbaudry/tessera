/**
 * `rate` and `client_rate` repository (portal-v0-spec.md §3, §3a, §6): the default rate of each
 * language pair, and a client's own rate in its place (issue #331).
 */

import { ratesForClient, type LanguagePairRate } from '@cat-tool/portal-core';
import type Database from 'better-sqlite3';

interface RateRow {
  id: number;
  src_lang: string;
  tgt_lang: string;
  rate_per_word: number;
  minimum_price: number;
  min_words_per_file: number;
}

const fromRow = (row: RateRow): LanguagePairRate => ({
  srcLang: row.src_lang,
  tgtLang: row.tgt_lang,
  ratePerWord: row.rate_per_word,
  minimumPrice: row.minimum_price,
  minWordsPerFile: row.min_words_per_file,
});

/**
 * Upserts the rate for one language pair. The row is the whole rate, not a
 * patch: a rate that omits `minWordsPerFile` has none (0), so saving it again
 * switches a per-file minimum off (portal-v0-spec.md §4b).
 *
 * @throws RangeError if `minWordsPerFile` is not a non-negative integer.
 */
export function setRate(db: Database.Database, rate: LanguagePairRate): void {
  const minWordsPerFile = checkedMinWordsPerFile(rate);
  db.prepare(
    `INSERT INTO rate (src_lang, tgt_lang, rate_per_word, minimum_price, min_words_per_file)
     VALUES (@src_lang, @tgt_lang, @rate_per_word, @minimum_price, @min_words_per_file)
     ON CONFLICT (src_lang, tgt_lang) DO UPDATE SET
       rate_per_word = excluded.rate_per_word,
       minimum_price = excluded.minimum_price,
       min_words_per_file = excluded.min_words_per_file`,
  ).run({
    src_lang: rate.srcLang,
    tgt_lang: rate.tgtLang,
    rate_per_word: rate.ratePerWord,
    minimum_price: rate.minimumPrice,
    min_words_per_file: minWordsPerFile,
  });
}

function checkedMinWordsPerFile(rate: LanguagePairRate): number {
  const minWordsPerFile = rate.minWordsPerFile ?? 0;
  if (!Number.isSafeInteger(minWordsPerFile) || minWordsPerFile < 0) {
    throw new RangeError(
      `minWordsPerFile must be a non-negative integer, got ${minWordsPerFile}`,
    );
  }
  return minWordsPerFile;
}

/** The default rate of every language pair, shared by every client without one of its own. */
export function listRates(db: Database.Database): LanguagePairRate[] {
  return (
    db.prepare('SELECT * FROM rate ORDER BY src_lang, tgt_lang').all() as RateRow[]
  ).map(fromRow);
}

/**
 * Upserts one client's own rate for a language pair (issue #331). The row is the whole rate, as
 * with `setRate`: it replaces the pair's default for this client entirely.
 *
 * @throws RangeError if `minWordsPerFile` is not a non-negative integer.
 * @throws if `clientId` names no client (a foreign key).
 */
export function setClientRate(
  db: Database.Database,
  clientId: number,
  rate: LanguagePairRate,
): void {
  const minWordsPerFile = checkedMinWordsPerFile(rate);
  db.prepare(
    `INSERT INTO client_rate
       (client_id, src_lang, tgt_lang, rate_per_word, minimum_price, min_words_per_file)
     VALUES (@client_id, @src_lang, @tgt_lang, @rate_per_word, @minimum_price, @min_words_per_file)
     ON CONFLICT (client_id, src_lang, tgt_lang) DO UPDATE SET
       rate_per_word = excluded.rate_per_word,
       minimum_price = excluded.minimum_price,
       min_words_per_file = excluded.min_words_per_file`,
  ).run({
    client_id: clientId,
    src_lang: rate.srcLang,
    tgt_lang: rate.tgtLang,
    rate_per_word: rate.ratePerWord,
    minimum_price: rate.minimumPrice,
    min_words_per_file: minWordsPerFile,
  });
}

/**
 * Removes a client's own rate for a pair, so the client is priced at the default again (or can no
 * longer order the pair, if it has no default).
 *
 * @returns Whether there was such a rate.
 */
export function removeClientRate(
  db: Database.Database,
  clientId: number,
  srcLang: string,
  tgtLang: string,
): boolean {
  return (
    db
      .prepare(
        'DELETE FROM client_rate WHERE client_id = ? AND src_lang = ? AND tgt_lang = ?',
      )
      .run(clientId, srcLang, tgtLang).changes > 0
  );
}

/** One client's own rates, ordered by pair. */
export function listClientRates(
  db: Database.Database,
  clientId: number,
): LanguagePairRate[] {
  return (
    db
      .prepare(
        'SELECT * FROM client_rate WHERE client_id = ? ORDER BY src_lang, tgt_lang',
      )
      .all(clientId) as RateRow[]
  ).map(fromRow);
}

/**
 * The rates a client is priced at and may order: the defaults with the client's own in their place
 * (`ratesForClient`). Every price for a client, from the estimate to the admin's confirmation, is
 * read through this, so the two can never quote from different lists.
 */
export function listRatesForClient(
  db: Database.Database,
  clientId: number,
): LanguagePairRate[] {
  return ratesForClient(listRates(db), listClientRates(db, clientId));
}
