/**
 * TMX 1.4b parsing and serialization (tm-format-spec.md §8; backlog
 * #18 import, #21 export).
 *
 * The multilingual `.ctm` model maps onto TMX directly — `tu` ↔ `<tu>`,
 * `tuv` ↔ `<tuv xml:lang>` — so this module's job is narrow: turn a TMX
 * document into the shape a `.ctm` writer needs (`ParsedTmx`), and turn
 * the shape a `.ctm` reader produces (`TmxExportDoc`) back into TMX
 * text, with nothing DB-specific in either direction. `@cat-tool/db/tm`'s
 * `importTmx`/`exportTmx` do the actual reading and writing.
 *
 * Unlike the DOCX filter, there is no byte-fidelity requirement here —
 * §8's own lossy-export table says so — so this parses into a real tree
 * rather than slicing the original string. The parser below is generic
 * (attribute/entity decoding, CDATA, comments, mixed content) rather
 * than TMX-specific; only the walk from that tree into `ParsedTmx` knows
 * about `<tu>`/`<tuv>`/`<bpt>` etc. `serializeTmx` is the inverse walk,
 * from `TmxExportDoc` into text.
 */

import type { TagKind, TmToken } from '../model/token.js';

export class TmxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TmxError';
  }
}

// ---------------------------------------------------------------------
// A minimal generic XML parser. Just enough of the spec for real TMX
// exports: elements, attributes, text, CDATA, comments, processing
// instructions, a DOCTYPE to skip over. No external DTD resolution, no
// custom entities beyond the five predefined ones plus numeric refs —
// TMX does not need either.
// ---------------------------------------------------------------------

interface XmlText {
  readonly type: 'text';
  readonly value: string;
}

interface XmlElement {
  readonly type: 'element';
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
}

type XmlNode = XmlText | XmlElement;

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(
    /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, ent: string) => {
      if (ent[0] === '#') {
        const code =
          ent[1] === 'x' || ent[1] === 'X'
            ? parseInt(ent.slice(2), 16)
            : parseInt(ent.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      switch (ent) {
        case 'amp':
          return '&';
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        default:
          // An entity this parser does not know (a DTD-defined custom
          // entity, in practice): left verbatim rather than guessed at.
          return match;
      }
    },
  );
}

const ATTR_PATTERN = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseAttrs(tagBody: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_PATTERN.exec(tagBody))) {
    const value = m[3] !== undefined ? m[3] : m[4]!;
    attrs[m[1]!] = decodeEntities(value);
  }
  return attrs;
}

