import type { CorpusCase } from './types.fixture.js';

/**
 * Korean segmentation corpus (issue #267). Hangul has no case, so the
 * segmenter treats any letter after a full stop as a possible sentence start.
 */
export const KO: readonly CorpusCase[] = [
  {
    category: 'scripts without case',
    text: '안녕하세요. 만나서 반갑습니다.',
    sentences: ['안녕하세요.', '만나서 반갑습니다.'],
  },
  {
    category: 'scripts without case',
    text: '질문입니까? 네, 맞습니다!',
    sentences: ['질문입니까?', '네, 맞습니다!'],
  },
  {
    category: 'numbers and decimals',
    text: '이것은 새 제품입니다. 가격은 3.5달러입니다.',
    sentences: ['이것은 새 제품입니다.', '가격은 3.5달러입니다.'],
  },
  {
    category: 'numbers and decimals',
    text: '버전 2.0이 출시되었습니다. 많은 기능이 추가되었습니다.',
    sentences: ['버전 2.0이 출시되었습니다.', '많은 기능이 추가되었습니다.'],
  },
  {
    category: 'abbreviation at a sentence end',
    text: '저는 사과, 배 등. 그리고 포도를 샀어요.',
    sentences: ['저는 사과, 배 등. 그리고 포도를 샀어요.'],
    status: 'policy',
    note: '"등" (and so on) is in the abbreviation list, so a full stop after it does not break; a missed break only makes a longer segment.',
  },
  {
    category: 'abbreviation at a sentence end',
    text: '이것은 내가 좋아하는 것. 저것은 싫다.',
    sentences: ['이것은 내가 좋아하는 것.', '저것은 싫다.'],
    status: 'gap',
    issue: 274,
    note: 'The list holds single syllables such as "것" (thing), which is also how Korean notes and manuals end a clause ("...하는 것."). A full stop after it never breaks.',
  },
];
