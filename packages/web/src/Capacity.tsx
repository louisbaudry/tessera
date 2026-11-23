/**
 * A vendor's capacity (vendor-spec decision 8, backlog #54): available, busy or
 * away, and a note, flipped from the home screen and never tied to a job. One
 * row per roster that lists them, because each owner keeps their own; a vendor
 * with one owner sees one row and no owner label. A status is saved the moment
 * it is chosen, the note when the box is left. Nothing is chosen for a vendor
 * who has not: "not set" is shown as such, never as available.
 *
 * Under each row, the vendor's time off on that roster (issue #156): periods still to
 * come, added or removed one at a time and saved as the whole list. The owner sees them
 * only as a reason in the advisory "who fits" read, never as a refusal.
 */
import { useCallback, useState } from 'react';

import type { DateWindow } from '@cat-tool/vendor-core';

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
        <div key={r.tenantId}>
          <CapacityRow initial={r} labelled={rosters.length > 1} />
          <TimeOff
            tenantId={r.tenantId}
            initial={r.timeOff ?? []}
            labelled={rosters.length > 1}
          />
        </div>
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
      api.setCapacity(token, saved.tenantId, {
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
        {labelled ? `Availability (organisation ${saved.tenantId})` : 'Availability'}
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

/** `2026-12-05` as the reader's own short date, read as a day (no zone shift). */
function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function TimeOff({
  tenantId,
  initial,
  labelled,
}: {
  tenantId: number;
  initial: readonly DateWindow[];
  labelled: boolean;
}) {
  const [periods, setPeriods] = useState(initial);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const action = useAction();
  const save = async (next: readonly DateWindow[]) => {
    const done = await action.run((token) => api.setTimeOff(token, tenantId, next));
    if (done) {
      setPeriods(done.timeOff);
      setFrom('');
      setTo('');
    }
  };
  const fromId = `time-off-from-${tenantId}`;
  const toId = `time-off-to-${tenantId}`;
  return (
    <div className="capacity-row time-off">
      <strong>{labelled ? `Time off (organisation ${tenantId})` : 'Time off'}</strong>
      {periods.length === 0 ? (
        <span className="muted">None planned</span>
      ) : (
        <ul aria-label="Planned time off">
          {periods.map((p, i) => (
            <li key={`${p.from}/${p.to}`}>
              {p.from === p.to
                ? dayLabel(p.from)
                : `${dayLabel(p.from)} to ${dayLabel(p.to)}`}{' '}
              <button
                type="button"
                className="link"
                disabled={action.busy}
                aria-label={`Remove time off from ${dayLabel(p.from)}`}
                onClick={() => void save(periods.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save([...periods, { from, to: to === '' ? from : to }]);
        }}
      >
        <label htmlFor={fromId}>From</label>
        <input
          id={fromId}
          type="date"
          value={from}
          required
          onChange={(e) => setFrom(e.target.value)}
        />
        <label htmlFor={toId}>To</label>
        <input
          id={toId}
          type="date"
          value={to}
          min={from}
          onChange={(e) => setTo(e.target.value)}
        />
        <button type="submit" disabled={action.busy || from === ''}>
          Add
        </button>
      </form>
      {action.error && (
        <span className="error" role="alert">
          {action.error}
        </span>
      )}
    </div>
  );
}
