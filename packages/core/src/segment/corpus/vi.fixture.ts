import type { CorpusCase } from './types.fixture.js';

/** Vietnamese segmentation corpus (issue #267). */
export const VI: readonly CorpusCase[] = [
  {
    category: 'plain terminators',
    text: 'Xin chào. Tôi là Lan.',
    sentences: ['Xin chào.', 'Tôi là Lan.'],
  },
  {
    category: 'plain terminators',
    text: 'Bạn khỏe không? Tôi khỏe!',
    sentences: ['Bạn khỏe không?', 'Tôi khỏe!'],
  },
  {
    category: 'abbreviations',
    text: 'TS. Nguyễn đến muộn. Mọi người chờ.',
    sentences: ['TS. Nguyễn đến muộn.', 'Mọi người chờ.'],
  },
  {
    category: 'numbers and decimals',
    text: 'Giá là 1.250.000 đồng. Rất đắt.',
    sentences: ['Giá là 1.250.000 đồng.', 'Rất đắt.'],
  },
  {
    category: 'abbreviation at a sentence end',
    text: 'Ví dụ: A, B, v.v. Sau đó chúng tôi đi.',
    sentences: ['Ví dụ: A, B, v.v.', 'Sau đó chúng tôi đi.'],
  },
  {
    category: 'abbreviations',
    text: 'Xem tr. 12 để biết thêm.',
    sentences: ['Xem tr. 12 để biết thêm.'],
  },
];
