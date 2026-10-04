/**
 * The glossary panel (smart-glossary-spec.md §5a.2; backlog #43b): a fixed
 * strip beside the grid with two tabs. **Terms** is the session over the
 * file — repeated terms, decided once; nothing is written until Confirm.
 * **Mismatches** lists the segments whose target lacks the glossary's
 * preferred rendering or uses a forbidden one, and never turns a segment
 * or the QA panel red (§6). What each says and when Confirm is allowed is
 * `glossary-panel.ts`'s; this is rendering and the calls.
 */
import type { Segment } from '@cat-tool/core';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { GlossaryProposals } from './GlossaryProposals.js';
import { api, ApiError, type GlossaryRefView } from './api.js';
import {
  cardActions,
  confirmState,
  footerText,
  glossaryNameInput,
  idsByOrd,
  latestVersion,
  MISMATCH_LABEL,
  canRecordException,
  mismatchText,
  occurrenceText,
  stateText,
  type FlagView,
  type MismatchList,
  type SessionView,
} from './glossary-panel.js';
import { useSession } from './session-context.js';
import { useAction } from './use-action.js';
import { useLoad } from './use-load.js';

type Tab = 'terms' | 'mismatches';

/** How long after the last edit the mismatch list is asked for again. */
const REFRESH_MS = 500;

export function GlossaryPanel({
  project,
  fileId,
  segments,
  positions,
  onJump,
}: {
  project: string;
  fileId: number;
  segments: readonly Segment[];
  /** Segment id → index in the file. */
  positions: ReadonlyMap<number, number>;
  onJump: (segmentId: number) => void;
}) {
  const [tab, setTab] = useState<Tab>('terms');
  const loaded = useLoad(
    useCallback(
      (token, signal) =>
        Promise.all([
          api.projectGlossaries(token, project, signal),
          api.glossaries(token, signal),
          api.glossarySession(token, project, fileId, signal),
        ]),
      [project, fileId],
    ),
  );
  // What the last change answered, over what was loaded.
  const [refsNow, setRefsNow] = useState<readonly GlossaryRefView[] | null>(null);
  const [sessionNow, setSessionNow] = useState<SessionView | null | undefined>(undefined);
  // Bumped when a commit writes to the glossary, so the mismatch list asks again.
  const [written, setWritten] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  const ids = useMemo(() => idsByOrd(segments), [segments]);
  const jumpToOrd = (ord: number) => {
    const id = ids.get(ord);
    if (id !== undefined) onJump(id);
  };

  let body;
  if (loaded.state === 'loading') {
    body = <p className="muted gp-pad">Loading glossary{'…'}</p>;
  } else if (loaded.state === 'error') {
    body = <p className="error gp-pad">{loaded.message}</p>;
  } else {
    const [{ refs: initialRefs }, glossaries, initialSession] = loaded.data;
    const refs = refsNow ?? initialRefs;
    const session = sessionNow === undefined ? initialSession : sessionNow;
    const writeTarget = refs.find((r) => r.writeTarget && r.enabled)?.glossary ?? null;
    body = (
      <>
        {writeTarget === null && (
          <GlossarySetup
            project={project}
            existing={glossaries.map((g) => g.slug)}
            onAttached={(next) => setRefsNow(next)}
          />
        )}
        {tab === 'terms' && writeTarget !== null && (
          <GlossaryProposals
            project={project}
            revision={written}
            onAccepted={() => setWritten((n) => n + 1)}
          />
        )}
        {tab === 'terms' ? (
          <Terms
            project={project}
            fileId={fileId}
            session={session}
            writeTarget={writeTarget}
            note={note}
            onSession={setSessionNow}
            onJumpOrd={jumpToOrd}
            onCommitted={(count) => {
              setWritten((n) => n + 1);
              setNote(
                `Wrote ${count} ${count === 1 ? 'decision' : 'decisions'} to “${writeTarget}”.`,
              );
            }}
            onClearNote={() => setNote(null)}
          />
        ) : (
          <Mismatches
            project={project}
            fileId={fileId}
            segments={segments}
            positions={positions}
            glossaryRevision={written}
            onJump={onJump}
            onRecorded={() => setWritten((n) => n + 1)}
          />
        )}
      </>
    );
  }

  return (
    <aside className="glossary-panel" aria-label="Glossary">
      <div className="gp-tabs" role="tablist">
        {(['terms', 'mismatches'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
          >
            {t === 'terms' ? 'Terms' : 'Mismatches'}
          </button>
        ))}
      </div>
      {body}
    </aside>
  );
}

/**
 * A project needs a glossary to write into before there is anything to
 * confirm. One field: a name that exists is attached, one that does not is
 * made first, and either becomes the write target.
 */
