import type { Segment, Token } from '@cat-tool/core';
import { describe, expect, it } from 'vitest';

import { createSaveQueue, type SaveResult } from './save-queue.js';

const text = (v: string): Token[] => [{ t: 'text', v }];

/** A fake server: records each write, answers when told to. */
function harness() {
  const sent: Array<{
    id: number;
    v: string;
    base: string | undefined;
    urgent: boolean;
  }> = [];
  const answers: Array<(ok: boolean) => void> = [];
  const saved: string[] = [];
  const failed: number[] = [];
  let version = 0;
  const queue = createSaveQueue({
    send: (id, tokens, base, urgent) => {
      sent.push({ id, v: (tokens[0] as { v: string }).v, base, urgent });
      return new Promise<SaveResult>((resolve, reject) =>
        answers.push((ok) =>
          ok
            ? resolve({
                segment: { id, updatedAt: `v${++version}` } as Segment,
                rerun: [id],
                issues: [],
              })
            : reject(new Error('conflict')),
        ),
      );
    },
    loadedVersion: () => 'v0',
    onSaved: (_id, result) => saved.push(result.segment.updatedAt),
    onFailed: (id) => failed.push(id),
  });
  const answer = async (ok = true) => {
    answers.shift()!(ok);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { queue, sent, saved, failed, answer };
}

describe('createSaveQueue', () => {
  it('sends a write with the version the page loaded', () => {
    const h = harness();
    h.queue.save(1, text('a'));
    expect(h.sent).toEqual([{ id: 1, v: 'a', base: 'v0', urgent: false }]);
  });

  it('holds a second write until the first answers, then sends the latest with the new version', async () => {
    const h = harness();
    h.queue.save(1, text('a'));
    h.queue.save(1, text('b'));
    h.queue.save(1, text('c'));
    expect(h.sent).toHaveLength(1);
    await h.answer();
    expect(h.sent.map((s) => [s.v, s.base])).toEqual([
      ['a', 'v0'],
      ['c', 'v1'],
    ]);
    await h.answer();
    expect(h.saved).toEqual(['v1', 'v2']);
  });

  it('keeps segments apart', () => {
    const h = harness();
    h.queue.save(1, text('a'));
    h.queue.save(2, text('b'));
    expect(h.sent.map((s) => s.id)).toEqual([1, 2]);
  });

  it('reports a failure and still sends what waited', async () => {
    const h = harness();
    h.queue.save(1, text('a'));
    h.queue.save(1, text('b'));
    await h.answer(false);
    expect(h.failed).toEqual([1]);
    expect(h.sent.map((s) => [s.v, s.base])).toEqual([
      ['a', 'v0'],
      ['b', 'v0'],
    ]);
  });

  it('sends an urgent write at once, page going away', () => {
    const h = harness();
    h.queue.save(1, text('a'));
    h.queue.save(1, text('b'), true);
    expect(h.sent.map((s) => [s.v, s.urgent])).toEqual([
      ['a', false],
      ['b', true],
    ]);
  });
});
