/**
 * The QA panel's list (v1-spec.md §7; backlog #33): a file's findings,
 * filtered by severity and rule, in document order, dismissed ones on
 * request. Pure, so what the panel shows is provable without a DOM.
 *
 * The rule table is a `Record` keyed by `core`'s `QaRule`, so a rule
 * added there fails this package's typecheck instead of listing blank.
 */
import type { QaIssue, QaRule, QaSeverity } from '@cat-tool/core';

import { SEVERITY_RANK } from './gutter.js';

/** Each rule in words, in the order v1-spec.md §6.4 lists them. */
export const QA_RULE_LABEL: Readonly<Record<QaRule, string>> = {
  'tag.missing': 'Missing tag',
  'tag.extra': 'Extra tag',
  'tag.unbalanced': 'Unbalanced tags',
  'seg.empty': 'Empty target',
  'seg.untranslated': 'Untranslated',
  'consistency.target_differs': 'Inconsistent translation',
  'consistency.source_differs': 'Same translation, different source',
  'num.missing': 'Missing number',
  'num.altered': 'Number reformatted',
  'punct.terminal': 'End punctuation',
  'punct.brackets': 'Unbalanced brackets or quotes',
  'punct.inverted': 'Missing \u00BF or \u00A1',
  'punct.spacing': 'Spacing',
  'term.glossary_mismatch': 'Glossary term',
};

export const QA_RULE_ORDER = Object.keys(QA_RULE_LABEL) as readonly QaRule[];

/** Worst first, as the panel offers them. */
export const SEVERITY_ORDER: readonly QaSeverity[] = ['error', 'warning', 'info'];

export interface PanelFilter {
  /** The severities shown; all three when none is chosen. */
  readonly severities: ReadonlySet<QaSeverity>;
  /** One rule, or every rule. */
  readonly rule: QaRule | null;
  readonly showDismissed: boolean;
}

export const NO_FILTER: PanelFilter = {
  severities: new Set(),
  rule: null,
  showDismissed: false,
};

/**
 * The findings the panel lists: those `filter` admits, in the order of
 * their segments in the file (`positions`, segment id → index), worst
 * first within a segment. A finding whose segment the file no longer has
 * is left out rather than listed at the end.
 */
export function panelIssues(
  issues: readonly QaIssue[],
  positions: ReadonlyMap<number, number>,
  filter: PanelFilter,
): QaIssue[] {
  return issues
    .filter(
      (i) =>
        positions.has(i.segmentId) &&
        (filter.showDismissed || !i.dismissed) &&
        (filter.severities.size === 0 || filter.severities.has(i.severity)) &&
        (filter.rule === null || i.rule === filter.rule),
    )
    .sort(
      (a, b) =>
        positions.get(a.segmentId)! - positions.get(b.segmentId)! ||
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        QA_RULE_ORDER.indexOf(a.rule) - QA_RULE_ORDER.indexOf(b.rule),
    );
}

export interface PanelCounts {
  readonly bySeverity: Readonly<Record<QaSeverity, number>>;
  /** Only rules that have a finding to count. */
  readonly byRule: ReadonlyMap<QaRule, number>;
  readonly dismissed: number;
}

/**
 * What each filter choice would find, so a choice shows its count and a
 * rule with nothing to show is not offered. Each facet counts under the
 * *other* facet's choice — the severity counts within the chosen rule,
 * the rule counts within the chosen severities — so a number is always
 * what picking it lists.
 */
export function panelCounts(
  issues: readonly QaIssue[],
  positions: ReadonlyMap<number, number>,
  filter: PanelFilter,
): PanelCounts {
  const bySeverity: Record<QaSeverity, number> = { error: 0, warning: 0, info: 0 };
  const byRule = new Map<QaRule, number>();
  let dismissed = 0;
  for (const i of issues) {
    if (!positions.has(i.segmentId)) continue;
    if (i.dismissed) dismissed++;
    if (i.dismissed && !filter.showDismissed) continue;
    if (filter.rule === null || i.rule === filter.rule) bySeverity[i.severity]++;
    if (filter.severities.size === 0 || filter.severities.has(i.severity)) {
      byRule.set(i.rule, (byRule.get(i.rule) ?? 0) + 1);
    }
  }
  const sorted = new Map(
    QA_RULE_ORDER.filter((r) => byRule.has(r)).map((r) => [r, byRule.get(r)!]),
  );
  return { bySeverity, byRule: sorted, dismissed };
}

/** `severities` with `severity` added, or taken out if it was in. */
export function toggleSeverity(
  severities: ReadonlySet<QaSeverity>,
  severity: QaSeverity,
): ReadonlySet<QaSeverity> {
  const next = new Set(severities);
  if (!next.delete(severity)) next.add(severity);
  return next;
}

/**
 * The file's findings with one replaced by the server's answer for it,
 * matched by segment and rule — the finding's key (`api.setQaDismissed`).
 * One QA has since cleared is not brought back.
 */
export function withIssue(issues: readonly QaIssue[], updated: QaIssue): QaIssue[] {
  return issues.map((i) =>
    i.segmentId === updated.segmentId && i.rule === updated.rule ? updated : i,
  );
}
