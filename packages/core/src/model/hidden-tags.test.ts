import { describe, expect, it } from 'vitest';

import { carryHiddenTags, withoutHiddenTags } from './hidden-tags.js';
import { validateTagStructure } from './tags.js';
import type { FormatEntry, Token } from './token.js';

const entry = (
  id: number,
  placement: FormatEntry['placement'],
  visible: boolean,
  kind: FormatEntry['kind'] = 'other',
): FormatEntry => ({
  id,
  kind,
  visible,
  placement,
  open: `<x${id}>`,
  close: placement === 'run' || placement === 'inline' ? `</x${id}>` : '',
});
const text = (v: string): Token => ({ t: 'text', v });
const open = (id: number): Token => ({ t: 'open', id, fmt: id });
const close = (id: number): Token => ({ t: 'close', id });
const ph = (id: number): Token => ({ t: 'ph', id, fmt: id });

describe('withoutHiddenTags', () => {
  it('drops both halves of a hidden pair and hidden placeholders', () => {
    const formats = [
      entry(1, 'run', false),
      entry(2, 'run', true, 'b'),
      entry(3, 'block', false),
    ];
    const tokens = [open(1), text('a '), close(1), open(2), text('b'), close(2), ph(3)];
    expect(withoutHiddenTags(tokens, formats)).toEqual([
      text('a '),
      open(2),
      text('b'),
      close(2),
    ]);
  });

  it('keeps a tag its table cannot explain, as the grid shows it', () => {
    expect(withoutHiddenTags([ph(9), text('x')], [])).toEqual([ph(9), text('x')]);
  });

  it('drops a stray close of a hidden pair by its id', () => {
    expect(withoutHiddenTags([text('x'), close(1)], [entry(1, 'run', false)])).toEqual([
      text('x'),
    ]);
  });
});

