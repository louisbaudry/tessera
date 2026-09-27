import type { FormatEntry, Token } from '@cat-tool/core';
import { undo, history } from 'prosemirror-history';
import { Fragment, Slice, type Node as PmNode } from 'prosemirror-model';
import { TextSelection, type EditorState } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';

import {
  chipNode,
  choicesIn,
  clipboardSegment,
  createTargetState,
  insertTag,
  nextUnplaced,
  pasteOwn,
  pasteText,
  planInsert,
  schema,
  SegmentClipboard,
  segmentCopyKey,
  targetFromDoc,
  tokensFromDoc,
} from './target-doc.js';
import { pairGroups, paletteOf, type PaletteTag } from './tags.js';

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
    expect(nextUnplaced(state, palette, formats)?.id).toBe(2);
    state = select(state, after(state, ' '), after(state, 'algo'));
    expect(nextUnplaced(state, palette, formats)?.id).toBe(3);
  });

  it('offers unplaced tags in source order', () => {
    let state = createTargetState([text('El texto')], formats).state;
    expect(nextUnplaced(state, palette, formats)?.id).toBe(1);
    state = createTargetState([open(1), text('x'), close(1)], formats).state;
    expect(nextUnplaced(state, palette, formats)?.id).toBe(2);
    state = createTargetState(source, formats).state;
    expect(nextUnplaced(state, palette, formats)).toBeUndefined();
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

  describe('placed apart, as a memory match can store them', () => {
    const apart = [
      open(1),
      text('Hallo'),
      close(1),
      text(' und '),
      open(2),
      text('Welt'),
      close(2),
    ];
    const load = () => createTargetState(apart, gFormats, groups).state;
    const place = (state: EditorState, t: PaletteTag | undefined) => {
      const plan = planInsert(state, t!, gFormats);
      if (!plan.ok) throw new Error(plan.reason);
      return state.apply(plan.tr);
    };

    it('moving the first pair leaves the member its own chip, saved once', () => {
      let state = load();
      state = select(state, after(state, ' '), after(state, 'und'));
      // The tag list offers the group's first pair; choosing it moves it.
      state = place(state, gPalette[0]);
      const saved = [
        text('Hallo '),
        open(1),
        text('und'),
        close(1),
        text(' '),
        open(2),
        text('Welt'),
        close(2),
      ];
      expect(tokens(state)).toEqual(saved);
      expect(targetFromDoc(state.doc)).toEqual(saved);
    });

    it('deleting the first pair offers it back without the member placed apart', () => {
      let state = load();
      state = state.apply(state.tr.delete(0, 1));
      const next = nextUnplaced(state, gPalette, gFormats);
      expect(next).toMatchObject({ id: 1, members: [] });
      state = place(select(state, 0, after(state, 'Hallo')), next);
      expect(targetFromDoc(state.doc)).toEqual(apart);
    });

    it('deleting the member offers it as a tag of its own', () => {
      let state = load();
      const at = after(state, ' und ');
      state = state.apply(state.tr.delete(at, at + 1));
      expect(tokens(state)).toEqual([
        open(1),
        text('Hallo'),
        close(1),
        text(' und Welt'),
      ]);
      const next = nextUnplaced(state, gPalette, gFormats);
      expect(next).toMatchObject({ id: 2, members: [] });
      state = place(select(state, after(state, 'und '), after(state, 'Welt')), next);
      expect(targetFromDoc(state.doc)).toEqual(apart);
    });
  });

  describe('placed partly apart, saved and loaded again', () => {
    // "a b c d" in bold, as four runs: one group of pairs 1 to 4.
    const fFormats: FormatEntry[] = [1, 2, 3, 4].map((id) => ({ ...formats[0]!, id }));
    const fSource = [1, 2, 3, 4].flatMap((id) => [
      open(id),
      text('abcd'[id - 1]!),
      close(id),
    ]);
    const fGroups = pairGroups(fSource, fFormats);
    const fPalette = paletteOf(fSource, fFormats);
    /** Loads what was saved, types one character at the end, saves again. */
    const resave = (saved: Token[]) => {
      let state = createTargetState(saved, fFormats, fGroups).state;
      state = state.apply(state.tr.insertText('!', state.doc.content.size));
      return targetFromDoc(state.doc);
    };

    it('keeps the members the first pair carried, placed back beside a member apart', () => {
      // A memory's match: member 2 apart, 3 and 4 not placed. Backspace the
      // first pair's open chip, then Ctrl+,.
      let state = createTargetState(
        [
          open(1),
          text('Hallo'),
          close(1),
          text(' und '),
          open(2),
          text('Welt'),
          close(2),
        ],
        fFormats,
        fGroups,
      ).state;
      state = state.apply(state.tr.delete(0, 1));
      const next = nextUnplaced(state, fPalette, fFormats);
      expect(next).toMatchObject({ id: 1, members: [3, 4] });
      const plan = planInsert(select(state, 0, after(state, 'Hallo')), next!, fFormats);
      if (!plan.ok) throw new Error(plan.reason);
      const saved = targetFromDoc(state.apply(plan.tr).doc);
      expect(saved).toEqual([
        open(1),
        text('Hallo'),
        close(1),
        open(3),
        close(3),
        open(4),
        close(4),
        text(' und '),
        open(2),
        text('Welt'),
        close(2),
      ]);
      const loaded = createTargetState(saved, fFormats, fGroups).state;
      expect(
        choicesIn(loaded.doc, fPalette, fFormats).map((c) => [
          c.tag.id,
          c.tag.members,
          c.placed,
        ]),
      ).toEqual([
        [1, [3, 4], true],
        [2, [], true],
      ]);
      expect(resave(saved)).toEqual([...saved, text('!')]);
    });

    it('keeps them with a member not placed at all, which stays one to place', () => {
      const saved = [
        open(1),
        text('Hallo'),
        close(1),
        open(4),
        close(4),
        text(' und '),
        open(2),
        text('Welt'),
        close(2),
      ];
      const loaded = createTargetState(saved, fFormats, fGroups).state;
      expect(
        choicesIn(loaded.doc, fPalette, fFormats).map((c) => [
          c.tag.id,
          c.tag.members,
          c.placed,
        ]),
      ).toEqual([
        [1, [4], true],
        [2, [], true],
        [3, [], false],
      ]);
      expect(resave(saved)).toEqual([...saved, text('!')]);
    });
  });

  it('keep every saved target tag-valid, however they are placed', () => {
    // Seeded walks over a three-pair group and a pair apart, from a target
    // that places the group piecemeal: type, delete, place the next tag,
    // place or move any tag the list offers. What would be saved never
    // holds a tag twice.
    const fmts: FormatEntry[] = [
      ...[1, 2, 3].map((id) => ({ ...formats[0]!, id })),
      { ...formats[2]!, id: 4 },
    ];
    const src = [
      open(1),
      text('a'),
      close(1),
      open(2),
      text('b'),
      close(2),
      open(3),
      text('c'),
      close(3),
      text(' '),
      open(4),
      text('d'),
      close(4),
    ];
    const g = pairGroups(src, fmts);
    const pal = paletteOf(src, fmts);
    expect([...g]).toEqual([[1, [1, 2, 3]]]);
    for (let seed = 1; seed <= 150; seed++) {
      let rand = seed;
      const next = () => (rand = (rand * 1103515245 + 12345) % 2147483648) / 2147483648;
      let state = createTargetState(
        [open(1), text('uno'), close(1), text(' dos '), open(3), text('tres'), close(3)],
        fmts,
        g,
        [history()],
      ).state;
      for (let step = 0; step < 30; step++) {
        const size = state.doc.content.size;
        const a = Math.floor(next() * (size + 1));
        const b = Math.floor(next() * (size + 1));
        state = select(state, Math.min(a, b), Math.max(a, b));
        const roll = next();
        if (roll < 0.25) state = state.apply(state.tr.insertText('ab '));
        else if (roll < 0.45) state = state.apply(state.tr.deleteSelection());
        else if (roll < 0.7) {
          const t = nextUnplaced(state, pal, fmts);
          if (t) insertTag(t, fmts)(state, (tr) => (state = state.apply(tr)));
        } else {
          // What the list offers, or the palette's own entry for it.
          const choices = choicesIn(state.doc, pal, fmts);
          const t =
            roll < 0.85
              ? choices[Math.floor(next() * choices.length)]!.tag
              : pal[Math.floor(next() * pal.length)]!;
          insertTag(t, fmts)(state, (tr) => (state = state.apply(tr)));
        }
        expect(
          validateTagStructureLike(targetFromDoc(state.doc)),
          `seed ${seed} step ${step}`,
        ).toEqual([]);
      }
    }
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
    const cut = state.apply(pasteOwn(state, clip, palette, formats));
    expect(tokens(cut)).toEqual([text('el coche'), open(1), text('rojo'), close(1)]);
    // After a copy it still has it: only the words arrive.
    const copied = createTargetState(
      [open(1), text('rojo'), close(1), text(' ')],
      formats,
    ).state;
    const pasted = copied.apply(pasteOwn(copied, clip, palette, formats));
    expect(tokens(pasted)).toEqual([open(1), text('rojo'), close(1), text(' rojo')]);
  });

  const paste = (state: EditorState, nodes: PmNode[], p = palette, f = formats) =>
    state.apply(pasteOwn(state, new Slice(Fragment.fromArray(nodes), 0, 0), p, f));

  it('keeps no pair where it may not nest: bold pasted into italic arrives as words', () => {
    let state = createTargetState(
      [text('la '), open(3), text('kursiv'), close(3)],
      formats,
    ).state;
    state = select(state, after(state, 'kur'));
    state = paste(state, [
      chipNode('open', 1, 1, formats),
      schema.text('fett'),
      chipNode('close', 1, 1, formats),
    ]);
    expect(tokens(state)).toEqual([text('la '), open(3), text('kurfettsiv'), close(3)]);
    // Beside the italic it may go.
    state = select(state, 0);
    state = paste(state, [
      chipNode('open', 1, 1, formats),
      schema.text('fett'),
      chipNode('close', 1, 1, formats),
    ]);
    expect(tokens(state)[0]).toEqual(open(1));
  });

  it('keeps no link pasted inside a link', () => {
    const link = (id: number): FormatEntry => ({
      id,
      kind: 'link',
      visible: true,
      placement: 'inline',
      open: `<w:hyperlink w:anchor="a${id}">`,
      close: '</w:hyperlink>',
    });
    const lFormats = [link(1), link(2)];
    const lPalette = paletteOf(
      [open(1), text('a'), close(1), text(' '), open(2), text('b'), close(2)],
      lFormats,
    );
    let state = createTargetState(
      [open(2), text('dos'), close(2), text(' uno')],
      lFormats,
    ).state;
    const clip = [
      chipNode('open', 1, 1, lFormats),
      schema.text('x'),
      chipNode('close', 1, 1, lFormats),
    ];
    const inside = paste(select(state, after(state, 'd')), clip, lPalette, lFormats);
    expect(tokens(inside)).toEqual([open(2), text('dxos'), close(2), text(' uno')]);
    state = paste(select(state, state.doc.content.size), clip, lPalette, lFormats);
    expect(tokens(state)).toEqual([
      open(2),
      text('dos'),
      close(2),
      text(' uno'),
      open(1),
      text('x'),
      close(1),
    ]);
  });

  it('keeps a pair the paste replaces: select all, paste a copy, the tags stay', () => {
    let state = createTargetState(
      [open(1), text('rojo'), close(1), text(' coche')],
      formats,
    ).state;
    state = select(state, 0, state.doc.content.size);
    state = paste(state, [
      chipNode('open', 1, 1, formats),
      schema.text('rot'),
      chipNode('close', 1, 1, formats),
    ]);
    expect(tokens(state)).toEqual([open(1), text('rot'), close(1)]);
  });

  it('pastes over one chip of a pair as if that pair were gone, its other chip too', () => {
    // The selection takes bold's close, not its open; the copy holds bold
    // again, beside italic. Bold's open must not survive to pair with the
    // pasted close around the italic: that exports as italic alone.
    let state = createTargetState(
      [open(1), text('yy'), close(1), text(' z')],
      formats,
    ).state;
    state = select(state, after(state, 'yy'), state.doc.content.size);
    state = paste(state, [
      chipNode('open', 3, 3, formats),
      schema.text('x'),
      chipNode('close', 3, 3, formats),
      chipNode('open', 1, 1, formats),
      schema.text('w'),
      chipNode('close', 1, 1, formats),
    ]);
    expect(tokens(state)).toEqual([
      text('yy'),
      open(3),
      text('x'),
      close(3),
      open(1),
      text('w'),
      close(1),
    ]);
  });

  it("moves a group's first pair with the members it carried, less any placed apart", () => {
    const gFormats: FormatEntry[] = [formats[0]!, { ...formats[0]!, id: 2 }];
    const gSource = [open(1), text('Rabu'), close(1), open(2), text(' ho'), close(2)];
    const gPalette = paletteOf(gSource, gFormats);
    const clip = [
      chipNode('open', 1, 1, gFormats, [2]),
      schema.text('Rabu ho'),
      chipNode('close', 1, 1, gFormats, [2]),
    ];
    const cut = createTargetState([text('y ')], gFormats).state;
    expect(targetFromDoc(paste(cut, clip, gPalette, gFormats).doc)).toEqual([
      text('y '),
      open(1),
      text('Rabu ho'),
      close(1),
      open(2),
      close(2),
    ]);
    const apart = createTargetState(
      [open(2), text('y'), close(2), text(' ')],
      gFormats,
    ).state;
    const pasted = paste(apart, clip, gPalette, gFormats);
    expect(pasted.doc.lastChild!.attrs['members']).toEqual([]);
    expect(targetFromDoc(pasted.doc)).toEqual([
      open(2),
      text('y'),
      close(2),
      text(' '),
      open(1),
      text('Rabu ho'),
      close(1),
    ]);
  });

  it("keeps only this segment's tags, rebuilt from its own format table", () => {
    const state = createTargetState([text('Hola')], formats).state;
    const foreign = schema.nodes['tag']!.create({
      role: 'ph',
      id: 1,
      fmt: 1,
      members: [],
      label: 'x',
      full: 'x',
      title: 'x',
    });
    const pasted = paste(state, [
      // Tag 9 is no tag of this segment's, and its tag 1 is a pair.
      chipNode('ph', 9, 9, formats),
      foreign,
      schema.text(' y'),
      // A placeholder of its own, described by the clipboard as something else.
      schema.nodes['tag']!.create({
        role: 'ph',
        id: 2,
        fmt: 2,
        members: [],
        label: 'bogus',
        full: 'bogus',
        title: 'bogus',
      }),
    ]);
    expect(tokens(pasted)).toEqual([text('Hola y'), ph(2)]);
    expect(pasted.doc.lastChild!.eq(chipNode('ph', 2, 2, formats))).toBe(true);
  });

  it('keeps the document tag-valid and nested as a source nests, whatever a paste replaces', () => {
    // Every selection of a few documents, each pasted over with a few
    // copies of this segment's: bold 1 and 6 are one group, 3 is italic,
    // 4 and 5 are links, 2 a footnote.
    const link = (id: number): FormatEntry => ({
      id,
      kind: 'link',
      visible: true,
      placement: 'inline',
      open: `<w:hyperlink w:anchor="a${id}">`,
      close: '</w:hyperlink>',
    });
    const fmts: FormatEntry[] = [...formats, link(4), link(5), { ...formats[0]!, id: 6 }];
    const src = [1, 6, 3, 4, 5].flatMap((id) => [open(id), text('abcde'), close(id)]);
    const pal = paletteOf([...src, ph(2)], fmts);
    const g = pairGroups(src, fmts);
    expect([...g]).toEqual([[1, [1, 6]]]);
    const docs = [
      [open(1), text('yy'), close(1), text(' z')],
      [
        open(4),
        text('a'),
        open(1),
        text('b'),
        close(1),
        close(4),
        text(' '),
        open(3),
        text('c'),
        close(3),
      ],
      [
        open(5),
        text('x'),
        close(5),
        ph(2),
        text(' '),
        open(4),
        text('y'),
        close(4),
        open(6),
        text('v'),
        close(6),
      ],
    ];
    const chip = (role: 'open' | 'close', id: number) =>
      chipNode(role, id, id, fmts, id === 1 ? [6] : []);
    const copies = [
      [
        chip('open', 3),
        schema.text('x'),
        chip('close', 3),
        chip('open', 1),
        schema.text('w'),
        chip('close', 1),
      ],
      [
        chip('open', 5),
        schema.text('p'),
        chip('close', 5),
        chip('open', 4),
        schema.text('q'),
        chip('open', 1),
        schema.text('r'),
        chip('close', 1),
        chip('close', 4),
      ],
      [
        chip('open', 1),
        schema.text('s'),
        chipNode('ph', 2, 2, fmts),
        chip('close', 1),
        chip('open', 3),
        schema.text('t'),
        chip('close', 3),
        chip('open', 5),
        schema.text('u'),
        chip('close', 5),
      ],
    ];
    for (const [d, doc] of docs.entries()) {
      const start = createTargetState(doc, fmts, g).state;
      const size = start.doc.content.size;
      for (const [c, copy] of copies.entries()) {
        const clip = new Slice(Fragment.fromArray(copy), 0, 0);
        for (let from = 0; from <= size; from++) {
          for (let to = from; to <= size; to++) {
            const state = select(start, from, to);
            const pasted = state.apply(pasteOwn(state, clip, pal, fmts));
            const where = `doc ${d} copy ${c} over ${from}-${to}`;
            expect(validateTagStructureLike(targetFromDoc(pasted.doc)), where).toEqual(
              [],
            );
            expect(nestingProblems(tokens(pasted), fmts), where).toEqual([]);
          }
        }
      }
    }
  });
});

