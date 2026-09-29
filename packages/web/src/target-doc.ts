/**
 * The target editor's document (v1-spec.md §7.2; backlog #29): a
 * ProseMirror schema whose content is exactly a visible target — text,
 * and each tag as one atomic chip — plus the plugin and commands that
 * keep it tag-valid. No DOM here: `prosemirror-state` runs in node, so
 * every rule below is tested without a browser (`target-doc.test.ts`);
 * `TargetEditor.tsx` puts a view on it.
 */
import type { FormatEntry, Token } from '@cat-tool/core';
import { withoutHiddenTags } from '@cat-tool/core/model';
import { closeHistory } from 'prosemirror-history';
import {
  DOMSerializer,
  Fragment,
  Schema,
  Slice,
  type Node as PmNode,
} from 'prosemirror-model';
import {
  EditorState,
  Plugin,
  TextSelection,
  type Command,
  type Transaction,
} from 'prosemirror-state';

import { fullTagLabel, tagLabel, tagTitle } from './pieces.js';
import { describeFormat } from './tag-label.js';
import {
  chipsToDrop,
  collapseGroups,
  expandGroups,
  isBalanced,
  nestingRefusal,
  pastedText,
  tagChoices,
  unplacedTags,
  withoutEmptyPairs,
  type Chip,
  type PairShape,
  type PaletteTag,
  type TagChoice,
} from './tags.js';

type Role = 'open' | 'close' | 'ph';

interface ChipAttrs {
  readonly role: Role;
  readonly id: number;
  readonly fmt: number;
  /** The pairs this chip's pair stands for too (`pairGroups`). */
  readonly members: readonly number[];
  /** The chip's label (`tagLabel`). */
  readonly label: string;
  /** The label with the format in words, shown with "show full tags" on. */
  readonly full: string;
  /** The format in words (`bold`): the tooltip. */
  readonly title: string;
}

/** A transaction a tag command made: not a deletion to report. */
export const TAG_OP = 'tagOp';

export const schema = new Schema({
  nodes: {
    // One line of inline content: the document is the segment's target.
    // `pre` keeps the edge spaces a segment's text genuinely carries.
    doc: { content: 'inline*', whitespace: 'pre' },
    text: { group: 'inline' },
    tag: {
      group: 'inline',
      inline: true,
      atom: true,
      // Arrows step over a chip in one press and a click places the
      // caret; a chip selected by itself would hide the caret, and the
      // next letter typed would replace it.
      selectable: false,
      draggable: false,
      attrs: {
        role: {},
        id: {},
        fmt: {},
        members: { default: [] },
        label: {},
        full: {},
        title: {},
      },
      toDOM: (node) => {
        const a = node.attrs as ChipAttrs;
        return [
          'span',
          {
            class: `chip chip-${a.role}`,
            title: a.title,
            contenteditable: 'false',
            'data-role': a.role,
            'data-id': String(a.id),
            'data-fmt': String(a.fmt),
            'data-members': a.members.join(','),
            'data-label': a.label,
            'data-full': a.full,
          },
          ['span', { class: 'chip-short' }, a.label],
          ['span', { class: 'chip-full' }, a.full],
        ];
      },
      // Read back only from this editor's own copy (`data-id`): a cut and
      // paste moves a tag. Anyone else's markup is never a chip.
      parseDOM: [
        {
          tag: 'span.chip[data-id]',
          getAttrs: (dom) => {
            const el = dom as HTMLElement;
            const role = el.dataset['role'];
            if (role !== 'open' && role !== 'close' && role !== 'ph') return false;
            const members = el.dataset['members'];
            return {
              role,
              id: Number(el.dataset['id']),
              fmt: Number(el.dataset['fmt']),
              members: members ? members.split(',').map(Number) : [],
              label: el.dataset['label'] ?? '',
              full: el.dataset['full'] ?? '',
              title: el.getAttribute('title') ?? '',
            };
          },
        },
      ],
    },
  },
  marks: {},
});

/** A chip node for one tag token, or for a group's first pair. */
export function chipNode(
  role: Role,
  id: number,
  fmt: number,
  formats: readonly FormatEntry[],
  members: readonly number[] = [],
): PmNode {
  const words = describeFormat(formats.find((f) => f.id === fmt));
  const last = members.length > 0 ? members[members.length - 1] : undefined;
  return schema.nodes['tag']!.create({
    role,
    id,
    fmt,
    members,
    label: tagLabel(role, id, last),
    full: fullTagLabel(role, id, words, last),
    title: tagTitle(words, members),
  } satisfies ChipAttrs);
}

