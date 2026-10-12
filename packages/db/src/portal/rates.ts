/** `rate` repository (portal-v0-spec.md §3, §6). */

import type { LanguagePairRate } from '@cat-tool/portal-core';
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
  const minWordsPerFile = rate.minWordsPerFile ?? 0;
  if (!Number.isSafeInteger(minWordsPerFile) || minWordsPerFile < 0) {
    throw new RangeError(
      `minWordsPerFile must be a non-negative integer, got ${minWordsPerFile}`,
    );
  }
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

export function listRates(db: Database.Database): LanguagePairRate[] {
  return (
    db.prepare('SELECT * FROM rate ORDER BY src_lang, tgt_lang').all() as RateRow[]
  ).map(fromRow);
}
