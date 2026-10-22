/**
 * XLIFF inline content ↔ project tokens (planning/v1-spec.md §3.8).
 *
 * `readInline` turns the content of a `<source>` or `<target>` into the
 * project's tokens (§3.3) and a per-segment format table whose `open`/`close`
 * hold the original element text, so a tag is written back as it was found.
 * `renderInline` is the inverse, from tokens and that table to inline XML.
 *
 * A tag's identity across source and target is its element and `id`, with the
 * role it plays here: a start code whose end code is in the same segment, and
 * properly nested, is a pair; one whose partner is elsewhere is a placeholder
 * (`sc#1!`). The role is in the key so a source pair and a target that lost
 * its end code are two different tags, which `tag.*` QA then reports, instead
 * of one table entry used in two roles.
 */

import type { FormatEntry, TagKind, Token } from '../model/token.js';
import { XliffError, XLIFF_NS, type XElement, type XNode } from './scan.js';

/** The format table of one segment while its source and target are read. */
export interface InlineTable {
  readonly entries: FormatEntry[];
  readonly byKey: Map<string, number>;
}

export function newInlineTable(): InlineTable {
  return { entries: [], byKey: new Map() };
}

type Item =
  | { readonly k: 'text'; readonly v: string }
  | {
      readonly k: 'pair-open' | 'pair-close';
      readonly key: string;
      readonly pairId: number;
      readonly el: XElement;
      readonly kind: TagKind;
    }
  | {
      readonly k: 'start';
      /** The start code's own `id`. */
      readonly ref: string;
      readonly el: XElement;
      readonly kind: TagKind;
      readonly prefix: 'sc' | 'sm';
    }
  | {
      readonly k: 'end';
      /** The `startRef` of the start code this one closes. */
      readonly ref: string;
      readonly el: XElement;
      readonly kind: TagKind;
      readonly prefix: 'sc' | 'sm';
    }
  | {
      readonly k: 'ph';
      readonly key: string;
      readonly el: XElement;
      readonly kind: TagKind;
    };

const kindOf = (el: XElement, fallback: TagKind = 'other'): TagKind => {
  const type = el.attrs.get('type');
  if (type === 'link') return 'link';
  if (type === 'image') return 'image';
  return fallback;
};

function required(el: XElement, name: string): string {
  const value = el.attrs.get(name);
  if (value === undefined || value === '') {
    throw new XliffError(`<${el.name}> at offset ${el.start} has no ${name}`);
  }
  return value;
}

/** The container's inline elements and text, in order, before pairing. */
function flatten(
  nodes: readonly XNode[],
  xml: string,
  items: Item[],
  counters: Map<string, number>,
  pairCounter: { n: number },
): void {
  for (const node of nodes) {
    if (node.kind === 'text') {
      if (node.text !== '') items.push({ k: 'text', v: node.text });
      continue;
    }
    const el = node;
    if (el.ns !== XLIFF_NS) {
      throw new XliffError(
        `<${el.name}> at offset ${el.start} is not XLIFF inline content`,
      );
    }
    switch (el.local) {
      case 'pc':
      case 'mrk': {
        const id = required(el, 'id');
        if (el.selfClosing) {
          items.push({ k: 'ph', key: `${el.local}#${id}`, el, kind: kindOf(el) });
          break;
        }
        const pairId = pairCounter.n++;
        const key = `${el.local}#${id}`;
        items.push({ k: 'pair-open', key, pairId, el, kind: kindOf(el) });
        flatten(el.children, xml, items, counters, pairCounter);
        items.push({ k: 'pair-close', key, pairId, el, kind: kindOf(el) });
        break;
      }
      case 'ph':
        items.push({ k: 'ph', key: `ph#${required(el, 'id')}`, el, kind: kindOf(el) });
        break;
      case 'cp': {
        const hex = required(el, 'hex');
        const n = (counters.get(`cp#${hex}`) ?? 0) + 1;
        counters.set(`cp#${hex}`, n);
        items.push({ k: 'ph', key: `cp#${hex}#${n}`, el, kind: 'other' });
        break;
      }
      case 'sc':
      case 'sm':
        items.push({
          k: 'start',
          ref: required(el, 'id'),
          el,
          kind: kindOf(el),
          prefix: el.local,
        });
        break;
      case 'ec':
      case 'em': {
        // An end code names its start by `startRef`; an isolated one has none
        // and carries its own `id` (the start is in another unit's segment).
        const ref = el.attrs.get('startRef');
        items.push({
          k: 'end',
          ref: ref ?? `isolated:${required(el, 'id')}`,
          el,
          kind: kindOf(el),
          prefix: el.local === 'ec' ? 'sc' : 'sm',
        });
        break;
      }
      default:
        throw new XliffError(
          `<${el.name}> at offset ${el.start} is not XLIFF inline content`,
        );
    }
  }
}

/**
 * Decides which start/end codes pair up: a start whose end (by `startRef`) is
 * in this content, as long as the pair does not cross a pair already accepted.
 * Returns the index pairs, start index → end index.
 */
