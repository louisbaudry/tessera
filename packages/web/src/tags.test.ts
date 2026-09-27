import type { FormatEntry, Token } from '@cat-tool/core';
import { describe, expect, it } from 'vitest';

import {
  chipsToDrop,
  collapseGroups,
  expandGroups,
  isBalanced,
  nestingRefusal,
  pairGroups,
  paletteOf,
  pastedText,
  tagChoices,
  unplacedTags,
  withoutEmptyPairs,
  type Chip,
  type PairShape,
} from './tags.js';

const fmt = (id: number, kind: FormatEntry['kind'], visible = true): FormatEntry => ({
  id,
  kind,
  visible,
  placement: kind === 'br' || kind === 'footnote' ? 'in-run' : 'run',
  open: '<x>',
  close: kind === 'br' || kind === 'footnote' ? '' : '</x>',
});
const text = (v: string): Token => ({ t: 'text', v });
const open = (id: number): Token => ({ t: 'open', id, fmt: id });
const close = (id: number): Token => ({ t: 'close', id });
const ph = (id: number): Token => ({ t: 'ph', id, fmt: id });

describe('paletteOf', () => {
  it("lists the source's visible tags in source order, hidden ones never", () => {
    const formats = [
      fmt(1, 'other', false),
      fmt(2, 'b'),
      fmt(3, 'footnote'),
      fmt(4, 'i'),
    ];
    const source = [
      open(1),
      text('a '),
      close(1),
      open(2),
      text('b'),
      close(2),
      ph(3),
      open(4),
      close(4),
    ];
    expect(paletteOf(source, formats)).toEqual([
      { role: 'pair', id: 2, fmt: 2, kind: 'b', members: [] },
      { role: 'ph', id: 3, fmt: 3, kind: 'footnote', members: [] },
      { role: 'pair', id: 4, fmt: 4, kind: 'i', members: [] },
    ]);
  });

  it('offers a tag the table cannot explain rather than hiding it', () => {
    expect(paletteOf([ph(7)], [])).toEqual([
      { role: 'ph', id: 7, fmt: 7, kind: null, members: [] },
    ]);
  });
});

describe('pair groups', () => {
  // "Rabu ho mivo?" in bold, as Word split it: three bold runs side by
  // side, a spell-check marker between two, then an italic word apart.
  const formats = [
    fmt(1, 'b'),
    fmt(2, 'b'),
    fmt(3, 'other', false),
    fmt(4, 'b'),
    fmt(5, 'i'),
  ];
  const source = [
    open(1),
    text('Rabu'),
    close(1),
    open(2),
    text(' ho'),
    close(2),
    ph(3),
    open(4),
    text(' mivo?'),
    close(4),
    text(' Y '),
    open(5),
    text('esto'),
    close(5),
  ];

  it('finds look-alike pairs side by side, hidden tags between or not', () => {
    expect([...pairGroups(source, formats)]).toEqual([[1, [1, 2, 4]]]);
  });

  it('never joins pairs with text between them, or that look different', () => {
    const f = [fmt(1, 'b'), fmt(2, 'b'), fmt(3, 'i')];
    const apart = [open(1), text('a'), close(1), text(' '), open(2), text('b'), close(2)];
    expect(pairGroups(apart, f).size).toBe(0);
    const unlike = [open(1), text('a'), close(1), open(3), text('b'), close(3)];
    expect(pairGroups(unlike, f).size).toBe(0);
  });

  it('offers a group as one palette entry', () => {
    expect(paletteOf(source, formats).map((t) => [t.id, t.members])).toEqual([
      [1, [2, 4]],
      [5, []],
    ]);
  });

  it('collapses the source chain into one pair, and what the editor saves too', () => {
    const groups = pairGroups(source, formats);
    const visible = source.filter((t) => !(t.t === 'ph' && t.id === 3));
    expect(collapseGroups(visible, groups)).toEqual({
      tokens: [
        open(1),
        text('Rabu'),
        text(' ho'),
        text(' mivo?'),
        close(1),
        text(' Y '),
        open(5),
        text('esto'),
        close(5),
      ],
      grouped: new Set([1]),
    });
    const members = new Map([...groups].map(([first, ids]) => [first, ids.slice(1)]));
    const saved = expandGroups([open(1), text('Rabu ho mivo?'), close(1)], members);
    expect(saved).toEqual([
      open(1),
      text('Rabu ho mivo?'),
      close(1),
      open(2),
      close(2),
      open(4),
      close(4),
    ]);
    expect(collapseGroups(saved, groups).tokens).toEqual([
      open(1),
      text('Rabu ho mivo?'),
      close(1),
    ]);
  });

  it('saves no member twice that the target places apart', () => {
    // A memory's match placed the pairs apart; the first then moved, carrying its members.
    const members = new Map([[1, [2, 4]]]);
    const saved = expandGroups(
      [open(1), text('a'), close(1), text(' y '), open(2), text('b'), close(2)],
      members,
    );
    expect(saved).toEqual([
      open(1),
      text('a'),
      close(1),
      open(4),
      close(4),
      text(' y '),
      open(2),
      text('b'),
      close(2),
    ]);
  });

  it('leaves a group placed piecemeal as separate pairs', () => {
    const groups = pairGroups(source, formats);
    const scattered = [
      open(2),
      text('a'),
      close(2),
      text(' '),
      open(1),
      text('b'),
      close(1),
    ];
    expect(collapseGroups(scattered, groups).grouped.size).toBe(0);
  });
});

