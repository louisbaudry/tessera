/**
 * Tokens → a spreadsheet string (planning/v1-spec.md §3.10; issue #169).
 *
 * The renderer is the DOCX one (`renderTokens`), given what a spreadsheet
 * string needs that a paragraph does not:
 *
 * - **A string is either one `t` or runs, never both.** The schema lets a
 *   string hold a bare `t` or a list of `r`, so text outside any run tag is a
 *   bare `<t>` only when the whole string is text, and a run of its own
 *   (`<r><t>…</t></r>`) as soon as the string holds anything else.
 * - **A line break is a character.** The tokenizer's `br` placeholder
 *   (`LINE_BREAK_OPEN`) becomes a line feed in the text again before the
 *   stream is rendered, so a run still holds exactly one `t`.
 *
 * Like the DOCX path, this is for a string something was translated in; an
 * untouched one is spliced from its original XML.
 */

import { escapeXmlText, renderTokens, type RenderDialect } from '../docx/render.js';
import { LINE_BREAK_OPEN, type FormatEntry, type Token } from '../model/token.js';

/**
 * `xml:space="preserve"` wherever a consumer that does not preserve by default
 * would lose something: edge whitespace, a run of spaces, a line break or a
 * tab. Asking for it where it was not needed costs nothing (LibreOffice writes
 * it on every string).
 */
function textNode(value: string): string {
  const preserve = /^\s|\s$|\s\s|[\n\t]/.test(value) ? ' xml:space="preserve"' : '';
  return `<t${preserve}>${escapeXmlText(value)}</t>`;
}

/** A string that is only text: its one `t` stands alone. */
const PLAIN_RENDER: RenderDialect = { textNode, bareRun: (inner) => inner };

/** A string with runs: bare text is a run of its own beside them. */
const RICH_RENDER: RenderDialect = { textNode, bareRun: (inner) => `<r>${inner}</r>` };

/**
 * Renders a token stream to the content of an `si` or `is`. Throws
 * `RenderError` under the same conditions as {@link renderTokens}.
 */
export function renderXlsxTokens(
  tokens: readonly Token[],
  formats: readonly FormatEntry[],
): string {
  const breaks = new Set(
    formats
      .filter((f) => f.placement === 'in-run' && f.open === LINE_BREAK_OPEN)
      .map((f) => f.id),
  );
  const flat = tokens.map((token): Token =>
    token.t === 'ph' && breaks.has(token.id) ? { t: 'text', v: '\n' } : token,
  );
  const rich = flat.some((token) => token.t !== 'text');
  return renderTokens(flat, formats, rich ? RICH_RENDER : PLAIN_RENDER);
}
