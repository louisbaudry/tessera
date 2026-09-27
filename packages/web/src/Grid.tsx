/**
 * The segment grid (v1-spec.md §7.1; backlog #28): source left, target
 * right, a status/origin/QA gutter, and only the rows on screen in the
 * DOM. Read-only — editing the target is #29, the keyboard model #30.
 */
import type { FormatEntry, QaIssue, Segment, Token } from '@cat-tool/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useMemo, useRef } from 'react';

import { api, type FileSegments, type ProjectDetail } from './api.js';
import { originBadge, qaMarks, STATUS_BADGE, statusOf, type QaMark } from './gutter.js';
import { estimateRowHeight } from './layout.js';
import { toPieces } from './pieces.js';
import { useLoad } from './use-load.js';

interface GridData {
  readonly detail: ProjectDetail;
  readonly file: FileSegments;
  readonly issues: readonly QaIssue[];
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
  return <SegmentGrid data={data.data} />;
}

function SegmentGrid({ data }: { data: GridData }) {
  const { detail, file, issues } = data;
  const segments = file.segments;
  const marks = useMemo(() => qaMarks(issues), [issues]);
  const scrollRef = useRef<HTMLDivElement>(null);

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
  });

  const flagged = useMemo(() => {
    let n = 0;
    for (const mark of marks.values()) if (mark.severity === 'error') n++;
    return n;
  }, [marks]);

  return (
    <section className="grid">
      <div className="grid-meta">
        <strong>{file.file.relPath}</strong>
        <span className="muted">
          {segments.length.toLocaleString()} segments
          {flagged > 0 && ` · ${flagged.toLocaleString()} with QA errors`}
        </span>
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
                  position={item.index + 1}
                  mark={marks.get(segment.id)}
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
  position,
  mark,
}: {
  segment: Segment;
  position: number;
  mark: QaMark | undefined;
}) {
  const status = statusOf(segment);
  const badge = STATUS_BADGE[status];
  const origin = originBadge(segment.origin);
  return (
    <div className={`row status-${status}`} role="row" aria-rowindex={position}>
      <div className="gutter" role="cell">
        <span className="ord">{position}</span>
        <span className="status" title={badge.title}>
          {badge.text}
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
      <div className="cell source" role="cell">
        <TokenText tokens={segment.sourceTokens} formats={segment.formatTable} />
      </div>
      <div className="cell target" role="cell">
        {segment.targetTokens && (
          <TokenText tokens={segment.targetTokens} formats={segment.formatTable} />
        )}
      </div>
    </div>
  );
});

function TokenText({
  tokens,
  formats,
}: {
  tokens: readonly Token[];
  formats: readonly FormatEntry[];
}) {
  return (
    <>
      {toPieces(tokens, formats).map((piece, i) =>
        piece.kind === 'text' ? (
          <span key={i}>{piece.text}</span>
        ) : (
          <span
            key={i}
            className={`chip chip-${piece.role}`}
            title={piece.tagKind ?? 'unknown tag'}
          >
            {piece.label}
          </span>
        ),
      )}
    </>
  );
}
