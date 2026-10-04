/**
 * One job, opened (vendor-spec.md §7 "Opening an offer", backlog #52): what
 * decision 11 says a vendor sees before answering, then the answers the
 * lifecycle allows. The offer deliberately shows words and rates side by
 * side and **no total** (decision 10): the sum is the vendor's to read, and
 * becomes a fact only at delivery, when it appears here as what locked.
 */
import { useCallback, useState } from 'react';

import { api, type LockedPayable, type OfferDetail } from './api.js';
import {
  availableVerbs,
  formatDeadline,
  formatMicros,
  isWorkable,
  STATUS_LABEL,
  TIER_LABEL,
  tierRows,
  VERB_LABEL,
  type VendorVerb,
} from './jobs.js';
import { projectKey } from './project-key.js';
import { formatRoute } from './route.js';
import { useAction } from './use-action.js';
import { useLoad } from './use-load.js';

export function JobScreen({ owner, id }: { owner: number; id: number }) {
  // Bumped after an answer, so the screen reads what the server now says.
  const [version, setVersion] = useState(0);
  const offer = useLoad(
    useCallback(
      (token, signal) => api.offer(token, owner, id, signal),
      // `version` is not read inside: bumping it is what reloads the offer after an answer.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [owner, id, version],
    ),
  );
  if (offer.state === 'loading') return <p className="muted">Loading the job{'…'}</p>;
  if (offer.state === 'error') {
    return (
      <div className="page">
        <p className="error">{offer.message}</p>
        <p>
          <a href={formatRoute({ screen: 'projects' })}>Back to your jobs</a>
        </p>
      </div>
    );
  }
  return (
    <Job
      owner={owner}
      id={id}
      detail={offer.data}
      onAnswered={() => setVersion((v) => v + 1)}
    />
  );
}