/**
 * The editor's document for a visible target (hidden tags already
 * dropped), each group as one pair carrying the members it was saved
 * with (`collapseGroups`).
 * A stored target that is not tag-valid — any API client can write one —
 * is repaired the way an edit would be (`chipsToDrop`), and `repaired`
 * says so, so the editor saves the repair rather than show one thing and
 * keep another.
 */
export function docFromTokens(
  tokens: readonly Token[],
  formats: readonly FormatEntry[],
  groups: ReadonlyMap<number, readonly number[]> = new Map(),
): { doc: PmNode; repaired: boolean } {
  const collapsed = collapseGroups(tokens, groups);
  const chips: Chip[] = collapsed.tokens.flatMap((t) =>
    t.t === 'text' ? [] : [{ role: t.t, id: t.id }],
  );
  const drop = chipsToDrop(chips);
  let chip = 0;
  const kept = collapsed.tokens.filter((t) => t.t === 'text' || !drop.has(chip++));
  const nodes: PmNode[] = [];
  for (const token of kept) {
    if (token.t === 'text') {
      if (token.v !== '') nodes.push(schema.text(token.v));
      continue;
    }
    const members = token.t === 'ph' ? [] : (collapsed.carried.get(token.id) ?? []);
    // A close carries no `fmt`; its id is its open's.
    const fmt = token.t === 'close' ? token.id : token.fmt;
    nodes.push(chipNode(token.t, token.id, fmt, formats, members));
  }
  return { doc: schema.node('doc', null, nodes), repaired: drop.size > 0 };
}

/** The document as tokens, a group as its first pair: what the editor reasons about. */
export function tokensFromDoc(doc: PmNode): Token[] {
  const out: Token[] = [];
  doc.forEach((node) => {
    if (node.isText) {
      out.push({ t: 'text', v: node.text! });
      return;
    }
    const { role, id, fmt } = node.attrs as ChipAttrs;
    out.push(role === 'close' ? { t: 'close', id } : { t: role, id, fmt });
  });
  return out;
}

/** The members each group chip in the document stands for, by its id. */
function membersIn(doc: PmNode): Map<number, readonly number[]> {
  const members = new Map<number, readonly number[]>();
  doc.forEach((node) => {
    const a = node.attrs as Partial<ChipAttrs>;
    if (a.role === 'open' && a.members && a.members.length > 0)
      members.set(a.id!, a.members);
  });
  return members;
}

/**
 * The visible target to save: pairs holding nothing dropped — an empty
 * pair formats nothing, so it counts as unplaced and QA's `tag.missing`
 * says so — then each group's members restored behind its first pair
 * (`expandGroups`), so the server stores every tag the source has.
 */
export function targetFromDoc(doc: PmNode): Token[] {
  return expandGroups(withoutEmptyPairs(tokensFromDoc(doc)), membersIn(doc));
}

/** The palette as the document stands (`tagChoices`): the bar and the tag list. */
export function choicesIn(
  doc: PmNode,
  palette: readonly PaletteTag[],
  formats: readonly FormatEntry[],
): TagChoice[] {
  return tagChoices(palette, tokensFromDoc(doc), membersIn(doc), formats);
}

type PlacedChip = Chip & { readonly pos: number; readonly fmt: number };

/** The document's chips with their positions, in order. */
function chipsIn(doc: PmNode, from = 0, to = doc.content.size): PlacedChip[] {
  const out: PlacedChip[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'tag' && pos >= from && pos + node.nodeSize <= to) {
      const { role, id, fmt } = node.attrs as ChipAttrs;
      out.push({ role, id, fmt, pos });
    }
  });
  return out;
}

/** The pairs open at a position: their opens before it, their closes after. */
function pairsAround(doc: PmNode, pos: number): PlacedChip[] {
  const stack: PlacedChip[] = [];
  for (const chip of chipsIn(doc, 0, pos)) {
    if (chip.role === 'open') stack.push(chip);
    else if (chip.role === 'close') stack.pop();
  }
  return stack;
}

/**
 * Keeps the document tag-valid after any change (`chipsToDrop`): deleting
 * one chip of a pair — Backspace, a selection typed over, a cut — takes
 * its partner too, and the tag becomes unplaced again; a pasted chip the
 * document already has goes. The deletion is appended to the same
 * transaction, so one undo restores both.
 */