function parseXmlDocument(xml: string): XmlElement {
  const s = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  const len = s.length;
  let i = 0;

  function readName(from: number): string {
    let j = from;
    while (j < len && !/[\s/>]/.test(s[j]!)) j++;
    return s.slice(from, j);
  }

  function skipDoctype(start: number): number {
    let j = start;
    let depth = 0;
    for (; j < len; j++) {
      const c = s[j]!;
      if (c === '[') depth++;
      else if (c === ']') depth--;
      else if (c === '>' && depth <= 0) return j + 1;
    }
    throw new TmxError('unterminated <!DOCTYPE');
  }

  function skipMisc(): void {
    for (;;) {
      while (i < len && /\s/.test(s[i]!)) i++;
      if (s.startsWith('<?', i)) {
        const end = s.indexOf('?>', i);
        if (end === -1) throw new TmxError('unterminated processing instruction');
        i = end + 2;
        continue;
      }
      if (s.startsWith('<!--', i)) {
        const end = s.indexOf('-->', i + 4);
        if (end === -1) throw new TmxError('unterminated comment');
        i = end + 3;
        continue;
      }
      if (/^<!DOCTYPE/i.test(s.slice(i, i + 9))) {
        i = skipDoctype(i);
        continue;
      }
      break;
    }
  }

  function textNode(raw: string): XmlText {
    return { type: 'text', value: decodeEntities(raw) };
  }

  function parseElement(): XmlElement {
    const tagStart = i;
    i++; // past '<'
    const name = readName(i);
    i += name.length;
    const bodyStart = i;
    let quote: string | null = null;
    while (i < len) {
      const c = s[i]!;
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
      i++;
    }
    if (i >= len) throw new TmxError(`unterminated tag <${name}> at offset ${tagStart}`);
    const tagBody = s.slice(bodyStart, i);
    const selfClosing = tagBody.endsWith('/');
    const attrs = parseAttrs(selfClosing ? tagBody.slice(0, -1) : tagBody);
    i++; // past '>'
    if (selfClosing) return { type: 'element', name, attrs, children: [] };

    const children: XmlNode[] = [];
    let textStart = i;
    for (;;) {
      if (i >= len) throw new TmxError(`unterminated element <${name}>`);
      if (s.startsWith('<![CDATA[', i)) {
        if (i > textStart) children.push(textNode(s.slice(textStart, i)));
        const end = s.indexOf(']]>', i + 9);
        if (end === -1) throw new TmxError('unterminated CDATA section');
        children.push({ type: 'text', value: s.slice(i + 9, end) });
        i = end + 3;
        textStart = i;
        continue;
      }
      if (s.startsWith('<!--', i)) {
        if (i > textStart) children.push(textNode(s.slice(textStart, i)));
        const end = s.indexOf('-->', i + 4);
        if (end === -1) throw new TmxError('unterminated comment');
        i = end + 3;
        textStart = i;
        continue;
      }
      if (s.startsWith('</', i)) {
        if (i > textStart) children.push(textNode(s.slice(textStart, i)));
        const closeName = readName(i + 2);
        const gt = s.indexOf('>', i + 2);
        if (gt === -1) throw new TmxError(`unterminated closing tag </${closeName}>`);
        if (closeName !== name) {
          throw new TmxError(`closing </${closeName}> does not match <${name}>`);
        }
        i = gt + 1;
        return { type: 'element', name, attrs, children };
      }
      if (s[i] === '<') {
        if (i > textStart) children.push(textNode(s.slice(textStart, i)));
        children.push(parseElement());
        textStart = i;
        continue;
      }
      i++;
    }
  }

  skipMisc();
  if (i >= len || s[i] !== '<') throw new TmxError('no root element found');
  const root = parseElement();
  return root;
}

function childElements(el: XmlElement, name: string): XmlElement[] {
  return el.children.filter(
    (c): c is XmlElement => c.type === 'element' && c.name === name,
  );
}

function textContent(el: XmlElement): string {
  let out = '';
  for (const c of el.children) if (c.type === 'text') out += c.value;
  return out;
}

// ---------------------------------------------------------------------
// TMX -> ParsedTmx
// ---------------------------------------------------------------------

export interface ParsedTmxProp {
  readonly type: string;
  readonly value: string;
}

export interface ParsedTmxTuv {
  readonly lang: string;
  readonly tokens: readonly TmToken[];
  readonly creationdate?: string;
  readonly changedate?: string;
  readonly creationid?: string;
  readonly changeid?: string;
  /** Raw TMX attributes — `importTmx` parses and falls back to the unit's own if absent. */
  readonly usagecount?: string;
  readonly lastusagedate?: string;
  /**
   * Restored from this variant's own `x-catm-*` props (tm-format-spec.md
   * §8 export table) — present only when re-importing a `.ctm`-exported
   * TMX, which is what makes that roundtrip lossless. `undefined` for
   * any file that never carried them; `importTmx` falls back to the
   * spec's ordinary TMX-import defaults in that case.
   */
  readonly restoredQuality?: number;
  readonly restoredPrevHash?: string;
  readonly restoredNextHash?: string;
  readonly restoredRev?: number;
}

export interface ParsedTmxTu {
  readonly tuid?: string;
  readonly creationdate?: string;
  readonly changedate?: string;
  readonly creationid?: string;
  /** Raw TMX attributes — a variant's own value, when present, wins over this fallback. */
  readonly usagecount?: string;
  readonly lastusagedate?: string;
  /** `x-catm-*` restoration already applied; never contains those keys. */
  readonly props: readonly ParsedTmxProp[];
  readonly variants: readonly ParsedTmxTuv[];
  readonly restoredUuid?: string;
  readonly restoredRev?: number;
}

export interface ParsedTmx {
  readonly srcLang?: string;
  readonly units: readonly ParsedTmxTu[];
  /** Non-fatal issues found while parsing — e.g. an unparseable `xml:lang`. */
  readonly warnings: readonly string[];
}

