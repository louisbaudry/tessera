/**
 * The editor's reading view (issue #172): the file as running text below the grid, each sentence
 * in its target where it has one, else in its source, which is shown greyed and in the source's
 * language. Built from the grid's own segments, so an edit shows here as soon as the grid has it.
 * A click (or Enter) on a sentence jumps the grid to it, as the QA panel's list does.
 *
 * What it draws and what it leaves out is `reading-view.ts`'s; this holds the rendering only.
 */
import type { Segment } from '@cat-tool/core';
import { useMemo, type ReactNode } from 'react';

import {
  readingProgress,
  readingSummary,
  readingView,
  type ReadingMark,
  type ReadingSpan,
} from './reading-view.js';

/** The element each mark is drawn with: a `Record`, so a new mark fails this typecheck. */
const MARK_TAG: Record<
  ReadingMark,
  'strong' | 'em' | 'u' | 's' | 'sup' | 'sub' | 'span'
> = {
  b: 'strong',
  i: 'em',
  u: 'u',
  strike: 's',
  sup: 'sup',
  sub: 'sub',
  // A link is shown as one, never followed: its target is the document's, not ours to open.
  link: 'span',
};

function Span({ span }: { span: ReadingSpan }) {
  let node: ReactNode = span.text;
  for (const mark of [...span.marks].reverse()) {
    const Tag = MARK_TAG[mark];
    node = <Tag className={mark === 'link' ? 'reading-link' : undefined}>{node}</Tag>;
  }
  return <>{node}</>;
}

export function ReadingView({
  segments,
  srcLang,
  tgtLang,
  onJump,
}: {
  segments: readonly Segment[];
  srcLang: string;
  tgtLang: string;
  onJump: (segmentId: number) => void;
}) {
  const sections = useMemo(() => readingView(segments), [segments]);
  const progress = useMemo(() => readingProgress(sections), [sections]);

  return (
    <section className="reading-view" aria-label="Reading view">
      <p className="muted reading-note">
        Reading view: the text and its bold, italic and other inline formats, not the page
        layout. {readingSummary(progress)} Select a sentence to open it in the grid.
      </p>
      <div className="reading-body">
        {sections.map((section) => (
          <div key={section.part} className="reading-part">
            {sections.length > 1 && <h2>{section.title}</h2>}
            {section.paragraphs.map((p) => (
              <p key={p.key}>
                {p.segments.map((s) =>
                  s.spans.length === 0 ? null : (
                    <span
                      key={s.id}
                      role="button"
                      tabIndex={0}
                      className={
                        s.shown === 'source' ? 'reading-seg untranslated' : 'reading-seg'
                      }
                      lang={s.shown === 'source' ? srcLang : tgtLang}
                      onClick={() => onJump(s.id)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        e.preventDefault();
                        onJump(s.id);
                      }}
                    >
                      {s.spans.map((span, i) => (
                        <Span key={i} span={span} />
                      ))}
                    </span>
                  ),
                )}
              </p>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
