/**
 * The concordance box (`v1-spec.md` §6.1b, §6.1c; issues #170, #151): a word or
 * phrase, the language to look it up in, and every source/target pair in the
 * project's memories that holds it, the match marked. Opened by `Ctrl+Shift+L` on
 * a selection, or from the palette empty. Each hit's translation can be corrected
 * and its unit retired, which is what a bad match calls for where it was found.
 * What the box starts with, how a hit is cut and what a refusal says is
 * `concordance.ts`'s.
 */
import type { ConcordanceSide } from '@cat-tool/core';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';

import { api, ApiError } from './api.js';
import {
  doneNote,
  editProblem,
  pieces,
  refusal,
  summary,
  type ConcordanceHitView,
  type ConcordanceStart,
} from './concordance.js';
import { useSession } from './session-context.js';
import { useLoad } from './use-load.js';

/** A question put to the server; a new object each time, so asking again reloads. */
interface Asked {
  readonly text: string;
  readonly side: ConcordanceSide;
}

/** What is being done to one hit: its translation edited, or its unit about to be retired. */
type Acting =
  | { readonly key: string; readonly kind: 'edit'; readonly draft: string }
  | { readonly key: string; readonly kind: 'retire' };

const hitKey = (hit: ConcordanceHitView) => `${hit.ref}:${hit.tuId}`;

function Marked({ text, hit }: { text: string; hit: ConcordanceHitView['ranges'] }) {
  return (
    <>
      {pieces(text, hit).map((piece, i) =>
        piece.hit ? <mark key={i}>{piece.text}</mark> : <span key={i}>{piece.text}</span>,
      )}
    </>
  );
}

