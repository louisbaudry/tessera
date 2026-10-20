import type { CorpusCase } from './types.fixture.js';

/** Spanish segmentation corpus (issue #267). */
export const ES: readonly CorpusCase[] = [
  {
    category: 'plain terminators',
    text: 'Llovió todo el día. Nos quedamos en casa.',
    sentences: ['Llovió todo el día.', 'Nos quedamos en casa.'],
  },
  {
    category: 'inverted marks',
    text: '¿Dónde estás? Estoy aquí.',
    sentences: ['¿Dónde estás?', 'Estoy aquí.'],
  },
  {
    category: 'inverted marks',
    text: '¡Qué bien! ¿Vienes con nosotros?',
    sentences: ['¡Qué bien!', '¿Vienes con nosotros?'],
  },
  {
    category: 'inverted marks',
    text: 'Dijo que sí. ¿Y ahora qué?',
    sentences: ['Dijo que sí.', '¿Y ahora qué?'],
  },
  {
    category: 'inverted marks',
    text: 'Pregunté: ¿Vienes? No contestó.',
    sentences: ['Pregunté: ¿Vienes?', 'No contestó.'],
  },
  {
    category: 'quotes and brackets',
    text: '\u00ABHola.\u00BB Ella sonrió.',
    sentences: ['\u00ABHola.\u00BB', 'Ella sonrió.'],
  },
  {
    category: 'abbreviations',
    text: 'El Sr. García llegó tarde.',
    sentences: ['El Sr. García llegó tarde.'],
  },
  {
    category: 'abbreviations',
    text: 'Vive en la Av. Libertad, número 5.',
    sentences: ['Vive en la Av. Libertad, número 5.'],
  },
  {
    category: 'abbreviations',
    text: 'Vea el cap. 4 para más detalles.',
    sentences: ['Vea el cap. 4 para más detalles.'],
  },
  {
    category: 'abbreviations',
    text: 'Los EE.UU. firmaron el acuerdo. Luego se fueron.',
    sentences: ['Los EE.UU. firmaron el acuerdo.', 'Luego se fueron.'],
  },
  {
    category: 'abbreviations',
    text: 'Véase la p. 12 para más detalles.',
    sentences: ['Véase la p. 12 para más detalles.'],
  },
  {
    category: 'abbreviation at a sentence end',
    text: 'Compró pan, leche, etc. Después se fue.',
    sentences: ['Compró pan, leche, etc. Después se fue.'],
    status: 'policy',
    note: 'Same choice as English "etc. They": a known abbreviation followed by a capital is ambiguous, and the segmenter does not break, because a missed break only makes a longer segment.',
  },
  {
    category: 'numbers and decimals',
    text: 'Cuesta 1.250,50 euros al mes. Es mucho.',
    sentences: ['Cuesta 1.250,50 euros al mes.', 'Es mucho.'],
  },
  {
    category: 'numbers and decimals',
    text: 'El 3,5 por ciento sube. Luego baja.',
    sentences: ['El 3,5 por ciento sube.', 'Luego baja.'],
  },
  {
    category: 'abbreviations',
    text: 'Nació en el 45 a. C. y murió joven.',
    sentences: ['Nació en el 45 a. C. y murió joven.'],
  },
];
