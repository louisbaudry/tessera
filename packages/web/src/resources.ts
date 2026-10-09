/**
 * What the editor's Resources panel says about the memories and glossaries a
 * project consults (backlog #114; issue #181): their order, the one that is
 * written to, and the ones switched off. Pure, so it is proved in node. The
 * server's lists are the truth; nothing here decides what is attached.
 */
import type { GlossaryRefView, TmRefView } from './api.js';

/** One attached memory or glossary, ready to show. */
export interface ResourceRow {
  readonly id: number;
  /** The slug the account knows it by, or a plain note for one attached from outside. */
  readonly name: string;
  /** Short facts about it, in the order they matter: `writes here`, `off`. */
  readonly badges: readonly string[];
  /** Whether it is consulted at all: a switched-off one is shown, dimmed. */
  readonly enabled: boolean;
}

/** What a reference attached from outside the account (the CLI) is called: never its path. */
export const OUTSIDE_NAME = 'Attached from outside this account';

interface Ref {
  readonly id: number;
  readonly priority: number;
  readonly writeTarget: boolean;
  readonly enabled: boolean;
}

function rows<T extends Ref>(
  refs: readonly T[],
  nameOf: (ref: T) => string | null,
): ResourceRow[] {
  return [...refs]
    .sort((a, b) => a.priority - b.priority || a.id - b.id)
    .map((ref) => ({
      id: ref.id,
      name: nameOf(ref) ?? OUTSIDE_NAME,
      badges: [
        ...(ref.writeTarget ? ['writes here'] : []),
        ...(ref.enabled ? [] : ['off']),
      ],
      enabled: ref.enabled,
    }));
}

/** The project's memories in the order they are consulted (priority, then id). */
export const memoryRows = (refs: readonly TmRefView[]): ResourceRow[] =>
  rows(refs, (ref) => ref.tm);

/** The project's glossaries in the order they are consulted. */
export const glossaryRows = (refs: readonly GlossaryRefView[]): ResourceRow[] =>
  rows(refs, (ref) => ref.glossary);

/** The panel's one-line summary, e.g. `2 memories, 1 glossary`. */
export function resourceSummary(memories: number, glossaries: number): string {
  const part = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return `${part(memories, 'memory', 'memories')}, ${part(glossaries, 'glossary', 'glossaries')}`;
}
