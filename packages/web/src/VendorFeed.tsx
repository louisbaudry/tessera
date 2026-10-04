/**
 * A vendor's home (vendor-spec.md §7, backlog #52): one feed across every
 * owner who engages them, the jobs that need an answer first. Each job is a
 * link to its screen; nothing here answers one, because a vendor decides
 * with the offer in front of them (decision 11), not from a list.
 */
import { useCallback } from 'react';

import { api, type FeedJob } from './api.js';
import { Capacity } from './Capacity.js';
import { FEED_GROUPS, formatDeadline, STATUS_LABEL } from './jobs.js';
import { formatRoute } from './route.js';
import { useLoad } from './use-load.js';

export function VendorFeed() {
  return (
    <>
      <div className="page jobs">
        <Capacity />
      </div>
      <FeedBody />
    </>
  );
}

function FeedBody() {
  const feed = useLoad(useCallback((token, signal) => api.vendorFeed(token, signal), []));
  if (feed.state === 'loading') return <p className="muted">Loading your jobs{'…'}</p>;
  if (feed.state === 'error') return <p className="error">{feed.message}</p>;

  const total = FEED_GROUPS.reduce((n, g) => n + feed.data[g.key].length, 0);
  if (total === 0) {
    return (
      <div className="page jobs">
        <section className="list">
          <h2>Your jobs</h2>
          <p className="muted">
            Nothing for you yet. A job offered to you, or posted for you to claim, appears
            here.
          </p>
        </section>
      </div>
    );
  }
  return (
    <div className="page jobs">
      {FEED_GROUPS.map(({ key, title }) => {
        const jobs = feed.data[key];
        if (jobs.length === 0) return null;
        return (
          <section className="list" key={key} aria-label={title}>
            <h2>
              {title} <span className="muted">{jobs.length}</span>
            </h2>
            <ul>
              {jobs.map((job) => (
                <JobRow key={`${job.owner}/${job.id}`} job={job} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function JobRow({ job }: { job: FeedJob }) {
  return (
    <li>
      <span className="job-main">
        <a href={formatRoute({ screen: 'job', owner: job.owner, id: job.id })}>
          {job.project}
        </a>
        <span className="muted">{formatDeadline(job.deadline)}</span>
      </span>
      <span className={`chip status-${job.status}`}>{STATUS_LABEL[job.status]}</span>
    </li>
  );
}
