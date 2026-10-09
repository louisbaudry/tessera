/**
 * A vendor's own payment record (backlog #113; `vendor-spec.md`, the #112
 * note): per job the amount that locked at delivery, whether the owner has
 * paid it, the day it was paid and how long that took, with one total per
 * currency. Their rows only, across every owner who engages them; the server
 * never sends another vendor's row or an owner's total.
 */
import { useCallback } from 'react';

import { api, type VendorPaymentRow } from './api.js';
import { formatDeadline } from './jobs.js';
import { amountLabel, amountNote, statusLabel, totalLines } from './payables.js';
import { formatRoute } from './route.js';
import { useLoad } from './use-load.js';

export function Payments() {
  const load = useLoad(
    useCallback((token, signal) => api.vendorPayments(token, signal), []),
  );
  if (load.state === 'loading') return <p className="muted">Loading{'…'}</p>;
  if (load.state === 'error') return <p className="error">{load.message}</p>;
  const { payments, totals } = load.data;
  return (
    <div className="page payments">
      <h2>Your payments</h2>
      {payments.length === 0 ? (
        <p className="muted">
          Nothing yet. The amount of a job is recorded here when you deliver it.
        </p>
      ) : (
        <>
          <table className="ledger totals" aria-label="Totals by currency">
            <thead>
              <tr>
                <th>Currency</th>
                <th className="num">Jobs</th>
                <th className="num">Awaiting payment</th>
                <th className="num">Paid</th>
                <th className="num">Total</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {totalLines(totals).map((l) => (
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
          <table className="ledger" aria-label="Payments">
            <thead>
              <tr>
                <th>Job</th>
                <th className="num">Words</th>
                <th className="num">Amount</th>
                <th>Delivered</th>
                <th>Payment</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((row) => (
                <PaymentLine key={`${row.owner}/${row.assignment}`} row={row} />
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function PaymentLine({ row }: { row: VendorPaymentRow }) {
  const note = amountNote(row);
  return (
    <tr>
      <td>
        <a href={formatRoute({ screen: 'job', owner: row.owner, id: row.assignment })}>
          {row.project}
        </a>
      </td>
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
    </tr>
  );
}
