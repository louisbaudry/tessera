/**
 * The printable quote for a priced order (issue #179, `planning/solo-translator-spec.md` D3): a
 * whole HTML document the admin opens and prints, or saves as PDF from the browser. It is made from
 * `quoteFor`, so its total is always the order's stored price. It says on its face that it is not an
 * invoice: it carries no invoice number, tax identity or payment terms (those wait for Epic 13).
 *
 * Every value from the database (the client's name, the portal's name) is escaped, and the page
 * carries no script: the admin opens it from a blob on the portal's origin.
 */

import type { Quote } from '@cat-tool/portal-core';

import { escapeHtml } from './page.js';

/** What the page names besides the quote itself. */
export interface QuotePageInput {
  readonly portalName: string;
  readonly clientName: string;
  readonly orderId: number;
  /** ISO 4217 (portal-v0-spec.md §9c). */
  readonly currency: string;
  /** The day the quote is printed, `YYYY-MM-DD`. */
  readonly issuedOn: string;
  readonly quote: Quote;
}

/**
 * The quote as a complete HTML document.
 *
 * @param input - The quote and what it names.
 * @returns HTML with every stored value escaped.
 */
export function renderQuoteHtml(input: QuotePageInput): string {
  const { quote } = input;
  const money = new Intl.NumberFormat('en', {
    style: 'currency',
    currency: input.currency,
  });
  const words = new Intl.NumberFormat('en');
  const pair = (tgt: string) => `${escapeHtml(quote.srcLang)} &rarr; ${escapeHtml(tgt)}`;
  const rows =
    quote.lines === null
      ? `<tr><td>Translation, ${escapeHtml(quote.srcLang)} &rarr; ${quote.tgtLangs
          .map(escapeHtml)
          .join(', ')}</td><td class="n">${words.format(quote.wordCount)}</td><td></td>` +
        `<td class="n">${escapeHtml(money.format(quote.total))}</td></tr>`
      : quote.lines
          .map(
            (line) =>
              `<tr><td>Translation, ${pair(line.tgtLang)}</td>` +
              `<td class="n">${words.format(line.billedWords)}</td>` +
              `<td class="n">${escapeHtml(money.format(line.ratePerWord))}${
                line.minimumApplied ? ' (minimum price)' : ''
              }</td>` +
              `<td class="n">${escapeHtml(money.format(line.price))}</td></tr>`,
          )
          .join('');
  const title = `Quote for order ${input.orderId}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; color: #111; background: #fff; margin: 2rem auto; max-width: 48rem; padding: 0 1rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .meta { color: #444; margin-bottom: 1.5rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid #ddd; }
  .n { text-align: right; font-variant-numeric: tabular-nums; }
  tfoot td { font-weight: 600; border-bottom: none; }
  .note { color: #555; font-size: .85rem; margin-top: 2rem; }
  @media print { body { margin: 0 auto; } .noprint { display: none; } }
</style>
</head>
<body>
<p class="noprint">Print this page, or save it as PDF, from your browser's Print command.</p>
<h1>${escapeHtml(input.portalName)}</h1>
<p class="meta">${escapeHtml(title)}<br>For: ${escapeHtml(input.clientName)}<br>Date: ${escapeHtml(input.issuedOn)}</p>
<table>
<thead><tr><th>Item</th><th class="n">Words</th><th class="n">Rate per word</th><th class="n">Price</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot><tr><td colspan="3">Total (${escapeHtml(input.currency)})</td><td class="n">${escapeHtml(money.format(quote.total))}</td></tr></tfoot>
</table>
<p class="note">Source words: ${words.format(quote.wordCount)}. This is a quote, not an invoice.</p>
</body>
</html>
`;
}
