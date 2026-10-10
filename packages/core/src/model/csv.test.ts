import { describe, expect, it } from 'vitest';

import { csvCell } from './csv.js';

describe('csvCell', () => {
  it('leaves plain text alone', () => {
    expect(csvCell('invoice')).toBe('invoice');
  });

  it('quotes a comma, a quote and a newline, doubling quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('one\ntwo')).toBe('"one\ntwo"');
  });

  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx'])(
    'neutralises %j so a spreadsheet does not run it',
    (cell) => {
      // A carriage return is also quoted, so look past an opening quote.
      expect(csvCell(cell).replace(/^"/, '').startsWith("'")).toBe(true);
    },
  );
});
