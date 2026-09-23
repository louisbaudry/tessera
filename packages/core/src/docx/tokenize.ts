/**
 * Runs → tagged tokens (planning/v1-spec.md §3.2, §3.3; backlog #9).
 *
 * Turns a region's raw XML into the {@link Token} stream a translator
 * edits: text, plus protected inline tags for everything else.
 *
 * **This does not change the export path.** An unmodified segment is still
 * exported by splicing its original XML, which is what keeps the roundtrip
 * gate byte-identical. Tokens are the editing representation; rendering a
 * *modified* segment back to XML is #10. A modified segment cannot be
 * byte-identical to the original anyway — its content changed — so the two
 * paths have genuinely different obligations.
 *
 * Tag ids are numbered per region from 1, in source order, so they are
 * stable across a reopen of the same file.
 */

import type { FormatEntry, TagKind, Token, TokenizedRegion } from '../model/token.js';
import { scanChildren, type XmlElement } from './xml-scan.js';

/**
 * `FormatEntry` and `TokenizedRegion` live in `model/token.ts` now, next
 * to `Token` — a project `Segment`'s own format table needs the same
 * type, and `model/` is the layer everything imports from, never the
 * reverse. Re-exported here so existing imports from this module are
 * unaffected.
 */
export type { FormatEntry, TokenizedRegion } from '../model/token.js';

/** Run children that are text rather than structure. */
const TEXT_NODES = new Set(['w:t']);

/** Run children that are visible, placeable objects. */
const VISIBLE_PH = new Set([
  'w:br',
  'w:tab',
  'w:sym',
  'w:footnoteReference',
  'w:endnoteReference',
  'w:footnoteRef',
  'w:endnoteRef',
  'w:drawing',
  'w:pict',
  'w:object',
  'w:instrText',
  'w:fldChar',
  'w:noBreakHyphen',
  'w:softHyphen',
  'w:ptab',
]);

/** Structure that carries no meaning for a translation. */
const HIDDEN_PH = new Set([
  'w:proofErr',
  'w:bookmarkStart',
  'w:bookmarkEnd',
  'w:lastRenderedPageBreak',
  'w:commentRangeStart',
  'w:commentRangeEnd',
  'w:commentReference',
  'w:permStart',
  'w:permEnd',
]);

/**
 * Wrappers whose children are current document text.
 *
 * Their content is walked so the text stays translatable, but the wrapper
 * itself is kept as a hidden paired tag rather than dropped. Flattening a
 * `w:ins` would silently accept a reviewer's pending insertion, and
 * dropping a `w:sdt` would destroy a content control — neither is a change
 * a translation tool has any business making.
 */
const WRAPPERS = new Set(['w:ins', 'w:smartTag']);

function kindOfElement(name: string): TagKind {
  switch (name) {
    case 'w:br':
      return 'br';
    case 'w:tab':
    case 'w:ptab':
      return 'tab';
    case 'w:footnoteReference':
    case 'w:footnoteRef':
    case 'w:endnoteReference':
    case 'w:endnoteRef':
      return 'footnote';
    case 'w:drawing':
    case 'w:pict':
    case 'w:object':
      return 'image';
    case 'w:instrText':
    case 'w:fldChar':
      return 'field';
    case 'w:bookmarkStart':
    case 'w:bookmarkEnd':
      return 'bookmark';
    default:
      return 'other';
  }
}

/**
 * Run properties that a translator would recognise as formatting.
 *
 * Everything else — kerning, font substitution, size, proofing state,
 * language tagging — is incidental typesetting that Word attaches to
 * almost every run. In one 31k-word manuscript, 9,261 runs carry nothing
 * but `w:spacing` against 201 that are actually italic. Treating any
 * `w:rPr` as a tag would put thousands of meaningless tags in front of the
 * translator and make the tag model unusable.
 *
 * Incidental properties still produce a tag, so the run can be rebuilt;
 * that tag is simply not shown (see {@link FormatEntry.visible}).
 */
