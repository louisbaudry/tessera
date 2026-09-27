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
import { roleFits, xmlIllegalChar, type Token } from '../model/token.js';
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
 *
 * A run tag with nothing inside it is dropped: it has nothing to format,
 * and an edited target has them — a hidden run `carryHiddenTags` had no
 * text for — where a source never does (the tokenizer keeps an empty
 * source run whole, as a placeholder). So is empty text, which would
 * otherwise open a run with nothing in it.
 */
export function mergeTokens(
  tokens: readonly Token[],
  formats: readonly FormatEntry[],
): Token[] {
  const byId = new Map(formats.map((f) => [f.id, f]));
  const out: Token[] = [];

  for (const token of tokens) {
    if (token.t === 'text' && token.v === '') continue;
    const previous = out[out.length - 1];

    if (
      token.t === 'close' &&
      previous?.t === 'open' &&
      previous.id === token.id &&
      byId.get(token.id)?.placement === 'run'
    ) {
      out.pop();
      continue;
    }

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
 * Every structurally valid stream renders to valid markup, not only the
 * shapes the tokenizer produces (backlog #29). An edited target nests
 * what a source never does — a bold run tag inside the hidden run that
 * carries the paragraph's fonts (`carryHiddenTags`), a bookmark inside a
 * bold span — and a `w:r` inside a `w:r`, or a `w:hyperlink` or
 * `w:proofErr` inside one, is a file Word refuses to open. So:
 *
 * - Content (text, a run-level placeholder) takes the properties of its
 *   **innermost** enclosing run tag. A run tag's `open` is the whole
 *   `w:rPr` of the run it came from, never a delta, so the innermost one
 *   is the complete answer. The search stops at the nearest `inline` tag:
 *   run properties never cross a hyperlink, an insertion or a content
 *   control in OOXML, so neither does a run tag placed around one.
 * - Run XML is emitted lazily: opened when content needs it, switched
 *   when the innermost run changes, kept open (its text joined) when the
 *   next run carries identical properties.
 * - Anything that may not sit inside a run — a paired `inline` tag, a
 *   `block` placeholder — closes the open run first.
 *
 * For a stream shaped like the tokenizer's output (runs never nested,
 * never empty, nothing paragraph-level inside one) this is byte-identical
 * to emitting each tag where it stands, which is what keeps the fixed
 * point below and the roundtrip gate unaffected.
 *
 * Valid here means markup Word opens: no element where OOXML does not
 * allow it, and no character XML cannot carry. It does not mean a field
 * whose begin, separator and end placeholders were reordered still works
 * — each is a placeholder of its own, and the tag rules only see ids.
 *
 * Throws {@link RenderError} if the tags are not well-formed, if a token
 * refers to a format entry that does not exist or in a role it does not
 * fit (`roleFits` — a pair's XML as a placeholder has no close), or if
 * text holds a character XML cannot carry (`xmlIllegalChar`).
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

  for (const token of tokens) {
    const illegal = token.t === 'text' ? xmlIllegalChar(token.v) : null;
    if (illegal)
      throw new RenderError(`refusing to render ${illegal}: XML cannot carry it`);
  }

  const byId = new Map(formats.map((f) => [f.id, f]));
  for (const token of tokens) {
    if (token.t === 'text') continue;
    const entry = byId.get(token.id);
    if (entry && !roleFits(token.t, entry.placement)) {
      throw new RenderError(
        `refusing to render tag ${token.id} as a ${token.t}: it is a ${entry.placement} tag`,
      );
    }
  }
  const lookup = (id: number): FormatEntry => {
    const entry = byId.get(id);
    if (!entry) throw new RenderError(`token refers to unknown format id ${id}`);
    return entry;
  };

  const merged = mergeTokens(tokens, formats);
  const open: FormatEntry[] = [];
  /** The run whose `<w:r>` is open in the output, if any. */
  let emitted: FormatEntry | null = null;
  /** Text waiting to be written into it, as one `w:t`. */
  let text = '';
  let out = '';

  const innermostRun = (): FormatEntry | null => {
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i]!.placement === 'run') return open[i]!;
      if (open[i]!.placement === 'inline') return null;
    }
    return null;
  };
  const flush = () => {
    if (text !== '') out += textNode(text);
    text = '';
  };
  const closeRun = () => {
    flush();
    if (emitted) out += emitted.close;
    emitted = null;
  };
  /** Opens the run content here belongs to; false when it belongs to none. */
  const enterRun = (): boolean => {
    const want = innermostRun();
    if (emitted && want && emitted.open === want.open) return true;
    closeRun();
    if (!want) return false;
    out += want.open;
    emitted = want;
    return true;
  };

  for (const token of merged) {
    switch (token.t) {
      case 'text': {
        if (enterRun()) text += token.v;
        else out += `<w:r>${textNode(token.v)}</w:r>`;
        break;
      }
      case 'open': {
        const entry = lookup(token.id);
        open.push(entry);
        if (entry.placement !== 'run') {
          closeRun();
          out += entry.open;
        }
        break;
      }
      case 'close': {
        const entry = lookup(token.id);
        open.pop();
        if (entry.placement !== 'run') {
          closeRun();
          out += entry.close;
        }
        break;
      }
      case 'ph': {
        const entry = lookup(token.id);
        if (entry.placement === 'in-run') {
          // A break or footnote reference is a run child and needs a run
          // around it when the stream is not inside one.
          if (enterRun()) {
            flush();
            out += entry.open;
          } else {
            out += `<w:r>${entry.open}</w:r>`;
          }
        } else {
          closeRun();
          out += entry.open;
        }
        break;
      }
    }
  }
  closeRun();
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
