/**
 * The account's memories (v1-spec.md §7.5): one `.ctm` each, shared by
 * every project that attaches it. Created empty, or imported whole from
 * a `.tmx` or Trados `.sdltm` the translator already has — an import
 * that runs on the server as a job (backlog #16a), which this screen
 * follows and can cancel, and which keeps nothing if it does not finish.
 */
import { slugify } from '@cat-tool/core/model';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { api, ApiError } from './api.js';
import {
  describeJob,
  findRunning,
  isFinished,
  percent,
  POLL_MS,
  type ImportJob,
} from './import-job.js';
import { useSession } from './session-context.js';
import { useAction } from './use-action.js';
import { useLoad } from './use-load.js';

export function Memories() {
  const [version, setVersion] = useState(0);
  const memories = useLoad(
    // `version` reloads the list after a memory is made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useCallback((token, signal) => api.memories(token, signal), [version]),
  );
  return (
    <div className="page">
      <section className="list">
        <h2>Memories</h2>
        {memories.state === 'loading' && (
          <p className="muted">Loading memories{'\u2026'}</p>
        )}
        {memories.state === 'error' && <p className="error">{memories.message}</p>}
        {memories.state === 'done' &&
          (memories.data.length === 0 ? (
            <p className="muted">No memories yet.</p>
          ) : (
            <ul>
              {memories.data.map((m) => (
                <li key={m.slug}>
                  <span>{m.slug}</span>
                  <span className="muted">
                    {m.units.toLocaleString()} {m.units === 1 ? 'unit' : 'units'}
                    {m.langs.length > 0 ? ` \u00B7 ${m.langs.join(' ')}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          ))}
      </section>
      <NewMemory onMade={() => setVersion((v) => v + 1)} />
    </div>
  );
}

function NewMemory({ onMade }: { onMade: () => void }) {
  const { token, signOut } = useSession();
  const [name, setName] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  // A new file input after each memory made, so it shows none chosen.
  const [made, setMade] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const action = useAction();
  // Null until edited: the name follows the file chosen.
  const slug = name ?? (file ? slugify(file.name.replace(/\.[^.]*$/, '')) : '');
  const importing = job !== null && !isFinished(job);

  // What to do with each answer the server gives about the job.
  const learn = useCallback(
    (next: ImportJob) => {
      setJob(next);
      if (next.state !== 'running') setCancelling(false);
      if (next.state === 'done') {
        setWarnings(next.result?.warnings ?? []);
        setName(null);
        setFile(null);
        setMade((n) => n + 1);
        onMade();
      }
    },
    [onMade],
  );

  // An import left running (another screen, a reloaded tab) is found again:
  // its progress and Cancel come back instead of an empty form.
  useEffect(() => {
    const controller = new AbortController();
    api.jobs(token, controller.signal).then(
      ({ jobs }) => {
        const running = findRunning(jobs);
        if (running && !controller.signal.aborted) setJob((now) => now ?? running);
      },
      (err: unknown) => {
        if (!controller.signal.aborted && err instanceof ApiError && err.status === 401)
          signOut();
      },
    );
    return () => controller.abort();
  }, [token, signOut]);

  // Follow a running job until it ends. Leaving the screen stops asking,
  // not the import: it carries on, and the memory is there when it is whole.
  useEffect(() => {
    if (!job || isFinished(job)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.importJob(token, job.id, controller.signal).then(
        (next) => {
          if (!controller.signal.aborted) learn(next);
        },
        (err: unknown) => {
          if (controller.signal.aborted) return;
          if (err instanceof ApiError && err.status === 401) return signOut();
          // The job is gone — the server restarted, or it was pruned.
          learn({
            ...job,
            state: 'failed',
            error: `Lost track of this import (${err instanceof Error ? err.message : err}). Check the list.`,
          });
        },
      );
    }, POLL_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [job, token, signOut, learn]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setWarnings([]);
    setJob(null);
    if (!file) {
      const memory = await action.run((t) => api.createMemory(t, slug));
      if (!memory) return;
      setName(null);
      setMade((n) => n + 1);
      onMade();
      return;
    }
    const started = await action.run((t) => api.importMemory(t, slug, file));
    if (started) learn(started.job);
  };

  const cancel = async () => {
    if (!job) return;
    setCancelling(true);
    const answer = await action.run((t) => api.cancelImport(t, job.id));
    if (answer) learn(answer);
    else setCancelling(false);
  };

  const busy = action.busy || importing;
  const pct = job?.state === 'running' ? percent(job.progress?.fraction ?? null) : null;

  return (
    <form className="panel form" onSubmit={(e) => void submit(e)}>
      <h2>New memory</h2>
      <label>
        Import from <span className="hint">optional: a .tmx or Trados .sdltm</span>
        <input
          type="file"
          accept=".tmx,.sdltm"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          key={made}
          disabled={busy}
        />
      </label>
      <label>
        Name
        <input
          value={slug}
          onChange={(e) => setName(e.target.value)}
          pattern="[a-z0-9](?:[a-z0-9\-]{0,62}[a-z0-9])?"
          title="lowercase letters, digits and hyphens"
          required
          disabled={busy}
        />
      </label>
      {action.error && (
        <p className="error" role="alert">
          {action.error}
        </p>
      )}
      {job && (
        <div role="status" className="import-job">
          {importing && (
            <progress
              max={100}
              {...(pct === null ? {} : { value: pct })}
              aria-label="Import progress"
            />
          )}
          <p className={job.state === 'failed' ? 'error' : 'muted'}>
            {cancelling && importing ? 'Cancelling\u2026' : describeJob(job)}
          </p>
          {importing && (
            <button
              type="button"
              className="link"
              disabled={cancelling}
              onClick={() => void cancel()}
            >
              Cancel import
            </button>
          )}
        </div>
      )}
      {warnings.length > 0 && (
        <ul className="warning">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <div>
        <button type="submit" disabled={busy}>
          {importing
            ? 'Importing\u2026'
            : action.busy
              ? file
                ? 'Starting\u2026'
                : 'Creating\u2026'
              : file
                ? 'Import'
                : 'Create empty memory'}
        </button>
      </div>
    </form>
  );
}