const MEANINGFUL_PROPS = [
  'w:b',
  'w:bCs',
  'w:i',
  'w:iCs',
  'w:u',
  'w:strike',
  'w:dstrike',
  'w:caps',
  'w:smallCaps',
  'w:vertAlign',
  'w:rStyle',
  'w:highlight',
  'w:color',
  'w:em',
  'w:outline',
  'w:shadow',
  'w:vanish',
];

/** True when a run's properties carry formatting worth showing. */
export function hasMeaningfulRunProps(rPr: string): boolean {
  return MEANINGFUL_PROPS.some((prop) => {
    const on = new RegExp(`<${prop}\\b(?![^>]*w:val="(?:0|false|none)")`);
    return on.test(rPr);
  });
}

/** True when a run's properties element has no child elements at all. */
function isEmptyProps(rPr: string): boolean {
  return !/<w:[a-zA-Z]/.test(rPr.replace(/^<w:rPr[^>]*>/, '').replace(/<\/w:rPr>$/, ''));
}

/** Derives a display hint from a run's properties. */
function kindOfRunProps(rPr: string): TagKind {
  if (/<w:vertAlign[^>]*w:val="superscript"/.test(rPr)) return 'sup';
  if (/<w:vertAlign[^>]*w:val="subscript"/.test(rPr)) return 'sub';
  if (/<w:b\b(?![^>]*w:val="(?:0|false)")/.test(rPr)) return 'b';
  if (/<w:i\b(?![^>]*w:val="(?:0|false)")/.test(rPr)) return 'i';
  if (/<w:u\b/.test(rPr)) return 'u';
  if (/<w:strike\b/.test(rPr)) return 'strike';
  if (/<w:rStyle\b/.test(rPr)) return 'style';
  return 'other';
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeXmlText(s: string): string {
  return s.replace(/&(#x?[0-9A-Fa-f]+|[a-z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return String.fromCodePoint(parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return ENTITIES[body] ?? match;
  });
}

export function tokenizeRegion(xml: string): TokenizedRegion {
  const tokens: Token[] = [];
  const formats: FormatEntry[] = [];
  let nextId = 1;

  const addFormat = (
    kind: TagKind,
    visible: boolean,
    placement: FormatEntry['placement'],
    open: string,
    close: string,
  ): number => {
    const id = nextId++;
    formats.push({ id, kind, visible, placement, open, close });
    return id;
  };

  const placeholder = (
    el: XmlElement,
    visible: boolean,
    placement: 'in-run' | 'block',
  ): void => {
    const raw = xml.slice(el.start, el.end);
    const id = addFormat(kindOfElement(el.name), visible, placement, raw, '');
    tokens.push({ t: 'ph', id, fmt: id });
  };

  /** Emits a paired tag around whatever `inner` produces. */
  const paired = (kind: TagKind, open: string, close: string, inner: () => void) => {
    const id = addFormat(kind, true, 'inline', open, close);
    tokens.push({ t: 'open', id, fmt: id });
    inner();
    tokens.push({ t: 'close', id });
  };

  const walkRun = (run: XmlElement): void => {
    const children = scanChildren(xml, run.contentStart, run.contentEnd);
    const propsEl = children.find((c) => c.name === 'w:rPr');
    const rPr = propsEl ? xml.slice(propsEl.start, propsEl.end) : '';
    const body = children.filter((c) => c.name !== 'w:rPr');

    // A run holding only an empty <w:t></w:t> is an empty run: it has a
    // child element but contributes nothing. Word emits these around
    // character-style boundaries. Treating it as content would give it a
    // visible tag that vanishes the moment the segment is re-rendered,
    // because the render produces a genuinely empty run.
    const contentful = body.filter(
      (c) => !(TEXT_NODES.has(c.name) && c.contentStart === c.contentEnd),
    );

    // A run with no properties adds no tag: plain prose should produce
    // plain text, not a tag around every sentence.
    const emitBody = () => {
      for (const child of body) {
        if (TEXT_NODES.has(child.name)) {
          const text = decodeXmlText(xml.slice(child.contentStart, child.contentEnd));
          if (text.length > 0) tokens.push({ t: 'text', v: text });
        } else if (HIDDEN_PH.has(child.name)) {
          placeholder(child, false, 'in-run');
        } else {
          placeholder(child, VISIBLE_PH.has(child.name), 'in-run');
        }
      }
    };

    // An empty run — properties but no content — carries nothing visible,
    // but dropping it is still data loss: it changes the tag count and
    // stops a re-render from reaching a fixed point, so every save would
    // rewrite the document a little further. Keep it whole and hidden.
    if (contentful.length === 0) {
      const raw = xml.slice(run.start, run.end);
      const id = addFormat('other', false, 'block', raw, '');
      tokens.push({ t: 'ph', id, fmt: id });
      return;
    }

    if (rPr === '' || isEmptyProps(rPr)) {
      emitBody();
      return;
    }
    const visible = hasMeaningfulRunProps(rPr);
    const id = addFormat(kindOfRunProps(rPr), visible, 'run', `<w:r>${rPr}`, '</w:r>');
    tokens.push({ t: 'open', id, fmt: id });
    emitBody();
    tokens.push({ t: 'close', id });
  };

  const walk = (from: number, to: number): void => {
    for (const el of scanChildren(xml, from, to)) {
      if (el.name === 'w:r') {
        walkRun(el);
      } else if (el.name === 'w:hyperlink') {
        const openTag = xml.slice(el.start, el.contentStart);
        paired('link', openTag, '</w:hyperlink>', () =>
          walk(el.contentStart, el.contentEnd),
        );
      } else if (WRAPPERS.has(el.name)) {
        const id = addFormat(
          'other',
          false,
          'inline',
          xml.slice(el.start, el.contentStart),
          `</${el.name}>`,
        );
        tokens.push({ t: 'open', id, fmt: id });
        walk(el.contentStart, el.contentEnd);
        tokens.push({ t: 'close', id });
      } else if (el.name === 'w:sdtContent') {
        walk(el.contentStart, el.contentEnd);
      } else if (el.name === 'w:sdt') {
        // A content control wraps its body in w:sdtContent, with w:sdtPr
        // holding the control's definition. Keep both, translate the body.
        const content = scanChildren(xml, el.contentStart, el.contentEnd).find(
          (c) => c.name === 'w:sdtContent',
        );
        if (!content) {
          placeholder(el, false, 'block');
        } else {
          const id = addFormat(
            'other',
            false,
            'inline',
            xml.slice(el.start, content.contentStart),
            `</w:sdtContent></w:sdt>`,
          );
          tokens.push({ t: 'open', id, fmt: id });
          walk(content.contentStart, content.contentEnd);
          tokens.push({ t: 'close', id });
        }
      } else if (el.name === 'w:del') {
        // Deleted text is struck through — not part of what gets
        // translated (spec §3.5). Keep it whole and opaque.
        placeholder(el, false, 'block');
      } else if (HIDDEN_PH.has(el.name)) {
        placeholder(el, false, 'block');
      } else {
        placeholder(el, VISIBLE_PH.has(el.name), 'block');
      }
    }
  };

  walk(0, xml.length);
  return { tokens, formats };
}

/** The text a translator reads, tags discarded. */
export function tokensText(tokens: readonly Token[]): string {
  let out = '';
  for (const token of tokens) if (token.t === 'text') out += token.v;
  return out;
}

/** Tags the translator must actually place. */
export function visibleTags(region: TokenizedRegion): FormatEntry[] {
  const used = new Set<number>();
  for (const token of region.tokens) if (token.t !== 'text') used.add(token.id);
  return region.formats.filter((f) => used.has(f.id) && f.visible);
}
