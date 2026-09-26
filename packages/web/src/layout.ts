/**
 * A row's height before it is measured (v1-spec.md §7.1). The grid
 * measures every row it renders; this only has to be close enough that
 * the scrollbar does not jump much when an estimate is corrected. Rows
 * are as tall as their longer side.
 */
import type { Token } from '@cat-tool/core';

export const LINE_HEIGHT = 22;
export const ROW_PADDING = 16;
/** Characters per line at the grid's usual column width. */
export const CHARS_PER_LINE = 64;

function length(tokens: readonly Token[] | null): number {
  if (!tokens) return 0;
  let n = 0;
  for (const token of tokens) n += token.t === 'text' ? token.v.length : 3;
  return n;
}

export function estimateRowHeight(
  source: readonly Token[],
  target: readonly Token[] | null,
): number {
  const chars = Math.max(length(source), length(target));
  const lines = Math.max(1, Math.ceil(chars / CHARS_PER_LINE));
  return ROW_PADDING + lines * LINE_HEIGHT;
}
