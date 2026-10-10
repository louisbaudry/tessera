/**
 * The "Add term" box (backlog #129; issue #151): a source form and its
 * rendering, written into the project's glossary as the translator's own
 * decision. Opened by `Ctrl+Shift+D` on a selection, or from the palette
 * empty. What goes in it, and whether it may be sent, is `add-term.ts`'s.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { cleanDraft, draftProblem, type TermDraft } from './add-term.js';
import { api } from './api.js';
import { useAction } from './use-action.js';

export function AddTermDialog({
  project,
  srcLang,
  tgtLang,
  initial,
  note,
  onClose,
}: {
  project: string;
  srcLang: string;
  tgtLang: string;
  initial: TermDraft;
  /** Why the box is empty when a selection was too long. */
  note: string | null;
  onClose: (added: boolean) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [added, setAdded] = useState<{ source: string; created: boolean } | null>(null);
  const action = useAction();
  const sourceRef = useRef<HTMLInputElement>(null);
  const targetRef = useRef<HTMLInputElement>(null);
  const problem = draftProblem(draft);

  // Focus goes to the side still to be filled, and back to where it was on close.
  useEffect(() => {
    const before = document.activeElement;
    (initial.source === '' ? sourceRef : targetRef).current?.focus();
    return () => {
      if (before instanceof HTMLElement) before.focus();
    };
  }, [initial.source]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem !== null) return;
    const clean = cleanDraft(draft);
    const result = await action.run((t) => api.addTerm(t, project, clean));
    if (result) setAdded({ source: clean.source, created: result.created });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose(added !== null);
    }
  };

  return (
    <div className="palette-backdrop" onMouseDown={() => onClose(added !== null)}>
      <form
        className="add-term"
        role="dialog"
        aria-modal="true"
        aria-label="Add term"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        onSubmit={(e) => void submit(e)}
      >
        <h3>Add term</h3>
        {added ? (
          <>
            <p role="status">
              {added.created ? 'Added' : 'Added a rendering to'} “{added.source}”.
            </p>
            <div className="add-term-actions">
              <button type="button" onClick={() => onClose(true)} autoFocus>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            {note && <p className="muted">{note}</p>}
            <label>
              Source ({srcLang})
              <input
                ref={sourceRef}
                type="text"
                lang={srcLang}
                value={draft.source}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setDraft({ ...draft, source: e.target.value })}
              />
            </label>
            <label>
              Rendering ({tgtLang})
              <input
                ref={targetRef}
                type="text"
                lang={tgtLang}
                value={draft.target}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setDraft({ ...draft, target: e.target.value })}
              />
            </label>
            {action.error && (
              <p className="error" role="alert">
                {action.error}
              </p>
            )}
            <div className="add-term-actions">
              <button type="button" className="secondary" onClick={() => onClose(false)}>
                Cancel
              </button>
              <button
                type="submit"
                disabled={problem !== null || action.busy}
                title={problem ?? undefined}
              >
                Add
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
