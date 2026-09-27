/**
 * The target editor's document (v1-spec.md §7.2; backlog #29): a
 * ProseMirror schema whose content is exactly a visible target — text,
 * and each tag as one atomic chip — plus the plugin and commands that
 * keep it tag-valid. No DOM here: `prosemirror-state` runs in node, so
 * every rule below is tested without a browser (`target-doc.test.ts`);
 * `TargetEditor.tsx` puts a view on it.
 */
import type { FormatEntry, Token } from '@cat-tool/core';
import { closeHistory } from 'prosemirror-history';
import { Fragment, Schema, Slice, type Node as PmNode } from 'prosemirror-model';
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
  unplacedTags,
  withoutEmptyPairs,
  type Chip,
  type PairShape,
  type PaletteTag,
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
 * dropped), each group it places whole as one pair (`collapseGroups`).
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
    const members = collapsed.grouped.has(token.id) ? (groups.get(token.id) ?? []) : [];
    // A close carries no `fmt`; its id is its open's.
    const fmt = token.t === 'close' ? token.id : token.fmt;
    nodes.push(chipNode(token.t, token.id, fmt, formats, members.slice(1)));
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

/**
 * The visible target to save: pairs holding nothing dropped — an empty
 * pair formats nothing, so it counts as unplaced and QA's `tag.missing`
 * says so — then each group's members restored behind its first pair
 * (`expandGroups`), so the server stores every tag the source has.
 */
export function targetFromDoc(doc: PmNode): Token[] {
  const members = new Map<number, readonly number[]>();
  doc.forEach((node) => {
    const a = node.attrs as Partial<ChipAttrs>;
    if (a.role === 'open' && a.members && a.members.length > 0)
      members.set(a.id!, a.members);
  });
  return expandGroups(withoutEmptyPairs(tokensFromDoc(doc)), members);
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
 * already placed is moved: its old chips go first. Each placement is its
 * own undo step.
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
  const last = tag.members.length > 0 ? tag.members[tag.members.length - 1] : undefined;
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
  tr.insert(to, chipNode('close', tag.id, tag.fmt, formats, tag.members));
  tr.insert(from, chipNode('open', tag.id, tag.fmt, formats, tag.members));
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
): PaletteTag | undefined {
  const unplaced = unplacedTags(palette, tokensFromDoc(state.doc));
  if (state.selection.empty) return unplaced[0];
  return unplaced.find((t) => t.role === 'pair') ?? unplaced[0];
}

/** A paste from elsewhere, as the one line of plain text it may be (`pastedText`). */
export function pasteText(state: EditorState, text: string): Transaction {
  return state.tr.insertText(pastedText(text)).scrollIntoView();
}

/**
 * A slice pasted from this editor, with the chips the document already
 * has taken out: a copy and paste copies the words, a cut and paste —
 * whose chips left with the cut — moves the tags with them. A half pair
 * left over is the integrity plugin's to drop.
 */
export function pastedSlice(slice: Slice, doc: PmNode): Slice {
  const present = new Set(chipsIn(doc).map((c) => `${c.role}${c.id}`));
  const nodes: PmNode[] = [];
  // At whatever depth the clipboard parser left them.
  slice.content.descendants((node) => {
    const a = node.attrs as Partial<ChipAttrs>;
    if (node.isText) nodes.push(schema.text(pastedText(node.text!)));
    else if (node.type.name === 'tag' && !present.has(`${a.role}${a.id}`))
      nodes.push(node);
    return true;
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
