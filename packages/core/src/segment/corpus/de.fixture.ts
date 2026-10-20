import type { CorpusCase } from './types.fixture.js';

/**
 * German segmentation corpus (issue #267). German writes ordinals as a digit
 * and a full stop ("der 3. Mai"), capitalises every noun, and closes a
 * quotation with a high mark (U+201C) after opening it with a low one
 * (U+201E).
 */
export const DE: readonly CorpusCase[] = [
  {
    category: 'plain terminators',
    text: 'Es regnete den ganzen Tag. Wir blieben zu Hause.',
    sentences: ['Es regnete den ganzen Tag.', 'Wir blieben zu Hause.'],
  },
  {
    category: 'ordinals and dates',
    text: 'Der 3. Absatz ist wichtig.',
    sentences: ['Der 3. Absatz ist wichtig.'],
  },
  {
    category: 'ordinals and dates',
    text: 'Wir treffen uns am 3. Mai. Danach gehen wir essen.',
    sentences: ['Wir treffen uns am 3. Mai.', 'Danach gehen wir essen.'],
  },
  {
    category: 'ordinals and dates',
    text: 'Wir zählten 20. Dann gingen wir.',
    sentences: ['Wir zählten 20.', 'Dann gingen wir.'],
  },
  {
    category: 'ordinals and dates',
    text: 'Das Treffen ist am 12.05.2026. Bitte kommen Sie pünktlich.',
    sentences: ['Das Treffen ist am 12.05.2026.', 'Bitte kommen Sie pünktlich.'],
  },
  {
    category: 'abbreviations',
    text: 'Siehe z.B. Kapitel 4 für Details.',
    sentences: ['Siehe z.B. Kapitel 4 für Details.'],
  },
  {
    category: 'abbreviations',
    text: 'Das gilt z. B. für Kinder und Senioren.',
    sentences: ['Das gilt z. B. für Kinder und Senioren.'],
    status: 'gap',
    issue: 270,
    note: 'Written with a space, "z. B." is the usual German form. The first part, "z.", is a single lowercase letter and is not in the list, and "B." that follows is a capital, so the segmenter breaks inside the abbreviation.',
  },
  {
    category: 'abbreviations',
    text: 'Das gilt z.\u00A0B. für Kinder und Senioren.',
    sentences: ['Das gilt z.\u00A0B. für Kinder und Senioren.'],
    status: 'gap',
    issue: 270,
    note: 'The same gap with the no-break space that correct German typography puts inside "z. B.".',
  },
  {
    category: 'abbreviations',
    text: 'Das kostet ca. 5 Euro. Bitte zahlen Sie bar.',
    sentences: ['Das kostet ca. 5 Euro.', 'Bitte zahlen Sie bar.'],
  },
  {
    category: 'abbreviations',
    text: 'Dr. Müller kam spät. Er blieb nicht lange.',
    sentences: ['Dr. Müller kam spät.', 'Er blieb nicht lange.'],
  },
  {
    category: 'abbreviations',
    text: 'Das Gesetz (Abs. 2) gilt hier. Es ist neu.',
    sentences: ['Das Gesetz (Abs. 2) gilt hier.', 'Es ist neu.'],
  },
  {
    category: 'quotes and brackets',
    text: 'Er sagte: \u201EKomm her.\u201C Dann ging er.',
    sentences: ['Er sagte: \u201EKomm her.\u201C', 'Dann ging er.'],
  },
  {
    category: 'quotes and brackets',
    text: 'Er sagte: \u00BBKomm her.\u00AB Dann ging er.',
    sentences: ['Er sagte: \u00BBKomm her.\u00AB', 'Dann ging er.'],
  },
  {
    category: 'hard separators',
    text: 'Startseite | \u00DCber uns | Kontakt',
    sentences: ['Startseite |', '\u00DCber uns |', 'Kontakt'],
  },
  {
    category: 'numbers and decimals',
    text: 'Der Preis beträgt 1.250,50 Euro. Das ist viel.',
    sentences: ['Der Preis beträgt 1.250,50 Euro.', 'Das ist viel.'],
  },
  {
    category: 'numbered steps',
    text: 'Schritt 1. Öffnen Sie die Datei. Schritt 2. Speichern Sie sie.',
    sentences: ['Schritt 1. Öffnen Sie die Datei.', 'Schritt 2. Speichern Sie sie.'],
    status: 'gap',
    issue: 272,
    note: 'As in English: a digit, a full stop and a capital read as a sentence end, and "Schritt" is not an ordinal prefix, so each step number is cut off from its text.',
  },
  {
    category: 'quotes and brackets',
    text: 'Er rief: \u201EKomm her.\u201C sagte sie leise.',
    sentences: ['Er rief: \u201EKomm her.\u201C sagte sie leise.'],
  },
];