function Hit({
  hit,
  side,
  srcLang,
  tgtLang,
  showMemory,
  acting,
  busy,
  onAct,
  onSave,
  onRetire,
}: {
  hit: ConcordanceHitView;
  side: ConcordanceSide;
  srcLang: string;
  tgtLang: string;
  showMemory: boolean;
  acting: Acting | null;
  busy: boolean;
  onAct: (next: Acting | null) => void;
  onSave: (hit: ConcordanceHitView, text: string) => void;
  onRetire: (hit: ConcordanceHitView) => void;
}) {
  const key = hitKey(hit);
  const mine = acting?.key === key ? acting : null;
  const problem = mine?.kind === 'edit' ? editProblem(mine.draft, hit.target) : null;
  return (
    <li>
      <div lang={srcLang}>
        {side === 'source' ? <Marked text={hit.source} hit={hit.ranges} /> : hit.source}
      </div>
      {mine?.kind === 'edit' ? (
        <div className="concordance-edit">
          <textarea
            lang={tgtLang}
            aria-label="Translation"
            rows={3}
            value={mine.draft}
            autoFocus
            spellCheck={false}
            onChange={(e) => onAct({ key, kind: 'edit', draft: e.target.value })}
          />
          <div className="concordance-actions">
            <button
              type="button"
              disabled={problem !== null || busy}
              title={problem ?? undefined}
              onClick={() => onSave(hit, mine.draft)}
            >
              Save
            </button>
            <button type="button" className="secondary" onClick={() => onAct(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div lang={tgtLang}>
          {side === 'target' ? <Marked text={hit.target} hit={hit.ranges} /> : hit.target}
        </div>
      )}
      {mine?.kind === 'retire' && (
        <div className="concordance-actions" role="group" aria-label="Retire this unit">
          <span>
            Retire this unit? It stops matching in every project that uses this memory.
          </span>
          <button type="button" disabled={busy} onClick={() => onRetire(hit)}>
            Retire
          </button>
          <button type="button" className="secondary" onClick={() => onAct(null)}>
            Cancel
          </button>
        </div>
      )}
      {mine === null && (
        <div className="concordance-actions">
          <button
            type="button"
            className="secondary"
            disabled={!hit.editable || busy}
            title={
              hit.editable
                ? undefined
                : 'This translation holds tags, which a text edit would lose. Retire the unit instead.'
            }
            onClick={() => onAct({ key, kind: 'edit', draft: hit.target })}
          >
            Edit translation
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => onAct({ key, kind: 'retire' })}
          >
            Retire…
          </button>
          {showMemory && <small className="muted">Memory {hit.memory}</small>}
        </div>
      )}
    </li>
  );
}

function Results({
  project,
  asked,
  srcLang,
  tgtLang,
  acting,
  busy,
  onAct,
  onSave,
  onRetire,
}: {
  project: string;
  asked: Asked;
  srcLang: string;
  tgtLang: string;
  acting: Acting | null;
  busy: boolean;
  onAct: (next: Acting | null) => void;
  onSave: (hit: ConcordanceHitView, text: string) => void;
  onRetire: (hit: ConcordanceHitView) => void;
}) {
  const load = useCallback(
    (token: string, signal: AbortSignal) =>
      api.concordance(token, project, asked, signal),
    [project, asked],
  );
  const loaded = useLoad(load);
  if (loaded.state === 'loading') {
    return <p className="muted concordance-results">Searching…</p>;
  }
  if (loaded.state === 'error') {
    return (
      <p className="error concordance-results" role="alert">
        {loaded.message}
      </p>
    );
  }
  const result = loaded.data;
  return (
    <div className="concordance-results">
      <p className="muted" role="status">
        {summary(result)}
      </p>
      <ul className="concordance-hits">
        {result.hits.map((hit) => (
          <Hit
            key={hitKey(hit)}
            hit={hit}
            side={asked.side}
            srcLang={srcLang}
            tgtLang={tgtLang}
            showMemory={result.searched > 1}
            acting={acting}
            busy={busy}
            onAct={onAct}
            onSave={onSave}
            onRetire={onRetire}
          />
        ))}
      </ul>
    </div>
  );
}

export function ConcordanceDialog({
  project,
  srcLang,
  tgtLang,
  initial,
  onClose,
}: {
  project: string;
  srcLang: string;
  tgtLang: string;
  initial: ConcordanceStart;
  onClose: () => void;
}) {
  const { token, signOut } = useSession();
  const [text, setText] = useState(initial.text);
  const [side, setSide] = useState<ConcordanceSide>(initial.side);
  // A selection that opened the box is looked up at once.
  const [asked, setAsked] = useState<Asked | null>(
    initial.text === '' ? null : { text: initial.text, side: initial.side },
  );
  const [acting, setActing] = useState<Acting | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus goes to the box, and back to where it was on close.
  useEffect(() => {
    const before = document.activeElement;
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      if (before instanceof HTMLElement) before.focus();
    };
  }, []);

  const ask = (query: string, onSide: ConcordanceSide) => {
    setActing(null);
    setNote(null);
    setFailure(null);
    setAsked(query.trim() === '' ? null : { text: query, side: onSide });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    ask(text, side);
  };
  const pick = (next: ConcordanceSide) => {
    setSide(next);
    ask(text, next);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  /** Sends one write, then looks again so the list is what the memory now holds. */
  const write = async (
    kind: 'edit' | 'retire',
    send: () => Promise<{ changed: boolean }>,
  ) => {
    setBusy(true);
    setNote(null);
    setFailure(null);
    try {
      const done = await send();
      setActing(null);
      setNote(doneNote(kind, done.changed));
      setAsked((now) => (now === null ? null : { ...now }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) signOut();
      else if (err instanceof ApiError) setFailure(refusal(err.status, err.message));
      else setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const save = (hit: ConcordanceHitView, draft: string) =>
    void write('edit', () =>
      api.editMemoryUnit(token, project, {
        ref: hit.ref,
        tuvId: hit.tuvId,
        rev: hit.rev,
        text: draft,
      }),
    );
  const retire = (hit: ConcordanceHitView) =>
    void write('retire', () =>
      api.retireMemoryUnit(token, project, {
        ref: hit.ref,
        tuvId: hit.tuvId,
        rev: hit.rev,
      }),
    );

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <form
        className="concordance"
        role="dialog"
        aria-modal="true"
        aria-label="Concordance"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        onSubmit={submit}
      >
        <h3>Concordance</h3>
        <div className="concordance-ask">
          <input
            ref={inputRef}
            type="text"
            aria-label="Word or phrase"
            lang={side === 'source' ? srcLang : tgtLang}
            value={text}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" disabled={text.trim() === ''}>
            Search
          </button>
        </div>
        <div className="concordance-sides" role="group" aria-label="Language searched">
          {(['source', 'target'] as const).map((s) => (
            <label key={s}>
              <input
                type="radio"
                name="concordance-side"
                checked={side === s}
                onChange={() => pick(s)}
              />
              {s === 'source' ? `Source (${srcLang})` : `Target (${tgtLang})`}
            </label>
          ))}
        </div>
        {note && (
          <p className="muted" role="status">
            {note}
          </p>
        )}
        {failure && (
          <p className="error" role="alert">
            {failure}
          </p>
        )}
        {asked && (
          <Results
            project={project}
            asked={asked}
            srcLang={srcLang}
            tgtLang={tgtLang}
            acting={acting}
            busy={busy}
            onAct={setActing}
            onSave={save}
            onRetire={retire}
          />
        )}
        <div className="add-term-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </form>
    </div>
  );
}
