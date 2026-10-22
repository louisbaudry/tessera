/**
 * Offset-reporting XML tree for the XLIFF filter (planning/v1-spec.md §3.8).
 *
 * The same stance as `docx/xml-scan.ts`: the filter edits the raw XML
 * *string* and this only says where things are, so everything outside a
 * located region stays byte-identical by construction. It differs in what it
 * reports: a whole element tree with attributes and namespaces, because an
 * XLIFF file's meaning is in its nesting (`<unit>` → `<segment>` → `<source>`)
 * and in mixed content (text between inline tags), where the DOCX scanner
 * only had to find named paragraphs.
 *
 * It is a scanner, not a validating parser: it checks that tags match and
 * that entities are ones XML defines, and nothing else. A file it cannot read
 * is refused by name (`XliffError`), never half-imported.
 */

export class XliffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XliffError';
  }
}

/** The XLIFF 2.x core namespace (2.0, 2.1 and 2.2 share it). */
export const XLIFF_NS = 'urn:oasis:names:tc:xliff:document:2.0';

export interface XText {
  readonly kind: 'text';
  /** Offset of the first character. */
  readonly start: number;
  /** Offset just past the last. */
  readonly end: number;
  /** The text with entities and CDATA decoded. */
  readonly text: string;
}

export interface XElement {
  readonly kind: 'element';
  /** The qualified name as written, prefix included. */
  readonly name: string;
  /** The name without its prefix. */
  readonly local: string;
  /** The namespace URI the prefix (or default) resolves to, or null. */
  readonly ns: string | null;
  /** Attributes by qualified name, values decoded. Declarations included. */
  readonly attrs: ReadonlyMap<string, string>;
  /** Offset of the opening `<`. */
  readonly start: number;
  /** Offset just past the opening tag's `>`. */
  readonly contentStart: number;
  /** Offset of the closing tag's `<`; equals `contentStart` when empty. */
  readonly contentEnd: number;
  /** Offset just past the final `>`. */
  readonly end: number;
  readonly selfClosing: boolean;
  readonly children: readonly XNode[];
}

export type XNode = XElement | XText;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Decodes the five predefined entities and numeric references. */
export function decodeEntities(raw: string, where: number): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(
    /&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g,
    (m, body: string) => {
      if (body.startsWith('#')) {
        const code =
          body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) {
          throw new XliffError(`bad character reference ${m} near offset ${where}`);
        }
        return String.fromCodePoint(code);
      }
      const named = NAMED_ENTITIES[body];
      if (named === undefined) {
        throw new XliffError(`undefined entity ${m} near offset ${where}`);
      }
      return named;
    },
  );
}

const NAME_RE = /[^\s/>=]+/y;
const SPACE_RE = /\s*/y;

/** Reads a start tag's attributes. `from` is just past the element name. */
function readAttributes(
  xml: string,
  from: number,
  tagEnd: number,
  tagStart: number,
): Map<string, string> {
  const attrs = new Map<string, string>();
  let i = from;
  for (;;) {
    SPACE_RE.lastIndex = i;
    SPACE_RE.exec(xml);
    i = SPACE_RE.lastIndex;
    if (i >= tagEnd) break;
    if (xml[i] === '/') break;
    NAME_RE.lastIndex = i;
    const nameMatch = NAME_RE.exec(xml);
    if (!nameMatch) throw new XliffError(`bad attribute at offset ${i}`);
    const name = nameMatch[0];
    i = NAME_RE.lastIndex;
    SPACE_RE.lastIndex = i;
    SPACE_RE.exec(xml);
    i = SPACE_RE.lastIndex;
    if (xml[i] !== '=') {
      throw new XliffError(
        `attribute "${name}" has no value (tag at offset ${tagStart})`,
      );
    }
    i++;
    SPACE_RE.lastIndex = i;
    SPACE_RE.exec(xml);
    i = SPACE_RE.lastIndex;
    const quote = xml[i];
    if (quote !== '"' && quote !== "'") {
      throw new XliffError(
        `attribute "${name}" is not quoted (tag at offset ${tagStart})`,
      );
    }
    const close = xml.indexOf(quote, i + 1);
    if (close === -1 || close >= tagEnd) {
      throw new XliffError(`unterminated attribute value at offset ${i}`);
    }
    if (attrs.has(name)) {
      throw new XliffError(`attribute "${name}" given twice (tag at offset ${tagStart})`);
    }
    attrs.set(name, decodeEntities(xml.slice(i + 1, close), i));
    i = close + 1;
  }
  return attrs;
}

