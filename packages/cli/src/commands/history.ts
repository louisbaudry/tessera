import type { AuditDetail, AuditEventRow, Token } from '@cat-tool/core';
import { getSegment, listEvents } from '@cat-tool/db';

import {
  CliError,
  integer,
  openExistingProject,
  parse,
  positional,
  type CliIo,
} from '../support.js';

export const HISTORY_USAGE = 'cat-tool history <project.catdb> <segment-id>';

/**
 * A target as a reader of the log needs it: its text, with each tag
 * marked by id — `{1}` … `{/1}`, `{2/}` — since a tag reapplied or
 * dropped is often the whole of an edit.
 */
function render(tokens: readonly Token[]): string {
  const parts = tokens.map((tok) => {
    switch (tok.t) {
      case 'text':
        return tok.v;
      case 'open':
        return `{${tok.id}}`;
      case 'close':
        return `{/${tok.id}}`;
      case 'ph':
        return `{${tok.id}/}`;
    }
  });
  return JSON.stringify(parts.join(''));
}

/** What a segment event says, in one line: the state it recorded, or what it wrote. */
function describe(event: AuditEventRow): string {
  if (event.detail === null) return '';
  switch (event.action) {
    case 'segment.target_set':
    case 'segment.baseline': {
      const d = JSON.parse(event.detail) as AuditDetail['segment.target_set'];
      const text = d.target_tokens === null ? '(no target)' : render(d.target_tokens);
      return `${d.status}\t${d.origin ?? '-'}\t${text}`;
    }
    case 'segment.confirmed': {
      const d = JSON.parse(event.detail) as AuditDetail['segment.confirmed'];
      return d.tm_write ? `TM unit ${d.tm_write.tu_uuid} rev ${d.tm_write.rev}` : '';
    }
    default:
      return event.detail;
  }
}

/**
 * A segment's audit history, oldest first (audit-spec.md §7): one line
 * per event — id, time, actor, action, what it recorded.
 */
export function history(args: readonly string[], io: CliIo): number {
  const { positionals } = parse(args, {});
  const projectPath = positional(positionals, 0, 'project path', HISTORY_USAGE);
  const idArg = positional(positionals, 1, 'segment id', HISTORY_USAGE);

  const { db } = openExistingProject(projectPath);
  try {
    const segmentId = integer(idArg, 'segment id')!;
    if (!getSegment(db, segmentId)) {
      throw new CliError(`no segment #${segmentId} in this project`);
    }
    const events = listEvents(db, {
      subjectType: 'segment',
      subjectId: String(segmentId),
    });
    for (const event of events) {
      const batch = event.batchId === null ? '' : ` (batch #${event.batchId})`;
      io.stdout(
        [
          `#${event.id}`,
          event.at,
          event.actor,
          `${event.action}${batch}`,
          describe(event),
        ]
          .filter((field) => field !== '')
          .join('\t'),
      );
    }
    io.stdout(`${events.length} events for segment #${segmentId}`);
  } finally {
    db.close();
  }
  return 0;
}
