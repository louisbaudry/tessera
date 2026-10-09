/**
 * The owner's pay run (backlog #113; `vendor-spec.md`, the #112 note): every
 * payable a delivery locked on their roster, filtered by vendor, period and
 * paid state, with one total per currency (never converted), "Mark paid" and
 * "Reopen", and the same list as a CSV. Tessera moves no money; this is the
 * record of it. An incomplete payable is listed with its flag, never hidden.
 */
import { useCallback, useState, type FormEvent } from 'react';

import { api, type PayableRow, type RosterVendor } from './api.js';
import { formatDeadline } from './jobs.js';
import {
  amountLabel,
  amountNote,
  dayOf,
  filterProblem,
  NO_FILTER,
  paidOnProblem,
  payablesQuery,
  statusLabel,
  todayUtc,
  totalLines,
  type PayablesFilter,
} from './payables.js';
import { useAction } from './use-action.js';
import { useLoad } from './use-load.js';

export function Payables() {
  const [filter, setFilter] = useState<PayablesFilter>(NO_FILTER);
  // Bumped after a write. It is part of `Results`' key, so the list and its totals
  // are read again from the server rather than patched here: the totals are the
  // server's to compute.
  const [version, setVersion] = useState(0);
  const problem = filterProblem(filter);
  const query = payablesQuery(filter);

  return (
    <div className="page payables">
      <h2>Pay run</h2>
      <Filters filter={filter} onChange={setFilter} problem={problem} />
      {problem === null && (
        <Results
          key={`${query}#${version}`}
          query={query}
          onChanged={() => setVersion((v) => v + 1)}
        />
      )}
    </div>
  );
}

function Filters({
  filter,
  onChange,
  problem,
}: {
  filter: PayablesFilter;
  onChange: (next: PayablesFilter) => void;
  problem: string | null;
}) {
  const vendors = useLoad(
    useCallback((token, signal) => api.rosterVendors(token, signal), []),
  );
  const list: readonly RosterVendor[] =
    vendors.state === 'done' ? vendors.data.vendors : [];
  const set = <K extends keyof PayablesFilter>(key: K, value: PayablesFilter[K]) =>
    onChange({ ...filter, [key]: value });
  return (
    <form className="ledger-filters" onSubmit={(e) => e.preventDefault()}>
      <label>
        Vendor
        <select value={filter.vendor} onChange={(e) => set('vendor', e.target.value)}>
          <option value="">All vendors</option>
          {list.map((v) => (
            <option key={v.accountId} value={String(v.accountId)}>
              {v.displayName}
            </option>
          ))}
        </select>
      </label>
      <label>
        Locked from
        <input
          type="date"
          value={filter.from}
          max={filter.to || undefined}
          onChange={(e) => set('from', e.target.value)}
        />
      </label>
      <label>
        to
        <input
          type="date"
          value={filter.to}
          min={filter.from || undefined}
          onChange={(e) => set('to', e.target.value)}
        />
      </label>
      <label>
        Paid
        <select
          value={filter.status}
          onChange={(e) => set('status', e.target.value as PayablesFilter['status'])}
        >
          <option value="">Paid and unpaid</option>
          <option value="unpaid">Unpaid</option>
          <option value="paid">Paid</option>
        </select>
      </label>
      {problem && <span className="error">{problem}</span>}
    </form>
  );
}

function Results({ query, onChanged }: { query: string; onChanged: () => void }) {
  const list = useLoad(
    useCallback((token, signal) => api.payables(token, query, signal), [query]),
  );
  if (list.state === 'loading') return <p className="muted">Loading{'…'}</p>;
  if (list.state === 'error') return <p className="error">{list.message}</p>;
  const { payables, totals } = list.data;
  if (payables.length === 0) {
    return (
      <p className="muted">
        {query === ''
          ? 'Nothing to pay yet. A payable appears here when a vendor delivers a job.'
          : 'No payable matches these filters.'}
      </p>
    );
  }
  return (
    <>
      <Totals totals={totals} />
      <div className="ledger-actions">
        <DownloadCsv query={query} />
      </div>
      <table className="ledger" aria-label="Payables">
        <thead>
          <tr>
            <th>Job</th>
            <th>Vendor</th>
            <th className="num">Words</th>
            <th className="num">Amount</th>
            <th>Locked</th>
            <th>Paid</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {payables.map((row) => (
            <PayableLine key={row.assignment} row={row} onChanged={onChanged} />
          ))}
        </tbody>
      </table>
    </>
  );
}

