import type { CorpusCase } from './types.fixture.js';

/** Portuguese segmentation corpus (issue #267). */
export const PT: readonly CorpusCase[] = [
  {
    category: 'plain terminators',
    text: 'Choveu o dia todo. Ficamos em casa.',
    sentences: ['Choveu o dia todo.', 'Ficamos em casa.'],
  },
  {
    category: 'abbreviations',
    text: 'O Sr. Silva chegou cedo. Ele sorriu.',
    sentences: ['O Sr. Silva chegou cedo.', 'Ele sorriu.'],
  },
  {
    category: 'abbreviations',
    text: 'A Dra. Costa ligou. Ela volta amanhã.',
    sentences: ['A Dra. Costa ligou.', 'Ela volta amanhã.'],
  },
  {
    category: 'abbreviations',
    text: 'Ver pág. 12 para detalhes.',
    sentences: ['Ver pág. 12 para detalhes.'],
  },
  {
    category: 'abbreviations',
    text: 'Mora na Av. Brasil, nº 100.',
    sentences: ['Mora na Av. Brasil, nº 100.'],
  },
  {
    category: 'abbreviations',
    text: 'O séc. XX foi longo. Muita coisa mudou.',
    sentences: ['O séc. XX foi longo.', 'Muita coisa mudou.'],
  },
  {
    category: 'numbers and decimals',
    text: 'Custa R$ 1.250,50 por mês. É caro.',
    sentences: ['Custa R$ 1.250,50 por mês.', 'É caro.'],
  },
  {
    category: 'quotes and brackets',
    text: 'Ele disse: "Não." Depois saiu.',
    sentences: ['Ele disse: "Não."', 'Depois saiu.'],
  },
];
