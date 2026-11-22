import { describe, expect, it } from 'vitest';

import { failedAnnouncement, savedAnnouncement, type AnsweredWrite } from './announce.js';

const write = (over: Partial<AnsweredWrite>): AnsweredWrite => ({
  position: 12,
  kind: 'save',
  before: 'translated',
  after: 'translated',
  confirmFollows: false,
  qa: undefined,
  ...over,
});

describe('savedAnnouncement', () => {
  it('says a confirm that landed, by the number the gutter shows', () => {
    expect(
      savedAnnouncement(
        write({ kind: 'confirm', before: 'translated', after: 'confirmed' }),
      ),
    ).toBe('Segment 12 confirmed.');
  });

  it('says a confirm of a segment that was confirmed already: the person asked', () => {
    expect(
      savedAnnouncement(
        write({ kind: 'confirm', before: 'confirmed', after: 'confirmed' }),
      ),
    ).toBe('Segment 12 confirmed.');
  });

  it('adds the QA findings the confirm left on the segment', () => {
    const confirmed = write({ kind: 'confirm', after: 'confirmed' });
    expect(
      savedAnnouncement({
        ...confirmed,
        qa: { severity: 'error', count: 1, messages: ['tag.missing: 1'] },
      }),
    ).toBe('Segment 12 confirmed, with 1 QA finding.');
    expect(
      savedAnnouncement({
        ...confirmed,
        qa: { severity: 'warning', count: 3, messages: ['a', 'b', 'c'] },
      }),
    ).toBe('Segment 12 confirmed, with 3 QA findings.');
  });

  it('says nothing for a save that leaves a confirmation as it was', () => {
    // The save every leave of a segment makes: the one an announcement would bury the rest under.
    expect(savedAnnouncement(write({ before: 'new', after: 'translated' }))).toBeNull();
    expect(savedAnnouncement(write({ before: 'draft', after: 'translated' }))).toBeNull();
    expect(
      savedAnnouncement(write({ before: 'translated', after: 'translated' })),
    ).toBeNull();
    // An edit that changed nothing visible is written as nothing: still confirmed.
    expect(
      savedAnnouncement(write({ before: 'confirmed', after: 'confirmed' })),
    ).toBeNull();
  });

  it('says an edit that took a segment out of confirmed', () => {
    expect(savedAnnouncement(write({ before: 'confirmed', after: 'translated' }))).toBe(
      'Segment 12 is no longer confirmed.',
    );
    expect(savedAnnouncement(write({ before: 'confirmed', after: 'new' }))).toBe(
      'Segment 12 is no longer confirmed.',
    );
  });

  it('keeps quiet about that when a confirm follows the save', () => {
    // Ctrl+Enter on an edited, confirmed segment: the confirm's answer is the news.
    expect(
      savedAnnouncement(
        write({ before: 'confirmed', after: 'translated', confirmFollows: true }),
      ),
    ).toBeNull();
  });

  it('says nothing when a draft is taken: the editor shows it', () => {
    expect(
      savedAnnouncement(write({ kind: 'accept', before: 'new', after: 'draft' })),
    ).toBeNull();
  });

  it('names a segment the page no longer lists without a number', () => {
    expect(
      savedAnnouncement(
        write({
          kind: 'confirm',
          position: undefined,
          before: undefined,
          after: 'confirmed',
        }),
      ),
    ).toBe('A segment confirmed.');
  });

  it('writes a large number as the gutter does', () => {
    expect(
      savedAnnouncement(write({ kind: 'confirm', position: 12345, after: 'confirmed' })),
    ).toBe(`Segment ${(12345).toLocaleString()} confirmed.`);
  });
});

describe('failedAnnouncement', () => {
  it('puts the segment before the message the row keeps', () => {
    expect(failedAnnouncement(7, 'Not confirmed: the segment has no target')).toBe(
      'Segment 7: Not confirmed: the segment has no target',
    );
    expect(failedAnnouncement(undefined, 'Not saved: offline')).toBe(
      'A segment: Not saved: offline',
    );
  });
});
