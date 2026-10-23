/**
 * What a tag is, in words (v1-spec.md §7.2): the "show full tags" view,
 * and every chip's tooltip. A chip is numbered by its tag id; the full
 * view says what formatting the number stands for (`bold italic`, `link`).
 *
 * Read from the format table's raw XML, the only description of a tag
 * there is — the filter carries formatting as bytes, not as a parsed
 * property set (§3.1). What is named here is what the filter shows a
 * translator at all: the run properties `hasMeaningfulRunProps` counts as
 * formatting (a tag carrying only kerning or a font is never visible),
 * hyperlinks, and the placeholders `tokenizeRegion` makes visible.
 */
import type { FormatEntry } from '@cat-tool/core';

/** Run properties by element, in the order they are named. */
const RUN_FEATURES: ReadonlyArray<readonly [string, string]> = [
  ['b', 'bold'],
  ['i', 'italic'],
  ['u', 'underline'],
  ['strike', 'strikethrough'],
  ['dstrike', 'double strikethrough'],
  ['caps', 'all caps'],
  ['smallCaps', 'small caps'],
  ['em', 'emphasis mark'],
  ['outline', 'outline'],
  ['shadow', 'shadow'],
  ['vanish', 'hidden text'],
];

const attr = (xml: string, element: string, name: string): string | undefined =>
  new RegExp(`<w:${element}\\b[^>]*\\b${name}="([^"]*)"`).exec(xml)?.[1];

/** Whether a toggle property is on: present and not switched off. */
const isOn = (rPr: string, element: string): boolean =>
  new RegExp(`<w:${element}\\b(?![^>]*w:val="(?:0|false|none)")`).test(rPr);

function describeRun(rPr: string): string[] {
  const words = RUN_FEATURES.filter(([el]) => isOn(rPr, el)).map(([, word]) => word);
  const vertAlign = attr(rPr, 'vertAlign', 'w:val');
  if (vertAlign === 'superscript' || vertAlign === 'subscript') words.push(vertAlign);
  const style = attr(rPr, 'rStyle', 'w:val');
  if (style) words.push(`style ${style}`);
  const highlight = attr(rPr, 'highlight', 'w:val');
  if (highlight && highlight !== 'none') words.push(`highlight ${highlight}`);
  const color = attr(rPr, 'color', 'w:val');
  if (color && color !== 'auto') words.push(`colour #${color}`);
  return words;
}

function describePlaceholder(xml: string): string {
  const element = /^<([\w:]+)/.exec(xml)?.[1] ?? '';
  switch (element) {
    case 'w:br':
      return attr(xml, 'br', 'w:type') === 'page' ? 'page break' : 'line break';
    case 'w:cr':
      return 'line break';
    case 'w:tab':
    case 'w:ptab':
      return 'tab';
    case 'w:footnoteReference':
    case 'w:footnoteRef':
      return 'footnote';
    case 'w:endnoteReference':
    case 'w:endnoteRef':
      return 'endnote';
    case 'w:drawing':
    case 'w:pict':
      return 'image';
    case 'w:object':
      return 'object';
    case 'w:instrText': {
      const code = /<w:instrText\b[^>]*>([^<]*)</.exec(xml)?.[1]?.trim();
      return code ? `field ${code}` : 'field';
    }
    case 'w:fldSimple': {
      const code = attr(xml, 'fldSimple', 'w:instr')?.trim().split(/\s+/)[0];
      return code ? `field ${code}` : 'field';
    }
    case 'w:pgNum':
      return 'page number';
    case 'w:dayShort':
    case 'w:dayLong':
    case 'w:monthShort':
    case 'w:monthLong':
    case 'w:yearShort':
    case 'w:yearLong':
      return 'date';
    case 'm:oMath':
    case 'm:oMathPara':
      return 'equation';
    case 'w:fldChar': {
      const type = attr(xml, 'fldChar', 'w:fldCharType');
      return type ? `field ${type}` : 'field';
    }
    case 'w:sym':
      return 'symbol';
    case 'w:noBreakHyphen':
      return 'non-breaking hyphen';
    case 'w:softHyphen':
      return 'soft hyphen';
    default:
      return element.replace(/^w:/, '') || 'placeholder';
  }
}

