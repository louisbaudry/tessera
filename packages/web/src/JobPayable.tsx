/**
 * What the vendor is owed for the job they are editing, beside the progress
 * line (vendor-spec decision 10, backlog #53). It is the amount the delivery
 * will lock, from the words and rates of the offer: it does not move as
 * segments are confirmed, because the tier of a confirmed segment cannot be
 * read back (an edit clears its `origin`), and a figure that did would be an
 * estimate dressed as a sum. Once delivered it reads what locked. Shows
 * nothing when the account has no job on the project, which is not an error.
 */
import { useCallback } from 'react';

import { api } from './api.js';
import { forecast, formatMicros } from './jobs.js';
import { useLoad } from './use-load.js';

export function JobPayable({ owner, project }: { owner: number; project: string }) {
  const job = useLoad(
    useCallback(
      async (token, signal) => {
        const { id } = await api.vendorJob(token, owner, project, signal);
        return api.offer(token, owner, id, signal);
      },
      [owner, project],
    ),
  );
  if (job.state !== 'done') return null;
  const { offer } = job.data;

  if (offer.payable) {
    const p = offer.payable;
    if (p.currency === null) return null;
    return (
      <span className="muted job-payable" title={`Locked ${p.lockedAt}`}>
        {' · '}Final amount {formatMicros(p.totalMicros, p.currency)}
      </span>
    );
  }
  if (!offer.analysis) return null;
  const f = forecast(offer.analysis.words, offer.rateCard);
  if (!f) return null;
  return (
    <span
      className="muted job-payable"
      title="From the word counts and your rates when the job was offered; it is fixed when you deliver, and does not change as you confirm segments."
    >
      {' · '}On delivery {formatMicros(f.totalMicros, f.currency)}
      {f.unpricedWords > 0 &&
        ` (not counting ${f.unpricedWords.toLocaleString()} words with no rate)`}
    </span>
  );
}
