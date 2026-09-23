/** QA rules and issues. See planning/v1-spec.md §6.4. */

export type QaSeverity = 'error' | 'warning' | 'info';

export const QA_RULES = [
  'tag.missing',
  'tag.extra',
  'tag.unbalanced',
  'seg.empty',
  'seg.untranslated',
  'consistency.target_differs',
  'consistency.source_differs',
  'num.missing',
  'num.altered',
  'punct.terminal',
  'punct.brackets',
  /** Spanish only: `?` without `¿`, or `!` without `¡`. No analogue in the other six languages. */
  'punct.inverted',
  'punct.spacing',
] as const;

export type QaRule = (typeof QA_RULES)[number];

export const DEFAULT_SEVERITY: Readonly<Record<QaRule, QaSeverity>> = {
  'tag.missing': 'error',
  'tag.extra': 'error',
  'tag.unbalanced': 'error',
  'seg.empty': 'error',
  'seg.untranslated': 'warning',
  'consistency.target_differs': 'warning',
  'consistency.source_differs': 'info',
  'num.missing': 'error',
  'num.altered': 'warning',
  'punct.terminal': 'warning',
  'punct.brackets': 'error',
  'punct.inverted': 'error',
  'punct.spacing': 'warning',
};

export interface QaIssue {
  readonly id: number;
  readonly segmentId: number;
  readonly rule: QaRule;
  readonly severity: QaSeverity;
  readonly message: string;
  readonly dismissed: boolean;
  readonly runAt: string;
}

export function isBlocking(issue: QaIssue): boolean {
  return issue.severity === 'error' && !issue.dismissed;
}