const KNOWN_TAG_KINDS = new Set<string>([
  'b',
  'i',
  'u',
  'strike',
  'sup',
  'sub',
  'link',
  'style',
  'br',
  'tab',
  'field',
  'footnote',
  'image',
  'bookmark',
  'other',
]);

/**
 * `type` on `<bpt>`/`<ph>`/`<it>` is free text in TMX generally, but is
 * exactly a `TagKind` name when the file came from our own export (§8's
 * "tag `k` hints approximated onto `<bpt>` `type`") — recognised here,
 * left as an unhinted tag otherwise rather than guessed at.
 */
function kindFromType(type: string | undefined): TagKind | undefined {
  return type !== undefined && KNOWN_TAG_KINDS.has(type) ? (type as TagKind) : undefined;
}

/** Loose BCP-47 shape check — language subtags separated by `-`. */
function looksLikeBcp47(lang: string): boolean {
  return /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/.test(lang);
}

/**
 * Walks a `<seg>`'s mixed content into `TmToken[]` (tm-format-spec.md
 * §8): `<bpt>`/`<ept>` pair on TMX's own `i` attribute into `open`/
 * `close`; `<ph>`/`<it>`/the deprecated `<ut>` become `ph`; `<hi>`
 * (paired, no `i`) is tracked with its own stack so nested highlights
 * still pair correctly. Anything else is an inline element this format
 * does not know — never silently dropped, it degrades to a bare `ph`
 * placeholder standing in for it.
 */
function segToTokens(seg: XmlElement): TmToken[] {
  const tokens: TmToken[] = [];
  let nextId = 1;
  const bptIds = new Map<string, number>();

  function walk(nodes: readonly XmlNode[]): void {
    for (const node of nodes) {
      if (node.type === 'text') {
        if (node.value.length > 0) tokens.push({ t: 'text', v: node.value });
        continue;
      }
      switch (node.name) {
        case 'bpt': {
          const id = nextId++;
          const i = node.attrs['i'];
          if (i !== undefined) bptIds.set(i, id);
          tokens.push({ t: 'open', id, k: kindFromType(node.attrs['type']) });
          // bpt's own content is the origin tool's raw native-tag
          // encoding — meaningless outside it, and TmTokens are
          // structural only (tm-format-spec.md §3), so it is discarded.
          break;
        }
        case 'ept': {
          const i = node.attrs['i'];
          const id = i !== undefined ? bptIds.get(i) : undefined;
          if (id === undefined) {
            throw new TmxError(`<ept i="${i ?? ''}"> has no matching <bpt>`);
          }
          tokens.push({ t: 'close', id });
          break;
        }
        case 'ph':
        case 'it':
        case 'ut':
          tokens.push({ t: 'ph', id: nextId++, k: kindFromType(node.attrs['type']) });
          break;
        case 'hi': {
          const id = nextId++;
          tokens.push({ t: 'open', id });
          walk(node.children);
          tokens.push({ t: 'close', id });
          break;
        }
        default:
          tokens.push({ t: 'ph', id: nextId++ });
      }
    }
  }

  walk(seg.children);
  return tokens;
}

/**
 * Direct `<prop>` children of `el`. `tu_attr` is one row per `(tu_id,
 * key)` (§2.4), but a real Trados export repeats the same `type` many
 * times on one unit — SDL's own `x-Context`/`x-ContextContent`
 * bookkeeping does this routinely, sometimes 100+ times on a single
 * `<tu>` — so a caller collapsing this list onto that shape keeps only
 * one value per key. That collapse is unavoidable without a schema
 * change, but doing it *silently* is not: `describe` names what's being
 * collapsed so a caller can warn about it.
 */
function directProps(el: XmlElement): {
  readonly props: ParsedTmxProp[];
  readonly duplicateTypes: readonly string[];
} {
  const props = childElements(el, 'prop')
    .map((p) => ({ type: p.attrs['type'], value: textContent(p) }))
    .filter((p): p is ParsedTmxProp => p.type !== undefined);
  const seen = new Set<string>();
  const duplicateTypes: string[] = [];
  for (const p of props) {
    if (seen.has(p.type) && !duplicateTypes.includes(p.type)) duplicateTypes.push(p.type);
    seen.add(p.type);
  }
  return { props, duplicateTypes };
}

const RESERVED_TU_ATTR_KEYS = new Set([
  'client',
  'domain',
  'subject',
  'register',
  'project',
  'note',
]);

