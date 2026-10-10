/**
 * Adding a term from the editor (backlog #129; issue #151): what a text
 * selection becomes in the "Add term" box, and whether the box may be sent.
 * Pure, so each is provable in node; `AddTermDialog.tsx` renders and `Grid.tsx`
 * reads the selection and says what the key does.
 */

/** Longer than this is a sentence, not a term, and is not put in the box. */
export const MAX_TERM_CHARS = 120;

export interface TermDraft {
  readonly source: string;
  readonly target: string;
}

/** Which side of the segment a selection was in. */
export type TermSide = 'source' | 'target';

export const EMPTY_DRAFT: TermDraft = { source: '', target: '' };

/** A selection as a term: whitespace (including a line break) collapsed to one space, trimmed. */
export function cleanSelection(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * The box for a selection. One DOM selection exists at a time, so a person
 * selects one side and types the other: the selected text fills its side and
 * the other starts empty. No selection, or one too long to be a term, opens
 * an empty box, with `note` saying why in the second case.
 */
export function draftFromSelection(
  side: TermSide | null,
  text: string,
): { draft: TermDraft; note: string | null } {
  const term = cleanSelection(text);
  if (side === null || term === '') return { draft: EMPTY_DRAFT, note: null };
  if (term.length > MAX_TERM_CHARS) {
    return {
      draft: EMPTY_DRAFT,
      note: `That selection is longer than a term (over ${MAX_TERM_CHARS} characters).`,
    };
  }
  return {
    draft:
      side === 'source' ? { source: term, target: '' } : { source: '', target: term },
    note: null,
  };
}

/** The draft as it is sent: both sides cleaned the way a selection is. */
export function cleanDraft(draft: TermDraft): TermDraft {
  return { source: cleanSelection(draft.source), target: cleanSelection(draft.target) };
}

/** Why the draft cannot be sent yet, or null when it can. */
export function draftProblem(draft: TermDraft): string | null {
  const { source, target } = cleanDraft(draft);
  if (source === '') return 'Type or select the source term.';
  if (target === '') return 'Type the rendering.';
  if (source.length > MAX_TERM_CHARS || target.length > MAX_TERM_CHARS) {
    return `A term is at most ${MAX_TERM_CHARS} characters.`;
  }
  return null;
}

/** Whether a key event is the "add a term" key: Ctrl+Shift+D, literal Ctrl on every platform. */
export function isAddTermKey(e: {
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly code: string;
}): boolean {
  return e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyD';
}
