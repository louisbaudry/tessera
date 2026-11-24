/**
 * An owner's view of what their draft runs spent (issue #150, `planning/translation-engine-spec.md`,
 * the #150 note): per project and in total, by engine, in tokens (characters for DeepL), with
 * how many replies were kept. Read only. Units, never text, and no price: Tessera holds none,
 * so an owner with a price list multiplies. A pm never reaches it (the shell hides it and
 * the server refuses it).
 */
import { useCallback } from 'react';

import { api } from './api.js';
import {
  engineLabel,
  outcomeSummary,
  unitsLabel,
  type SpendUsage,
} from './ai-spend-view.js';
import { useLoad } from './use-load.js';

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
            </section>
          ))}
        </>
      )}
    </div>
  );
}