function GlossarySetup({
  project,
  existing,
  onAttached,
}: {
  project: string;
  existing: readonly string[];
  onAttached: (refs: readonly GlossaryRefView[]) => void;
}) {
  const [name, setName] = useState('');
  const action = useAction();
  const slug = glossaryNameInput(name);
  const exists = existing.includes(slug);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const answer = await action.run(async (token) => {
      if (!exists) await api.createGlossary(token, slug);
      return api.attachGlossary(token, project, slug, true);
    });
    if (answer) onAttached(answer.refs);
  };

  return (
    <form className="gp-setup" onSubmit={(e) => void submit(e)}>
      <p className="muted">
        This project has no glossary to write into. Choose one, or name a new one.
      </p>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        list="gp-glossaries"
        aria-label="Glossary name"
        pattern="[a-z0-9](?:[a-z0-9\-]{0,62}[a-z0-9])?"
        title="lowercase letters, digits and hyphens"
        required
      />
      <datalist id="gp-glossaries">
        {existing.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
      <button type="submit" disabled={action.busy || slug === ''}>
        {exists ? 'Use this glossary' : 'Create and use'}
      </button>
      {action.error && (
        <p className="error" role="alert">
          {action.error}
        </p>
      )}
    </form>
  );
}

function Terms({
  project,
  fileId,
  session,
  writeTarget,
  note,
  onSession,
  onJumpOrd,
  onCommitted,
  onClearNote,
}: {
  project: string;
  fileId: number;
  session: SessionView | null;
  writeTarget: string | null;
  note: string | null;
  onSession: (session: SessionView | null) => void;
  onJumpOrd: (ord: number) => void;
  onCommitted: (written: number) => void;
  onClearNote: () => void;
}) {
  const action = useAction();

  const start = async () => {
    onClearNote();
    const answer = await action.run((t) => api.startGlossarySession(t, project, fileId));
    if (answer) onSession(answer.session);
  };
  const decide = async (
    verb: 'choose' | 'propose' | 'skip' | 'reopen',
    body: Record<string, string>,
  ) => {
    const answer = await action.run((t) =>
      api.glossaryDecide(t, project, fileId, verb, body),
    );
    if (answer) onSession(answer.session);
  };
  const commit = async () => {
    const answer = await action.run((t) => api.commitGlossarySession(t, project, fileId));
    if (!answer) return;
    onSession(null);
    onCommitted(answer.written);
  };
  const discard = async () => {
    const answer = await action.run((t) =>
      api.discardGlossarySession(t, project, fileId),
    );
    if (answer) onSession(null);
  };

  const error = action.error && (
    <p className="error gp-pad" role="alert">
      {action.error}
    </p>
  );

  if (session === null) {
    return (
      <div className="gp-body">
        <div className="gp-pad">
          {note && (
            <p role="status" className="muted">
              {note}
            </p>
          )}
          <p className="muted">
            Find the terms this file repeats, and decide each one once.
          </p>
          <button type="button" disabled={action.busy} onClick={() => void start()}>
            {action.busy ? 'Looking…' : 'Find repeated terms'}
          </button>
        </div>
        {error}
      </div>
    );
  }

  const confirm = confirmState(session.counts, writeTarget);
  return (
    <div className="gp-body">
      {session.flags.length === 0 ? (
        <p className="muted gp-pad">No term repeats enough to ask about.</p>
      ) : (
        <ul className="gp-cards">
          {session.flags.map((flag) => (
            <TermCard
              key={flag.key}
              flag={flag}
              busy={action.busy}
              onJump={() => flag.ords[0] !== undefined && onJumpOrd(flag.ords[0])}
              onDecide={(verb, body) => void decide(verb, { key: flag.key, ...body })}
            />
          ))}
        </ul>
      )}
      {error}
      <footer className="gp-footer">
        <span>{footerText(session.counts)}</span>
        {confirm.reason && <span className="muted">{confirm.reason}</span>}
        <span className="gp-footer-buttons">
          <button
            type="button"
            disabled={!confirm.enabled || action.busy}
            onClick={() => void commit()}
          >
            Confirm
          </button>
          <button
            type="button"
            className="link"
            disabled={action.busy}
            onClick={() => void discard()}
          >
            Discard
          </button>
        </span>
      </footer>
    </div>
  );
}