describe('the clipboard', () => {
  /** Just enough of a DOM for a serializer: elements, text and fragments. */
  class FakeNode {
    readonly childNodes: FakeNode[] = [];
    readonly attributes = new Map<string, string>();
    constructor(
      readonly nodeType: number,
      readonly nodeName: string,
      readonly text = '',
    ) {}
    get firstChild(): FakeNode | null {
      return this.childNodes[0] ?? null;
    }
    appendChild(child: FakeNode): FakeNode {
      this.childNodes.push(child);
      return child;
    }
    setAttribute(name: string, value: string): void {
      this.attributes.set(name, value);
    }
    get html(): string {
      if (this.nodeType === 3) return this.text;
      const inner = this.childNodes.map((c) => c.html).join('');
      if (this.nodeType !== 1) return inner;
      const attrs = [...this.attributes].map(([k, v]) => ` ${k}="${v}"`).join('');
      return `<${this.nodeName}${attrs}>${inner}</${this.nodeName}>`;
    }
  }
  const fakeDocument = {
    createElement: (name: string) => new FakeNode(1, name),
    createTextNode: (text: string) => new FakeNode(3, '#text', text),
    createDocumentFragment: () => new FakeNode(11, '#document-fragment'),
  } as unknown as Document;

  it('marks every copy as one element naming its segment, even one starting with a word', () => {
    const copy = Fragment.fromArray([
      schema.text('rojo '),
      chipNode('open', 1, 1, formats),
      schema.text('coche'),
      chipNode('close', 1, 1, formats),
    ]);
    const out = new SegmentClipboard('manual', 7).serializeFragment(copy, {
      document: fakeDocument,
    }) as unknown as FakeNode;
    // ProseMirror puts `data-pm-slice` on the first child only if it is an element.
    expect(out.childNodes).toHaveLength(1);
    expect(out.firstChild!.nodeType).toBe(1);
    expect(out.firstChild!.firstChild!.text).toBe('rojo ');
    expect(clipboardSegment(out.html)).toBe(segmentCopyKey('manual', 7));
  });

  it("tells this segment's copy from another's and from anyone else's HTML", () => {
    expect(
      clipboardSegment(
        '<span data-segment-copy="manual/12" data-pm-slice="0 0 []">a</span>',
      ),
    ).toBe(segmentCopyKey('manual', 12));
    expect(clipboardSegment('<p data-pm-slice="0 0 []">a</p>')).toBeNull();
    expect(clipboardSegment('')).toBeNull();
  });

  it('names the project too: segment 12 of another project is not this segment', () => {
    // Every project numbers its segments from 1, and the clipboard outlives
    // a move between projects (or is shared by two tabs).
    const copy = (project: string, id: number) =>
      clipboardSegment(
        (
          new SegmentClipboard(project, id).serializeFragment(
            Fragment.from(schema.text('Warning')),
            { document: fakeDocument },
          ) as unknown as FakeNode
        ).html,
      );
    expect(copy('manual', 12)).toBe(segmentCopyKey('manual', 12));
    expect(copy('manual', 12)).not.toBe(segmentCopyKey('brochure', 12));
    expect(copy('manual', 12)).not.toBe(segmentCopyKey('manual', 1));
    // The name is opaque text: whatever it holds, the key reads back whole.
    for (const odd of ['a"b/1', 'a"b', 'x y&z<', '1/12']) {
      expect(copy(odd, 2), odd).toBe(segmentCopyKey(odd, 2));
    }
    expect(segmentCopyKey('1/12', 2)).not.toBe(segmentCopyKey('1', 122));
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
          const t = nextUnplaced(state, palette, formats);
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

/**
 * Pairs nested as no source nests them, checked independently of
 * `tags.ts` too: a pair inside formatting, a link inside a link.
 */
function nestingProblems(
  stream: readonly Token[],
  fmts: readonly FormatEntry[],
): string[] {
  const problems: string[] = [];
  const stack: FormatEntry[] = [];
  for (const t of stream) {
    if (t.t === 'close') stack.pop();
    if (t.t !== 'open') continue;
    const f = fmts.find((x) => x.id === t.fmt)!;
    if (stack.some((s) => s.placement === 'run')) problems.push(`${t.id} in formatting`);
    if (f.kind === 'link' && stack.some((s) => s.kind === 'link')) {
      problems.push(`link ${t.id} in a link`);
    }
    stack.push(f);
  }
  return problems;
}

function planInsertOk(state: EditorState, id: number) {
  const plan = planInsert(state, tag(id), formats);
  if (!plan.ok) throw new Error(plan.reason);
  return plan.tr;
}
