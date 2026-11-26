/**
 * The editor's reading view (issue #172): the file as running text below the grid, each sentence
 * in its target where it has one, else in its source, which is shown greyed and in the source's
 * language. Built from the grid's own segments, so an edit shows here as soon as the grid has it.
 * A click (or Enter) on a sentence jumps the grid to it, as the QA panel's list does.
 *
 * "Source beside" (slice 2) puts the source in a column to the left, paragraph by paragraph on one
 * row, for reading a translation against its original; pointing at a sentence on either side
 * marks its counterpart on the other.
 *
 * What it draws and what it leaves out is `reading-view.ts`'s; this holds the rendering only.
 */
import type { Segment } from '@cat-tool/core';
import { Fragment, useMemo, useState, type ReactNode } from 'react';

import {
  hasShownText,
  readingProgress,
  readingSummary,
  readingView,
  type ReadingMark,
  type ReadingParagraph,
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

/** One sentence: a button that opens its segment, marked while its counterpart is pointed at. */
function Sentence({
  id,
  spans,
  lang,
  untranslated,
  paired,
  onJump,
  onPoint,
}: {
  id: number;
  spans: readonly ReadingSpan[];
  lang: string;
  untranslated: boolean;
  paired: boolean;
  onJump: (segmentId: number) => void;
  onPoint: (segmentId: number | null) => void;
}) {
  const classes = ['reading-seg'];
  if (untranslated) classes.push('untranslated');
  if (paired) classes.push('paired');
  return (
    <span
      role="button"
      tabIndex={0}
      className={classes.join(' ')}
      lang={lang}
      onClick={() => onJump(id)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        onJump(id);
      }}
      onMouseEnter={() => onPoint(id)}
      onMouseLeave={() => onPoint(null)}
      onFocus={() => onPoint(id)}
      onBlur={() => onPoint(null)}
    >
      {spans.map((span, i) => (
        <Span key={i} span={span} />
      ))}
    </span>
  );
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
  // Not kept between visits, like the view itself.
  const [beside, setBeside] = useState(false);
  const [pointed, setPointed] = useState<number | null>(null);

  const shownSide = (p: ReadingParagraph) => (
    <p lang={tgtLang}>
      {p.segments.map((s) =>
        s.spans.length === 0 ? (
          s.before
        ) : (
          <Fragment key={s.id}>
            {s.before}
            <Sentence
              id={s.id}
              spans={s.spans}
              lang={s.shown === 'source' ? srcLang : tgtLang}
              untranslated={s.shown === 'source'}
              paired={beside && pointed === s.id}
              onJump={onJump}
              onPoint={setPointed}
            />
          </Fragment>
        ),
      )}
    </p>
  );
  const sourceSide = (p: ReadingParagraph) => (
    <p lang={srcLang}>
      {p.segments.map((s) =>
        s.sourceSpans.length === 0 ? null : (
          <Sentence
            key={s.id}
            id={s.id}
            spans={s.sourceSpans}
            lang={srcLang}
            untranslated={false}
            paired={pointed === s.id}
            onJump={onJump}
            onPoint={setPointed}
          />
        ),
      )}
    </p>
  );

  return (
    <section className="reading-view" aria-label="Reading view">
      <div className="reading-head">
        <p className="muted reading-note">
          Reading view: the text and its bold, italic and other inline formats, not the
          page layout. {readingSummary(progress)} Select a sentence to open it in the
          grid.
        </p>
        <label className="toggle">
          <input
            type="checkbox"
            checked={beside}
            onChange={(e) => setBeside(e.target.checked)}
          />{' '}
          Source beside
        </label>
      </div>
      <div className={beside ? 'reading-body beside' : 'reading-body'}>
        {beside && (
          <div className="reading-row reading-columns" aria-hidden="true">
            <span className="muted">Source {srcLang}</span>
            <span className="muted">Target {tgtLang}</span>
          </div>
        )}
        {sections.map((section) => (
          <div key={section.part} className="reading-part">
            {sections.length > 1 && <h2>{section.title}</h2>}
            {section.paragraphs.map((p) =>
              beside ? (
                <div key={p.key} className="reading-row">
                  {sourceSide(p)}
                  {shownSide(p)}
                </div>
              ) : hasShownText(p) ? (
                <Fragment key={p.key}>{shownSide(p)}</Fragment>
              ) : null,
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
