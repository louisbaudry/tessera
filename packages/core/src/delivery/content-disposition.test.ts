import { describe, expect, it } from 'vitest';

import { attachmentDisposition } from './content-disposition.js';

describe('attachmentDisposition', () => {
  it('quotes an ASCII name as-is and repeats it percent-encoded', () => {
    expect(attachmentDisposition('report.docx')).toBe(
      `attachment; filename="report.docx"; filename*=UTF-8''report.docx`,
    );
  });

  it('never lets a quote, backslash or non-ASCII character into the quoted fallback', () => {
    const header = attachmentDisposition('r\u00e9sum\u00e9 "final".docx');
    expect(header).toBe(
      `attachment; filename="r_sum_ _final_.docx"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.docx`,
    );
  });
});
