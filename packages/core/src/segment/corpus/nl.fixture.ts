import type { CorpusCase } from './types.fixture.js';

/** Dutch segmentation corpus (issue #267). */
export const NL: readonly CorpusCase[] = [
  {
    category: 'plain terminators',
    text: 'Het regende de hele dag. We bleven thuis.',
    sentences: ['Het regende de hele dag.', 'We bleven thuis.'],
  },
  {
    category: 'abbreviations',
    text: 'Dhr. Jansen belde gisteren. Hij was boos.',
    sentences: ['Dhr. Jansen belde gisteren.', 'Hij was boos.'],
  },
  {
    category: 'abbreviations',
    text: 'Zie blz. 4 voor details.',
    sentences: ['Zie blz. 4 voor details.'],
  },
  {
    category: 'abbreviations',
    text: 'Prof. dr. Visser sprak lang. Niemand luisterde.',
    sentences: ['Prof. dr. Visser sprak lang.', 'Niemand luisterde.'],
  },
  {
    category: 'abbreviations',
    text: 'Het kost bijv. 5 euro. Dat is veel.',
    sentences: ['Het kost bijv. 5 euro.', 'Dat is veel.'],
  },
  {
    category: 'abbreviation at a sentence end',
    text: 'Ze kopen appels, peren, enz. Daarna gaan ze naar huis.',
    sentences: ['Ze kopen appels, peren, enz. Daarna gaan ze naar huis.'],
    status: 'policy',
    note: 'A known abbreviation followed by a capital is ambiguous; the segmenter does not break, because a missed break only makes a longer segment.',
  },
  {
    category: 'quotes and brackets',
    text: 'Hij zei: \u201ENee.\u201D Toen vertrok hij.',
    sentences: ['Hij zei: \u201ENee.\u201D', 'Toen vertrok hij.'],
  },
  {
    category: 'numbers and decimals',
    text: 'Dit kost € 1.250,50 per maand. Dat is duur.',
    sentences: ['Dit kost € 1.250,50 per maand.', 'Dat is duur.'],
  },
  {
    category: 'ordinals and dates',
    text: 'Hij kwam op 3 mei aan. Het regende.',
    sentences: ['Hij kwam op 3 mei aan.', 'Het regende.'],
  },
];
