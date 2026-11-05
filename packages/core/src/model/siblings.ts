/**
 * Siblings: the plural forms of one string (`planning/software-localisation-spec.md`
 * G2, issue #353).
 *
 * An XLIFF `<group>` is the file's own statement that its units belong together;
 * for keyed software strings it is a plural set, whose English source is often
 * the same sentence for several categories while each target is a different
 * form. Two rules of the CAT tool would treat those as repeats of one another (a
 * pre-translate placement, a consistency warning), so they are told apart here,
 * once, for every caller.
 *
 * Pure, and in `model/` so the db layer and the QA engine share one definition.
 */

/** What a segment must say to be placed in a group: its file, its group and its source. */
export interface SiblingFields {
  readonly id: number;
  readonly fileId: number;
  /** The enclosing XLIFF group's id, or null/absent when the unit has none. */
  readonly unitGroup?: string | null;
  readonly sourceHash: string;
}

/**
 * Whether two segments sit in the same group of the same file. False when either
 * has no group, and for a segment and itself: a group is a set of different units.
 */
export function inSameGroup(
  a: Pick<SiblingFields, 'id' | 'fileId' | 'unitGroup'>,
  b: Pick<SiblingFields, 'id' | 'fileId' | 'unitGroup'>,
): boolean {
  return (
    a.id !== b.id &&
    a.unitGroup != null &&
    a.unitGroup === b.unitGroup &&
    a.fileId === b.fileId
  );
}

/**
 * The ids of segments that have the same source text as another member of their
 * own group: plural forms that the file keeps apart on purpose. A member whose
 * source is its own in the group (an English `one` form beside an `other` form)
 * is not here, and neither is a repeat in a different group or no group.
 */
export function ambiguousSiblingIds(
  segments: readonly SiblingFields[],
): ReadonlySet<number> {
  const seen = new Map<string, number[]>();
  for (const s of segments) {
    if (s.unitGroup == null) continue;
    const key = `${s.fileId}\u0000${s.unitGroup}\u0000${s.sourceHash}`;
    const ids = seen.get(key);
    if (ids) ids.push(s.id);
    else seen.set(key, [s.id]);
  }
  const out = new Set<number>();
  for (const ids of seen.values()) {
    if (ids.length > 1) for (const id of ids) out.add(id);
  }
  return out;
}
