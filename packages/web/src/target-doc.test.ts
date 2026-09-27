import type { FormatEntry, Token } from '@cat-tool/core';
import { undo, history } from 'prosemirror-history';
import { Fragment, Slice } from 'prosemirror-model';
import { TextSelection, type EditorState } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';

import {
  chipNode,
  createTargetState,
  insertTag,
  nextUnplaced,
  pastedSlice,
  pasteText,
  planInsert,
  schema,
  targetFromDoc,
  tokensFromDoc,
} from './target-doc.js';
import { pairGroups, paletteOf } from './tags.js';

const formats: FormatEntry[] = [
  {
    id: 1,
    kind: 'b',
    visible: true,
    placement: 'run',
    open: '<w:r><w:rPr><w:b/></w:rPr>',
    close: '</w:r>',
  },
  {
    id: 2,
    kind: 'footnote',
    visible: true,
    placement: 'in-run',
    open: '<w:footnoteReference w:id="3"/>',
    close: '',
  },
  {
    id: 3,
    kind: 'i',
    visible: true,
    placement: 'run',
    open: '<w:r><w:rPr><w:i/></w:rPr>',
    close: '</w:r>',
  },
];
const text = (v: string): Token => ({ t: 'text', v });
const open = (id: number): Token => ({ t: 'open', id, fmt: id });
const close = (id: number): Token => ({ t: 'close', id });
const ph = (id: number): Token => ({ t: 'ph', id, fmt: id });
// "The bold text¹ and italics."
const source = [
  text('The '),
  open(1),
  text('bold'),
  close(1),
  text(' text'),
  ph(2),
  text(' and '),
  open(3),
  text('italics'),
  close(3),
  text('.'),
];
const palette = paletteOf(source, formats);
const tag = (id: number) => palette.find((t) => t.id === id)!;

const tokens = (state: EditorState) => tokensFromDoc(state.doc);
/** Position just after the first occurrence of `needle` in the document's text. */
function after(state: EditorState, needle: string): number {
  let found = -1;
  state.doc.descendants((node, pos) => {
    if (found < 0 && node.isText) {
      const i = node.text!.indexOf(needle);
      if (i >= 0) found = pos + i + needle.length;
    }
  });
  if (found < 0) throw new Error(`no "${needle}"`);
  return found;
}
const select = (state: EditorState, from: number, to = from) =>
  state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));

describe('the document', () => {
  it('holds a visible target exactly, and gives it back', () => {
    expect(tokens(createTargetState(source, formats).state)).toEqual(source);
    expect(tokens(createTargetState([], formats).state)).toEqual([]);
  });

  it('keeps edge spaces a segment carries', () => {
    const edged = [text(' leading and trailing ')];
    expect(tokens(createTargetState(edged, formats).state)).toEqual(edged);
  });
});