function Totals({ totals }: { totals: Parameters<typeof totalLines>[0] }) {
  const lines = totalLines(totals);
  return (
    <table className="ledger totals" aria-label="Totals by currency">
      <thead>
        <tr>
          <th>Currency</th>
          <th className="num">Payables</th>
          <th className="num">Unpaid</th>
          <th className="num">Paid</th>
          <th className="num">Total</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.key}>
            <th scope="row">{l.currency ?? 'No currency'}</th>
            <td className="num">{l.count}</td>
            <td className="num">{l.unpaid}</td>
            <td className="num">{l.paid}</td>
            <td className="num">{l.total}</td>
            <td className="muted">{l.incomplete}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The CSV of the list on screen, fetched with the session's token and saved by the browser. */
function DownloadCsv({ query }: { query: string }) {
  const action = useAction();
  const download = async () => {
    const text = await action.run((token) => api.payablesCsv(token, query));
    if (text === null) return;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'payables.csv';
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <>
      <button type="button" disabled={action.busy} onClick={() => void download()}>
        Download CSV
      </button>
      {action.error && <span className="error">{action.error}</span>}
    </>
  );
}

function PayableLine({ row, onChanged }: { row: PayableRow; onChanged: () => void }) {
  const [paying, setPaying] = useState(false);
  const note = amountNote(row);
  return (
    <>
      <tr>
        <td>{row.project}</td>
        <td>{row.vendor}</td>
        <td className="num">{row.words}</td>
        <td className="num">
          {amountLabel(row)}
          {note && (
            <span className="flag" title={note}>
              {' '}
              incomplete
            </span>
          )}
        </td>
        <td className="when">{formatDeadline(row.lockedAt)}</td>
        <td>
          <span className={row.status === 'paid' ? 'chip status-delivered' : 'chip'}>
            {statusLabel(row)}
          </span>
        </td>
        <td>
          {row.status === 'paid' ? (
            <ReopenButton assignment={row.assignment} onChanged={onChanged} />
          ) : (
            !paying && (
              <button type="button" onClick={() => setPaying(true)}>
                Mark paid
              </button>
            )
          )}
        </td>
      </tr>
      {note && (
        <tr className="ledger-note">
          <td colSpan={7} className="muted">
            {note}
          </td>
        </tr>
      )}
      {paying && row.status !== 'paid' && (
        <tr className="ledger-note">
          <td colSpan={7}>
            <PayForm
              row={row}
              onDone={() => {
                setPaying(false);
                onChanged();
              }}
              onCancel={() => setPaying(false)}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function PayForm({
  row,
  onDone,
  onCancel,
}: {
  row: PayableRow;
  onDone: () => void;
  onCancel: () => void;
}) {
  const action = useAction();
  const today = todayUtc();
  const [paidOn, setPaidOn] = useState(today);
  const [note, setNote] = useState('');
  const problem = paidOnProblem(paidOn, row.lockedAt, today);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem !== null) return;
    const done = await action.run((token) =>
      api.markPaid(token, row.assignment, {
        paidOn,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      }),
    );
    if (done) onDone();
  };

  return (
    <form className="pay-form" onSubmit={(e) => void submit(e)}>
      <label>
        Day the money moved
        <input
          type="date"
          value={paidOn}
          min={dayOf(row.lockedAt)}
          max={today}
          required
          onChange={(e) => setPaidOn(e.target.value)}
        />
      </label>
      <label className="grow">
        Note
        <input
          type="text"
          value={note}
          maxLength={500}
          placeholder="e.g. bank transfer reference"
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <button type="submit" disabled={action.busy || problem !== null}>
        Confirm paid
      </button>
      <button type="button" className="link" disabled={action.busy} onClick={onCancel}>
        Cancel
      </button>
      {problem && <span className="error">{problem}</span>}
      {action.error && <span className="error">{action.error}</span>}
    </form>
  );
}

/** Withdraws a payment to correct it. A second click confirms: the log keeps both events. */
function ReopenButton({
  assignment,
  onChanged,
}: {
  assignment: number;
  onChanged: () => void;
}) {
  const action = useAction();
  const [confirming, setConfirming] = useState(false);
  const reopen = async () => {
    const done = await action.run((token) => api.reopenPayment(token, assignment));
    if (done) onChanged();
  };
  if (!confirming) {
    return (
      <button type="button" className="link" onClick={() => setConfirming(true)}>
        Reopen
      </button>
    );
  }
  return (
    <span className="reopen-confirm">
      <button type="button" disabled={action.busy} onClick={() => void reopen()}>
        Reopen payment
      </button>
      <button
        type="button"
        className="link"
        disabled={action.busy}
        onClick={() => setConfirming(false)}
      >
        Keep
      </button>
      {action.error && <span className="error">{action.error}</span>}
    </span>
  );
}