function TermCard({
  flag,
  busy,
  onJump,
  onDecide,
}: {
  flag: FlagView;
  busy: boolean;
  onJump: () => void;
  onDecide: (
    verb: 'choose' | 'propose' | 'skip' | 'reopen',
    body: Record<string, string>,
  ) => void;
}) {
  const [text, setText] = useState('');
  const typed = text.trim();
  const { canEdit, deprecatable } = cardActions(flag);
  const decided = stateText(flag.state);

  return (
    <li className={`gp-card gp-${flag.state.state}`}>
      <div className="gp-card-head">
        <strong>{flag.term}</strong>
        <button
          type="button"
          className="link"
          onClick={onJump}
          title="Go to the first segment"
        >
          {occurrenceText(flag)}
        </button>
      </div>
      {decided !== null ? (
        <div className="gp-decided">
          <span>{decided}</span>
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={() => onDecide('reopen', {})}
          >
            Reopen
          </button>
        </div>
      ) : (
        <>
          {flag.offered.length === 0 ? (
            <p className="muted gp-hint">
              Repeated, undecided. Type a rendering to settle it.
            </p>
          ) : (
            <ul className="gp-offered">
              {flag.offered.map((rendering) => (
                <li key={rendering}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onDecide('choose', { rendering })}
                  >
                    {rendering}
                  </button>
                  {deprecatable.includes(rendering) && (
                    <button
                      type="button"
                      className="link"
                      disabled={busy}
                      title={`Deprecate “${rendering}”: never use it`}
                      aria-label={`Deprecate ${rendering}`}
                      onClick={() =>
                        onDecide('propose', { edit: 'deprecate', rendering })
                      }
                    >
                      {'×'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <form
            className="gp-free"
            onSubmit={(e) => {
              e.preventDefault();
              if (typed !== '') onDecide('choose', { rendering: typed });
            }}
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label={`Your rendering of ${flag.term}`}
              placeholder="Your own rendering"
            />
            <button type="submit" disabled={busy || typed === ''}>
              Use
            </button>
            {canEdit && (
              <button
                type="button"
                disabled={busy || typed === ''}
                title="Change the entry's preferred rendering to this one"
                onClick={() =>
                  onDecide('propose', { edit: 'override', rendering: typed })
                }
              >
                Override
              </button>
            )}
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() => onDecide('skip', {})}
            >
              Skip
            </button>
          </form>
        </>
      )}
    </li>
  );
}

function Mismatches({
  project,
  fileId,
  segments,
  positions,
  glossaryRevision,
  onJump,
  onRecorded,
}: {
  project: string;
  fileId: number;
  segments: readonly Segment[];
  positions: ReadonlyMap<number, number>;
  glossaryRevision: number;
  onJump: (segmentId: number) => void;
  /** An exception was recorded: the proposals may have changed. */
  onRecorded: () => void;
}) {
  const { token, signOut } = useSession();
  const action = useAction();
  // Rows recorded in this panel's lifetime: the mismatch stays (it is still a mismatch),
  // so the row says it has been noted rather than offering the button again.
  const [recorded, setRecorded] = useState<ReadonlySet<string>>(new Set());
  const version = useMemo(() => latestVersion(segments), [segments]);
  const [list, setList] = useState<MismatchList | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Stored targets are what is compared, so the list is asked for again a
  // moment after the editor's last write (every write moves `version`).
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.glossaryMismatches(token, project, fileId, controller.signal).then(
        (next) => {
          if (controller.signal.aborted) return;
          setList(next);
          setError(null);
        },
        (err: unknown) => {
          if (controller.signal.aborted) return;
          if (err instanceof ApiError && err.status === 401) return signOut();
          setError(err instanceof Error ? err.message : String(err));
        },
      );
    }, REFRESH_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [token, signOut, project, fileId, version, glossaryRevision]);

  if (error) return <p className="error gp-pad">{error}</p>;
  if (list === null) return <p className="muted gp-pad">Looking{'…'}</p>;
  if (list.glossary === null) {
    return (
      <p className="muted gp-pad">There is no glossary to compare this file against.</p>
    );
  }
  if (list.mismatches.length === 0) {
    return (
      <p className="muted gp-pad">
        No translated segment departs from {'“'}
        {list.glossary}
        {'”'}.
      </p>
    );
  }
  return (
    <>
      {action.error && <p className="error gp-pad">{action.error}</p>}
      <ul className="gp-mismatches">
        {list.mismatches.map((m) => (
          <li key={`${m.segmentId}:${m.termId}`}>
            <button
              type="button"
              className="gp-jump"
              onClick={() => onJump(m.segmentId)}
              title="Go to the segment"
            >
              <span className="ord">{(positions.get(m.segmentId) ?? m.ord) + 1}</span>
              <span className="gp-kind">{MISMATCH_LABEL[m.kind]}</span>
              <span>
                <strong>{m.term}</strong> {mismatchText(m)}
              </span>
            </button>
            {canRecordException(m) &&
              (recorded.has(`${m.segmentId}:${m.termId}`) ? (
                <span className="muted gp-recorded">Recorded as an exception</span>
              ) : (
                <button
                  type="button"
                  className="link gp-record"
                  disabled={action.busy}
                  title="Note that this alternative is acceptable here. It does not change the entry."
                  onClick={async () => {
                    const done = await action.run((t) =>
                      api.recordException(t, project, fileId, m.segmentId, m.termId),
                    );
                    if (done) {
                      setRecorded((r) => new Set(r).add(`${m.segmentId}:${m.termId}`));
                      onRecorded();
                    }
                  }}
                >
                  Record as exception
                </button>
              ))}
          </li>
        ))}
      </ul>
    </>
  );
}
