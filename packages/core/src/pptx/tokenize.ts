/**
 * DrawingML paragraph content → tagged tokens (planning/v1-spec.md §3.9;
 * issue #169).
 *
 * The PPTX sibling of `docx/tokenize.ts`, for what a slide or a notes page
 * holds inside an `a:p`. It is simpler than Word's: a paragraph's content is
 * flat (runs, breaks, fields and the closing `a:endParaRPr`), with no
 * hyperlink, insertion or content-control wrapper to walk through, and a
 * hyperlink is a property of the run it is on.
 *
 * Like the DOCX tokenizer, this does not change the export path: an untouched
 * paragraph is spliced from its original XML, which is what keeps the roundtrip
 * gate byte-identical. Tokens are the editing representation.
 */

import { decodeXmlText } from '../docx/tokenize.js';
import { scanChildren, type XmlElement } from '../docx/xml-scan.js';
import type { FormatEntry, TagKind, Token, TokenizedRegion } from '../model/token.js';

/** The value of attribute `name` on a start tag, or undefined. */
function attrOf(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

/** `rPr`'s own start tag (attributes only), whether or not it has children. */
function startTag(rPr: string): string {
  return /^<a:rPr\b[^>]*>/.exec(rPr)?.[0] ?? '';
}

const isOn = (value: string | undefined): boolean => value === '1' || value === 'true';

/**
 * Run properties a translator would recognise as formatting: bold, italic,
 * underline, strikethrough, super- or subscript, capitals, a highlight, a
 * hyperlink. **Colour is not on the list**: PowerPoint puts a colour on nearly
 * every run, and a tag for each would bury the text. Size, spacing, `lang`,
 * `dirty`, `err` and the like are incidental. An incidental run still gets a
 * tag so it can be rebuilt; the tag is simply not shown.
 */
export function hasMeaningfulRunProps(rPr: string): boolean {
  const tag = startTag(rPr);
  const underline = attrOf(tag, 'u');
  const strike = attrOf(tag, 'strike');
  const baseline = attrOf(tag, 'baseline');
  const cap = attrOf(tag, 'cap');
  return (
    isOn(attrOf(tag, 'b')) ||
    isOn(attrOf(tag, 'i')) ||
    (underline !== undefined && underline !== 'none') ||
    (strike !== undefined && strike !== 'noStrike') ||
    (baseline !== undefined && baseline !== '0') ||
    (cap !== undefined && cap !== 'none') ||
    /<a:(highlight|hlinkClick|hlinkMouseOver)\b/.test(rPr)
  );
}

/** A display hint from a run's properties. */
function kindOfRunProps(rPr: string): TagKind {
  const tag = startTag(rPr);
  if (/<a:hlinkClick\b/.test(rPr)) return 'link';
  const baseline = Number(attrOf(tag, 'baseline') ?? '0');
  if (baseline > 0) return 'sup';
  if (baseline < 0) return 'sub';
  if (isOn(attrOf(tag, 'b'))) return 'b';
  if (isOn(attrOf(tag, 'i'))) return 'i';
  const underline = attrOf(tag, 'u');
  if (underline !== undefined && underline !== 'none') return 'u';
  const strike = attrOf(tag, 'strike');
  if (strike !== undefined && strike !== 'noStrike') return 'strike';
  return 'other';
}

function kindOfElement(name: string): TagKind {
  if (name === 'a:br') return 'br';
  if (name === 'a:fld') return 'field';
  return 'other';
}

/** Elements that show something on the page, so where they go is the translator's call. */
const VISIBLE_PH = new Set(['a:br', 'a:fld']);

/**
 * Tokenizes the content of one `a:p` (what `extractSkeleton` stored as a
 * region: everything after `a:pPr`).
 */
export function tokenizePptxRegion(xml: string): TokenizedRegion {
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

  const placeholder = (el: XmlElement): void => {
    const id = addFormat(
      kindOfElement(el.name),
      VISIBLE_PH.has(el.name),
      'block',
      xml.slice(el.start, el.end),
      '',
    );
    tokens.push({ t: 'ph', id, fmt: id });
  };

  const walkRun = (run: XmlElement): void => {
    const children = scanChildren(xml, run.contentStart, run.contentEnd);
    const propsEl = children.find((c) => c.name === 'a:rPr');
    const rPr = propsEl ? xml.slice(propsEl.start, propsEl.end) : '';
    const textEl = children.find((c) => c.name === 'a:t');
    const text = textEl
      ? decodeXmlText(xml.slice(textEl.contentStart, textEl.contentEnd))
      : '';

    // A run with no text, or with something besides its properties and one text
    // node, is kept whole and hidden: dropping it would be data loss, and
    // treating it as content would give it a tag that vanishes on re-render.
    const strangers = children.filter((c) => c.name !== 'a:rPr' && c.name !== 'a:t');
    if (text === '' || strangers.length > 0) {
      const id = addFormat('other', false, 'block', xml.slice(run.start, run.end), '');
      tokens.push({ t: 'ph', id, fmt: id });
      return;
    }

    if (rPr === '') {
      tokens.push({ t: 'text', v: text });
      return;
    }
    const id = addFormat(
      kindOfRunProps(rPr),
      hasMeaningfulRunProps(rPr),
      'run',
      `<a:r>${rPr}`,
      '</a:r>',
    );
    tokens.push({ t: 'open', id, fmt: id });
    tokens.push({ t: 'text', v: text });
    tokens.push({ t: 'close', id });
  };

  for (const el of scanChildren(xml, 0, xml.length)) {
    if (el.name === 'a:r') walkRun(el);
    else placeholder(el);
  }
  return { tokens, formats };
}
