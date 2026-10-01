/**
 * The QA panel (v1-spec.md §7; backlog #33): the file's findings, filtered
 * by severity and rule, each a jump to its segment and a dismissal. Docked
 * under the grid at a fixed height, so opening it shortens the grid's
 * window and moves no column (§7, "no layout shift when the QA panel
 * opens"). What it lists is `qa-panel.ts`'s; this is rendering.
 */
import type { QaIssue, QaRule } from '@cat-tool/core';
import { useMemo, useState } from 'react';

import {
  NO_FILTER,
  panelCounts,
  panelIssues,
  QA_RULE_LABEL,
  SEVERITY_ORDER,
  toggleSeverity,
  type PanelFilter,
} from './qa-panel.js';

export function QaPanel({
  issues,
  positions,
  pending,
  onJump,
  onDismiss,
}: {
  issues: readonly QaIssue[];
  /** Segment id → index in the file. */
  positions: ReadonlyMap<number, number>;
  /** `segmentId:rule` of each finding whose dismissal is on its way. */
  pending: ReadonlySet<string>;
  onJump: (segmentId: number) => void;
  onDismiss: (issue: QaIssue, dismissed: boolean) => void;
}) {
  const [filter, setFilter] = useState<PanelFilter>(NO_FILTER);
  const shown = useMemo(
    () => panelIssues(issues, positions, filter),
    [issues, positions, filter],
  );
  const counts = useMemo(
    () => panelCounts(issues, positions, filter),
    [issues, positions, filter],
  );
  // A chosen rule that no longer fires stays chosen, so the list does
  // not silently widen under the translator; it shows with no count.
  const rules: QaRule[] = [...counts.byRule.keys()];
  if (filter.rule !== null && !counts.byRule.has(filter.rule)) rules.push(filter.rule);

  return (
    <section className="qa-panel" aria-label="QA findings">
      <div className="qa-filters">
        {SEVERITY_ORDER.map((severity) => (
          <button
            key={severity}
            type="button"
            className={`qa-facet qa-facet-${severity}`}
            aria-pressed={filter.severities.has(severity)}
            onClick={() =>
              setFilter((f) => ({
                ...f,
                severities: toggleSeverity(f.severities, severity),
              }))
            }
          >
            {severity} <span className="count">{counts.bySeverity[severity]}</span>
          </button>
        ))}
        <select
          aria-label="Rule"
          value={filter.rule ?? ''}
          onChange={(e) =>
            setFilter((f) => ({
              ...f,
              rule: e.target.value === '' ? null : (e.target.value as QaRule),
            }))
          }
        >
          <option value="">Every rule</option>
          {rules.map((rule) => (
            <option key={rule} value={rule}>
              {QA_RULE_LABEL[rule]} ({counts.byRule.get(rule) ?? 0})
            </option>
          ))}
        </select>
        <label className="toggle">
          <input
            type="checkbox"
            checked={filter.showDismissed}
            onChange={(e) =>
              setFilter((f) => ({ ...f, showDismissed: e.target.checked }))
            }
          />{' '}
          Show dismissed ({counts.dismissed})
        </label>
      </div>
      {shown.length === 0 ? (
        <p className="qa-empty muted">
          {issues.length === 0 ? 'No QA findings in this file.' : 'Nothing matches.'}
        </p>
      ) : (
        <ul className="qa-list">
          {shown.map((issue) => {
            const busy = pending.has(`${issue.segmentId}:${issue.rule}`);
            return (
              <li
                key={`${issue.segmentId}:${issue.rule}`}
                className={issue.dismissed ? 'dismissed' : undefined}
              >
                <button
                  type="button"
                  className="qa-jump"
                  onClick={() => onJump(issue.segmentId)}
                  title="Go to the segment"
                >
                  <span className="ord">{positions.get(issue.segmentId)! + 1}</span>
                  <span
                    className={`qa-dot qa-${issue.severity}`}
                    title={issue.severity}
                  />
                  <span className="rule" title={issue.rule}>
                    {QA_RULE_LABEL[issue.rule]}
                  </span>
                  <span className="message">{issue.message}</span>
                </button>
                <button
                  type="button"
                  className="link"
                  disabled={busy}
                  onClick={() => onDismiss(issue, !issue.dismissed)}
                >
                  {issue.dismissed ? 'Reinstate' : 'Dismiss'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