export const tagIntegrity = new Plugin({
  appendTransaction(transactions, _old, state) {
    if (!transactions.some((tr) => tr.docChanged)) return null;
    const chips = chipsIn(state.doc);
    const drop = chipsToDrop(chips);
    if (drop.size === 0) return null;
    const tr = state.tr;
    // From the end, so earlier positions stay put.
    for (const i of [...drop].sort((a, b) => b - a)) {
      const pos = chips[i]!.pos;
      tr.delete(pos, pos + 1);
    }
    return tr;
  },
});

export type InsertResult =
  | { readonly ok: true; readonly tr: Transaction }
  | { readonly ok: false; readonly reason: string };

function shapeOf(fmt: number, formats: readonly FormatEntry[]): PairShape {
  const format = formats.find((f) => f.id === fmt);
  return { placement: format?.placement, kind: format?.kind ?? null };
}

/**
 * Places a tag at the selection. A placeholder goes at its end. A pair
 * wraps a non-empty selection when the selection is balanced (`isBalanced`)
 * and is refused otherwise; with nothing selected it goes in empty, the
 * cursor between its chips, ready to type into. Either way it must nest
 * the way a source's pairs do (`nestingRefusal`), or it is refused. A tag
 * already placed is moved: its old chips go first. A group's first pair
 * stands for only the members the document does not place apart, which
 * keep their own chips (`expandGroups` would otherwise save them twice).
 * Each placement is its own undo step.
 */
export function planInsert(
  state: EditorState,
  tag: PaletteTag,
  formats: readonly FormatEntry[],
): InsertResult {
  const tr = closeHistory(state.tr).setMeta(TAG_OP, true);
  const existing = chipsIn(state.doc).filter(
    (c) => c.id === tag.id && (tag.role === 'ph') === (c.role === 'ph'),
  );
  for (const chip of [...existing].reverse()) tr.delete(chip.pos, chip.pos + 1);
  const from = tr.mapping.map(state.selection.from);
  const to = tr.mapping.map(state.selection.to);
  const apart = new Set(
    chipsIn(tr.doc)
      .filter((c) => c.role === 'open')
      .map((c) => c.id),
  );
  const members = tag.members.filter((id) => !apart.has(id));
  const last = members.length > 0 ? members[members.length - 1] : undefined;
  const label = tagLabel(tag.role === 'ph' ? 'ph' : 'open', tag.id, last);

  if (tag.role === 'ph') {
    tr.insert(to, chipNode('ph', tag.id, tag.fmt, formats));
    tr.setSelection(TextSelection.create(tr.doc, to + 1));
    return { ok: true, tr: tr.scrollIntoView() };
  }
  const inside = chipsIn(tr.doc, from, to);
  if (from !== to && !isBalanced(inside)) {
    return {
      ok: false,
      reason: `The selection crosses a tag pair; select inside one pair to wrap it in ${label}.`,
    };
  }
  const refusal = nestingRefusal(
    shapeOf(tag.fmt, formats),
    pairsAround(tr.doc, from).map((c) => shapeOf(c.fmt, formats)),
    inside.filter((c) => c.role === 'open').map((c) => shapeOf(c.fmt, formats)),
  );
  if (refusal) return { ok: false, reason: `${label}: ${refusal}.` };
  tr.insert(to, chipNode('close', tag.id, tag.fmt, formats, members));
  tr.insert(from, chipNode('open', tag.id, tag.fmt, formats, members));
  tr.setSelection(TextSelection.create(tr.doc, from === to ? from + 1 : to + 2));
  return { ok: true, tr: tr.scrollIntoView() };
}

/** `planInsert` as a command: false (and nothing done) when refused. */
export function insertTag(tag: PaletteTag, formats: readonly FormatEntry[]): Command {
  return (state, dispatch) => {
    const plan = planInsert(state, tag, formats);
    if (!plan.ok) return false;
    dispatch?.(plan.tr);
    return true;
  };
}

/**
 * The tag `Ctrl+,` places: the first the document has not placed, in
 * source order — but with text selected, the first *pair*, since a
 * selection asks to be wrapped; a placeholder only when no pair is left.
 */
export function nextUnplaced(
  state: EditorState,
  palette: readonly PaletteTag[],
  formats: readonly FormatEntry[],
): PaletteTag | undefined {
  const unplaced = unplacedTags(
    palette,
    tokensFromDoc(state.doc),
    membersIn(state.doc),
    formats,
  );
  if (state.selection.empty) return unplaced[0];
  return unplaced.find((t) => t.role === 'pair') ?? unplaced[0];
}

/** A paste from elsewhere, as the one line of plain text it may be (`pastedText`). */
export function pasteText(state: EditorState, text: string): Transaction {
  return state.tr.insertText(pastedText(text)).scrollIntoView();
}

