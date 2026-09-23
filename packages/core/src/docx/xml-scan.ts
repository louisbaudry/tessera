/**
 * Offset-reporting XML scanner.
 *
 * The DOCX filter must never rebuild a part from a parsed tree. Generic
 * serializers reorder attributes, change self-closing style, and — the one
 * that actually bit us — drop namespace declarations that are referenced
 * only by `mc:Ignorable`, producing OOXML that Word must repair.
 *
 * So the filter edits the raw XML *string*, and this scanner exists only to
 * say where things are. It never rewrites anything, and everything outside
 * a located region stays byte-identical by construction.
 *
 * It is a scanner, not a parser: it tracks element boundaries, quoting, and
 * the constructs that can hide a `<` or `>`, and nothing else. OOXML is
 * machine-generated and well-formed, which is what makes that sufficient.
 */

export interface XmlElement {
  readonly name: string;
  /** Offset of the opening `<`. */
  readonly start: number;
  /** Offset just past the opening tag's `>`. */
  readonly contentStart: number;
  /** Offset of the closing tag's `<`. Equals `contentStart` when empty. */
  readonly contentEnd: number;
  /** Offset just past the final `>`. */
  readonly end: number;
  readonly selfClosing: boolean;
  /** Nesting depth among *scanned* elements, 0 for outermost. */
  readonly depth: number;
}

export class XmlScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlScanError';
  }
}

const SKIPPABLE: ReadonlyArray<readonly [string, string]> = [
  ['<!--', '-->'],
  ['<![CDATA[', ']]>'],
  ['<?', '?>'],
];

/** Reads a tag name starting just past `<` or `</`. */
function readName(xml: string, from: number): string {
  let i = from;
  while (i < xml.length && !/[\s/>]/.test(xml[i]!)) i++;
  return xml.slice(from, i);
}

/**
 * Finds the `>` that ends a tag starting at `start`, skipping over any `>`
 * that appears inside a quoted attribute value.
 */
function findTagEnd(xml: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < xml.length; i++) {
    const ch = xml[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  throw new XmlScanError(`unterminated tag at offset ${start}`);
}

/**
 * Scans for every element whose qualified name is in `names`.
 *
 * Returns them in document order (by opening-tag offset). Nesting is
 * reported via `depth`, counted among matched elements only — a `w:p`
 * inside a text box inside another `w:p` comes back at depth 1.
 */
export function scanElements(xml: string, names: ReadonlySet<string>): XmlElement[] {
  const found: XmlElement[] = [];
  // Open matched elements, innermost last.
  const open: Array<{ name: string; start: number; contentStart: number }> = [];

  let i = 0;
  outer: while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) break;

    for (const [prefix, suffix] of SKIPPABLE) {
      if (xml.startsWith(prefix, lt)) {
        const close = xml.indexOf(suffix, lt + prefix.length);
        if (close === -1) {
          throw new XmlScanError(`unterminated ${prefix} at offset ${lt}`);
        }
        i = close + suffix.length;
        continue outer;
      }
    }

    // Doctype and other declarations: no nested `<` in practice.
    if (xml.startsWith('<!', lt)) {
      i = findTagEnd(xml, lt) + 1;
      continue;
    }

    if (xml.startsWith('</', lt)) {
      const name = readName(xml, lt + 2);
      const gt = findTagEnd(xml, lt);
      if (names.has(name)) {
        const top = open.pop();
        if (!top || top.name !== name) {
          throw new XmlScanError(
            `closing </${name}> at offset ${lt} does not match ${
              top ? `<${top.name}>` : 'any open element'
            }`,
          );
        }
        found.push({
          name,
          start: top.start,
          contentStart: top.contentStart,
          contentEnd: lt,
          end: gt + 1,
          selfClosing: false,
          depth: open.length,
        });
      }
      i = gt + 1;
      continue;
    }

    const name = readName(xml, lt + 1);
    const gt = findTagEnd(xml, lt);
    const selfClosing = xml[gt - 1] === '/';
    if (names.has(name)) {
      if (selfClosing) {
        found.push({
          name,
          start: lt,
          contentStart: gt + 1,
          contentEnd: gt + 1,
          end: gt + 1,
          selfClosing: true,
          depth: open.length,
        });
      } else {
        open.push({ name, start: lt, contentStart: gt + 1 });
      }
    }
    i = gt + 1;
  }

  if (open.length > 0) {
    throw new XmlScanError(`unclosed <${open[open.length - 1]!.name}>`);
  }
  return found.sort((a, b) => a.start - b.start);
}

