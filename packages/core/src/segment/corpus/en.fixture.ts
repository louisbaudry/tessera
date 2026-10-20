import type { CorpusCase } from './types.fixture.js';

/**
 * English segmentation corpus (issue #267). Invisible and lookalike characters
 * are written as `\uXXXX` escapes, never as glyphs (CLAUDE.md, Gotchas).
 */
export const EN: readonly CorpusCase[] = [
  // \u2500\u2500 plain terminators \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  {
    category: 'plain terminators',
    text: 'It rained all day. We stayed in.',
    sentences: ['It rained all day.', 'We stayed in.'],
  },
  {
    category: 'plain terminators',
    text: 'Is it ready? Not yet! Please wait.',
    sentences: ['Is it ready?', 'Not yet!', 'Please wait.'],
  },
  {
    category: 'plain terminators',
    text: 'A heading with no stop',
    sentences: ['A heading with no stop'],
  },
  {
    category: 'plain terminators',
    text: 'STOP. DO NOT ENTER. KEEP OUT.',
    sentences: ['STOP.', 'DO NOT ENTER.', 'KEEP OUT.'],
  },
  {
    category: 'plain terminators',
    text: 'Prices rose 5%. Costs fell 3%.',
    sentences: ['Prices rose 5%.', 'Costs fell 3%.'],
  },

  {
    category: 'hard separators',
    text: 'Home | About us | Contact',
    sentences: ['Home |', 'About us |', 'Contact'],
  },
  {
    category: 'hard separators',
    text: 'Sale ends today. Shop | basket',
    sentences: ['Sale ends today.', 'Shop |', 'basket'],
  },
  {
    category: 'hard separators',
    text: 'Read a|b as one token',
    sentences: ['Read a|b as one token'],
  },

  {
    category: 'abbreviation at a sentence end',
    text: 'She said no. We moved on.',
    sentences: ['She said no.', 'We moved on.'],
  },

  // \u2500\u2500 ellipsis and runs of marks \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  {
    category: 'ellipsis and runs of marks',
    text: 'She paused... Then she spoke.',
    sentences: ['She paused...', 'Then she spoke.'],
  },
  {
    category: 'ellipsis and runs of marks',
    text: 'Wait... what was that noise?',
    sentences: ['Wait... what was that noise?'],
  },
  {
    category: 'ellipsis and runs of marks',
    text: 'Really?! I never knew.',
    sentences: ['Really?!', 'I never knew.'],
  },
  {
    category: 'ellipsis and runs of marks',
    text: 'No way!!! That is wild.',
    sentences: ['No way!!!', 'That is wild.'],
  },
  {
    category: 'ellipsis and runs of marks',
    text: 'It ended\u2026 Nobody said a word.',
    sentences: ['It ended\u2026', 'Nobody said a word.'],
  },

  // \u2500\u2500 quotes and brackets \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  {
    category: 'quotes and brackets',
    text: 'He asked, "Where is it?" She shrugged.',
    sentences: ['He asked, "Where is it?"', 'She shrugged.'],
  },
  {
    category: 'quotes and brackets',
    text: 'The sign was faded (we could barely read it.) Then we left.',
    sentences: ['The sign was faded (we could barely read it.)', 'Then we left.'],
  },
  {
    category: 'quotes and brackets',
    text: 'She said \u201Cstop.\u201D We moved on.',
    sentences: ['She said \u201Cstop.\u201D', 'We moved on.'],
  },
  {
    category: 'quotes and brackets',
    text: 'She said \u2018stop.\u2019 We moved on.',
    sentences: ['She said \u2018stop.\u2019', 'We moved on.'],
  },
  {
    category: 'quotes and brackets',
    text: 'He said "stop" and left. We waited.',
    sentences: ['He said "stop" and left.', 'We waited.'],
  },

  // \u2500\u2500 abbreviations in the middle of a sentence \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  {
    category: 'abbreviations',
    text: 'Dr. Brown met Mrs. Green at noon.',
    sentences: ['Dr. Brown met Mrs. Green at noon.'],
  },
  {
    category: 'abbreviations',
    text: 'Fig. 3 shows the result clearly.',
    sentences: ['Fig. 3 shows the result clearly.'],
  },
  {
    category: 'abbreviations',
    text: 'She works at Acme Inc. in Boston.',
    sentences: ['She works at Acme Inc. in Boston.'],
  },
  {
    category: 'abbreviations',
    text: 'Use fruit, e.g. apples, or vegetables, i.e. carrots.',
    sentences: ['Use fruit, e.g. apples, or vegetables, i.e. carrots.'],
  },
  {
    category: 'abbreviations',
    text: 'It happens on Jan. 5 every year.',
    sentences: ['It happens on Jan. 5 every year.'],
  },
  {
    category: 'abbreviations',
    text: 'The box weighs 5 kg. Handle it with care.',
    sentences: ['The box weighs 5 kg.', 'Handle it with care.'],
  },

  // \u2500\u2500 an abbreviation that also ends the sentence \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  {
    category: 'abbreviation at a sentence end',
    text: 'We sell pens, paper, etc. They also sell ink.',
    sentences: ['We sell pens, paper, etc. They also sell ink.'],
    status: 'policy',
    note: 'An abbreviation followed by a capital is ambiguous ("etc. They" can be either). The segmenter does not break: a false break would put half a sentence in the memory, a missed one only makes a longer segment the translator can split by hand.',
  },
  {
    category: 'abbreviation at a sentence end',
    text: 'She works at Acme Inc. Her desk is small.',
    sentences: ['She works at Acme Inc. Her desk is small.'],
    status: 'policy',
    note: 'Same choice as "etc. They": "Inc." is a known abbreviation, so a capital after it does not open a sentence.',
  },

  // \u2500\u2500 initials and acronyms \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  {
    category: 'initials and acronyms',
    text: 'J. R. R. Tolkien wrote it in the 1930s.',
    sentences: ['J. R. R. Tolkien wrote it in the 1930s.'],
  },
  {
    category: 'initials and acronyms',
    text: 'It was written by A. B. Carter and J. Smith. It sold well.',
    sentences: ['It was written by A. B. Carter and J. Smith.', 'It sold well.'],
  },
  {
    category: 'initials and acronyms',
    text: 'The U.S. government agreed. Talks resumed.',
    sentences: ['The U.S. government agreed.', 'Talks resumed.'],
  },
  {
    category: 'initials and acronyms',
    text: 'Q. How are you? A. Fine, thanks.',
    sentences: ['Q. How are you?', 'A. Fine, thanks.'],
  },

  // \u2500\u2500 numbers and decimals \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  {
    category: 'numbers and decimals',
    text: 'Pi is about 3.14159. Memorise it.',
    sentences: ['Pi is about 3.14159.', 'Memorise it.'],
  },
  {
    category: 'numbers and decimals',
    text: 'The fee is $1,250.50 per month. Pay early.',
    sentences: ['The fee is $1,250.50 per month.', 'Pay early.'],
  },
  {
    category: 'numbers and decimals',
    text: 'Version 2.0.1 was released. It fixes bugs.',
    sentences: ['Version 2.0.1 was released.', 'It fixes bugs.'],
  },
  {
    category: 'numbers and decimals',
    text: 'The ratio is 3:1 here. Next, we test.',
    sentences: ['The ratio is 3:1 here.', 'Next, we test.'],
  },

  // \u2500\u2500 dates and numbering \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  {
    category: 'ordinals and dates',
    text: 'Payment is due 5/12/2026. Please confirm.',
    sentences: ['Payment is due 5/12/2026.', 'Please confirm.'],
  },
  {
    category: 'numbered steps',
    text: 'Step 1. Open the file. Step 2. Save it.',
    sentences: ['Step 1. Open the file.', 'Step 2. Save it.'],
    status: 'gap',
    issue: 272,
    note: 'A digit, a full stop and a capital read as the end of a sentence, so each step number is cut off from its text: "Step 1." / "Open the file." / "Step 2." / "Save it."',
  },

  // \u2500\u2500 urls, emails and file names \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  {
    category: 'urls, emails and file names',
    text: 'Visit www.example.com/page. Then log in.',
    sentences: ['Visit www.example.com/page.', 'Then log in.'],
  },
  {
    category: 'urls, emails and file names',
    text: 'Email jane.doe@example.org for details. She replies fast.',
    sentences: ['Email jane.doe@example.org for details.', 'She replies fast.'],
  },
  {
    category: 'urls, emails and file names',
    text: 'Open report.final.docx now. It is small.',
    sentences: ['Open report.final.docx now.', 'It is small.'],
  },
  {
    category: 'urls, emails and file names',
    text: 'See https://example.com/a.b?x=1.2 for more.',
    sentences: ['See https://example.com/a.b?x=1.2 for more.'],
  },

  // \u2500\u2500 lowercase starts \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  {
    category: 'lowercase starts',
    text: 'He bought apples. oranges were sold out.',
    sentences: ['He bought apples. oranges were sold out.'],
    status: 'policy',
    note: 'A lowercase letter after a full stop never opens a sentence: more often it is a typo or a continuation than a new sentence.',
  },
  {
    category: 'lowercase starts',
    text: 'It works. iPhone users agree.',
    sentences: ['It works.', 'iPhone users agree.'],
    status: 'gap',
    issue: 273,
    note: 'A product name that starts with a lowercase letter (iPhone, eBay) does open a sentence, but the segmenter only breaks before a capital, digit or opening mark.',
  },

  // \u2500\u2500 whitespace \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  {
    category: 'whitespace',
    text: 'First.\u00A0Second.',
    sentences: ['First.', 'Second.'],
  },
  {
    category: 'whitespace',
    text: 'First.  Second.',
    sentences: ['First.', 'Second.'],
  },
  {
    category: 'whitespace',
    text: 'First.\nSecond.',
    sentences: ['First.', 'Second.'],
  },
  {
    category: 'whitespace',
    text: 'First.Second is one token',
    sentences: ['First.Second is one token'],
  },

  // -- page references and place names the list does not know ----------
  {
    category: 'abbreviations',
    text: 'See p. 12 for details.',
    sentences: ['See p. 12 for details.'],
  },
  {
    category: 'abbreviations',
    text: 'Mt. Everest is the highest mountain.',
    sentences: ['Mt. Everest is the highest mountain.'],
  },
  {
    category: 'abbreviations',
    text: 'The meeting starts at 9 a.m. tomorrow.',
    sentences: ['The meeting starts at 9 a.m. tomorrow.'],
  },
  {
    category: 'abbreviation at a sentence end',
    text: 'The meeting starts at 9 a.m. Bring snacks.',
    sentences: ['The meeting starts at 9 a.m.', 'Bring snacks.'],
  },
  {
    category: 'abbreviations',
    text: 'Please see no. 5 for details.',
    sentences: ['Please see no. 5 for details.'],
  },
  {
    category: 'abbreviation at a sentence end',
    text: 'No. We moved on.',
    sentences: ['No.', 'We moved on.'],
  },
];
