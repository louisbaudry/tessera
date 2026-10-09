/**
 * "Check against a glossary" on a memory (backlog #122; `smart-glossary-spec.md`
 * §6.2): which of its units use a rendering the glossary now prefers against or
 * forbids, so a client's ruling becomes a rework list. The scan is a job on the
 * server; this starts it, follows it and can cancel it, then shows what it found.
 * It reads and reports: nothing in the memory is changed, and the screen says so.
 * What the words are is `stale-scan.ts`'s.
 */
import { useCallback, useEffect, useState } from 'react';

import { api, ApiError, type MemorySummary } from './api.js';
import { POLL_MS } from './import-job.js';
import { useSession } from './session-context.js';
import {
  describeScan,
  isScanFinished,
  pairChoices,
  pairKey,
  rowFinding,
  scanSummary,
  type ScanJob,
} from './stale-scan.js';
import { useAction } from './use-action.js';
import { useLoad } from './use-load.js';

export function StaleCheck({ memory }: { memory: MemorySummary }) {
  const [open, setOpen] = useState(false);
  const pairs = pairChoices(memory.langs);
  return (
    <div className="stale-check">
      <button
        type="button"
        className="link"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        disabled={pairs.length === 0}
        title={
          pairs.length === 0
            ? 'This memory holds fewer than two languages'
            : 'Find units that use an old rendering of a glossary term'
        }
      >
        {open ? 'Hide the glossary check' : 'Check against a glossary'}
      </button>
      {open && <Check memory={memory.slug} pairs={pairs} />}
    </div>
  );
}

function Check({
  memory,
  pairs,
}: {
  memory: string;
  pairs: Array<{ srcLang: string; tgtLang: string }>;
}) {
  const { token, signOut } = useSession();
  const glossaries = useLoad(useCallback((t, signal) => api.glossaries(t, signal), []));
  const [glossary, setGlossary] = useState('');
  const [pair, setPair] = useState(pairKey(pairs[0]!));
  const [job, setJob] = useState<ScanJob | null>(null);
  const [asked, setAsked] = useState<{ srcLang: string; tgtLang: string } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const action = useAction();

  const slugs = glossaries.state === 'done' ? glossaries.data.map((g) => g.slug) : [];
  const chosen = slugs.includes(glossary) ? glossary : (slugs[0] ?? '');

  // Follow a running scan until it ends. Leaving the screen stops asking, not the scan.
  useEffect(() => {
    if (!job || isScanFinished(job)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.scanJob(token, job.id, controller.signal).then(
        (next) => {
          if (controller.signal.aborted) return;
          setJob(next);
          if (isScanFinished(next)) setCancelling(false);
        },
        (err: unknown) => {
          if (controller.signal.aborted) return;
          if (err instanceof ApiError && err.status === 401) return signOut();
          setJob({
            ...job,
            state: 'failed',
            error: `Lost track of this scan (${err instanceof Error ? err.message : err}).`,
          });
        },
      );
    }, POLL_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [job, token, signOut]);

  const start = async () => {
    const chosenPair = pairs.find((p) => pairKey(p) === pair) ?? pairs[0]!;
    setAsked(chosenPair);
    setJob(null);
    const started = await action.run((t) =>
      api.startStaleScan(t, memory, { glossary: chosen, ...chosenPair }),
    );
    if (started) setJob(started.job);
  };

  const cancel = async () => {
    if (!job) return;
    setCancelling(true);
    const answer = await action.run((t) => api.cancelScan(t, job.id));
    if (answer) setJob(answer);
    else setCancelling(false);
  };

  const running = job?.state === 'running';
  const result = job?.state === 'done' ? job.result : null;
  return (
    <div className="stale-body">
      {glossaries.state === 'error' && <p className="error">{glossaries.message}</p>}
      {glossaries.state === 'done' && slugs.length === 0 ? (
        <p className="muted">
          No glossary yet: make one from a project, then check against it.
        </p>
      ) : (
        <form
          className="stale-form"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <label>
            Glossary
            <select
              value={chosen}
              onChange={(e) => setGlossary(e.target.value)}
              disabled={running}
            >
              {slugs.map((slug) => (
                <option key={slug} value={slug}>
                  {slug}
                </option>
              ))}
            </select>
          </label>
          <label>
            Language pair
            <select
              value={pair}
              onChange={(e) => setPair(e.target.value)}
              disabled={running}
            >
              {pairs.map((p) => (
                <option key={pairKey(p)} value={pairKey(p)}>
                  {p.srcLang} {'→'} {p.tgtLang}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={running || action.busy || chosen === ''}>
            {running ? 'Scanning…' : 'Check'}
          </button>
          {running && (
            <button
              type="button"
              className="link"
              disabled={cancelling}
              onClick={() => void cancel()}
            >
              Cancel
            </button>
          )}
        </form>
      )}
      {action.error && (
        <p className="error" role="alert">
          {action.error}
        </p>
      )}
      {job && (
        <p role="status" className={job.state === 'failed' ? 'error' : 'muted'}>
          {cancelling && running
            ? 'Cancelling…'
            : result
              ? scanSummary(result, asked)
              : describeScan(job)}
        </p>
      )}
      {result && result.rows.length > 0 && (
        <>
          <table
            className="ledger stale-rows"
            aria-label="Units that use an old rendering"
          >
            <thead>
              <tr>
                <th>Source</th>
                <th>Target</th>
                <th>Term</th>
                <th>Finding</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => (
                <tr key={`${row.tuUuid}/${row.termId}`}>
                  <td>{row.source}</td>
                  <td>{row.target}</td>
                  <td>{row.term}</td>
                  <td className="muted">{rowFinding(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            A report only: nothing in the memory was changed. Fix a unit where it is used,
            or import a corrected memory.
          </p>
        </>
      )}
    </div>
  );
}
