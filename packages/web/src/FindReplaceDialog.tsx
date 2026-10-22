/**
 * Find and replace across the project (`v1-spec.md` §7.8; backlog #148b, issue #170):
 * what to find and what to put there, a preview of every segment it would change with
 * the text before and after, and the segments ticked to make it. The search and the
 * replace are jobs on the server, run on a thread under a time limit, so this starts
 * them, follows them and can cancel them. Nothing is written until Replace, and what is
 * written is exactly what the preview showed: a segment that changed since is left
 * alone, and the summary says so. Opened by `Ctrl+Shift+H` or from the palette. What the
 * words say and what is ticked is `find-replace.ts`'s.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { api, ApiError } from './api.js';
import { pieces } from './concordance.js';
import {
  allTicked,
  applyLabel,
  applySummary,
  chosenFor,
  describeJob,
  EMPTY_FORM,
  formProblem,
  isFinished,
  scanSummary,
  toggled,
  type ReplaceApplyResult,
  type ReplaceForm,
  type ReplaceJob,
  type ReplaceProposalView,
  type ReplaceScanResult,
} from './find-replace.js';
import { POLL_MS } from './import-job.js';
import { useSession } from './session-context.js';

type Step =
  | { readonly kind: 'idle' }
  | { readonly kind: 'search'; readonly job: ReplaceJob<ReplaceScanResult> }
  | { readonly kind: 'replace'; readonly job: ReplaceJob<ReplaceApplyResult> };

function Marked({
  text,
  ranges,
}: {
  text: string;
  ranges: ReplaceProposalView['ranges'];
}) {
  return (
    <>
      {pieces(text, ranges).map((piece, i) =>
        piece.hit ? <mark key={i}>{piece.text}</mark> : <span key={i}>{piece.text}</span>,
      )}
    </>
  );
}

export function FindReplaceDialog({
  project,
  tgtLang,
  onClose,
}: {
  project: string;
  tgtLang: string;
  /** `changed` is true when a replace wrote segments, so the grid must be loaded again. */
  onClose: (changed: boolean) => void;
}) {
  const { token, signOut } = useSession();
  const [form, setForm] = useState<ReplaceForm>(EMPTY_FORM);
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  // What the preview was run for: Replace sends this, not whatever the boxes say now.
  const [previewed, setPreviewed] = useState<ReplaceForm | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const findRef = useRef<HTMLInputElement>(null);

  // Focus goes to the box, and back to where it was on close.
  useEffect(() => {
    const before = document.activeElement;
    findRef.current?.focus();
    return () => {
      if (before instanceof HTMLElement) before.focus();
    };
  }, []);

  // Follow a running job until it ends. Leaving the box stops asking, not the job.
  useEffect(() => {
    if (step.kind === 'idle' || isFinished(step.job)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api
        .replaceJob<ReplaceScanResult | ReplaceApplyResult>(
          token,
          step.job.id,
          controller.signal,
        )
        .then(
          (next) => {
            if (controller.signal.aborted) return;
            setStep({ kind: step.kind, job: next } as Step);
            if (isFinished(next) && step.kind === 'search' && next.state === 'done') {
              setTicked(allTicked((next.result as ReplaceScanResult).proposals));
            }
            if (isFinished(next) && step.kind === 'replace' && next.state === 'done') {
              if (((next.result as ReplaceApplyResult | null)?.segments ?? 0) > 0)
                setChanged(true);
            }
          },
          (err: unknown) => {
            if (controller.signal.aborted) return;
            if (err instanceof ApiError && err.status === 401) return signOut();
            setStep({
              kind: step.kind,
              job: {
                ...step.job,
                state: 'failed',
                error: `Lost track of this job (${err instanceof Error ? err.message : err}).`,
              },
            } as Step);
          },
        );
    }, POLL_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [step, token, signOut]);

  const refused = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return signOut();
    setFailure(err instanceof Error ? err.message : String(err));
  };

  const preview = async (e: FormEvent) => {
    e.preventDefault();
    if (formProblem(form) !== null || (step.kind !== 'idle' && !isFinished(step.job)))
      return;
    setFailure(null);
    setTicked(new Set());
    setPreviewed(form);
    try {
      const { job } = await api.startReplaceScan(token, project, form);
      setStep({ kind: 'search', job });
    } catch (err) {
      setStep({ kind: 'idle' });
      setPreviewed(null);
      refused(err);
    }
  };

  const proposals =
    step.kind === 'search' && step.job.state === 'done' ? step.job.result!.proposals : [];
  const apply = async () => {
    if (!previewed || ticked.size === 0) return;
    setFailure(null);
    try {
      const { job } = await api.startReplaceApply(
        token,
        project,
        previewed,
        chosenFor(proposals, ticked),
      );
      setStep({ kind: 'replace', job });
    } catch (err) {
      refused(err);
    }
  };

  const cancel = async () => {
    if (step.kind === 'idle') return;
    try {
      const next = await api.cancelReplace<ReplaceScanResult | ReplaceApplyResult>(
        token,
        step.job.id,
      );
      setStep({ kind: step.kind, job: next } as Step);
    } catch (err) {
      refused(err);
    }
  };

  const running = step.kind !== 'idle' && !isFinished(step.job);
  const edited = previewed !== null && JSON.stringify(previewed) !== JSON.stringify(form);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !running) {
      e.preventDefault();
      onClose(changed);
    }
  };
  const done =
    step.kind === 'replace' && step.job.state === 'done' ? step.job.result : null;
  const scan =
    step.kind === 'search' && step.job.state === 'done' ? step.job.result : null;

  return (
    <div className="palette-backdrop" onMouseDown={() => !running && onClose(changed)}>
      <form
        className="find-replace"
        role="dialog"
        aria-modal="true"
        aria-label="Find and replace"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        onSubmit={(e) => void preview(e)}
      >
        <h3>Find and replace</h3>
        <label>
          Find
          <input
            ref={findRef}
            type="text"
            lang={tgtLang}
            value={form.pattern}
            autoComplete="off"
            spellCheck={false}
            disabled={running}
            onChange={(e) => setForm({ ...form, pattern: e.target.value })}
          />
        </label>
        <label>
          Replace with
          <input
            type="text"
            lang={tgtLang}
            value={form.replacement}
            autoComplete="off"
            spellCheck={false}
            disabled={running}
            onChange={(e) => setForm({ ...form, replacement: e.target.value })}
          />
        </label>
        <div className="find-replace-options">
          <label>
            <input
              type="checkbox"
              checked={form.regex}
              disabled={running}
              onChange={(e) => setForm({ ...form, regex: e.target.checked })}
            />
            Regular expression
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.caseSensitive}
              disabled={running}
              onChange={(e) => setForm({ ...form, caseSensitive: e.target.checked })}
            />
            Match case
          </label>
        </div>
        <p className="muted">
          Searches the translations only. A match inside one run of text is found; one
          that would cross a tag is not. A regular expression can use <code>$1</code> in
          the replacement.
        </p>
        <div className="find-replace-actions">
          <button type="submit" disabled={formProblem(form) !== null || running}>
            Preview
          </button>
          {running && (
            <button type="button" className="secondary" onClick={() => void cancel()}>
              Cancel
            </button>
          )}
        </div>
        {failure && (
          <p className="error" role="alert">
            {failure}
          </p>
        )}
        {step.kind !== 'idle' && step.job.state !== 'done' && (
          <p
            className={step.job.state === 'failed' ? 'error' : 'muted'}
            role={step.job.state === 'failed' ? 'alert' : 'status'}
          >
            {describeJob(step.job, step.kind === 'search' ? 'search' : 'replace')}
          </p>
        )}
        {scan && (
          <div className="find-replace-results">
            <p className="muted" role="status">
              {scanSummary(scan)}
              {edited && ' The boxes have changed since: preview again before replacing.'}
            </p>
            {proposals.length > 0 && (
              <>
                <div className="find-replace-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setTicked(allTicked(proposals))}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setTicked(new Set())}
                  >
                    Select none
                  </button>
                </div>
                <ul className="find-replace-hits">
                  {proposals.map((p) => (
                    <li key={p.segmentId}>
                      <label>
                        <input
                          type="checkbox"
                          checked={ticked.has(p.segmentId)}
                          onChange={() => setTicked((t) => toggled(t, p.segmentId))}
                        />
                        <span className="muted">Segment {p.ord + 1}</span>
                      </label>
                      <div lang={tgtLang}>
                        <Marked text={p.before} ranges={p.ranges} />
                      </div>
                      <div lang={tgtLang} className="find-replace-after">
                        {p.after}
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="find-replace-actions">
                  <button
                    type="button"
                    disabled={ticked.size === 0 || edited || running}
                    onClick={() => void apply()}
                  >
                    {applyLabel(ticked.size)}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        {done && <p role="status">{applySummary(done)}</p>}
        <div className="add-term-actions">
          <button
            type="button"
            className="secondary"
            disabled={running}
            onClick={() => onClose(changed)}
          >
            Close
          </button>
        </div>
      </form>
    </div>
  );
}
