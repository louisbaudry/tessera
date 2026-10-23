/**
 * An admin's view of their own organisation's log (backlog #211, `planning/audit-spec.md`
 * §3.1): who did what, newest first, a page at a time. Read only, and not itself an event.
 * It shows the tenant's slice of the platform log and nothing of any other tenant's: the
 * server picks the tenant from the session. A pm never reaches it (the shell hides it and
 * the server refuses it).
 */
import { useCallback, useState } from 'react';

import { api } from './api.js';
import { aboutLabel, actionLabel, whoLabel, type AuditEventView } from './audit-view.js';
import { formatDeadline } from './jobs.js';
import { useAction } from './use-action.js';
import { useLoad } from './use-load.js';

export function Audit() {
  const first = useLoad(useCallback((token, signal) => api.audit(token, {}, signal), []));
  // The pages read after the first, appended in order; the first page is the load's own, and
  // the cursor is whichever page was read last.
  const [older, setOlder] = useState<{
    events: AuditEventView[];
    next: number | null;
  } | null>(null);
  const more = useAction();

  if (first.state === 'loading') return <p className="muted">Loading{'\u2026'}</p>;
  if (first.state === 'error') return <p className="error">{first.message}</p>;
  const events = [...first.data.events, ...(older?.events ?? [])];
  const next = older === null ? first.data.next : older.next;

  const loadOlder = async () => {
    if (next === null) return;
    const page = await more.run((token) => api.audit(token, { before: next }));
    if (page) {
      setOlder({ events: [...(older?.events ?? []), ...page.events], next: page.next });
    }
  };

  return (
    <div className="page audit">
      <h2>Activity</h2>
      <p className="muted">
        What your staff did in your organisation, newest first. It records ids and states,
        never the text of a document. Events before this log began carrying your
        organisation are not shown here.
      </p>
      {events.length === 0 ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        <table className="ledger" aria-label="Activity">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>What</th>
              <th>About</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td className="when">{formatDeadline(e.at)}</td>
                <td>{whoLabel(e)}</td>
                <td>{actionLabel(e.action)}</td>
                <td>{aboutLabel(e) ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next !== null && (
        <div className="actions">
          <button type="button" disabled={more.busy} onClick={() => void loadOlder()}>
            Older
          </button>
          {more.error && <span className="error">{more.error}</span>}
        </div>
      )}
    </div>
  );
}