/** The `>` that ends the tag starting at `start`, skipping quoted values. */
function findTagEnd(xml: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < xml.length; i++) {
    const ch = xml[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  throw new XliffError(`unterminated tag at offset ${start}`);
}

interface Scope {
  readonly prefixes: ReadonlyMap<string, string>;
}

function resolveNs(name: string, scope: Scope): string | null {
  const colon = name.indexOf(':');
  const prefix = colon === -1 ? '' : name.slice(0, colon);
  if (prefix === 'xml') return 'http://www.w3.org/XML/1998/namespace';
  return scope.prefixes.get(prefix) ?? null;
}

/**
 * Scans `xml` into its element tree.
 *
 * @throws XliffError for a tag that does not close, a closing tag that does
 *   not match, text or a second root outside the root element, an undefined
 *   entity, or an unquoted attribute.
 */
export function scanTree(xml: string): XElement {
  interface Open {
    name: string;
    start: number;
    contentStart: number;
    ns: string | null;
    attrs: Map<string, string>;
    children: XNode[];
    scope: Scope;
  }
  const stack: Open[] = [];
  let root: XElement | null = null;
  let i = 0;

  const pushText = (from: number, to: number, decode: boolean, raw?: string) => {
    if (to <= from) return;
    const top = stack[stack.length - 1];
    const slice = raw ?? xml.slice(from, to);
    if (!top) {
      if (slice.trim() !== '') {
        throw new XliffError(`text outside the root element at offset ${from}`);
      }
      return;
    }
    top.children.push({
      kind: 'text',
      start: from,
      end: to,
      text: decode ? decodeEntities(slice, from) : slice,
    });
  };

  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      pushText(i, xml.length, true);
      break;
    }
    pushText(i, lt, true);

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) throw new XliffError(`unterminated comment at offset ${lt}`);
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) throw new XliffError(`unterminated CDATA at offset ${lt}`);
      pushText(lt, end + 3, false, xml.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1)
        throw new XliffError(`unterminated processing instruction at offset ${lt}`);
      i = end + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      // A DOCTYPE: XLIFF has none, and an internal subset could define
      // entities this scanner would then misread. Refuse rather than guess.
      throw new XliffError(`a DOCTYPE or declaration at offset ${lt} is not supported`);
    }

    if (xml.startsWith('</', lt)) {
      const gt = xml.indexOf('>', lt);
      if (gt === -1) throw new XliffError(`unterminated tag at offset ${lt}`);
      const name = xml.slice(lt + 2, gt).trim();
      const top = stack.pop();
      if (!top || top.name !== name) {
        throw new XliffError(
          `closing </${name}> at offset ${lt} does not match ${
            top ? `<${top.name}>` : 'any open element'
          }`,
        );
      }
      const element: XElement = {
        kind: 'element',
        name: top.name,
        local: top.name.slice(top.name.indexOf(':') + 1),
        ns: top.ns,
        attrs: top.attrs,
        start: top.start,
        contentStart: top.contentStart,
        contentEnd: lt,
        end: gt + 1,
        selfClosing: false,
        children: top.children,
      };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(element);
      else root = element;
      i = gt + 1;
      continue;
    }

    const gt = findTagEnd(xml, lt);
    const selfClosing = xml[gt - 1] === '/';
    NAME_RE.lastIndex = lt + 1;
    const nameMatch = NAME_RE.exec(xml);
    if (!nameMatch) throw new XliffError(`element without a name at offset ${lt}`);
    const name = nameMatch[0];
    const attrs = readAttributes(xml, NAME_RE.lastIndex, selfClosing ? gt - 1 : gt, lt);

    const parentScope = stack[stack.length - 1]?.scope ?? {
      prefixes: new Map<string, string>(),
    };
    let scope = parentScope;
    for (const [key, value] of attrs) {
      if (key === 'xmlns' || key.startsWith('xmlns:')) {
        if (scope === parentScope) scope = { prefixes: new Map(parentScope.prefixes) };
        (scope.prefixes as Map<string, string>).set(
          key === 'xmlns' ? '' : key.slice(6),
          value,
        );
      }
    }
    const ns = resolveNs(name, scope);

    if (selfClosing) {
      const element: XElement = {
        kind: 'element',
        name,
        local: name.slice(name.indexOf(':') + 1),
        ns,
        attrs,
        start: lt,
        contentStart: gt + 1,
        contentEnd: gt + 1,
        end: gt + 1,
        selfClosing: true,
        children: [],
      };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(element);
      else if (root) throw new XliffError(`a second root element at offset ${lt}`);
      else root = element;
    } else {
      if (stack.length === 0 && root) {
        throw new XliffError(`a second root element at offset ${lt}`);
      }
      stack.push({
        name,
        start: lt,
        contentStart: gt + 1,
        ns,
        attrs,
        children: [],
        scope,
      });
    }
    i = gt + 1;
  }

  if (stack.length > 0) {
    throw new XliffError(`<${stack[stack.length - 1]!.name}> is never closed`);
  }
  if (!root) throw new XliffError('no root element');
  return root;
}

/** The element children of `el`, in order. */
export function elementChildren(el: XElement): XElement[] {
  return el.children.filter((c): c is XElement => c.kind === 'element');
}

/** Whether `el` is the XLIFF core element `local`. */
export function isCore(el: XElement, local: string): boolean {
  return el.ns === XLIFF_NS && el.local === local;
}