/**
 * The elements directly inside `[from, to)`, ignoring anything deeper.
 *
 * The tokenizer walks the XML structurally — a run, then its children —
 * rather than searching for known tag names, because an unrecognised
 * element must still be captured rather than silently skipped.
 */
export function scanChildren(xml: string, from: number, to: number): XmlElement[] {
  const found: XmlElement[] = [];
  let i = from;

  outer: while (i < to) {
    const lt = xml.indexOf('<', i);
    if (lt === -1 || lt >= to) break;

    for (const [prefix, suffix] of SKIPPABLE) {
      if (xml.startsWith(prefix, lt)) {
        const close = xml.indexOf(suffix, lt + prefix.length);
        if (close === -1) throw new XmlScanError(`unterminated ${prefix}`);
        i = close + suffix.length;
        continue outer;
      }
    }
    if (xml.startsWith('<!', lt)) {
      i = findTagEnd(xml, lt) + 1;
      continue;
    }
    if (xml.startsWith('</', lt)) {
      // A closing tag at this level ends the range.
      break;
    }

    const name = readName(xml, lt + 1);
    const gt = findTagEnd(xml, lt);
    if (xml[gt - 1] === '/') {
      found.push({
        name,
        start: lt,
        contentStart: gt + 1,
        contentEnd: gt + 1,
        end: gt + 1,
        selfClosing: true,
        depth: 0,
      });
      i = gt + 1;
      continue;
    }

    // Walk forward to this element's own closing tag, tracking depth so a
    // nested element of the same name does not end it early.
    let depth = 1;
    let j = gt + 1;
    while (j < xml.length && depth > 0) {
      const next = xml.indexOf('<', j);
      if (next === -1) throw new XmlScanError(`unclosed <${name}>`);
      let skipped = false;
      for (const [prefix, suffix] of SKIPPABLE) {
        if (xml.startsWith(prefix, next)) {
          const close = xml.indexOf(suffix, next + prefix.length);
          if (close === -1) throw new XmlScanError(`unterminated ${prefix}`);
          j = close + suffix.length;
          skipped = true;
          break;
        }
      }
      if (skipped) continue;

      const end = findTagEnd(xml, next);
      if (xml.startsWith('</', next)) {
        depth--;
        if (depth === 0) {
          found.push({
            name,
            start: lt,
            contentStart: gt + 1,
            contentEnd: next,
            end: end + 1,
            selfClosing: false,
            depth: 0,
          });
          i = end + 1;
          break;
        }
      } else if (xml[end - 1] !== '/' && !xml.startsWith('<!', next)) {
        depth++;
      }
      j = end + 1;
    }
    if (depth > 0) throw new XmlScanError(`unclosed <${name}>`);
  }
  return found;
}

/** True when `inner` lies strictly within `outer`. */
export function contains(outer: XmlElement, inner: XmlElement): boolean {
  return inner.start >= outer.contentStart && inner.end <= outer.contentEnd;
}

/**
 * Of the given elements, those not contained in any other — i.e. the
 * outermost ones. Used to walk paragraphs without descending into the
 * paragraphs nested inside text boxes.
 */
export function outermost(elements: readonly XmlElement[]): XmlElement[] {
  return elements.filter((el) => !elements.some((other) => contains(other, el)));
}