/**
 * Ctrl+Ins (v1-spec.md §7.3): the target becomes the source, its visible
 * tags as chips in the source's order — the same ids, so every tag reads
 * as placed. One transaction, so Ctrl+Z gives the old target back. The
 * source's hidden tags are not the editor's to place (`carryHiddenTags`
 * puts them on save), so they are left out as they are for a target.
 */
export function copySource(
  state: EditorState,
  source: readonly Token[],
  formats: readonly FormatEntry[],
  groups: ReadonlyMap<number, readonly number[]>,
): Transaction {
  const { doc } = docFromTokens(withoutHiddenTags(source, formats), formats, groups);
  const tr = state.tr.replaceWith(0, state.doc.content.size, doc.content);
  return tr.setSelection(TextSelection.atEnd(tr.doc)).scrollIntoView();
}

/** The attribute naming the segment a copy came from (`SegmentClipboard`). */
const COPY_OF = 'data-segment-copy';

/**
 * What names one segment's copy: its project and its id. The id alone is
 * not enough — every project numbers its segments from 1, and the
 * clipboard outlives a move to another project, or is shared by two
 * tabs — and the project's name is text to keep whole, so it is encoded
 * (`encodeURIComponent`): no quote to end the attribute early, and no
 * `/` to make two names one.
 */
export function segmentCopyKey(project: string, segmentId: number): string {
  return `${encodeURIComponent(project)}/${segmentId}`;
}

/**
 * What one segment's editor puts on the clipboard (its view's
 * `clipboardSerializer`): the copy wrapped in one element naming the
 * segment (`segmentCopyKey`). ProseMirror marks its own copy
 * (`data-pm-slice`) on the first node only if that is an element, and a
 * copy starting with a word starts with a text node — so it read as
 * anyone's HTML, arrived as plain text, and the tags a cut had taken were
 * lost. Wrapped, every copy is marked, and a paste can tell this
 * segment's copy from another's (`clipboardSegment`), whose tag ids name
 * other tags.
 */
export class SegmentClipboard extends DOMSerializer {
  readonly key: string;

  constructor(project: string, segmentId: number) {
    super(DOMSerializer.nodesFromSchema(schema), DOMSerializer.marksFromSchema(schema));
    this.key = segmentCopyKey(project, segmentId);
  }

  override serializeFragment(
    fragment: Fragment,
    options: { document?: Document } = {},
    target?: HTMLElement | DocumentFragment,
  ): HTMLElement | DocumentFragment {
    // Only the copy itself is wrapped, not a node's content inside it.
    if (target) return super.serializeFragment(fragment, options, target);
    const dom = options.document ?? document;
    const wrap = dom.createElement('span');
    wrap.setAttribute(COPY_OF, this.key);
    super.serializeFragment(fragment, options, wrap);
    const out = dom.createDocumentFragment();
    out.appendChild(wrap);
    return out;
  }
}

/**
 * The segment whose editor copied this clipboard HTML, as its
 * `segmentCopyKey` — to compare whole — or null: anyone else's.
 */
export function clipboardSegment(html: string): string | null {
  const match = new RegExp(`${COPY_OF}="([^"]*)"`).exec(html);
  return match ? match[1]! : null;
}

/**
 * A paste of this segment's own copy, as one transaction (so one undo).
 * A copy and paste copies the words; a cut and paste — whose chips left
 * with the cut — moves the tags with them, the EN→ES adjective-after-noun
 * gesture. The selection goes first, and with it any pair it took one
 * chip of — what the integrity rule would do after the paste, done
 * before it: left to the rule, that pair's other chip would still be
 * there when the paste brings the pair again, the rule keeps the earlier
 * of two, and the pasted close would pair with it around whatever came
 * between — bold around italic, a link in a link. Then the copy is
 * pasted as it may enter the document that is left (`pastedSlice`).
 */
export function pasteOwn(
  state: EditorState,
  slice: Slice,
  palette: readonly PaletteTag[],
  formats: readonly FormatEntry[],
): Transaction {
  const tr = state.tr.deleteSelection();
  const left = chipsIn(tr.doc);
  // From the end, so earlier positions stay put.
  for (const i of [...chipsToDrop(left)].sort((a, b) => b - a)) {
    tr.delete(left[i]!.pos, left[i]!.pos + 1);
  }
  return tr
    .replaceSelection(pastedSlice(slice, tr.doc, tr.selection.from, palette, formats))
    .scrollIntoView();
}