/**
 * "Trados `x-*` props map onto reserved keys where recognised"
 * (tm-format-spec.md §8): an `x-`-prefixed prop whose name (case-
 * insensitively, prefix stripped) matches a reserved `tu_attr` key
 * lands under that key; anything else passes through under its own
 * TMX `type` verbatim, per §2.4's "no new metadata field ever requires
 * a schema migration".
 */
function mapReservedProp(prop: ParsedTmxProp): ParsedTmxProp {
  const stripped = prop.type.replace(/^x-/i, '').toLowerCase();
  return RESERVED_TU_ATTR_KEYS.has(stripped)
    ? { type: stripped, value: prop.value }
    : prop;
}

/**
 * Splits `x-catm-uuid`/`x-catm-rev` out of a unit's props for
 * restoration, leaving the rest to become ordinary `tu_attr` rows.
 */
function extractCatmUnitProps(props: readonly ParsedTmxProp[]): {
  readonly uuid?: string;
  readonly rev?: number;
  readonly remaining: ParsedTmxProp[];
} {
  let uuid: string | undefined;
  let rev: number | undefined;
  const remaining: ParsedTmxProp[] = [];
  for (const p of props) {
    if (p.type === 'x-catm-uuid') {
      uuid = p.value;
      continue;
    }
    if (p.type === 'x-catm-rev') {
      const n = Number(p.value);
      if (Number.isInteger(n)) rev = n;
      continue;
    }
    remaining.push(mapReservedProp(p));
  }
  return { uuid, rev, remaining };
}

/**
 * Tally of how many units/variants repeated a given `<prop type>` more
 * than once, keyed by prop type. A real Trados export can do this on
 * nearly every unit (SDL's `x-Context` bookkeeping), so a warning per
 * *occurrence* would flood a large import's report with thousands of
 * near-identical lines — {@link parseTmx} flushes this into one summary
 * line per prop type instead.
 */
type DuplicatePropTally = Map<string, number>;

function recordDuplicates(tally: DuplicatePropTally, types: readonly string[]): void {
  for (const type of types) tally.set(type, (tally.get(type) ?? 0) + 1);
}

function parseTuv(
  tuv: XmlElement,
  warnings: string[],
  duplicatePropTally: DuplicatePropTally,
): ParsedTmxTuv {
  const lang = tuv.attrs['xml:lang'] ?? tuv.attrs['lang'];
  if (!lang) throw new TmxError('<tuv> has no xml:lang');
  if (!looksLikeBcp47(lang)) {
    warnings.push(
      `<tuv xml:lang="${lang}"> does not look like a valid BCP-47 tag — imported as-is`,
    );
  }
  const seg = childElements(tuv, 'seg')[0];
  if (!seg) throw new TmxError(`<tuv xml:lang="${lang}"> has no <seg>`);

  let quality: number | undefined;
  let prevHash: string | undefined;
  let nextHash: string | undefined;
  let rev: number | undefined;
  const { props, duplicateTypes } = directProps(tuv);
  for (const p of props) {
    if (p.type === 'x-catm-quality') {
      const n = Number(p.value);
      if (Number.isInteger(n)) quality = n;
    } else if (p.type === 'x-catm-prev') {
      prevHash = p.value;
    } else if (p.type === 'x-catm-next') {
      nextHash = p.value;
    } else if (p.type === 'x-catm-rev') {
      const n = Number(p.value);
      if (Number.isInteger(n)) rev = n;
    }
  }
  recordDuplicates(duplicatePropTally, duplicateTypes);

  return {
    lang,
    tokens: segToTokens(seg),
    creationdate: tuv.attrs['creationdate'],
    changedate: tuv.attrs['changedate'],
    creationid: tuv.attrs['creationid'],
    changeid: tuv.attrs['changeid'],
    usagecount: tuv.attrs['usagecount'],
    lastusagedate: tuv.attrs['lastusagedate'],
    restoredQuality: quality,
    restoredPrevHash: prevHash,
    restoredNextHash: nextHash,
    restoredRev: rev,
  };
}

