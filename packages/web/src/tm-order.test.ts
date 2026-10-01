import { describe, expect, it } from 'vitest';

import { moved } from './tm-order.js';

describe('moved', () => {
  it('swaps a memory with its neighbour', () => {
    expect(moved([1, 2, 3], 3, -1)).toEqual([1, 3, 2]);
    expect(moved([1, 2, 3], 1, 1)).toEqual([2, 1, 3]);
  });

  it('cannot move the first up, the last down, or one not in the list', () => {
    expect(moved([1, 2, 3], 1, -1)).toBeNull();
    expect(moved([1, 2, 3], 3, 1)).toBeNull();
    expect(moved([1, 2, 3], 9, 1)).toBeNull();
  });

  it('leaves the list it was given alone', () => {
    const ids = [1, 2];
    moved(ids, 1, 1);
    expect(ids).toEqual([1, 2]);
  });
});