describe('insert next tag', () => {
  it('with text selected, offers the first pair before a placeholder', () => {
    // Only the footnote and the italics are left; a selection asks to be wrapped.
    let state = createTargetState(
      [open(1), text('x'), close(1), text(' algo')],
      formats,
    ).state;
    expect(nextUnplaced(state, palette)?.id).toBe(2);
    state = select(state, after(state, ' '), after(state, 'algo'));
    expect(nextUnplaced(state, palette)?.id).toBe(3);
  });

  it('offers unplaced tags in source order', () => {
    let state = createTargetState([text('El texto')], formats).state;
    expect(nextUnplaced(state, palette)?.id).toBe(1);
    state = createTargetState([open(1), text('x'), close(1)], formats).state;
    expect(nextUnplaced(state, palette)?.id).toBe(2);
    state = createTargetState(source, formats).state;
    expect(nextUnplaced(state, palette)).toBeUndefined();
  });

  it('inserts a pair empty at the cursor, the cursor between its chips', () => {
    let state = createTargetState([text('El texto')], formats).state;
    state = select(state, after(state, 'El '));
    state = state.apply(planInsertOk(state, 1));
    state = state.apply(state.tr.insertText('negrita'));
    expect(tokens(state)).toEqual([
      text('El '),
      open(1),
      text('negrita'),
      close(1),
      text('texto'),
    ]);
  });

  it('wraps a balanced selection', () => {
    let state = createTargetState([text('El texto en negrita')], formats).state;
    state = select(state, after(state, 'texto en '), after(state, 'negrita'));
    state = state.apply(planInsertOk(state, 1));
    expect(tokens(state)).toEqual([
      text('El texto en '),
      open(1),
      text('negrita'),
      close(1),
    ]);
  });

  it('refuses a selection that crosses a pair, and changes nothing', () => {
    let state = createTargetState(
      [text('El '), open(1), text('texto'), close(1), text(' y más')],
      formats,
    ).state;
    state = select(state, after(state, 'te'), after(state, ' y'));
    const plan = planInsert(state, tag(3), formats);
    expect(plan.ok).toBe(false);
    expect(insertTag(tag(3), formats)(state)).toBe(false);
  });

  it('puts a placeholder at the end of the selection, text untouched', () => {
    let state = createTargetState([text('El texto y más')], formats).state;
    state = select(state, after(state, 'El '), after(state, 'texto'));
    state = state.apply(planInsertOk(state, 2));
    expect(tokens(state)).toEqual([text('El texto'), ph(2), text(' y más')]);
  });

  it('refuses formatting inside formatting, which would export as the inner alone', () => {
    let state = createTargetState(
      [open(1), text('negrita y cursiva'), close(1)],
      formats,
    ).state;
    state = select(state, after(state, 'y '), after(state, 'cursiva'));
    const plan = planInsert(state, tag(3), formats);
    expect(plan.ok).toBe(false);
    // Around it too.
    state = createTargetState(
      [text('a '), open(1), text('b'), close(1), text(' c')],
      formats,
    ).state;
    state = select(state, 1, state.doc.content.size);
    expect(planInsert(state, tag(3), formats).ok).toBe(false);
  });

  it('puts a placeholder inside formatting, where a footnote reference lives', () => {
    let state = createTargetState([text('Nota')], formats).state;
    state = state.apply(planInsertOk(state, 1));
    state = state.apply(planInsertOk(state, 2));
    expect(tokens(state)).toEqual([text('Nota'), open(1), ph(2), close(1)]);
  });

  it('moves a tag that is already placed', () => {
    let state = createTargetState(
      [open(1), text('uno'), close(1), text(' dos')],
      formats,
    ).state;
    state = select(state, after(state, ' '), after(state, 'dos'));
    state = state.apply(planInsertOk(state, 1));
    expect(tokens(state)).toEqual([text('uno '), open(1), text('dos'), close(1)]);
  });
});

describe('groups of look-alike pairs', () => {
  // "Rabu ho" in bold, split by Word into two bold runs.
  const gFormats: FormatEntry[] = [formats[0]!, { ...formats[0]!, id: 2 }];
  const gSource = [open(1), text('Rabu'), close(1), open(2), text(' ho'), close(2)];
  const groups = pairGroups(gSource, gFormats);
  const gPalette = paletteOf(gSource, gFormats);

  it('are placed as one pair and saved as every pair the source has', () => {
    let state = createTargetState([text('Rabu ho')], gFormats, groups).state;
    state = select(state, 0, state.doc.content.size);
    const plan = planInsert(state, gPalette[0]!, gFormats);
    if (!plan.ok) throw new Error(plan.reason);
    state = state.apply(plan.tr);
    expect(tokens(state)).toEqual([open(1), text('Rabu ho'), close(1)]);
    expect(targetFromDoc(state.doc)).toEqual([
      open(1),
      text('Rabu ho'),
      close(1),
      open(2),
      close(2),
    ]);
  });

  it('load back as one pair from what was saved, and from a copy of the source', () => {
    const saved = [open(1), text('Rabu ho'), close(1), open(2), close(2)];
    expect(tokens(createTargetState(saved, gFormats, groups).state)).toEqual([
      open(1),
      text('Rabu ho'),
      close(1),
    ]);
    expect(tokens(createTargetState(gSource, gFormats, groups).state)).toEqual([
      open(1),
      text('Rabu ho'),
      close(1),
    ]);
  });
});

describe('saving', () => {
  it('drops a pair left empty: it formats nothing, so it is not placed', () => {
    let state = createTargetState([text('Hola')], formats).state;
    state = state.apply(planInsertOk(state, 1));
    expect(tokens(state)).toEqual([text('Hola'), open(1), close(1)]);
    expect(targetFromDoc(state.doc)).toEqual([text('Hola')]);
  });

  it('repairs a stored target that is not tag-valid, and says so', () => {
    const broken = [close(1), text('x'), open(1), ph(2)];
    const { state, repaired } = createTargetState(broken, formats);
    expect(repaired).toBe(true);
    expect(tokens(state)).toEqual([text('x'), ph(2)]);
    expect(createTargetState(source, formats).repaired).toBe(false);
  });
});