/**
 * A copy as it may enter `landing`, a tag-valid document, at `at`. A chip
 * is kept only when it is one of this segment's tags (the palette's, a
 * group's members included) that the document does not have, as a whole
 * pair, and nesting where it lands the way a source's pairs do
 * (`nestingRefusal`): bold pasted into italic would export as italic
 * alone, which `planInsert` refuses too. Each pair is checked against
 * what will be around it, so of two that may not nest the inner one goes.
 * A kept chip is rebuilt from this segment's format table, never taken as
 * the clipboard describes it.
 */
function pastedSlice(
  slice: Slice,
  landing: PmNode,
  at: number,
  palette: readonly PaletteTag[],
  formats: readonly FormatEntry[],
): Slice {
  // This segment's tags, by role and id, each with its fmt; a group's members.
  const fmtOf = new Map<string, number>();
  const groupOf = new Map<number, readonly number[]>();
  for (const tag of palette) {
    fmtOf.set(`${tag.role}${tag.id}`, tag.fmt);
    for (const id of tag.members) fmtOf.set(`pair${id}`, id);
    if (tag.members.length > 0) groupOf.set(tag.id, tag.members);
  }

  const staying = chipsIn(landing);
  const present = new Set(staying.map((c) => `${c.role}${c.id}`));
  const placed = new Set<number>();
  for (const c of staying) {
    if (c.role !== 'open') continue;
    placed.add(c.id);
    for (const id of (landing.nodeAt(c.pos)!.attrs as ChipAttrs).members) placed.add(id);
  }
  const outer = pairsAround(landing, at).map((c) => shapeOf(c.fmt, formats));

  type Pasted = Chip & { readonly members: readonly number[] };
  const items: Array<PmNode | Pasted> = [];
  // At whatever depth the clipboard parser left them.
  slice.content.descendants((node) => {
    const a = node.attrs as ChipAttrs;
    if (node.isText) {
      const v = pastedText(node.text!);
      if (v !== '') items.push(schema.text(v));
    } else if (
      node.type.name === 'tag' &&
      fmtOf.has(`${a.role === 'ph' ? 'ph' : 'pair'}${a.id}`) &&
      !present.has(`${a.role}${a.id}`) &&
      !(a.role !== 'ph' && placed.has(a.id))
    ) {
      items.push({ role: a.role, id: a.id, members: a.members });
    }
    return true;
  });
  const chips = items.filter((item): item is Pasted => !('type' in item));
  const unpaired = chipsToDrop(chips);
  const refused = new Set<number>();
  const stack: PairShape[] = [];
  chips.forEach((chip, i) => {
    if (unpaired.has(i)) return;
    if (chip.role === 'close') stack.pop();
    if (chip.role !== 'open') return;
    const shape = shapeOf(fmtOf.get(`pair${chip.id}`)!, formats);
    if (nestingRefusal(shape, [...outer, ...stack], [])) refused.add(chip.id);
    stack.push(shape);
  });
  const kept = chips.filter(
    (chip, i) => !unpaired.has(i) && (chip.role === 'ph' || !refused.has(chip.id)),
  );

  // A group's first pair still stands for the members its copy carried,
  // less any the document or the paste places apart.
  for (const chip of kept) if (chip.role === 'open') placed.add(chip.id);
  const members = new Map<number, readonly number[]>();
  for (const chip of kept) {
    const group = chip.role === 'open' ? groupOf.get(chip.id) : undefined;
    if (group) {
      members.set(
        chip.id,
        group.filter((id) => chip.members.includes(id) && !placed.has(id)),
      );
    }
  }
  const nodes = items.flatMap((item): PmNode[] => {
    if ('type' in item) return [item];
    if (!kept.includes(item)) return [];
    const fmt = fmtOf.get(`${item.role === 'ph' ? 'ph' : 'pair'}${item.id}`)!;
    return [chipNode(item.role, item.id, fmt, formats, members.get(item.id) ?? [])];
  });
  return new Slice(Fragment.fromArray(nodes), 0, 0);
}

/** A fresh editor state for a visible target; `repaired` as `docFromTokens`. */
export function createTargetState(
  tokens: readonly Token[],
  formats: readonly FormatEntry[],
  groups: ReadonlyMap<number, readonly number[]> = new Map(),
  plugins: readonly Plugin[] = [],
): { state: EditorState; repaired: boolean } {
  const { doc, repaired } = docFromTokens(tokens, formats, groups);
  return {
    state: EditorState.create({
      doc,
      plugins: [tagIntegrity, ...plugins],
      selection: TextSelection.atEnd(doc),
    }),
    repaired,
  };
}
