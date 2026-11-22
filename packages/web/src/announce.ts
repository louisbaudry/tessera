/**
 * What the editor says to a screen reader about a write (issue #391, audit N3,
 * `planning/accessibility-audit.md` §10). A sighted translator sees a row's badge change;
 * the grid puts the same fact, as text, in one of two regions that are read and not drawn.
 *
 * The rule is that a **confirmation** is what gets said: gained, lost or refused, and any
 * write that failed. A save that changes nothing about a confirmation is silent: one goes
 * every time a segment is left, the row's status is already its name, and an announcement
 * per save would bury the ones that matter.
 *
 * Pure: the grid gives it what the queue answered, so the wording is tested in node.
 */
import type { SegmentStatus } from '@cat-tool/core';

import type { QaMark } from './gutter.js';
import type { WriteKind } from './save-queue.js';

/** A write the server answered, as the grid knows it when the answer arrives. */
export interface AnsweredWrite {
  /** The segment's number as the gutter shows it; undefined if the row is gone. */
  readonly position: number | undefined;
  /** Which request was answered. */
  readonly kind: WriteKind;
  /** The status the row showed before the answer; undefined if the row is gone. */
  readonly before: SegmentStatus | undefined;
  /** The status the server stored. */
  readonly after: SegmentStatus;
  /** A confirm is still to go after this write: its answer speaks for the segment. */
  readonly confirmFollows: boolean;
  /** The segment's undismissed findings now, when QA reran with the write. */
  readonly qa: QaMark | undefined;
}

/** "Segment 12", or "A segment" for one the page no longer lists (merged away). */
function named(position: number | undefined): string {
  return position === undefined ? 'A segment' : `Segment ${position.toLocaleString()}`;
}

/**
 * What an answered write is worth saying, or null for nothing.
 *
 * - A confirm that landed: "Segment 12 confirmed.", with the count of QA findings the
 *   confirm left on it, because that count is what the gutter shows next.
 * - A save that took a confirmed segment out of `confirmed` (it was edited): "Segment 12 is
 *   no longer confirmed." Not when a confirm follows: Ctrl+Enter on an edited, confirmed
 *   segment saves and then confirms, and the save's half is not news.
 * - Any other save, and a draft taken: nothing.
 */
export function savedAnnouncement(write: AnsweredWrite): string | null {
  if (write.kind === 'confirm' && write.after === 'confirmed') {
    const findings =
      write.qa === undefined
        ? ''
        : write.qa.count === 1
          ? ', with 1 QA finding'
          : `, with ${write.qa.count.toLocaleString()} QA findings`;
    return `${named(write.position)} confirmed${findings}.`;
  }
  if (
    write.kind === 'save' &&
    write.before === 'confirmed' &&
    write.after !== 'confirmed' &&
    !write.confirmFollows
  ) {
    return `${named(write.position)} is no longer confirmed.`;
  }
  return null;
}

/**
 * A write that failed, said with the message the row keeps ("Not saved: ...",
 * "Not confirmed: ..."): the segment first, because by the time the answer comes the
 * translator is usually on another one.
 */
export function failedAnnouncement(
  position: number | undefined,
  message: string,
): string {
  return `${named(position)}: ${message}`;
}