describe('unplacedTags', () => {
  const formats = [fmt(1, 'b'), fmt(2, 'br'), fmt(3, 'i')];
  const palette = paletteOf(
    [open(1), text('x'), close(1), ph(2), open(3), close(3)],
    formats,
  );
  const none = new Map<number, number[]>();

  it('is every palette tag the target lacks, in source order', () => {
    expect(
      unplacedTags(palette, [text('x'), ph(2)], none, formats).map((t) => t.id),
    ).toEqual([1, 3]);
    expect(unplacedTags(palette, [], none, formats)).toEqual(palette);
    expect(
      unplacedTags(palette, [open(3), ph(2), open(1), close(1), close(3)], none, formats),
    ).toEqual([]);
  });

  it('does not take a placeholder for the pair with the same id', () => {
    expect(unplacedTags(palette, [ph(1)], none, formats).map((t) => t.id)).toEqual([
      1, 2, 3,
    ]);
  });
});

describe('tagChoices', () => {
  // "Rabu ho mivo" in bold, as Word split it: one group of three pairs.
  const formats = [fmt(1, 'b'), fmt(2, 'b'), fmt(4, 'b')];
  const source = [
    open(1),
    text('Rabu'),
    close(1),
    open(2),
    text(' ho'),
    close(2),
    open(4),
    text(' mivo'),
    close(4),
  ];
  const palette = paletteOf(source, formats);
  const shown = (choices: ReturnType<typeof tagChoices>) =>
    choices.map((c) => [c.tag.id, c.tag.members, c.placed]);

  it('is the group as one tag, placed whole or not at all', () => {
    expect(shown(tagChoices(palette, [text('x')], new Map(), formats))).toEqual([
      [1, [2, 4], false],
    ]);
    const grouped = [open(1), text('x'), close(1)];
    expect(shown(tagChoices(palette, grouped, new Map([[1, [2, 4]]]), formats))).toEqual([
      [1, [2, 4], true],
    ]);
  });

  it('lists a member its placed first pair does not carry as a tag of its own', () => {
    // Placed apart, then member 4 deleted: nothing else would put it back.
    const apart = [open(1), text('a'), close(1), text(' '), open(2), text('b'), close(2)];
    const choices = tagChoices(palette, apart, new Map(), formats);
    expect(shown(choices)).toEqual([
      [1, [], true],
      [2, [], true],
      [4, [], false],
    ]);
    expect(choices[2]!.tag).toEqual({
      role: 'pair',
      id: 4,
      fmt: 4,
      kind: 'b',
      members: [],
    });
  });

  it('places with an unplaced first pair only the members not placed apart', () => {
    const apart = [text('a '), open(2), text('b'), close(2)];
    expect(shown(tagChoices(palette, apart, new Map(), formats))).toEqual([
      [1, [4], false],
      [2, [], true],
    ]);
  });
});

