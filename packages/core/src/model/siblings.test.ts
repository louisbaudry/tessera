import { describe, expect, it } from 'vitest';

import { ambiguousSiblingIds, inSameGroup, type SiblingFields } from './siblings.js';

const seg = (
  id: number,
  hash: string,
  unitGroup: string | null,
  fileId = 1,
): SiblingFields => ({ id, fileId, unitGroup, sourceHash: hash });

describe('inSameGroup', () => {
  it('is true for different units of one group in one file', () => {
    expect(inSameGroup(seg(1, 'h', 'g'), seg(2, 'h', 'g'))).toBe(true);
  });

  it('is false for a segment and itself, another group, no group, or another file', () => {
    expect(inSameGroup(seg(1, 'h', 'g'), seg(1, 'h', 'g'))).toBe(false);
    expect(inSameGroup(seg(1, 'h', 'g'), seg(2, 'h', 'other'))).toBe(false);
    expect(inSameGroup(seg(1, 'h', null), seg(2, 'h', null))).toBe(false);
    expect(inSameGroup({ id: 1, fileId: 1 }, { id: 2, fileId: 1 })).toBe(false);
    expect(inSameGroup(seg(1, 'h', 'g', 1), seg(2, 'h', 'g', 2))).toBe(false);
  });
});

describe('ambiguousSiblingIds', () => {
  it('holds the members of a group that share a source with another member', () => {
    const ids = ambiguousSiblingIds([
      seg(1, 'one', 'count'),
      seg(2, 'many', 'count'),
      seg(3, 'many', 'count'),
      seg(4, 'many', 'count'),
    ]);
    expect([...ids].sort()).toEqual([2, 3, 4]);
  });

  it('leaves out a member whose source is its own in the group', () => {
    expect(ambiguousSiblingIds([seg(1, 'a', 'g'), seg(2, 'b', 'g')]).size).toBe(0);
  });

  it('does not treat a repeat outside a group, or across groups or files, as siblings', () => {
    expect(
      ambiguousSiblingIds([
        seg(1, 'h', null),
        seg(2, 'h', null),
        seg(3, 'h', 'a'),
        seg(4, 'h', 'b'),
        seg(5, 'h', 'a', 2),
      ]).size,
    ).toBe(0);
  });
});
