import { describe, expect, it } from 'vitest';

import {
  GLOSSARY_LANGUAGES,
  stopwordsFor,
  UnsupportedGlossaryLanguage,
} from './stopwords.js';

describe('stopwordsFor', () => {
  it('has a list for each of the seven v1 languages', () => {
    expect([...GLOSSARY_LANGUAGES].sort()).toEqual([
      'de',
      'en',
      'es',
      'fr',
      'it',
      'nl',
      'pt',
    ]);
    for (const lang of GLOSSARY_LANGUAGES)
      expect(stopwordsFor(lang).size).toBeGreaterThan(20);
  });

  it('is found by primary subtag, whatever the region', () => {
    expect(stopwordsFor('es-419')).toBe(stopwordsFor('es'));
    expect(stopwordsFor('pt_BR')).toBe(stopwordsFor('pt'));
    expect(stopwordsFor('FR-ca')).toBe(stopwordsFor('fr'));
  });

  it('refuses a language with no list', () => {
    expect(() => stopwordsFor('ko-KR')).toThrow(UnsupportedGlossaryLanguage);
  });

  it('holds only single lowercase words, as termKey leaves them', () => {
    for (const lang of GLOSSARY_LANGUAGES) {
      for (const word of stopwordsFor(lang)) {
        expect(word, `${lang}: ${word}`).toBe(word.toLowerCase());
        expect(word, `${lang}: ${word}`).toMatch(/^[\p{L}]+$/u);
      }
    }
  });

  it('holds the commonest function words, and no content word a term would begin with', () => {
    expect(stopwordsFor('en').has('the')).toBe(true);
    expect(stopwordsFor('fr').has('des')).toBe(true);
    expect(stopwordsFor('de').has('der')).toBe(true);
    for (const content of ['new', 'first', 'customer', 'invoice']) {
      expect(stopwordsFor('en').has(content)).toBe(false);
    }
  });
});
