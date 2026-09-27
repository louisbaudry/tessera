import type { Segment, Token } from '@cat-tool/core';
import { describe, expect, it } from 'vitest';

import { createSaveQueue, type SaveResult } from './save-queue.js';

const text = (v: string): Token[] => [{ t: 'text', v }];

/**
 * A fake server: records each write, versions it in the order it was
 * sent (the order the server takes them), answers when told to — the
 * oldest unanswered write, or the one at `which`.
 */
function harness() {
  const sent: Array<{
    id: number;
    v: string;
    base: string | undefined;
    urgent: boolean;
  }> = [];
  const answers: Array<(ok: boolean) => void> = [];
  const saved: string[] = [];
  const latest: boolean[] = [];
  const failed: Array<[number, boolean]> = [];
  let version = 0;
  const queue = createSaveQueue({
    send: (id, tokens, base, urgent) => {
      sent.push({ id, v: (tokens[0] as { v: string }).v, base, urgent });
      const updatedAt = `v${++version}`;
      return new Promise<SaveResult>((resolve, reject) =>
        answers.push((ok) =>
          ok
            ? resolve({ segment: { id, updatedAt } as Segment, rerun: [id], issues: [] })
            : reject(new Error('conflict')),
        ),
      );
    },
    loadedVersion: () => 'v0',
    onSaved: (_id, result, isLatest) => {
      saved.push(result.segment.updatedAt);
      latest.push(isLatest);
    },
    onFailed: (id, _error, isLatest) => failed.push([id, isLatest]),
  });
  const answer = async (ok = true, which = 0) => {
    answers.splice(which, 1)[0]!(ok);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { queue, sent, saved, latest, failed, answer };
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
    expect(h.failed).toEqual([[1, false]]);
    expect(h.sent.map((s) => [s.v, s.base])).toEqual([
      ['a', 'v0'],
      ['b', 'v0'],
    ]);
    await h.answer(false);
    expect(h.failed).toEqual([
      [1, false],
      [1, true],
    ]);
  });

  it('says an answer is not the latest while a later write of the segment waits', async () => {
    // Edit to "a", leave; reopen, edit to "b", leave: the row shows "b",
    // which the answer for "a" must not replace.
    const h = harness();
    h.queue.save(1, text('a'));
    h.queue.save(1, text('b'));
    await h.answer();
    expect(h.latest).toEqual([false]);
    await h.answer();
    expect(h.latest).toEqual([false, true]);
    // A write asked for after the answer came makes that answer no less the latest then.
    h.queue.save(1, text('c'));
    await h.answer();
    expect(h.latest).toEqual([false, true, true]);
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

  it('sends an urgent write with no version while its own write is in flight', async () => {
    // With "a"'s base it would be a certain conflict: "a" is about to replace v0.
    const h = harness();
    h.queue.save(2, text('x'), true);
    h.queue.save(1, text('a'));
    h.queue.save(1, text('b'));
    h.queue.save(1, text('c'), true);
    expect(h.sent.map((s) => [s.id, s.v, s.base])).toEqual([
      [2, 'x', 'v0'],
      [1, 'a', 'v0'],
      [1, 'c', undefined],
    ]);
    // What waited ("b") is older than the urgent write, and is never sent.
    await h.answer();
    await h.answer();
    await h.answer();
    expect(h.sent).toHaveLength(3);
    expect(h.latest).toEqual([true, false, true]);
  });

  it("keeps the newer version when an earlier write's answer comes last", async () => {
    const h = harness();
    h.queue.save(1, text('a'));
    h.queue.save(1, text('b'), true);
    // The server took "a" (v1) then "b" (v2); "b"'s answer arrives first.
    await h.answer(true, 1);
    await h.answer();
    expect(h.saved).toEqual(['v2', 'v1']);
    h.queue.save(1, text('c'));
    expect(h.sent[2]).toMatchObject({ v: 'c', base: 'v2' });
  });
});
