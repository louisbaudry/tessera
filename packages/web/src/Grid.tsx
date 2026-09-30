/**
 * The segment grid (v1-spec.md §7.1; backlog #28): source left, target
 * right, a status/origin/QA gutter, and only the rows on screen in the
 * DOM. Clicking a target opens it in the tag-aware editor (§7.2; backlog
 * #29) — one row at a time. Ctrl+Enter in it confirms the segment and
 * opens the next one still to do (§7.3; backlog #30).
 */
import type { FormatEntry, QaIssue, Segment, Token } from '@cat-tool/core';
import { isBlankTarget } from '@cat-tool/core/model';
import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
} from '@tanstack/react-virtual';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import {
  api,
  ApiError,
  type FileSegments,
  type ProjectDetail,
  type Restructured,
} from './api.js';
import {
  originBadge,
  qaMarks,
  replaceIssues,
  STATUS_BADGE,
  statusOf,
  type QaMark,
} from './gutter.js';
import { nextUnconfirmed } from './advance.js';
import { estimateRowHeight } from './layout.js';
import { toPieces } from './pieces.js';
import { loadFullTags, saveFullTags } from './prefs.js';
import { createPageHide, createSaveQueue } from './save-queue.js';
import { useSession } from './session-context.js';
import { splitOffset, type SourceChild } from './split-point.js';
import { pairGroups } from './tags.js';
import { TargetEditor, type CommitOptions } from './TargetEditor.js';
import { useLoad } from './use-load.js';

interface GridData {
  readonly detail: ProjectDetail;
  readonly file: FileSegments;
  readonly issues: readonly QaIssue[];
}

/** Why a segment's last write failed: a new object for each failure. */
interface SaveFailure {
  readonly message: string;
}

export function Grid({ project, fileId }: { project: string; fileId: number }) {
  const data = useLoad(
    useCallback(
      async (token: string, signal: AbortSignal): Promise<GridData> => {
        const [detail, file, qa] = await Promise.all([
          api.project(token, project, signal),
          api.segments(token, project, fileId, signal),
          api.qaIssues(token, project, fileId, signal),
        ]);
        return { detail, file, issues: qa.issues };
      },
      [project, fileId],
    ),
  );
  if (data.state === 'loading') return <p className="muted">Loading segments{'…'}</p>;
  if (data.state === 'error') return <p className="error">{data.message}</p>;
  return <SegmentGrid project={project} data={data.data} />;
}

