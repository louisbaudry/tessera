import { DE } from './de.fixture.js';
import { EN } from './en.fixture.js';
import { ES } from './es.fixture.js';
import { FR } from './fr.fixture.js';
import { IT } from './it.fixture.js';
import { KO } from './ko.fixture.js';
import { NL } from './nl.fixture.js';
import { PT } from './pt.fixture.js';
import type { CorpusCase } from './types.fixture.js';
import { VI } from './vi.fixture.js';

/**
 * Every language's corpus, keyed by BCP-47 primary subtag. `corpus.test.ts`
 * fails when a language in `SUPPORTED_LANGUAGES` has no entry here, so adding
 * a language to the segmenter forces its cases to be written.
 */
export const CORPUS: Readonly<Record<string, readonly CorpusCase[]>> = {
  en: EN,
  es: ES,
  fr: FR,
  de: DE,
  it: IT,
  pt: PT,
  nl: NL,
  ko: KO,
  vi: VI,
};
