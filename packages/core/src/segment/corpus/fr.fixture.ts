import type { CorpusCase } from './types.fixture.js';

/**
 * French segmentation corpus (issue #267). French typography puts a no-break
 * space (U+00A0) or a narrow one (U+202F) before `: ; ! ?` and inside
 * guillemets, so the real text is not the text a keyboard in English produces.
 */
export const FR: readonly CorpusCase[] = [
  {
    category: 'plain terminators',
    text: 'Il a plu toute la journée. Nous sommes restés.',
    sentences: ['Il a plu toute la journée.', 'Nous sommes restés.'],
  },
  {
    category: 'typographic spacing',
    text: 'Bonjour\u00A0! Comment allez-vous\u00A0? Très bien.',
    sentences: ['Bonjour\u00A0!', 'Comment allez-vous\u00A0?', 'Très bien.'],
  },
  {
    category: 'typographic spacing',
    text: 'Quoi\u202F? Déjà\u202F! Je ne savais pas.',
    sentences: ['Quoi\u202F?', 'Déjà\u202F!', 'Je ne savais pas.'],
  },
  {
    category: 'quotes and brackets',
    text: 'Il a dit : \u00AB Non. \u00BB Puis il est parti.',
    sentences: ['Il a dit : \u00AB Non. \u00BB', 'Puis il est parti.'],
    status: 'gap',
    issue: 268,
    note: 'French puts a space between the full stop and the closing guillemet. The closing mark is then read as the start of the next word, and a guillemet is not something that opens a sentence, so no break is made.',
  },
  {
    category: 'quotes and brackets',
    text: 'Il a dit\u00A0: \u00AB\u00A0Non.\u00A0\u00BB Puis il est parti.',
    sentences: ['Il a dit\u00A0: \u00AB\u00A0Non.\u00A0\u00BB', 'Puis il est parti.'],
    status: 'gap',
    issue: 268,
    note: 'The same gap with the correct typography: a no-break space before the closing guillemet.',
  },
  {
    category: 'quotes and brackets',
    text: 'Il a dit \u00AB non. \u00BB Puis il est parti.',
    sentences: ['Il a dit \u00AB non. \u00BB', 'Puis il est parti.'],
    status: 'gap',
    issue: 268,
    note: 'Same cause as the others, with a lowercase quotation.',
  },
  {
    category: 'abbreviations',
    text: 'M. Dupont est arrivé. Il sourit.',
    sentences: ['M. Dupont est arrivé.', 'Il sourit.'],
  },
  {
    category: 'abbreviations',
    text: 'Mme Martin est là. Elle sourit.',
    sentences: ['Mme Martin est là.', 'Elle sourit.'],
  },
  {
    category: 'abbreviations',
    text: 'Le Dr Durand est parti. Il reviendra.',
    sentences: ['Le Dr Durand est parti.', 'Il reviendra.'],
  },
  {
    category: 'abbreviations',
    text: 'Voir p. 12 pour les détails.',
    sentences: ['Voir p. 12 pour les détails.'],
  },
  {
    category: 'abbreviations',
    text: 'Chap. 3 : les bases du sujet.',
    sentences: ['Chap. 3 : les bases du sujet.'],
  },
  {
    category: 'numbers and decimals',
    text: 'Il coûte 1\u202F250,50 € environ. C\u2019est cher.',
    sentences: ['Il coûte 1\u202F250,50 € environ.', 'C\u2019est cher.'],
  },
  {
    category: 'ordinals and dates',
    text: 'Elle est née le 1er mai 1990. Elle a grandi à Lyon.',
    sentences: ['Elle est née le 1er mai 1990.', 'Elle a grandi à Lyon.'],
  },
];
