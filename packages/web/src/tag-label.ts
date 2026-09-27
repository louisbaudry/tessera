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
 * The words for a tag's format: `bold italic`, `link`, `footnote`,
 * `field PAGE`. A tag the table cannot explain is `unknown tag`.
 */
export function describeFormat(format: FormatEntry | undefined): string {
  if (!format) return 'unknown tag';
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
