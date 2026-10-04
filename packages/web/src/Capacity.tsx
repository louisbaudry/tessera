/**
 * A vendor's capacity (vendor-spec decision 8, backlog #54): available, busy or
 * away, and a note, flipped from the home screen and never tied to a job. One
 * row per roster that lists them, because each owner keeps their own; a vendor
 * with one owner sees one row and no owner label. A status is saved the moment
 * it is chosen, the note when the box is left. Nothing is chosen for a vendor
 * who has not: "not set" is shown as such, never as available.
 */
import { useCallback, useState } from 'react';

import { api, type RosterCapacity } from './api.js';
import { CAPACITY_LABEL, CAPACITY_OPTIONS, formatDeadline, noteChanged } from './jobs.js';
import { useAction } from './use-action.js';
import { useLoad } from './use-load.js';

export function Capacity() {
  const load = useLoad(
    useCallback((token, signal) => api.vendorCapacity(token, signal), []),
  );
  if (load.state !== 'done' || load.data.rosters.length === 0) return null;
  const { rosters } = load.data;
  return (
    <section className="capacity" aria-label="Your availability">
      {rosters.map((r) => (
        <CapacityRow key={r.owner} initial={r} labelled={rosters.length > 1} />
      ))}
    </section>
  );
}

function CapacityRow({
  initial,
  labelled,
}: {
  initial: RosterCapacity;
  labelled: boolean;
}) {
  const [saved, setSaved] = useState(initial);
  const [note, setNote] = useState(initial.note ?? '');
  const action = useAction();

  const save = async (status: NonNullable<RosterCapacity['status']>, text: string) => {
    const done = await action.run((token) =>
      api.setCapacity(token, saved.owner, {
        status,
        note: text.trim() === '' ? null : text,
      }),
    );
    if (done) {
      setSaved(done);
      setNote(done.note ?? '');
    }
  };

  return (
    <div className="capacity-row">
      <strong>
        {labelled ? `Availability (client ${saved.owner})` : 'Availability'}
      </strong>
      <span role="group" aria-label="Status">
        {CAPACITY_OPTIONS.map((status) => (
          <button
            key={status}
            type="button"
            className={saved.status === status ? 'chip active' : 'chip'}
            aria-pressed={saved.status === status}
            disabled={action.busy}
            onClick={() => void save(status, note)}
          >
            {CAPACITY_LABEL[status]}
          </button>
        ))}
      </span>
      <input
        type="text"
        aria-label="Note"
        placeholder={
          saved.status === null ? 'Choose a status first' : 'A note, e.g. back Monday'
        }
        maxLength={500}
        value={note}
        disabled={saved.status === null || action.busy}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => {
          if (saved.status !== null && noteChanged(note, saved.note))
            void save(saved.status, note);
        }}
      />
      {saved.setAt === null ? (
        <span className="muted">Not set</span>
      ) : (
        <span className="muted">Set {formatDeadline(saved.setAt)}</span>
      )}
      {action.error && <span className="error">{action.error}</span>}
    </div>
  );
}
