/**
 * The concordance box (`v1-spec.md` §6.1b; issue #170): a word or phrase, the
 * language to look it up in, and every source/target pair in the project's
 * memories that holds it, the match marked. Opened by `Ctrl+Shift+L` on a
 * selection, or from the palette empty. Read-only: nothing is written, and
 * putting a hit into a target is a later slice. What the box starts with and
 * how a hit is cut is `concordance.ts`'s.
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

import { api } from './api.js';
import {
  pieces,
  summary,
  type ConcordanceHitView,
  type ConcordanceStart,
} from './concordance.js';
import { useLoad } from './use-load.js';

/** A question put to the server; a new object each time, so asking again reloads. */
interface Asked {
  readonly text: string;
  readonly side: ConcordanceSide;
}

function Marked({ text, hit }: { text: string; hit: ConcordanceHitView['ranges'] }) {
  return (
    <>
      {pieces(text, hit).map((piece, i) =>
        piece.hit ? <mark key={i}>{piece.text}</mark> : <span key={i}>{piece.text}</span>,
      )}
    </>
  );
}

function Results({
  project,
  asked,
  srcLang,
  tgtLang,
}: {
  project: string;
  asked: Asked;
  srcLang: string;
  tgtLang: string;
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
          <li key={`${hit.memory}:${hit.tuId}`}>
            <div lang={srcLang}>
              {asked.side === 'source' ? (
                <Marked text={hit.source} hit={hit.ranges} />
              ) : (
                hit.source
              )}
            </div>
            <div lang={tgtLang}>
              {asked.side === 'target' ? (
                <Marked text={hit.target} hit={hit.ranges} />
              ) : (
                hit.target
              )}
            </div>
            {result.searched > 1 && <small className="muted">Memory {hit.memory}</small>}
          </li>
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
  const [text, setText] = useState(initial.text);
  const [side, setSide] = useState<ConcordanceSide>(initial.side);
  // A selection that opened the box is looked up at once.
  const [asked, setAsked] = useState<Asked | null>(
    initial.text === '' ? null : { text: initial.text, side: initial.side },
  );
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

  const ask = (query: string, onSide: ConcordanceSide) =>
    setAsked(query.trim() === '' ? null : { text: query, side: onSide });
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
        {asked && (
          <Results project={project} asked={asked} srcLang={srcLang} tgtLang={tgtLang} />
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
