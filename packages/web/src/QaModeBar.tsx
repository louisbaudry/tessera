/**
 * The QA panel's strip for live or deferred QA (issue #361, `planning/v1-spec.md` §7.10): the
 * owner's switch, the line that says whether the findings can be trusted, and "Run QA", which
 * starts the project's sweep as a job and follows it. What it says is `qa-mode.ts`'s; the sweep
 * is the server's job (`POST /api/projects/:name/qa/sweep`), never this thread's work.
 *
 * `onSwept` is told when a sweep finished so the panel can read the file's findings again.
 */
import { useEffect, useRef, useState } from 'react';

import { api, ApiError } from './api.js';
import {
  afterSweep,
  canRunQa,
  describeSweep,
  isRunning,
  modeLine,
  type QaModeView,
  type QaSweepJob,
} from './qa-mode.js';
import { useSession } from './session-context.js';

const POLL_MS = 500;

export function QaModeBar({
  project,
  mode,
  canChoose,
  onMode,
  onSwept,
}: {
  project: string;
  mode: QaModeView;
  /** Whether this account may switch the mode (the project's owner): the route is `manage`. */
  canChoose: boolean;
  onMode: (mode: QaModeView) => void;
  onSwept: () => void;
}) {
  const { token, signOut } = useSession();
  const [job, setJob] = useState<QaSweepJob | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) signOut();
    else setProblem(err instanceof Error ? err.message : 'That did not work.');
  };

  const choose = async (deferred: boolean) => {
    setProblem(null);
    setBusy(true);
    try {
      onMode(await api.setQaMode(token, project, deferred));
    } catch (err) {
      fail(err);
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const run = async () => {
    setProblem(null);
    setBusy(true);
    try {
      let current = (await api.startQaSweep(token, project)).job;
      setJob(current);
      while (live.current && isRunning(current)) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (!live.current) return;
        current = await api.qaSweepJob(token, current.id);
        setJob(current);
      }
      if (current.state === 'done' && current.result) {
        onMode(afterSweep(mode, current.result));
        onSwept();
      }
    } catch (err) {
      fail(err);
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const line = modeLine(mode);
  return (
    <div className="qa-mode">
      {canChoose && (
        <label className="toggle">
          <input
            type="checkbox"
            checked={mode.deferred}
            disabled={busy}
            onChange={(e) => void choose(e.target.checked)}
          />{' '}
          Run QA only when I ask (for very large files)
        </label>
      )}
      {canRunQa(mode) && (
        <button type="button" disabled={busy} onClick={() => void run()}>
          Run QA
        </button>
      )}
      {line && <span className={mode.stale ? 'stale' : 'muted'}>{line}</span>}
      {job && (
        <span role="status" className="muted">
          {describeSweep(job)}
        </span>
      )}
      {problem && (
        <span className="error" role="alert">
          {problem}
        </span>
      )}
    </div>
  );
}