describe('carryHiddenTags', () => {
  // "Hello world!" in a paragraph whose every run carries the font (hidden
  // run 1 and its twin 3), with "world" bold (visible run 2), a spell-check
  // marker in the middle (hidden block 4) and a bookmark start before it
  // all (hidden block 5).
  const formats = [
    entry(1, 'run', false),
    entry(2, 'run', true, 'b'),
    entry(3, 'run', false),
    entry(4, 'block', false),
    entry(5, 'block', false, 'bookmark'),
  ];
  const source = [
    ph(5),
    open(1),
    text('Hello '),
    close(1),
    ph(4),
    open(2),
    text('world'),
    close(2),
    open(3),
    text('!'),
    close(3),
  ];

  it('wraps plain typed text in the dominant hidden run and carries the rest', () => {
    expect(carryHiddenTags([text('Hola mundo')], source, formats)).toEqual([
      open(1),
      ph(5),
      text('Hola mundo'),
      ph(4),
      open(3),
      close(3),
      close(1),
    ]);
  });

  it('nests the placed visible tags inside it, untouched', () => {
    const visible = [text('Hola '), open(2), text('mundo'), close(2), text('!')];
    const carried = carryHiddenTags(visible, source, formats);
    expect(carried).toEqual([
      open(1),
      ph(5),
      text('Hola '),
      open(2),
      text('mundo'),
      close(2),
      // Run 3 lost to run 1, but its text was kept verbatim: it wraps it.
      open(3),
      text('!'),
      close(3),
      ph(4),
      close(1),
    ]);
    expect(withoutHiddenTags(carried, formats)).toEqual(visible);
    expect(validateTagStructure(carried)).toEqual({ ok: true });
  });

  it('is a function of the visible target alone', () => {
    const visible = [open(2), text('mundo'), close(2), text(', hola')];
    const once = carryHiddenTags(visible, source, formats);
    expect(carryHiddenTags(once, source, formats)).toEqual(once);
    // A copy of the source, hidden tags and all, dresses the same way as
    // its visible part would.
    expect(carryHiddenTags(source, source, formats)).toEqual(
      carryHiddenTags(withoutHiddenTags(source, formats), source, formats),
    );
  });

  it('carries hidden tags into a target with nothing visible, so nothing is lost', () => {
    // A bookmark or an anchored drawing outlives an empty translation.
    const carried = [open(1), ph(5), ph(4), open(3), close(3), close(1)];
    expect(carryHiddenTags([], source, formats)).toEqual(carried);
    expect(carryHiddenTags([open(1), close(1), ph(4)], source, formats)).toEqual(carried);
  });

  it("gives a target that reads as the source's the source's own hidden tags", () => {
    // A copy of the source, or a match of the same sentence: nothing is
    // re-derived, nothing a dominant run would flatten.
    const copy = withoutHiddenTags(source, formats);
    expect(carryHiddenTags(copy, source, formats)).toEqual(source);
  });

  it('wraps a verbatim minority only where it stands apart', () => {
    // "Note" in Arial, "8" raised by hand, " applies." in Arial.
    const f = [entry(1, 'run', false), entry(2, 'run', false), entry(3, 'run', false)];
    const src = [
      open(1),
      text('Note '),
      close(1),
      open(2),
      text('8'),
      close(2),
      open(3),
      text(' applies to both.'),
      close(3),
    ];
    expect(carryHiddenTags([text('La nota 18 y la nota8 aplican.')], src, f)).toEqual([
      open(3),
      text('La nota 18 y la nota'),
      open(2),
      text('8'),
      close(2),
      text(' aplican.'),
      open(1),
      close(1),
      close(3),
    ]);
  });

  it('ignores whitespace when judging what a wrapper encloses', () => {
    // A whole-sentence insertion, then the paragraph's trailing space.
    const f = [entry(1, 'inline', false), entry(2, 'run', false)];
    const src = [open(1), text('Inserted.'), close(1), open(2), text(' '), close(2)];
    expect(carryHiddenTags([text('Insertado.')], src, f)).toEqual([
      open(1),
      text('Insertado.'),
      open(2),
      close(2),
      close(1),
    ]);
  });

  it('grows a bookmark that covered part of the text to the whole, never collapses it', () => {
    const start: FormatEntry = {
      ...entry(1, 'block', false, 'bookmark'),
      open: '<w:bookmarkStart w:id="4" w:name="_Ref1"/>',
    };
    const end: FormatEntry = {
      ...entry(2, 'block', false, 'bookmark'),
      open: '<w:bookmarkEnd w:id="4"/>',
    };
    const src = [text('See '), ph(1), text('table 3'), ph(2), text(' below.')];
    expect(carryHiddenTags([text('Véase la tabla 3.')], src, [start, end])).toEqual([
      ph(1),
      text('Véase la tabla 3.'),
      ph(2),
    ]);
  });

  it('adds no run where most of the source text had none', () => {
    const f = [entry(1, 'run', false)];
    const src = [text('Mostly plain text, '), open(1), text('x'), close(1)];
    expect(carryHiddenTags([text('Casi todo')], src, f)).toEqual([
      text('Casi todo'),
      open(1),
      close(1),
    ]);
  });

  it('keeps a wrapper that enclosed all the text around all of it', () => {
    // A tracked insertion of the whole sentence stays one.
    const f = [entry(1, 'inline', false), entry(2, 'run', false)];
    const src = [open(1), open(2), text('Inserted.'), close(2), close(1)];
    expect(carryHiddenTags([text('Insertado.')], src, f)).toEqual([
      open(1),
      open(2),
      text('Insertado.'),
      close(2),
      close(1),
    ]);
  });

  it('places a wrapper that enclosed only part of the text empty', () => {
    const f = [entry(1, 'inline', false)];
    const src = [text('Kept, '), open(1), text('inserted'), close(1)];
    expect(carryHiddenTags([text('Todo')], src, f)).toEqual([
      text('Todo'),
      open(1),
      close(1),
    ]);
  });

  it('dresses a placed visible container from its own source content', () => {
    // A hyperlink whose text had its own hidden run: inside the link, not
    // the paragraph's.
    const f = [
      entry(1, 'run', false),
      entry(2, 'inline', true, 'link'),
      entry(3, 'run', false),
    ];
    const src = [
      open(1),
      text('See '),
      close(1),
      open(2),
      open(3),
      text('here'),
      close(3),
      close(2),
    ];
    expect(
      carryHiddenTags([text('Ver '), open(2), text('aquí'), close(2)], src, f),
    ).toEqual([
      open(1),
      text('Ver '),
      open(2),
      open(3),
      text('aquí'),
      close(3),
      close(2),
      close(1),
    ]);
  });

  it('carries the hidden tags of an unplaced container at the top level', () => {
    const f = [
      entry(1, 'run', false),
      entry(2, 'inline', true, 'link'),
      entry(3, 'run', false),
    ];
    const src = [
      open(1),
      text('See '),
      close(1),
      open(2),
      open(3),
      text('here'),
      close(3),
      close(2),
    ];
    expect(carryHiddenTags([text('Ver aquí')], src, f)).toEqual([
      open(1),
      text('Ver aquí'),
      open(3),
      close(3),
      close(1),
    ]);
  });

  it('carries each hidden tag once even if a pair is placed twice', () => {
    const f = [entry(1, 'inline', true, 'link'), entry(2, 'run', false)];
    const src = [open(1), open(2), text('here'), close(2), close(1)];
    const doubled = [open(1), text('a'), close(1), open(1), text('b'), close(1)];
    const carried = carryHiddenTags(doubled, src, f);
    expect(carried.filter((t) => t.t === 'open' && t.id === 2)).toHaveLength(1);
  });

  it('carries every hidden tag of the source exactly once', () => {
    const hiddenIds = (tokens: readonly Token[]) =>
      tokens
        .filter((t) => t.t !== 'text' && t.t !== 'close')
        .map((t) => (t as { id: number }).id)
        .filter((id) => !formats.find((x) => x.id === id)!.visible)
        .sort();
    for (const visible of [
      [text('x')],
      [open(2), text('x'), close(2)],
      [text('x'), open(2), close(2), text('y')],
    ]) {
      expect(hiddenIds(carryHiddenTags(visible, source, formats))).toEqual(
        hiddenIds(source),
      );
    }
  });
});