function parseTu(
  tu: XmlElement,
  warnings: string[],
  duplicatePropTally: DuplicatePropTally,
): ParsedTmxTu {
  const note = childElements(tu, 'note')[0];
  const { props: rawProps, duplicateTypes } = directProps(tu);
  const allProps = note
    ? [...rawProps, { type: 'note', value: textContent(note) }]
    : rawProps;
  const { uuid, rev, remaining } = extractCatmUnitProps(allProps);
  recordDuplicates(duplicatePropTally, duplicateTypes);

  const variants = childElements(tu, 'tuv').map((v) =>
    parseTuv(v, warnings, duplicatePropTally),
  );
  if (variants.length === 0) {
    throw new TmxError(`<tu tuid="${tu.attrs['tuid'] ?? ''}"> has no <tuv> variants`);
  }

  return {
    tuid: tu.attrs['tuid'],
    creationdate: tu.attrs['creationdate'],
    changedate: tu.attrs['changedate'],
    creationid: tu.attrs['creationid'],
    usagecount: tu.attrs['usagecount'],
    lastusagedate: tu.attrs['lastusagedate'],
    props: remaining,
    variants,
    restoredUuid: uuid,
    restoredRev: rev,
  };
}

/**
 * Parses a TMX 1.4b document into the shape `@cat-tool/db/tm`'s
 * `importTmx` writes into a `.ctm` file. Throws {@link TmxError} only
 * for structural problems (no root `<tmx>`, no `<body>`, a `<tu>` with
 * no `<tuv>`, an `<ept>` with no matching `<bpt>`) — anything narrower,
 * like a malformed `xml:lang`, is reported in `warnings` instead so one
 * bad unit never fails an otherwise-good import.
 */
export function parseTmx(xml: string): ParsedTmx {
  const root = parseXmlDocument(xml);
  if (root.name !== 'tmx') {
    throw new TmxError(`root element is <${root.name}>, expected <tmx>`);
  }
  const header = childElements(root, 'header')[0];
  const body = childElements(root, 'body')[0];
  if (!body) throw new TmxError('<tmx> has no <body>');

  const warnings: string[] = [];
  const duplicatePropTally: DuplicatePropTally = new Map();
  const units = childElements(body, 'tu').map((tu) =>
    parseTu(tu, warnings, duplicatePropTally),
  );

  for (const [type, count] of duplicatePropTally) {
    warnings.push(
      `${count} unit(s)/variant(s) repeat <prop type="${type}"> more than once — only the ` +
        'last value is kept for each',
    );
  }

  return { srcLang: header?.attrs['srclang'], units, warnings };
}

