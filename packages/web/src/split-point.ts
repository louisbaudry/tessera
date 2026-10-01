/**
 * Where a split lands (v1-spec.md §7.4; backlog #30a). The break is chosen
 * in the source cell, whose children are the segment's pieces in order —
 * a `<span>` of text or a chip per piece (`toPieces`) — and `core` cuts at
 * a *plain-text* offset, which counts no tag: a chip is no characters.
 * This is the arithmetic from "a caret in child `index`, `within`
 * characters in" to that offset, kept off the DOM so it is tested in node.
 */

/** One child of the source cell, as far as an offset is concerned. */
export type SourceChild =
  { readonly kind: 'text'; readonly length: number } | { readonly kind: 'chip' };

/**
 * The plain-text offset of a caret `within` characters into child
 * `index` — or at `index`'s start when `within` is 0 or the child is a
 * chip. An `index` past the last child is the end of the text.
 */
export function splitOffset(
  children: readonly SourceChild[],
  index: number,
  within: number,
): number {
  let offset = 0;
  const end = Math.min(Math.max(index, 0), children.length);
  for (let i = 0; i < end; i++) {
    const child = children[i]!;
    if (child.kind === 'text') offset += child.length;
  }
  const at = children[index];
  if (at?.kind === 'text') offset += Math.min(Math.max(within, 0), at.length);
  return offset;
}
