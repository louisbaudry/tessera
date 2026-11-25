/**
 * An owner's view of what their draft runs spent (issue #150, `planning/translation-engine-spec.md`,
 * the #150 note): per project and in total, by engine, in tokens (characters for DeepL), with
 * how many replies were kept. Read only. Units, never text, and no price: Tessera holds none,
 * so an owner with a price list multiplies. A pm never reaches it (the shell hides it and
 * the server refuses it). Each project opens onto its per-call log: one line per reply, with
 * the segment's number and nothing of its text.
 */
import { useCallback, useState } from 'react';

import { api, ApiError } from './api.js';
import {
  appendPage,
  callOutcome,
  callTime,
  engineLabel,
  outcomeSummary,
  unitsLabel,
  type CallRow,
  type SpendUsage,
} from './ai-spend-view.js';
import { useSession } from './session-context.js';
import { useLoad } from './use-load.js';

/** A project's replies, loaded when asked for and a page older each time. */
function CallLog({ name }: { name: string }) {
  const { token, signOut } = useSession();
  const [rows, setRows] = useState<CallRow[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = (before: number | null) => {
    setBusy(true);
    setError(null);
    api.aiCalls(token, name, before).then(
      (page) => {
        setRows((shown) => appendPage(before === null ? [] : (shown ?? []), page));
        setNext(page.next);
        setBusy(false);
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return signOut();
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      },
    );
  };

  if (rows === null)
    return (
      <>
        <button type="button" disabled={busy} onClick={() => load(null)}>
          Show each reply
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </>
    );
  return (
    <>
      <table className="ledger" aria-label={`${name}: each reply`}>
        <thead>
          <tr>
            <th>When</th>
            <th>Segment</th>
            <th>Engine</th>
            <th>Used</th>
            <th>Reply</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td>{callTime(c.at)}</td>
              <td className="num">{c.segmentId}</td>
              <td>{engineLabel(c.engine, c.model)}</td>
              <td>{unitsLabel(c)}</td>
              <td>{callOutcome(c.outcome)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {next !== null && (
        <button type="button" disabled={busy} onClick={() => load(next)}>
          Older replies
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function SpendTable({ usage, label }: { usage: SpendUsage; label: string }) {
  return (
    <table className="ledger" aria-label={label}>
      <thead>
        <tr>
          <th>Engine</th>
          <th>Used</th>
          <th>Replies</th>
        </tr>
      </thead>
      <tbody>
        {usage.rows.map((r) => (
          <tr key={`${r.engine}/${r.model}/${r.unit}`}>
            <td>{engineLabel(r.engine, r.model)}</td>
            <td>{unitsLabel(r)}</td>
            <td>{outcomeSummary(r)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AiSpend() {
  const spend = useLoad(useCallback((token, signal) => api.aiSpend(token, signal), []));
  if (spend.state === 'loading') return <p className="muted">Loading{'…'}</p>;
  if (spend.state === 'error') return <p className="error">{spend.message}</p>;
  const { projects, total } = spend.data;

  return (
    <div className="page ai-spend">
      <h1>AI spend</h1>
      <p className="muted">
        What your machine-translation drafts used, by project. Counted in tokens, or in
        characters for DeepL, and never priced here: check the units against your engine’s
        price list. A reply that was refused or dropped was still paid for, so it is
        counted. Spend from before this record began is not shown.
      </p>
      {projects.length === 0 ? (
        <p className="muted">Nothing has been drafted yet.</p>
      ) : (
        <>
          <h2>All projects</h2>
          <SpendTable usage={total} label="All projects" />
          {projects.map((p) => (
            <section key={p.name}>
              <h2>{p.name}</h2>
              <SpendTable usage={p.usage} label={p.name} />
              <CallLog name={p.name} />
            </section>
          ))}
        </>
      )}
    </div>
  );
}
