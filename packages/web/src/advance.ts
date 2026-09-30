/**
 * Where confirm-and-advance goes (v1-spec.md §7.3; backlog #30): the next
 * segment after this one that is still the translator's to do — anything
 * but confirmed or locked. Forward only, and it does not wrap: at the end
 * of the file the editor simply closes, since a translator who has read
 * to the bottom is choosing where to go next. Pure, so it is tested in node.
 */
import type { Segment } from '@cat-tool/core';

import { statusOf } from './gutter.js';

export function nextUnconfirmed(
  segments: readonly Pick<Segment, 'status' | 'locked'>[],
  from: number,
): number | null {
  for (let i = from + 1; i < segments.length; i++) {
    const status = statusOf(segments[i]!);
    if (status !== 'confirmed' && status !== 'locked') return i;
  }
  return null;
}
