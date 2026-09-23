/**
 * Tokens → runs (planning/v1-spec.md §3.2, §3.4; backlog #10).
 *
 * The inverse of {@link tokenizeRegion}: turns an edited token stream back
 * into OOXML that Word will open.
 *
 * This path is for **modified** segments only. An unmodified segment is
 * still exported by splicing its original XML, which is what keeps the
 * roundtrip gate byte-identical. A translated segment cannot be
 * byte-identical to its source — the words changed — so what is required
 * here is different: valid markup, the right formatting, and every
 * placeholder reproduced exactly.
 *
 * Tag-invalid input is rejected rather than rendered. Emitting broken XML
 * would hand the translator a document that Word refuses to open, and the
 * failure would surface at delivery rather than at the point of the
 * mistake.
 */

import { validateTagStructure } from '../model/tags.js';
import type { Token } from '../model/token.js';
import type { FormatEntry, TokenizedRegion } from './tokenize.js';

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

/** Escapes text for an XML text node. */
export function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * `xml:space="preserve"` is emitted whenever the text has edge
 * whitespace. Without it Word collapses a leading or trailing space, which
 * silently joins words across a formatting boundary — "**bold** text"
 * becoming "**bold**text".
 */
function textNode(value: string): string {
  const preserve = value !== value.trim() ? ' xml:space="preserve"' : '';
  return `<w:t${preserve}>${escapeXmlText(value)}</w:t>`;
}

/**
 * Collapses adjacent text and re-merges neighbouring runs that carry
 * identical formatting (spec §3.4).
 *
 * Editing fragments a segment: a translator typing inside a bold span can
 * leave three consecutive text tokens, and a segmentation split can leave
 * two adjacent runs with the same properties. Emitting those verbatim
 * produces valid but progressively noisier XML, and the noise compounds
 * every time the file is reopened and saved.
 */
export function mergeTokens(
  tokens: readonly Token[],
  formats: readonly FormatEntry[],
): Token[] {
  const byId = new Map(formats.map((f) => [f.id, f]));
  const out: Token[] = [];

  for (const token of tokens) {
    const previous = out[out.length - 1];

    if (token.t === 'text' && previous?.t === 'text') {
      out[out.length - 1] = { t: 'text', v: previous.v + token.v };
      continue;
    }

    // `</run a><run b>` with identical properties: drop both and carry on
    // inside the first run.
    if (token.t === 'open' && previous?.t === 'close') {
      const opening = byId.get(token.id);
      const closing = byId.get(previous.id);
      if (
        opening &&
        closing &&
        opening.placement === 'run' &&
        closing.placement === 'run' &&
        opening.open === closing.open
      ) {
        out.pop();
        continue;
      }
    }
    out.push(token);
  }
  return out;
}

/**
 * Renders a token stream to OOXML.
 *
 * Throws {@link RenderError} if the tags are not well-formed, or if a
 * token refers to a format entry that does not exist.
 */
export function renderTokens(
  tokens: readonly Token[],
  formats: readonly FormatEntry[],
): string {
  const structure = validateTagStructure(tokens);
  if (!structure.ok) {
    const detail = structure.errors
      .map((e) => `${e.code}(id ${e.id} at ${e.index})`)
      .join(', ');
    throw new RenderError(`refusing to render tag-invalid target: ${detail}`);
  }

  const byId = new Map(formats.map((f) => [f.id, f]));
  const lookup = (id: number): FormatEntry => {
    const entry = byId.get(id);
    if (!entry) throw new RenderError(`token refers to unknown format id ${id}`);
    return entry;
  };

  const merged = mergeTokens(tokens, formats);
  const open: FormatEntry[] = [];
  const insideRun = () => open.some((f) => f.placement === 'run');

  let out = '';
  for (const token of merged) {
    switch (token.t) {
      case 'text': {
        const node = textNode(token.v);
        out += insideRun() ? node : `<w:r>${node}</w:r>`;
        break;
      }
      case 'open': {
        const entry = lookup(token.id);
        out += entry.open;
        open.push(entry);
        break;
      }
      case 'close': {
        const entry = lookup(token.id);
        out += entry.close;
        open.pop();
        break;
      }
      case 'ph': {
        const entry = lookup(token.id);
        // A break or footnote reference is a run child and needs a run
        // around it when the stream is not already inside one.
        out +=
          entry.placement === 'in-run' && !insideRun()
            ? `<w:r>${entry.open}</w:r>`
            : entry.open;
        break;
      }
    }
  }
  return out;
}

/** Convenience: render a region tokenized by {@link tokenizeRegion}. */
export function renderRegion(region: TokenizedRegion): string {
  return renderTokens(region.tokens, region.formats);
}

/**
 * Replaces a segment's text while keeping its tags.
 *
 * The common editing case: the translator has typed a target and the
 * source's tags need carrying over. Tags are appended in source order
 * where the target does not place them itself.
 */
export function withText(region: TokenizedRegion, text: string): Token[] {
  const tags = region.tokens.filter((t) => t.t !== 'text');
  const first = region.tokens.findIndex((t) => t.t === 'text');
  if (first === -1) return [...region.tokens, { t: 'text', v: text }];

  // Keep tags that opened before the first text, then the new text, then
  // whatever closed after it — so a fully-wrapping pair still wraps.
  const before = region.tokens.slice(0, first).filter((t) => t.t !== 'text');
  const after = tags.slice(before.length);
  return [...before, { t: 'text', v: text }, ...after];
}
