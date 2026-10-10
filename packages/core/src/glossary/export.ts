/**
 * A glossary as the CSV a client takes away (backlog #162, portal-v0-spec.md
 * §9). Pure: rows in, text out; which terms exist and which rendering is
 * preferred is `db`'s (`db/glossary/export.ts`).
 *
 * One row per rendering, in long form, so any number of languages fits in the
 * same four columns and a spreadsheet filters on `lang`. `concept` groups the
 * renderings of one term; it is a position in this export, never the term's
 * row id, so nothing internal to the file leaves with it. What does not leave:
 * notes, who changed a term, and the decision log (the client asked for their
 * terms, not for how the owner arrived at them).
 */

import { csvCell } from '../model/csv.js';

/** How a rendering stands in the glossary, as a person reads it. */
export const GLOSSARY_EXPORT_STATUSES = ['preferred', 'allowed', 'forbidden'] as const;
export type GlossaryExportStatus = (typeof GLOSSARY_EXPORT_STATUSES)[number];

export interface GlossaryExportRow {
  /** 1-based position of the term in this export; renderings of one term share it. */
  readonly concept: number;
  readonly lang: string;
  readonly term: string;
  readonly status: GlossaryExportStatus;
}

export const GLOSSARY_CSV_COLUMNS = ['concept', 'lang', 'term', 'status'] as const;

/** The rows as CSV (RFC 4180, CRLF, free text neutralised against formula injection). */
export function glossaryCsv(rows: readonly GlossaryExportRow[]): string {
  const lines = [GLOSSARY_CSV_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push([String(r.concept), csvCell(r.lang), csvCell(r.term), r.status].join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