function SegmentGrid({ project, data }: { project: string; data: GridData }) {
  const { detail, file } = data;
  const { token, signOut } = useSession();
  const [segments, setSegments] = useState(file.segments);
  const [issues, setIssues] = useState(data.issues);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [clickAt, setClickAt] = useState<{ x: number; y: number } | undefined>();
  const [unsaved, setUnsaved] = useState<ReadonlyMap<number, SaveFailure>>(new Map());
  const [fullTags, setFullTags] = useState(loadFullTags);
  const [note, setNote] = useState<string | null>(null);
  const marks = useMemo(() => qaMarks(issues), [issues]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeIndex = useMemo(
    () => (activeId === null ? -1 : segments.findIndex((s) => s.id === activeId)),
    [segments, activeId],
  );
  // The editing row stays in the DOM when scrolled away, so it keeps its
  // caret and undo history instead of being unmounted and saved.
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      if (activeIndex < 0 || indexes.includes(activeIndex)) return indexes;
      return [...indexes, activeIndex].sort((a, b) => a - b);
    },
    [activeIndex],
  );

  // The virtualizer's API is not memoisable, which the React compiler
  // lint knows; nothing here relies on memoising it.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: segments.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const s = segments[i]!;
      return estimateRowHeight(s.sourceTokens, s.targetTokens);
    },
    getItemKey: (i) => segments[i]!.id,
    overscan: 10,
    rangeExtractor,
  });

  // Writes go through one queue for the grid's life (`save-queue.ts`); the
  // session and the versions this page loaded are read when a write goes.
  const session = useRef({ token, project, signOut });
  useEffect(() => {
    session.current = { token, project, signOut };
  });
  const loadedVersions = useRef(new Map(file.segments.map((s) => [s.id, s.updatedAt])));
  // The segments of this file, for the answers that cover the project's.
  const [inFile] = useState(() => new Set(file.segments.map((s) => s.id)));
  const [queue] = useState(() => {
    return createSaveQueue({
      send: (segmentId, tokens, baseUpdatedAt, urgent) =>
        api.saveTarget(
          session.current.token,
          session.current.project,
          segmentId,
          { targetTokens: tokens, baseUpdatedAt },
          { keepalive: urgent },
        ),
      confirm: (segmentId, baseUpdatedAt) =>
        api.confirm(session.current.token, session.current.project, segmentId, {
          baseUpdatedAt,
        }),
      loadedVersion: (segmentId) => loadedVersions.current.get(segmentId),
      onSaved: (segmentId, result, latest) => {
        // The row takes what the server stored — unless a later edit of
        // it is still on its way, whose text the row already shows.
        setSegments((all) =>
          all.map((s) =>
            s.id !== segmentId
              ? s
              : latest
                ? result.segment
                : { ...result.segment, targetTokens: s.targetTokens },
          ),
        );
        setIssues((all) => replaceIssues(all, result.rerun, result.issues, inFile));
        if (!latest) return;
        setUnsaved((all) => {
          if (!all.has(segmentId)) return all;
          const next = new Map(all);
          next.delete(segmentId);
          return next;
        });
      },
      onFailed: (segmentId, err, latest, kind) => {
        if (err instanceof ApiError && err.status === 401) {
          session.current.signOut();
          return;
        }
        // A later write of the segment answers for it.
        if (!latest) return;
        const what = err instanceof Error ? err.message : String(err);
        const message =
          kind === 'confirm'
            ? `Not confirmed: ${what}`
            : err instanceof ApiError && err.status === 409
              ? `${err.message}: this edit was not saved. Reload the file to see the segment as it is now.`
              : `Not saved: ${what}`;
        setUnsaved((all) => new Map(all).set(segmentId, { message }));
      },
    });
  });

  // One `pagehide` listener, so the open editor's write goes before the
  // ones still waiting (`createPageHide`), each a `keepalive` request.
  const [pageHide] = useState(() => createPageHide(queue));
  useEffect(() => {
    const onPageHide = () => pageHide.onPageHide();
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [pageHide]);

  const activate = useCallback((id: number, at?: { x: number; y: number }) => {
    setClickAt(at);
    setActiveId(id);
  }, []);
  const leave = useCallback(() => setActiveId(null), []);
  // Ctrl+Enter: the editor has sent any change; the queue confirms after
  // it. The next segment opens at once — the answer, or a refusal shown on
  // the row, follows — and scrolls into view if it is not.
  const segmentsNow = useRef(segments);
  useEffect(() => {
    segmentsNow.current = segments;
  });
  const confirmAndAdvance = useCallback(
    (segmentId: number) => {
      queue.confirm(segmentId);
      const all = segmentsNow.current;
      const to = nextUnconfirmed(
        all,
        all.findIndex((s) => s.id === segmentId),
      );
      if (to === null) {
        setActiveId(null);
        return;
      }
      activate(all[to]!.id);
      virtualizer.scrollToIndex(to, { align: 'auto' });
    },
    [queue, activate, virtualizer],
  );
  const commit = useCallback(
    (segmentId: number, tokens: Token[], options: CommitOptions) => {
      // Shown at once; the server's answer replaces it with what it stored,
      // which for nothing visible but spaces is no target (`isBlankTarget`).
      setSegments((all) =>
        all.map((s) =>
          s.id === segmentId
            ? {
                ...s,
                targetTokens: isBlankTarget(tokens, s.formatTable) ? null : tokens,
              }
            : s,
        ),
      );
      queue.save(segmentId, tokens, options.urgent);
    },
    [queue],
  );

  // Merge and split (§7.4). Both read the segments as stored, so the open
  // editor is closed first — it sends its change as it goes — and the
  // requests wait for every write of these segments already asked for.
  const activeNow = useRef(activeId);
  useEffect(() => {
    activeNow.current = activeId;
  });
  const busy = useRef(false);
  const restructure = useCallback(
    async (kind: 'split' | 'merge') => {
      if (busy.current) return;
      const all = segmentsNow.current;
      const caret = sourceCaret();
      const id =
        kind === 'split' ? caret?.segmentId : (activeNow.current ?? caret?.segmentId);
      if (id === undefined) {
        setNote(
          kind === 'split'
            ? 'Click in the source where the segment should break, then split.'
            : 'Open a segment, or click in its source, to merge it with the next.',
        );
        return;
      }
      const at = all.findIndex((s) => s.id === id);
      const segment = all[at];
      const next = kind === 'merge' ? all[at + 1] : undefined;
      if (!segment || segment.locked || statusOf(segment) === 'locked') {
        setNote('A locked segment cannot be merged or split.');
        return;
      }
      if (kind === 'merge') {
        if (!next || next.part !== segment.part || next.paraKey !== segment.paraKey) {
          setNote(
            'This is the last segment of its paragraph: there is nothing to merge it with.',
          );
          return;
        }
        if (next.locked || statusOf(next) === 'locked') {
          setNote('A locked segment cannot be merged or split.');
          return;
        }
      }
      const involved = next ? [id, next.id] : [id];
      const wasActive =
        activeNow.current !== null && involved.includes(activeNow.current);
      busy.current = true;
      setNote(null);
      try {
        if (wasActive) flushSync(() => setActiveId(null));
        await queue.whenIdle(involved);
        const { token: bearer, project: name } = session.current;
        const result =
          kind === 'split'
            ? await api.split(bearer, name, id, {
                offset: caret!.offset,
                baseUpdatedAt: queue.version(id),
              })
            : await api.merge(bearer, name, id, {
                baseUpdatedAt: queue.version(id),
                nextBaseUpdatedAt: queue.version(next!.id),
              });
        applyRestructure(result);
        if (wasActive) activate(result.segments[0]!.id);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          session.current.signOut();
          return;
        }
        const what = err instanceof Error ? err.message : String(err);
        setNote(
          err instanceof ApiError && err.status === 409
            ? `${what}. Reload the file to see the segment as it is now.`
            : what,
        );
      } finally {
        busy.current = false;
      }
    },
    // `applyRestructure` only touches state setters and refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queue, activate],
  );
  const applyRestructure = (result: Restructured) => {
    const standing = result.segments;
    setSegments((all) =>
      all.flatMap((s) =>
        result.removed.includes(s.id) ? [] : s.id === standing[0]!.id ? standing : [s],
      ),
    );
    for (const s of standing) {
      loadedVersions.current.set(s.id, s.updatedAt);
      inFile.add(s.id);
    }
    for (const id of result.removed) {
      loadedVersions.current.delete(id);
      inFile.delete(id);
    }
    queue.forget([...standing.map((s) => s.id), ...result.removed]);
    setIssues((all) =>
      replaceIssues(
        all.filter((i) => !result.removed.includes(i.segmentId)),
        result.rerun,
        result.issues,
        inFile,
      ),
    );
    setUnsaved((all) => {
      if (!result.removed.some((id) => all.has(id))) return all;
      const kept = new Map(all);
      for (const id of result.removed) kept.delete(id);
      return kept;
    });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Literal Ctrl on every platform, as the editor's other keys (§7.2).
      if (!e.ctrlKey || e.altKey || e.metaKey || e.code !== 'KeyM') return;
      e.preventDefault();
      void restructure(e.shiftKey ? 'split' : 'merge');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [restructure]);

  const flagged = useMemo(() => {
    let n = 0;
    for (const mark of marks.values()) if (mark.severity === 'error') n++;
    return n;
  }, [marks]);

  return (
    <section className={fullTags ? 'grid full-tags' : 'grid'}>
      <div className="grid-meta">
        <strong>{file.file.relPath}</strong>
        <span className="muted">
          {segments.length.toLocaleString()} segments
          {flagged > 0 && ` · ${flagged.toLocaleString()} with QA errors`}
          {unsaved.size > 0 && (
            <span className="error"> · {unsaved.size.toLocaleString()} not saved</span>
          )}
        </span>
        <label className="toggle">
          <input
            type="checkbox"
            checked={fullTags}
            onChange={(e) => {
              setFullTags(e.target.checked);
              saveFullTags(e.target.checked);
            }}
          />{' '}
          Show full tags
        </label>
        <span className="restructure">
          <button
            type="button"
            className="link"
            // Keep the caret where it is: a split reads it.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void restructure('merge')}
            title="Merge the open segment with the next one of its paragraph (Ctrl+M)"
          >
            Merge with next
          </button>
          <button
            type="button"
            className="link"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void restructure('split')}
            title="Split at the caret you put in a source (Ctrl+Shift+M)"
          >
            Split at source caret
          </button>
        </span>
        {note && (
          <span className="error" role="status">
            {note}
          </span>
        )}
      </div>
      <div className="row head" role="row">
        <div className="gutter" role="columnheader">
          #
        </div>
        <div className="cell" role="columnheader">
          Source <span className="muted">{detail.project.srcLang}</span>
        </div>
        <div className="cell" role="columnheader">
          Target <span className="muted">{detail.project.tgtLang}</span>
        </div>
      </div>
      <div
        className="grid-scroll"
        ref={scrollRef}
        role="table"
        aria-rowcount={segments.length}
      >
        <div className="grid-body" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const segment = segments[item.index]!;
            return (
              <div
                key={item.key}
                className={item.index % 2 === 1 ? 'row-slot odd' : 'row-slot'}
                data-index={item.index}
                ref={virtualizer.measureElement}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <SegmentRow
                  segment={segment}
                  project={project}
                  position={item.index + 1}
                  mark={marks.get(segment.id)}
                  active={segment.id === activeId}
                  clickAt={segment.id === activeId ? clickAt : undefined}
                  unsaved={unsaved.get(segment.id)}
                  srcLang={detail.project.srcLang}
                  tgtLang={detail.project.tgtLang}
                  onActivate={activate}
                  onCommit={commit}
                  onLeave={leave}
                  onConfirm={confirmAndAdvance}
                  registerPageHide={pageHide.register}
                />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/** Memoised: scrolling re-renders the slots, not every row's chips. */
const SegmentRow = memo(function SegmentRow({
  segment,
  project,
  position,
  mark,
  active,
  clickAt,
  unsaved,
  srcLang,
  tgtLang,
  onActivate,
  onCommit,
  onLeave,
  onConfirm,
  registerPageHide,
}: {
  segment: Segment;
  project: string;
  position: number;
  mark: QaMark | undefined;
  active: boolean;
  clickAt: { x: number; y: number } | undefined;
  /** Why the last write of this target failed, if it did. */
  unsaved: SaveFailure | undefined;
  srcLang: string;
  tgtLang: string;
  onActivate: (segmentId: number, at: { x: number; y: number }) => void;
  onCommit: (segmentId: number, tokens: Token[], options: CommitOptions) => void;
  onLeave: () => void;
  onConfirm: (segmentId: number) => void;
  registerPageHide: (leaveNow: () => void) => () => void;
}) {
  const groups = useMemo(
    () => pairGroups(segment.sourceTokens, segment.formatTable),
    [segment.sourceTokens, segment.formatTable],
  );
  const status = statusOf(segment);
  const badge = STATUS_BADGE[status];
  const origin = originBadge(segment.origin);
  const editable = status !== 'locked';
  const classes = ['row', `status-${status}`];
  if (active) classes.push('active');
  if (unsaved !== undefined) classes.push('unsaved');
  return (
    <div className={classes.join(' ')} role="row" aria-rowindex={position}>
      <div className="gutter" role="cell">
        <span className="ord">{position}</span>
        <span
          className="status"
          title={unsaved === undefined ? badge.title : unsaved.message}
        >
          {unsaved === undefined ? badge.text : '!'}
        </span>
        <span className="origin" title={origin?.title}>
          {origin?.text}
        </span>
        <span
          className={mark ? `qa qa-${mark.severity}` : 'qa'}
          title={mark?.messages.join('\n')}
          aria-label={mark ? `${mark.count} QA ${mark.severity}` : undefined}
        >
          {mark ? mark.count : ''}
        </span>
      </div>
      <div
        className="cell source"
        role="cell"
        lang={srcLang}
        data-segment-id={segment.id}
      >
        <TokenText
          tokens={segment.sourceTokens}
          formats={segment.formatTable}
          groups={groups}
        />
      </div>
      <div
        className={editable ? 'cell target editable' : 'cell target'}
        role="cell"
        lang={tgtLang}
        title={unsaved?.message}
        onClick={
          editable && !active
            ? (e) => onActivate(segment.id, { x: e.clientX, y: e.clientY })
            : undefined
        }
      >
        {active ? (
          <TargetEditor
            segment={segment}
            project={project}
            tgtLang={tgtLang}
            clickAt={clickAt}
            failed={unsaved}
            onCommit={onCommit}
            onLeave={onLeave}
            onConfirm={onConfirm}
            registerPageHide={registerPageHide}
          />
        ) : (
          segment.targetTokens && (
            <TokenText
              tokens={segment.targetTokens}
              formats={segment.formatTable}
              groups={groups}
            />
          )
        )}
      </div>
    </div>
  );
});

/**
 * The caret the translator put in a source cell: which segment, and the
 * plain-text offset into its source (`splitOffset` — a chip counts no
 * characters). Null when the selection is not in a source. The cell's
 * children are its pieces (`TokenText`), a `<span>` of text or a chip each.
 */
function sourceCaret(): { segmentId: number; offset: number } | null {
  const selection = window.getSelection();
  const anchor = selection?.anchorNode;
  if (!selection || !anchor) return null;
  const cell = (
    anchor instanceof Element ? anchor : anchor.parentElement
  )?.closest<HTMLElement>('.cell.source[data-segment-id]');
  if (!cell) return null;
  const segmentId = Number(cell.dataset.segmentId);
  const pieces = [...cell.children];
  const children: SourceChild[] = pieces.map((el) =>
    el.classList.contains('chip')
      ? { kind: 'chip' }
      : { kind: 'text', length: el.textContent?.length ?? 0 },
  );
  let index: number;
  let within = 0;
  if (anchor === cell) {
    // The caret is between the cell's children: `anchorOffset` of them precede it.
    index = selection.anchorOffset;
  } else {
    let node: Node = anchor;
    while (node.parentNode !== cell) node = node.parentNode!;
    index = pieces.indexOf(node as Element);
    // In a text node the offset counts characters; on the span itself, its
    // child nodes — 0 is its start, anything more its end.
    within =
      anchor.nodeType === Node.TEXT_NODE
        ? selection.anchorOffset
        : selection.anchorOffset > 0
          ? (node.textContent?.length ?? 0)
          : 0;
  }
  return { segmentId, offset: splitOffset(children, index, within) };
}

function TokenText({
  tokens,
  formats,
  groups,
}: {
  tokens: readonly Token[];
  formats: readonly FormatEntry[];
  groups: ReadonlyMap<number, readonly number[]>;
}) {
  return (
    <>
      {toPieces(tokens, formats, groups).map((piece, i) =>
        piece.kind === 'text' ? (
          <span key={i}>{piece.text}</span>
        ) : (
          <span key={i} className={`chip chip-${piece.role}`} title={piece.title}>
            <span className="chip-short">{piece.label}</span>
            <span className="chip-full">{piece.full}</span>
          </span>
        ),
      )}
    </>
  );
}