/**
 * An XLIFF 2.x tag (`v1-spec.md` §3.8), named by what the file calls it: its
 * `disp` or `equiv` text when it has one, else its type, else the element.
 */
function describeXliffTag(xml: string): string {
  const element = /^<(?:[\w-]+:)?(pc|ph|sc|ec|sm|em|mrk|cp)\b/.exec(xml)?.[1] ?? 'tag';
  const named = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(xml)?.[1];
  const label = named('disp') ?? named('equiv') ?? named('type');
  switch (element) {
    case 'cp':
      return 'control character';
    case 'mrk':
      return label ? `marker ${label}` : 'marker';
    default:
      return (
        label ?? (element === 'ph' ? 'placeholder' : element === 'pc' ? 'tag' : element)
      );
  }
}

/** Words for a DrawingML run (`a:r`, PPTX): its attributes and the few child elements that matter. */
function describeDrawingRun(open: string): string {
  const tag = /<a:rPr\b[^>]*>/.exec(open)?.[0] ?? '';
  const value = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
  const words: string[] = [];
  const on = (v: string | undefined) => v === '1' || v === 'true';
  if (on(value('b'))) words.push('bold');
  if (on(value('i'))) words.push('italic');
  const underline = value('u');
  if (underline !== undefined && underline !== 'none') words.push('underline');
  const strike = value('strike');
  if (strike !== undefined && strike !== 'noStrike') words.push('strikethrough');
  const baseline = Number(value('baseline') ?? '0');
  if (baseline > 0) words.push('superscript');
  if (baseline < 0) words.push('subscript');
  const cap = value('cap');
  if (cap !== undefined && cap !== 'none') words.push('capitals');
  if (/<a:hlinkClick\b/.test(open)) words.push('link');
  if (/<a:highlight\b/.test(open)) words.push('highlight');
  return words.join(' ');
}

/** Words for a DrawingML paragraph-level element (PPTX): a break, a field. */
function describeDrawingPlaceholder(xml: string): string {
  const element = /^<([\w:]+)/.exec(xml)?.[1] ?? '';
  switch (element) {
    case 'a:br':
      return 'line break';
    case 'a:fld': {
      const type = /\stype="([^"]*)"/.exec(xml.slice(0, xml.indexOf('>')))?.[1];
      return type ? `field ${type}` : 'field';
    }
    case 'a:endParaRPr':
      return 'end of paragraph';
    default:
      return element.replace(/^a:/, '') || 'placeholder';
  }
}

/**
 * The words for a tag's format: `bold italic`, `link`, `footnote`,
 * `field PAGE`. A tag the table cannot explain is `unknown tag`.
 */
export function describeFormat(format: FormatEntry | undefined): string {
  if (!format) return 'unknown tag';
  if (/^<(?:[\w-]+:)?(?:pc|ph|sc|ec|sm|em|mrk|cp)\b/.test(format.open)) {
    return describeXliffTag(format.open);
  }
  // PPTX (DrawingML, issue #169): a run is `<a:r>`, a placeholder another `a:` element.
  if (format.open.startsWith('<a:r>'))
    return describeDrawingRun(format.open) || format.kind;
  if (/^<a:/.test(format.open)) return describeDrawingPlaceholder(format.open);
  switch (format.placement) {
    case 'run': {
      const rPr =
        /<w:rPr\b[\s\S]*<\/w:rPr>|<w:rPr\b[^>]*\/>/.exec(format.open)?.[0] ?? '';
      const words = describeRun(rPr);
      return words.length ? words.join(' ') : format.kind;
    }
    case 'inline':
      if (format.kind === 'link') {
        const anchor = attr(format.open, 'hyperlink', 'w:anchor');
        return anchor ? `link #${anchor}` : 'link';
      }
      return format.kind;
    case 'in-run':
    case 'block':
      return describePlaceholder(format.open);
  }
}
