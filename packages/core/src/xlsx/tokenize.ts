/**
 * A spreadsheet string → tagged tokens (planning/v1-spec.md §3.10; issue #169).
 *
 * The XLSX sibling of `docx/tokenize.ts` and `pptx/tokenize.ts`, for what a
 * shared string (`si`) or an inline string (`is`) holds: either one `t`, or
 * rich-text runs (`r`, each an optional `rPr` and one `t`), then the phonetic
 * guide East Asian text may carry (`rPh`, `phoneticPr`).
 *
 * Like its siblings this does not change the export path: a string nobody
 * translated is spliced from its original XML, which is what keeps the
 * roundtrip gate byte-identical. Tokens are the editing representation, and
 * two things about them are particular to a spreadsheet:
 *
 * - **A line break in a cell is a character**, not an element (Alt+Enter
 *   stores a line feed in the text). It becomes a visible `br` placeholder, so
 *   a translator places it like any tag and QA reports one that went missing;
 *   `xlsx/render.ts` writes it back as the character.
 * - **A phonetic guide is dropped from the tokens.** It is a reading of the
 *   source text, so carrying it into a translated string would annotate words
 *   that are no longer there. An untranslated string keeps it, being spliced.
 */

import { decodeXmlText } from '../docx/tokenize.js';
import { scanChildren, type XmlElement } from '../docx/xml-scan.js';
import {
  LINE_BREAK_OPEN,
  type FormatEntry,
  type TagKind,
  type Token,
  type TokenizedRegion,
} from '../model/token.js';

/** A boolean run property (`<b/>`, `<i val="0"/>`): on unless its `val` says off. */
function isOn(rPr: string, name: string): boolean {
  const tag = new RegExp(`<${name}(?:\\s[^>]*)?/?>`).exec(rPr)?.[0];
  if (tag === undefined) return false;
  const val = /\sval="([^"]*)"/.exec(tag)?.[1];
  return val === undefined || (val !== '0' && val !== 'false');
}

/** The `val` of a run property element, or undefined when the element is absent. */
function valOf(rPr: string, name: string): string | undefined {
  const tag = new RegExp(`<${name}(?:\\s[^>]*)?/?>`).exec(rPr)?.[0];
  if (tag === undefined) return undefined;
  return /\sval="([^"]*)"/.exec(tag)?.[1] ?? '';
}

/** Whether `rPr` underlines: `<u/>` is a single underline, `val="none"` is none. */
function underlines(rPr: string): boolean {
  const val = valOf(rPr, 'u');
  return val !== undefined && val !== 'none';
}

/** `superscript`, `subscript` or undefined, from `<vertAlign val="…"/>`. */
function vertAlign(rPr: string): 'sup' | 'sub' | undefined {
  const val = valOf(rPr, 'vertAlign');
  return val === 'superscript' ? 'sup' : val === 'subscript' ? 'sub' : undefined;
}

/**
 * Run properties a translator would recognise as formatting: bold, italic,
 * underline, strikethrough, super- or subscript. **Font, size and colour are
 * not on the list**: Excel writes them on every run of a rich string, and a
 * tag for each would bury the text. An incidental run still gets a tag so it
 * can be rebuilt; the tag is simply not shown.
 */
export function hasMeaningfulRunProps(rPr: string): boolean {
  return (
    isOn(rPr, 'b') ||
    isOn(rPr, 'i') ||
    isOn(rPr, 'strike') ||
    underlines(rPr) ||
    vertAlign(rPr) !== undefined
  );
}

/** A display hint from a run's properties. */
function kindOfRunProps(rPr: string): TagKind {
  const vertical = vertAlign(rPr);
  if (vertical) return vertical;
  if (isOn(rPr, 'b')) return 'b';
  if (isOn(rPr, 'i')) return 'i';
  if (underlines(rPr)) return 'u';
  if (isOn(rPr, 'strike')) return 'strike';
  return 'other';
}

/** The phonetic guide: a reading of the source, never carried into a target. */
const PHONETIC = new Set(['rPh', 'phoneticPr']);

/**
 * Tokenizes the content of one `si` or `is` (what `extractSkeleton` stored as
 * a region).
 */
export function tokenizeXlsxRegion(xml: string): TokenizedRegion {
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

  /** Text, with each line break in it as a placeholder of its own. */
  const pushText = (text: string): void => {
    text.split(/\r\n|\r|\n/).forEach((line, i) => {
      if (i > 0) {
        const id = addFormat('br', true, 'in-run', LINE_BREAK_OPEN, '');
        tokens.push({ t: 'ph', id, fmt: id });
      }
      if (line !== '') tokens.push({ t: 'text', v: line });
    });
  };

  const textOf = (el: XmlElement): string =>
    decodeXmlText(xml.slice(el.contentStart, el.contentEnd));

  /** Kept whole and hidden: something this filter does not model, rebuilt as it was. */
  const keepWhole = (el: XmlElement): void => {
    const id = addFormat('other', false, 'block', xml.slice(el.start, el.end), '');
    tokens.push({ t: 'ph', id, fmt: id });
  };

  const walkRun = (run: XmlElement): void => {
    const children = scanChildren(xml, run.contentStart, run.contentEnd);
    const propsEl = children.find((c) => c.name === 'rPr');
    const textEl = children.find((c) => c.name === 't');
    const text = textEl ? textOf(textEl) : '';

    // A run with no text, or with something besides its properties and one
    // text node, is kept whole: dropping it would be data loss, and a tag
    // around nothing vanishes on re-render.
    const strangers = children.filter((c) => c.name !== 'rPr' && c.name !== 't');
    if (text === '' || strangers.length > 0) {
      keepWhole(run);
      return;
    }
    // A run with no properties is plain text in a rich string: the renderer
    // gives bare text its own run there (`xlsx/render.ts`).
    if (!propsEl) {
      pushText(text);
      return;
    }
    const rPr = xml.slice(propsEl.start, propsEl.end);
    const id = addFormat(
      kindOfRunProps(rPr),
      hasMeaningfulRunProps(rPr),
      'run',
      `<r>${rPr}`,
      '</r>',
    );
    tokens.push({ t: 'open', id, fmt: id });
    pushText(text);
    tokens.push({ t: 'close', id });
  };

  for (const el of scanChildren(xml, 0, xml.length)) {
    if (el.name === 't') pushText(textOf(el));
    else if (el.name === 'r') walkRun(el);
    else if (!PHONETIC.has(el.name)) keepWhole(el);
  }
  return { tokens, formats };
}
