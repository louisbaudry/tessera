import type { Segment, Token } from '@cat-tool/core';
import { describe, expect, it } from 'vitest';

import { createPageHide, createSaveQueue, type SaveResult } from './save-queue.js';

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
  const failed: Array<[number, boolean, string]> = [];
  const confirms: Array<{ id: number; base: string | undefined }> = [];
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
    onFailed: (id, _error, isLatest, kind) => failed.push([id, isLatest, kind]),
    confirm: (id, base) => {
      confirms.push({ id, base });
      const updatedAt = `v${++version}`;
      return new Promise<SaveResult>((resolve, reject) =>
        answers.push((ok) =>
          ok
            ? resolve({ segment: { id, updatedAt } as Segment, rerun: [id], issues: [] })
            : reject(new Error('no memory')),
        ),
      );
    },
  });
  const answer = async (ok = true, which = 0) => {
    answers.splice(which, 1)[0]!(ok);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { queue, sent, confirms, saved, latest, failed, answer };
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
    expect(h.failed).toEqual([[1, false, 'save']]);
    expect(h.sent.map((s) => [s.v, s.base])).toEqual([
      ['a', 'v0'],
      ['b', 'v0'],
    ]);
    await h.answer(false);
    expect(h.failed).toEqual([
      [1, false, 'save'],
      [1, true, 'save'],
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

  it('flushes every waiting write at once when the page goes away', async () => {
    // Leave 5 ("a" in flight), reopen and leave it again ("b" waits), move
    // to 6 and close the tab: 6's editor sends its own, the flush sends "b".
    const h = harness();
    h.queue.save(5, text('a'));
    h.queue.save(5, text('b'));
    h.queue.save(6, text('c'), true);
    h.queue.flush();
    expect(h.sent.map((s) => [s.id, s.v, s.base, s.urgent])).toEqual([
      [5, 'a', 'v0', false],
      [6, 'c', 'v0', true],
      // Its own write is in flight: with that one's base, a certain conflict.
      [5, 'b', undefined, true],
    ]);
    await h.answer();
    await h.answer();
    await h.answer();
    // Nothing waits any more, so "a"'s answer sends nothing after it.
    expect(h.sent).toHaveLength(3);
    expect(h.latest).toEqual([false, true, true]);
    h.queue.flush();
    expect(h.sent).toHaveLength(3);
  });

  it("flushes nothing twice: the open editor's urgent write already replaced its waiting one", () => {
    const h = harness();
    h.queue.save(5, text('a'));
    h.queue.save(5, text('b'));
    h.queue.save(5, text('c'), true);
    h.queue.flush();
    expect(h.sent.map((s) => [s.v, s.base])).toEqual([
      ['a', 'v0'],
      ['c', undefined],
    ]);
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

describe('createSaveQueue confirm', () => {
  it('confirms at once when the segment has no write on its way', () => {
    const h = harness();
    h.queue.confirm(1);
    expect(h.confirms).toEqual([{ id: 1, base: 'v0' }]);
  });

  it("waits for the segment's write, then confirms over the version it returned", async () => {
    const h = harness();
    h.queue.save(1, text('a'));
    h.queue.confirm(1);
    expect(h.confirms).toEqual([]);
    await h.answer();
    expect(h.confirms).toEqual([{ id: 1, base: 'v1' }]);
    await h.answer();
    // Both answers reach the row; the confirm's is the newest version.
    expect(h.saved).toEqual(['v1', 'v2']);
    expect(h.latest).toEqual([true, true]);
  });

  it('sends a waiting write first, then confirms once, over the last version', async () => {
    const h = harness();
    h.queue.save(1, text('a'));
    h.queue.save(1, text('b'));
    h.queue.confirm(1);
    await h.answer();
    expect(h.sent.map((s) => s.v)).toEqual(['a', 'b']);
    expect(h.confirms).toEqual([]);
    await h.answer();
    expect(h.confirms).toEqual([{ id: 1, base: 'v2' }]);
  });

  it('never confirms after a write failed: it would approve the text that write replaced', async () => {
    const h = harness();
    h.queue.save(1, text('a'));
    h.queue.confirm(1);
    await h.answer(false);
    expect(h.confirms).toEqual([]);
    expect(h.failed).toEqual([[1, true, 'save']]);
  });

  it('drops a confirm that has not gone when the segment is edited again', async () => {
    const h = harness();
    h.queue.save(1, text('a'));
    h.queue.confirm(1);
    h.queue.save(1, text('b'));
    await h.answer();
    await h.answer();
    expect(h.sent.map((s) => s.v)).toEqual(['a', 'b']);
    expect(h.confirms).toEqual([]);
  });

  it("holds an edit made while its confirm is on its way, over the confirm's version", async () => {
    const h = harness();
    h.queue.confirm(1);
    h.queue.save(1, text('b'));
    expect(h.sent).toEqual([]);
    await h.answer();
    expect(h.sent.map((s) => [s.v, s.base])).toEqual([['b', 'v1']]);
    // The confirm's answer is not for the text now on screen.
    expect(h.latest).toEqual([false]);
  });

  it('reports a failed confirm as one, and keeps segments apart', async () => {
    const h = harness();
    h.queue.save(2, text('x'));
    h.queue.confirm(1);
    expect(h.confirms).toEqual([{ id: 1, base: 'v0' }]);
    await h.answer(true, 1);
    await h.answer(true, 0);
    expect(h.failed).toEqual([]);
    h.queue.confirm(1);
    await h.answer(false);
    expect(h.failed).toEqual([[1, true, 'confirm']]);
  });
});

describe('createSaveQueue — before a merge or split', () => {
  it('is idle at once for segments with nothing outstanding', async () => {
    const h = harness();
    h.queue.save(1, text('a'));
    await expect(h.queue.whenIdle([2, 3])).resolves.toBeUndefined();
  });

  it('waits for every write of the segments, including one that waited its turn', async () => {
    const h = harness();
    h.queue.save(1, text('a'));
    h.queue.save(1, text('b'));
    h.queue.save(2, text('x'));
    let idle = false;
    void h.queue.whenIdle([1, 2]).then(() => (idle = true));
    await h.answer(true, 1); // segment 2's write
    expect(idle).toBe(false);
    await h.answer(); // segment 1's first write; its second is sent next
    expect(idle).toBe(false);
    await h.answer();
    expect(idle).toBe(true);
  });

  it('is idle when the last write failed too: the merge reads what is stored', async () => {
    const h = harness();
    h.queue.save(1, text('a'));
    let idle = false;
    void h.queue.whenIdle([1]).then(() => (idle = true));
    await h.answer(false);
    expect(idle).toBe(true);
  });

  it('knows the version the next write goes over, and forgets it once replaced', async () => {
    const h = harness();
    expect(h.queue.version(1)).toBe('v0');
    h.queue.save(1, text('a'));
    await h.answer();
    expect(h.queue.version(1)).toBe('v1');
    h.queue.forget([1]);
    expect(h.queue.version(1)).toBe('v0'); // the page's own copy, which it has updated
  });
});

describe('createPageHide', () => {
  it("sends the open editor's write before the waiting ones, and none twice", () => {
    // 5 left ("a" in flight), left again ("b" waits), reopened and edited
    // to "c"; 7 left twice ("x" in flight, "y" waits). Then the tab closes.
    const h = harness();
    const page = createPageHide(h.queue);
    h.queue.save(5, text('a'));
    h.queue.save(5, text('b'));
    h.queue.save(7, text('x'));
    h.queue.save(7, text('y'));
    page.register(() => h.queue.save(5, text('c'), true));
    page.onPageHide();
    // Flushed first, "b" and "c" would both be in flight unversioned, racing.
    expect(h.sent.map((s) => [s.id, s.v, s.base, s.urgent])).toEqual([
      [5, 'a', 'v0', false],
      [7, 'x', 'v0', false],
      [5, 'c', undefined, true],
      [7, 'y', undefined, true],
    ]);
  });

  it('forgets a closed editor, and never the one opened after it', () => {
    const h = harness();
    const page = createPageHide(h.queue);
    const left: string[] = [];
    const releaseFirst = page.register(() => left.push('first'));
    page.register(() => left.push('second'));
    releaseFirst();
    page.onPageHide();
    expect(left).toEqual(['second']);
  });
});
