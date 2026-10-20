import type { CorpusCase } from './types.fixture.js';

/** Italian segmentation corpus (issue #267). */
export const IT: readonly CorpusCase[] = [
  {
    category: 'plain terminators',
    text: 'Ha piovuto tutto il giorno. Siamo rimasti a casa.',
    sentences: ['Ha piovuto tutto il giorno.', 'Siamo rimasti a casa.'],
  },
  {
    category: 'abbreviations',
    text: 'Il sig. Rossi è arrivato. Era tardi.',
    sentences: ['Il sig. Rossi è arrivato.', 'Era tardi.'],
  },
  {
    category: 'abbreviations',
    text: 'Il Dott. Bianchi ha chiamato. Era urgente.',
    sentences: ['Il Dott. Bianchi ha chiamato.', 'Era urgente.'],
  },
  {
    category: 'abbreviations',
    text: 'Vedi pag. 5 per i dettagli.',
    sentences: ['Vedi pag. 5 per i dettagli.'],
  },
  {
    category: 'abbreviation at a sentence end',
    text: 'Compra pane, latte, ecc. Poi torna a casa.',
    sentences: ['Compra pane, latte, ecc. Poi torna a casa.'],
    status: 'policy',
    note: 'A known abbreviation followed by a capital is ambiguous; the segmenter does not break, because a missed break only makes a longer segment.',
  },
  {
    category: 'numbers and decimals',
    text: 'Costa 3,50 euro. È troppo.',
    sentences: ['Costa 3,50 euro.', 'È troppo.'],
  },
  {
    category: 'plain terminators',
    text: "L'uomo è qui. È tardi.",
    sentences: ["L'uomo è qui.", 'È tardi.'],
  },
  {
    category: 'quotes and brackets',
    text: 'Ha detto: \u00ABNo.\u00BB Poi è uscito.',
    sentences: ['Ha detto: \u00ABNo.\u00BB', 'Poi è uscito.'],
  },
];
