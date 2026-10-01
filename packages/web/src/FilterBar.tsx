/**
 * The grid's filter bar (v1-spec.md §7; backlog #34): text, status, origin
 * and QA state. What each choice lets through is `filter.ts`'s; this is
 * rendering. `Ctrl+Shift+F` focuses the text box (the grid binds it).
 */
import type { Segment, SegmentStatus } from '@cat-tool/core';
import { useMemo, type Ref } from 'react';

import {
  isFiltering,
  NO_FILTER,
  originCounts,
  type QaFilter,
  type SegmentFilter,
} from './filter.js';
import { originBadge, STATUS_BADGE } from './gutter.js';

const QA_CHOICES: Readonly<Record<QaFilter, string>> = {
  any: 'Any QA state',
  flagged: 'With QA findings',
  errors: 'With QA errors',
  clean: 'No QA findings',
};

export function FilterBar({
  ref,
  filter,
  segments,
  shown,
  onChange,
}: {
  ref: Ref<HTMLInputElement>;
  filter: SegmentFilter;
  segments: readonly Segment[];
  /** How many rows the filter lets through. */
  shown: number;
  onChange: (filter: SegmentFilter) => void;
}) {
  const origins = useMemo(() => originCounts(segments), [segments]);
  const statuses = Object.keys(STATUS_BADGE) as SegmentStatus[];
  const toggle = (status: SegmentStatus) => {
    const next = new Set(filter.statuses);
    if (!next.delete(status)) next.add(status);
    onChange({ ...filter, statuses: next });
  };
  return (
    <div className="filter-bar" role="search">
      <input
        ref={ref}
        type="search"
        placeholder="Filter source and target (Ctrl+Shift+F)"
        aria-label="Filter text"
        value={filter.text}
        onChange={(e) => onChange({ ...filter, text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Escape') e.currentTarget.blur();
        }}
      />
      <span className="filter-statuses" role="group" aria-label="Status">
        {statuses.map((status) => (
          <button
            key={status}
            type="button"
            className="qa-facet"
            aria-pressed={filter.statuses.has(status)}
            onClick={() => toggle(status)}
          >
            {STATUS_BADGE[status].title}
          </button>
        ))}
      </span>
      <select
        aria-label="Origin"
        value={filter.origin ?? '*'}
        onChange={(e) =>
          onChange({ ...filter, origin: e.target.value === '*' ? null : e.target.value })
        }
      >
        <option value="*">Any origin</option>
        {[...origins].map(([origin, n]) => (
          <option key={origin} value={origin}>
            {origin === '' ? 'No origin' : (originBadge(origin)?.title ?? origin)} ({n})
          </option>
        ))}
        {filter.origin !== null && !origins.has(filter.origin) && (
          <option value={filter.origin}>
            {filter.origin === '' ? 'No origin' : filter.origin} (0)
          </option>
        )}
      </select>
      <select
        aria-label="QA state"
        value={filter.qa}
        onChange={(e) => onChange({ ...filter, qa: e.target.value as QaFilter })}
      >
        {(Object.keys(QA_CHOICES) as QaFilter[]).map((qa) => (
          <option key={qa} value={qa}>
            {QA_CHOICES[qa]}
          </option>
        ))}
      </select>
      {isFiltering(filter) && (
        <>
          <span className="muted">
            {shown.toLocaleString()} of {segments.length.toLocaleString()}
          </span>
          <button type="button" className="link" onClick={() => onChange(NO_FILTER)}>
            Clear
          </button>
        </>
      )}
    </div>
  );
}
