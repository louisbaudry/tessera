/**
 * The consultation order of a project's memories, as the management
 * screen moves them (v1-spec.md §7.5). The server takes a whole order,
 * never a priority number, so a move is a new list of ref ids.
 */

/** `ids` with `id` moved `delta` places, or null when it cannot move that way. */
export function moved(
  ids: readonly number[],
  id: number,
  delta: -1 | 1,
): number[] | null {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  const order = [...ids];
  order[from] = order[to]!;
  order[to] = id;
  return order;
}