describe('pasting from this editor', () => {
  it('moves the tags a cut took, and copies only the words of a copy', () => {
    const state = createTargetState([text('el coche')], formats).state;
    // The clipboard holds pair 1 around "rojo", as this editor serialised it.
    const clip = new Slice(
      Fragment.fromArray([
        chipNode('open', 1, 1, formats),
        schema.text('rojo'),
        chipNode('close', 1, 1, formats),
      ]),
      0,
      0,
    );
    // After a cut the document no longer has the pair: it moves.
    let cut = state;
    cut = cut.apply(cut.tr.replaceSelection(pastedSlice(clip, cut.doc)));
    expect(tokens(cut)).toEqual([text('el coche'), open(1), text('rojo'), close(1)]);
    // After a copy it still has it: only the words arrive.
    const copied = createTargetState(
      [open(1), text('rojo'), close(1), text(' ')],
      formats,
    ).state;
    const pasted = copied.apply(
      copied.tr.replaceSelection(pastedSlice(clip, copied.doc)),
    );
    expect(tokens(pasted)).toEqual([open(1), text('rojo'), close(1), text(' rojo')]);
  });
});

describe('tag integrity', () => {
  const start = () => createTargetState(source, formats, new Map(), [history()]).state;

  it('deleting one chip of a pair deletes its partner, content kept', () => {
    let state = start();
    const openPos = after(state, 'The ');
    state = state.apply(state.tr.delete(openPos, openPos + 1));
    expect(tokens(state)).toEqual([
      text('The bold text'),
      ph(2),
      text(' and '),
      open(3),
      text('italics'),
      close(3),
      text('.'),
    ]);
  });

  it('typing over a selection that cuts a pair removes the whole pair', () => {
    let state = start();
    state = select(state, after(state, 'bo'), after(state, ' te'));
    state = state.apply(state.tr.insertText('X'));
    expect(tokens(state)).toEqual([
      text('The boXxt'),
      ph(2),
      text(' and '),
      open(3),
      text('italics'),
      close(3),
      text('.'),
    ]);
  });

  it('one undo restores both chips', () => {
    let state = start();
    const openPos = after(state, 'The ');
    state = state.apply(state.tr.delete(openPos, openPos + 1));
    expect(tokens(state).some((t) => t.t !== 'text' && t.id === 1)).toBe(false);
    undo(state, (tr) => {
      state = state.apply(tr);
    });
    expect(tokens(state)).toEqual(source);
  });

  it('a paste is one line of text, whatever the clipboard held', () => {
    let state = createTargetState([text('A')], formats).state;
    state = state.apply(pasteText(state, 'uno\ndos\ttres'));
    expect(tokens(state)).toEqual([text('Auno dos tres')]);
  });

  it('keeps every reachable state tag-valid', () => {
    // Seeded walks of edits a translator can make: type, delete a range,
    // place the next tag, place a tag from the list. None leaves the
    // document in a state `renderTokens` would refuse.
    for (let seed = 1; seed <= 200; seed++) {
      let rand = seed;
      const next = () => (rand = (rand * 1103515245 + 12345) % 2147483648) / 2147483648;
      let state = createTargetState([text('Uno dos tres cuatro')], formats, new Map(), [
        history(),
      ]).state;
      for (let step = 0; step < 40; step++) {
        const size = state.doc.content.size;
        const a = Math.floor(next() * (size + 1));
        const b = Math.floor(next() * (size + 1));
        state = select(state, Math.min(a, b), Math.max(a, b));
        const roll = next();
        if (roll < 0.3) state = state.apply(state.tr.insertText('ab '));
        else if (roll < 0.5) state = state.apply(state.tr.deleteSelection());
        else if (roll < 0.75) {
          const t = nextUnplaced(state, palette);
          if (t) insertTag(t, formats)(state, (tr) => (state = state.apply(tr)));
        } else {
          insertTag(palette[Math.floor(next() * palette.length)]!, formats)(
            state,
            (tr) => (state = state.apply(tr)),
          );
        }
        expect(
          validateTagStructureLike(tokens(state)),
          `seed ${seed} step ${step}`,
        ).toEqual([]);
      }
    }
  });
});

/**
 * Structural problems in a token stream, checked independently of
 * `tags.ts` (a test of the editor by its own rules would prove nothing),
 * the way `core`'s `validateTagStructure` reads them.
 */
function validateTagStructureLike(stream: readonly Token[]): string[] {
  const problems: string[] = [];
  const stack: number[] = [];
  const seen = new Set<string>();
  for (const t of stream) {
    if (t.t === 'text') continue;
    if (t.t !== 'close') {
      const key = `${t.t}${t.id}`;
      if (seen.has(key)) problems.push(`duplicate ${key}`);
      seen.add(key);
    }
    if (t.t === 'open') stack.push(t.id);
    else if (t.t === 'close' && stack.pop() !== t.id) problems.push(`bad close ${t.id}`);
  }
  if (stack.length) problems.push(`unclosed ${stack.join(',')}`);
  return problems;
}

function planInsertOk(state: EditorState, id: number) {
  const plan = planInsert(state, tag(id), formats);
  if (!plan.ok) throw new Error(plan.reason);
  return plan.tr;
}
