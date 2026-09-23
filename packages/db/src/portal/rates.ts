/** `rate` repository (portal-v0-spec.md §3, §6). */

import type { LanguagePairRate } from '@cat-tool/portal-core';
import type Database from 'better-sqlite3';

interface RateRow {
  id: number;
  src_lang: string;
  tgt_lang: string;
  rate_per_word: number;
  minimum_price: number;
}

const fromRow = (row: RateRow): LanguagePairRate => ({
  srcLang: row.src_lang,
  tgtLang: row.tgt_lang,
  ratePerWord: row.rate_per_word,
  minimumPrice: row.minimum_price,
});

/** Upserts the rate for one language pair. */
export function setRate(db: Database.Database, rate: LanguagePairRate): void {
  db.prepare(
    `INSERT INTO rate (src_lang, tgt_lang, rate_per_word, minimum_price)
     VALUES (@src_lang, @tgt_lang, @rate_per_word, @minimum_price)
     ON CONFLICT (src_lang, tgt_lang) DO UPDATE SET
       rate_per_word = excluded.rate_per_word,
       minimum_price = excluded.minimum_price`,
  ).run({
    src_lang: rate.srcLang,
    tgt_lang: rate.tgtLang,
    rate_per_word: rate.ratePerWord,
    minimum_price: rate.minimumPrice,
  });
}

export function listRates(db: Database.Database): LanguagePairRate[] {
  return (
    db.prepare('SELECT * FROM rate ORDER BY src_lang, tgt_lang').all() as RateRow[]
  ).map(fromRow);
}