function Job({
  owner,
  id,
  detail,
  onAnswered,
}: {
  owner: number;
  id: number;
  detail: OfferDetail;
  onAnswered: () => void;
}) {
  const { assignment: job, offer } = detail;
  const rows = offer.analysis ? tierRows(offer.analysis.words, offer.rateCard) : [];
  const verbs = availableVerbs(job.status);

  return (
    <div className="page job">
      <header>
        <h2>
          {job.project}{' '}
          <span className={`chip status-${job.status}`}>{STATUS_LABEL[job.status]}</span>
        </h2>
        <p className="muted">
          Deadline: {formatDeadline(job.deadline)} {'·'} offered{' '}
          {formatDeadline(job.offeredAt)}
        </p>
      </header>

      {job.instructions !== null && (
        <section aria-label="Instructions">
          <h3>Instructions</h3>
          <p className="instructions">{job.instructions}</p>
        </section>
      )}

      <section aria-label="Size and rates">
        <h3>What is in it</h3>
        {offer.analysis === null ? (
          <p className="muted">The word count was not recorded for this job.</p>
        ) : (
          <>
            <p>
              {offer.analysis.totalWords.toLocaleString()} words
              {offer.source
                ? ` in ${offer.source.segments.toLocaleString()} segments`
                : ''}
              , counted when it was offered.
            </p>
            {rows.length > 0 && (
              <table className="tier-table">
                <thead>
                  <tr>
                    <th scope="col">Match</th>
                    <th scope="col" className="num">
                      Words
                    </th>
                    <th scope="col" className="num">
                      Your rate per word
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.tier}>
                      <th scope="row">{r.label}</th>
                      <td className="num">{r.words.toLocaleString()}</td>
                      <td className="num">
                        {r.rate ? (
                          formatMicros(r.rate.rateMicros, r.rate.currency)
                        ) : (
                          <span className="muted">no rate set</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="muted">
              Your rates as they stood when this was offered. The amount is yours to read
              off the table; it is fixed when you deliver.
            </p>
          </>
        )}
      </section>

      {offer.source !== null && offer.source.preview.length > 0 && (
        <section aria-label="Source preview">
          <h3>A look at the source</h3>
          <ol className="preview">
            {offer.source.preview.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ol>
          <p className="muted">
            The first {offer.source.preview.length} of{' '}
            {offer.source.segments.toLocaleString()} segments.
          </p>
        </section>
      )}

      {offer.payable !== null && <Payable payable={offer.payable} />}

      <Answers
        key={job.status}
        owner={owner}
        id={id}
        verbs={verbs}
        workable={isWorkable(job.status)}
        project={projectKey(job.project, owner)}
        onAnswered={onAnswered}
      />
    </div>
  );
}

/** What locked at delivery: the amount the vendor is owed, and what it is made of. */
function Payable({ payable }: { payable: LockedPayable }) {
  const money = (micros: number) =>
    payable.currency === null ? '—' : formatMicros(micros, payable.currency);
  return (
    <section aria-label="Final amount">
      <h3>Final amount</h3>
      <table className="tier-table">
        <thead>
          <tr>
            <th scope="col">Match</th>
            <th scope="col" className="num">
              Words
            </th>
            <th scope="col" className="num">
              Rate
            </th>
            <th scope="col" className="num">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {payable.lines.map((l) => (
            <tr key={l.tier}>
              <th scope="row">{TIER_LABEL[l.tier]}</th>
              <td className="num">{l.words.toLocaleString()}</td>
              <td className="num">
                {l.rateMicros === null ? (
                  <span className="muted">no rate set</span>
                ) : (
                  money(l.rateMicros)
                )}
              </td>
              <td className="num">
                {l.rateMicros === null ? (
                  <span className="muted">not priced</span>
                ) : (
                  money(l.amountMicros)
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td className="num">{payable.words.toLocaleString()}</td>
            <td />
            <td className="num">
              <strong>{money(payable.totalMicros)}</strong>
            </td>
          </tr>
        </tfoot>
      </table>
      {!payable.complete && (
        <p className="error">
          Some of the words have no rate on your card, so this total leaves them out. Ask
          the project manager to set one.
        </p>
      )}
      <p className="muted">Locked on {formatDeadline(payable.lockedAt)}.</p>
    </section>
  );
}

/** The answers the lifecycle allows, with a second step before the one that cannot be undone. */
function Answers({
  owner,
  id,
  verbs,
  workable,
  project,
  onAnswered,
}: {
  owner: number;
  id: number;
  verbs: VendorVerb[];
  workable: boolean;
  project: string;
  onAnswered: () => void;
}) {
  const action = useAction();
  const [confirmDecline, setConfirmDecline] = useState(false);

  const answer = async (verb: VendorVerb) => {
    const done = await action.run((token) => api.answerJob(token, owner, id, verb));
    if (done) onAnswered();
  };

  return (
    <section aria-label="Your answer" className="answers">
      {verbs.length > 0 && (
        <div className="actions">
          {verbs.map((verb) =>
            verb === 'decline' ? (
              confirmDecline ? (
                <span key={verb} className="confirm">
                  Decline this job?{' '}
                  <button
                    type="button"
                    disabled={action.busy}
                    onClick={() => void answer('decline')}
                  >
                    Yes, decline
                  </button>{' '}
                  <button
                    type="button"
                    className="link"
                    onClick={() => setConfirmDecline(false)}
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  key={verb}
                  type="button"
                  className="link"
                  disabled={action.busy}
                  onClick={() => setConfirmDecline(true)}
                >
                  {VERB_LABEL[verb]}
                </button>
              )
            ) : (
              <button
                key={verb}
                type="button"
                disabled={action.busy}
                onClick={() => void answer(verb)}
              >
                {VERB_LABEL[verb]}
              </button>
            ),
          )}
        </div>
      )}
      {action.error && <p className="error">{action.error}</p>}
      {workable && (
        <p>
          <a href={formatRoute({ screen: 'project', project })}>Open the project</a>
        </p>
      )}
    </section>
  );
}