function pairCodes(items: readonly Item[]): Map<number, number> {
  const accepted: Array<[number, number]> = [];
  // `pc`/`mrk` pairs are well-nested by construction: take them as they are.
  const open = new Map<number, number>();
  items.forEach((item, idx) => {
    if (item.k === 'pair-open') open.set(item.pairId, idx);
    else if (item.k === 'pair-close') accepted.push([open.get(item.pairId)!, idx]);
  });

  const starts = new Map<string, number>();
  items.forEach((item, idx) => {
    if (item.k === 'start') starts.set(`${item.prefix}:${item.ref}`, idx);
  });
  const crosses = (a: number, b: number) =>
    accepted.some(([p, q]) => (a < p && p < b && b < q) || (p < a && a < q && q < b));

  const result = new Map<number, number>();
  items.forEach((item, idx) => {
    if (item.k !== 'end') return;
    const start = starts.get(`${item.prefix}:${item.ref}`);
    if (start === undefined || start > idx || result.has(start)) return;
    if (crosses(start, idx)) return;
    accepted.push([start, idx]);
    result.set(start, idx);
  });
  return result;
}

const rawOf = (xml: string, el: XElement): string => xml.slice(el.start, el.end);

function entryFor(
  table: InlineTable,
  key: string,
  make: () => Omit<FormatEntry, 'id'>,
): number {
  const known = table.byKey.get(key);
  if (known !== undefined) return known;
  const id = table.entries.length + 1;
  table.entries.push({ id, ...make() });
  table.byKey.set(key, id);
  return id;
}

/**
 * Reads the content of `container` (a `<source>` or `<target>`) into tokens,
 * adding any tag the table does not hold yet.
 *
 * @throws XliffError for an element that is not XLIFF inline content or one
 *   missing its required attribute.
 */
export function readInline(
  container: XElement,
  xml: string,
  table: InlineTable,
): Token[] {
  const items: Item[] = [];
  flatten(container.children, xml, items, new Map(), { n: 0 });
  const pairs = pairCodes(items);
  const pairedEnds = new Map<number, number>([...pairs].map(([s, e]) => [e, s]));

  const out: Token[] = [];
  const pushText = (v: string) => {
    const last = out[out.length - 1];
    if (last?.t === 'text') out[out.length - 1] = { t: 'text', v: last.v + v };
    else out.push({ t: 'text', v });
  };
  const placeholder = (key: string, el: XElement, kind: TagKind) => {
    const id = entryFor(table, key, () => ({
      kind,
      visible: true,
      placement: 'in-run',
      open: rawOf(xml, el),
      close: '',
    }));
    out.push({ t: 'ph', id, fmt: id });
  };

  items.forEach((item, idx) => {
    switch (item.k) {
      case 'text':
        pushText(item.v);
        break;
      case 'pair-open': {
        const id = entryFor(table, item.key, () => ({
          kind: item.kind,
          visible: true,
          placement: 'inline',
          open: xml.slice(item.el.start, item.el.contentStart),
          close: xml.slice(item.el.contentEnd, item.el.end),
        }));
        out.push({ t: 'open', id, fmt: id });
        break;
      }
      case 'pair-close': {
        out.push({ t: 'close', id: table.byKey.get(item.key)! });
        break;
      }
      case 'ph':
        placeholder(item.key, item.el, item.kind);
        break;
      case 'start': {
        const endIdx = pairs.get(idx);
        const key = `${item.prefix}#${item.ref}`;
        if (endIdx === undefined) {
          placeholder(`${key}!`, item.el, item.kind);
          break;
        }
        const end = items[endIdx] as Extract<Item, { k: 'end' }>;
        const id = entryFor(table, key, () => ({
          kind: item.kind,
          visible: true,
          placement: 'inline',
          open: rawOf(xml, item.el),
          close: rawOf(xml, end.el),
        }));
        out.push({ t: 'open', id, fmt: id });
        break;
      }
      case 'end': {
        const startIdx = pairedEnds.get(idx);
        if (startIdx === undefined) {
          placeholder(
            `${item.prefix === 'sc' ? 'ec' : 'em'}#${item.ref}!`,
            item.el,
            item.kind,
          );
          break;
        }
        const start = items[startIdx] as Extract<Item, { k: 'start' }>;
        out.push({ t: 'close', id: table.byKey.get(`${start.prefix}#${start.ref}`)! });
        break;
      }
    }
  });
  return out;
}

const escapeText = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Renders tokens back to XLIFF inline XML from the segment's format table.
 *
 * @throws XliffError for a tag the table does not hold.
 */
export function renderInline(
  tokens: readonly Token[],
  formats: readonly FormatEntry[],
): string {
  const byId = new Map(formats.map((f) => [f.id, f]));
  let out = '';
  for (const token of tokens) {
    if (token.t === 'text') {
      out += escapeText(token.v);
      continue;
    }
    const format = byId.get(token.t === 'close' ? token.id : token.fmt);
    if (!format)
      throw new XliffError(
        `tag ${token.t === 'close' ? token.id : token.fmt} is not in the format table`,
      );
    out += token.t === 'close' ? format.close : format.open;
  }
  return out;
}