describe('chipsToDrop', () => {
  const o = (id: number): Chip => ({ role: 'open', id });
  const c = (id: number): Chip => ({ role: 'close', id });
  const p = (id: number): Chip => ({ role: 'ph', id });
  const kept = (chips: Chip[]) => {
    const drop = chipsToDrop(chips);
    return chips.filter((_, i) => !drop.has(i));
  };

  it('leaves a valid sequence alone', () => {
    expect(chipsToDrop([o(1), o(2), c(2), p(3), c(1)]).size).toBe(0);
  });

  it("drops a pair's partner when one chip is gone", () => {
    expect(kept([o(1), p(2)])).toEqual([p(2)]);
    expect(kept([p(2), c(1)])).toEqual([p(2)]);
  });

  it('drops a second chip of the same tag', () => {
    expect(kept([p(2), p(2)])).toEqual([p(2)]);
    expect(kept([o(1), c(1), o(1), c(1)])).toEqual([o(1), c(1)]);
  });

  it('drops a pair whose close comes before its open', () => {
    expect(kept([c(1), p(2), o(1)])).toEqual([p(2)]);
  });

  it('drops a whole pair that would interleave, never half of one', () => {
    const rest = kept([o(1), o(2), c(1), c(2)]);
    expect(rest).toHaveLength(2);
    expect(isBalanced(rest)).toBe(true);
  });
});

describe('isBalanced', () => {
  it('holds when every pair inside is whole', () => {
    expect(isBalanced([])).toBe(true);
    expect(
      isBalanced([
        { role: 'open', id: 1 },
        { role: 'close', id: 1 },
        { role: 'ph', id: 2 },
      ]),
    ).toBe(true);
  });

  it('fails when the selection cuts a pair', () => {
    expect(isBalanced([{ role: 'open', id: 1 }])).toBe(false);
    expect(
      isBalanced([
        { role: 'close', id: 1 },
        { role: 'open', id: 2 },
        { role: 'close', id: 2 },
      ]),
    ).toBe(false);
  });
});

describe('nestingRefusal', () => {
  const bold: PairShape = { placement: 'run', kind: 'b' };
  const italic: PairShape = { placement: 'run', kind: 'i' };
  const link: PairShape = { placement: 'inline', kind: 'link' };

  it('lets pairs nest the way a source nests them', () => {
    expect(nestingRefusal(bold, [], [])).toBeNull();
    expect(nestingRefusal(bold, [link], [])).toBeNull();
    expect(nestingRefusal(link, [], [bold, italic])).toBeNull();
  });

  it('refuses formatting inside or around formatting', () => {
    // Bold around italic would export as italic alone.
    expect(nestingRefusal(bold, [italic], [])).toMatch(/formatting/);
    expect(nestingRefusal(bold, [], [italic])).toMatch(/formatting/);
    expect(nestingRefusal(link, [bold], [])).toMatch(/formatting/);
  });

  it('refuses a link inside or around a link', () => {
    expect(nestingRefusal(link, [link], [])).toMatch(/link/);
    expect(nestingRefusal(link, [], [link])).toMatch(/link/);
  });
});

describe('withoutEmptyPairs', () => {
  it('drops pairs that hold nothing, and empty text', () => {
    expect(
      withoutEmptyPairs([
        open(1),
        close(1),
        text(''),
        text('a'),
        open(2),
        ph(3),
        close(2),
      ]),
    ).toEqual([text('a'), open(2), ph(3), close(2)]);
    expect(withoutEmptyPairs([open(1), open(2), close(2), close(1)])).toEqual([]);
  });
});

describe('pastedText', () => {
  it('makes one line, a space for each run of breaks and tabs', () => {
    expect(pastedText('uno\r\ndos\n\n\ttres\u2028cuatro')).toBe('uno dos tres cuatro');
    expect(pastedText('sin cambios')).toBe('sin cambios');
  });

  it('turns the soft breaks other programs write into spaces, drops other controls', () => {
    expect(pastedText('uno\u000Bdos\u000Ctres\u0007!\u007F')).toBe('uno dos tres!');
  });

  it('drops whatever else XML cannot carry, as core defines it', () => {
    expect(pastedText('a\uFFFEb\uD800c\u{1F600}')).toBe('abc\u{1F600}');
  });
});