/** TMX's `CCYYMMDDThhmmssZ` date form → ISO 8601. `undefined` if absent or malformed. */
export function tmxDateToIso(date: string | undefined): string | undefined {
  if (!date) return undefined;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, se] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${se}.000Z`;
}

/** ISO 8601 → TMX's `CCYYMMDDThhmmssZ` date form. Inverse of {@link tmxDateToIso}. */
export function isoToTmxDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

// ---------------------------------------------------------------------
// TmxExportDoc -> TMX (tm-format-spec.md §8's "Export" table and its
// implementation notes)
// ---------------------------------------------------------------------

export interface TmxExportProp {
  readonly type: string;
  readonly value: string;
}

export interface TmxExportTuv {
  readonly lang: string;
  readonly tokens: readonly TmToken[];
  readonly quality: number;
  readonly rev: number;
  readonly prevHash: string | null;
  readonly nextHash: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
  readonly usageCount: number;
  readonly lastUsedAt: string | null;
}

export interface TmxExportTu {
  readonly uuid: string;
  readonly rev: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: string | null;
  /** From this unit's `tu_attr` `tuid` key, if any — becomes `<tu tuid>`, never a `<prop>`. */
  readonly tuid?: string;
  /** From this unit's `tu_attr` `note` key, if any — becomes a `<note>` child, never a `<prop>`. */
  readonly note?: string;
  /** Every other `tu_attr` row, verbatim — becomes `<prop type="{key}">`. */
  readonly props: readonly TmxExportProp[];
  readonly variants: readonly TmxExportTuv[];
}

export interface TmxExportDoc {
  readonly units: readonly TmxExportTu[];
  /** e.g. `"cat-tool/0.3.1"` — `.ctm`'s own `generator` field. */
  readonly creationTool: string;
}

function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeXmlAttr(s: string): string {
  return escapeXmlText(s).replace(/"/g, '&quot;');
}

function attr(name: string, value: string | undefined): string {
  return value === undefined ? '' : ` ${name}="${escapeXmlAttr(value)}"`;
}

/**
 * Serializes one variant's `TmToken[]` into TMX `<seg>` mixed content —
 * the inverse of {@link segToTokens}. `open`/`close` reuse the token's
 * own `id` as `<bpt>`/`<ept>`'s `i` correlation attribute; `<ph>` carries
 * no `i`/`x` at all, since import assigns placeholder ids locally in
 * document order rather than reading one back (tm-format-spec.md §8's
 * implementation notes).
 */
function tokensToSeg(tokens: readonly TmToken[]): string {
  let out = '';
  for (const token of tokens) {
    switch (token.t) {
      case 'text':
        out += escapeXmlText(token.v);
        break;
      case 'open':
        out += `<bpt i="${token.id}"${attr('type', token.k)}/>`;
        break;
      case 'close':
        out += `<ept i="${token.id}"/>`;
        break;
      case 'ph':
        out += `<ph${attr('type', token.k)}/>`;
        break;
    }
  }
  return out;
}

function serializeProp(prop: TmxExportProp): string {
  return `<prop type="${escapeXmlAttr(prop.type)}">${escapeXmlText(prop.value)}</prop>`;
}

function serializeTuv(v: TmxExportTuv): string {
  const props: TmxExportProp[] = [{ type: 'x-catm-quality', value: String(v.quality) }];
  if (v.rev !== 1) props.push({ type: 'x-catm-rev', value: String(v.rev) });
  if (v.prevHash !== null) props.push({ type: 'x-catm-prev', value: v.prevHash });
  if (v.nextHash !== null) props.push({ type: 'x-catm-next', value: v.nextHash });

  const creationOrChangeId = v.updatedBy ?? undefined;
  return (
    `<tuv xml:lang="${escapeXmlAttr(v.lang)}"` +
    `${attr('creationdate', isoToTmxDate(v.createdAt))}` +
    `${attr('creationid', creationOrChangeId)}` +
    `${attr('changedate', isoToTmxDate(v.updatedAt))}` +
    `${attr('changeid', creationOrChangeId)}` +
    `${attr('usagecount', v.usageCount > 0 ? String(v.usageCount) : undefined)}` +
    `${attr('lastusagedate', v.lastUsedAt ? isoToTmxDate(v.lastUsedAt) : undefined)}>` +
    props.map(serializeProp).join('') +
    `<seg>${tokensToSeg(v.tokens)}</seg>` +
    `</tuv>`
  );
}

function serializeTu(tu: TmxExportTu): string {
  const props: TmxExportProp[] = [
    { type: 'x-catm-uuid', value: tu.uuid },
    { type: 'x-catm-rev', value: String(tu.rev) },
    ...tu.props,
  ];
  return (
    `<tu${attr('tuid', tu.tuid)}` +
    `${attr('creationdate', isoToTmxDate(tu.createdAt))}` +
    `${attr('creationid', tu.createdBy ?? undefined)}` +
    `${attr('changedate', isoToTmxDate(tu.updatedAt))}>` +
    (tu.note !== undefined ? `<note>${escapeXmlText(tu.note)}</note>` : '') +
    props.map(serializeProp).join('') +
    tu.variants.map(serializeTuv).join('') +
    `</tu>`
  );
}

/**
 * Serializes a `.ctm` export shape into a TMX 1.4b document (§8's
 * "Export" table). A `tu` with no variants (everything filtered out by
 * a language filter upstream) is the caller's responsibility to have
 * already dropped — never emitted here, matching {@link parseTmx}'s own
 * refusal of a `<tu>` with no `<tuv>`.
 */
export function serializeTmx(doc: TmxExportDoc): string {
  const now = isoToTmxDate(new Date().toISOString());
  const header =
    `<header creationtool="${escapeXmlAttr(doc.creationTool)}" creationtoolversion="1" ` +
    `datatype="plaintext" segtype="sentence" adminlang="en" srclang="*all*" ` +
    `o-tmf="cat-tool" creationdate="${now}"/>`;
  const body = doc.units
    .filter((tu) => tu.variants.length > 0)
    .map(serializeTu)
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<tmx version="1.4">${header}<body>${body}</body></tmx>`
  );
}
