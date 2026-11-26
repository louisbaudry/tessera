/**
 * The editor's reading view (issue #172, `v1-spec.md` §7.11): the file's text as one flowing
 * document, paragraph by paragraph in document order, each sentence shown in its target when it
 * has one and in its source when it does not. Pure, so it is proved in node.
 *
 * It is a **reading view, not a layout**. It keeps what the segments themselves carry (the order,
 * the paragraphs, a part such as a footnote or a slide, and the inline formats a tag names:
 * bold, italic, underline, strike, superscript, subscript, a link, a line break, a tab), and it
 * draws nothing the segments do not hold: no page, no font, no heading style, no table, no
 * image. A paragraph of the export that holds no segment (an empty one, a drawing) is not shown.
 * The export (`exportFileBytes`) is the faithful document; this is a way to read the
 * translation in context, and the screen says so.
 *
 * Built from the segments the editor already holds, so it shows exactly what the grid shows,
 * a confirmed target and a draft alike, and the hidden tags no one places are left out as they
 * are everywhere in the editor (`withoutHiddenTags`). A text box's fallback copy
 * (`fallbackCopy`, backlog #34) is the same text a second time and is shown once.
 */
import type { DocPart, FormatEntry, Segment, TagKind, Token } from '@cat-tool/core';
import { plainText, withoutHiddenTags } from '@cat-tool/core/model';

/** The inline formats the view draws. Every other kind of tag is read through. */
export const READING_MARKS = ['b', 'i', 'u', 'strike', 'sup', 'sub', 'link'] as const;
export type ReadingMark = (typeof READING_MARKS)[number];

/** A run of text under one set of marks, in `READING_MARKS` order. */
export interface ReadingSpan {
  readonly text: string;
  readonly marks: readonly ReadingMark[];
}

/** One segment as the view shows it. */
export interface ReadingSegment {
  readonly id: number;
  /** Which side is shown: the target when the segment has one, else the source. */
  readonly shown: 'target' | 'source';
  /**
   * What goes between this sentence and the text before it in its paragraph: a space where the
   * export puts one (`foldSegments`), else nothing. Drawn outside the sentence, so selecting a
   * sentence never selects it.
   */
  readonly before: '' | ' ';
  readonly spans: readonly ReadingSpan[];
}

/** A paragraph: its segments in order. */
export interface ReadingParagraph {
  /** Unique within the file: the part and the paragraph's key. */
  readonly key: string;
  readonly segments: readonly ReadingSegment[];
}

/** A part of the file (the body, a footnote part, a slide), in the order it first appears. */
export interface ReadingSection {
  readonly part: DocPart;
  readonly title: string;
  readonly paragraphs: readonly ReadingParagraph[];
}

const MARK_OF: Partial<Record<TagKind, ReadingMark>> = {
  b: 'b',
  i: 'i',
  u: 'u',
  strike: 'strike',
  sup: 'sup',
  sub: 'sub',
  link: 'link',
};

/** What a placeholder stands for as text: a line break or a tab; anything else is nothing. */
const PLACEHOLDER_TEXT: Partial<Record<TagKind, string>> = { br: '\n', tab: '\t' };

/**
 * A part's name as a reader knows it. A part the editor has never seen named is shown by its
 * own name rather than hidden.
 */
export function partTitle(part: DocPart): string {
  if (part === 'document' || part === 'xliff' || part === 'strings') return 'Text';
  if (part === 'footnotes') return 'Footnotes';
  if (part === 'endnotes') return 'Endnotes';
  const numbered = /^(header|footer|slide|notes|sheet)(\d+)$/.exec(part);
  if (numbered) {
    const word = {
      header: 'Header',
      footer: 'Footer',
      slide: 'Slide',
      notes: 'Notes',
      sheet: 'Sheet',
    }[numbered[1] as 'header' | 'footer' | 'slide' | 'notes' | 'sheet'];
    return `${word} ${numbered[2]}`;
  }
  return part;
}

/**
 * A token stream as spans: the text under the marks of the tags open around it, a line break or
 * a tab as its character, every other tag read through. Adjacent text under the same marks is
 * one span. A close with no open (a stream the editor would refuse) closes nothing.
 */
export function readingSpans(
  tokens: readonly Token[],
  formats: readonly FormatEntry[],
): ReadingSpan[] {
  // By id, never by index: the filter numbers a segment's formats from 1 (`tokenizeRegion`).
  const byId = new Map(formats.map((f) => [f.id, f]));
  const kindOf = (fmt: number): TagKind | null => byId.get(fmt)?.kind ?? null;
  const open = new Map<number, ReadingMark | null>();
  const spans: ReadingSpan[] = [];
  const push = (text: string) => {
    if (text === '') return;
    const set = new Set([...open.values()].filter((m): m is ReadingMark => m !== null));
    const marks = READING_MARKS.filter((m) => set.has(m));
    const last = spans[spans.length - 1];
    if (last && last.marks.join() === marks.join()) {
      spans[spans.length - 1] = { text: last.text + text, marks };
    } else spans.push({ text, marks });
  };
  for (const token of withoutHiddenTags(tokens, formats)) {
    if (token.t === 'text') push(token.v);
    else if (token.t === 'open') {
      const kind = kindOf(token.fmt);
      open.set(token.id, kind === null ? null : (MARK_OF[kind] ?? null));
    } else if (token.t === 'close') open.delete(token.id);
    else {
      const kind = kindOf(token.fmt);
      push(kind === null ? '' : (PLACEHOLDER_TEXT[kind] ?? ''));
    }
  }
  return spans;
}

/**
 * A file's segments as the reading view: sections by part in the order each first appears,
 * paragraphs in document order (`ord`), segments in their order within a paragraph. A segment
 * with no text on the side shown (an empty paragraph's one segment) still has its place, with
 * no spans, so a paragraph that is only that is dropped and an empty sentence inside one is not.
 */
export function readingView(segments: readonly Segment[]): ReadingSection[] {
  const sections = new Map<DocPart, Map<string, Segment[]>>();
  const ordered = [...segments]
    .filter((s) => !s.fallbackCopy)
    .sort((a, b) => a.ord - b.ord || a.paraOrd - b.paraOrd);
  for (const s of ordered) {
    let paragraphs = sections.get(s.part);
    if (!paragraphs) sections.set(s.part, (paragraphs = new Map()));
    let list = paragraphs.get(s.paraKey);
    if (!list) paragraphs.set(s.paraKey, (list = []));
    list.push(s);
  }
  return [...sections].map(([part, paragraphs]) => ({
    part,
    title: partTitle(part),
    paragraphs: [...paragraphs]
      .map(([paraKey, list]) => ({
        key: `${part}/${paraKey}`,
        segments: paragraph(list),
      }))
      .filter((p) => p.segments.some((s) => s.spans.length > 0)),
  }));
}

/**
 * A paragraph's segments as the view shows them, with the space the export would put between
 * them. The rule is `mergeSegments`' (`core/segment/edit.ts`, run by `foldSegments` with a `' '`
 * separator), which the browser cannot import: a space only where the text so far does not end in
 * whitespace and the next does not start with it, judged on the text alone. It applies only to a
 * paragraph with a target in it, because the export splices an untranslated one from the original.
 */
function paragraph(list: readonly Segment[]): ReadingSegment[] {
  const translated = list.some((s) => s.targetTokens !== null);
  let soFar = '';
  return list.map((s, i) => {
    const tokens = s.targetTokens ?? s.sourceTokens;
    const own = plainText(tokens);
    const before =
      translated && i > 0 && !/\s$/.test(soFar) && !/^\s/.test(own) ? ' ' : '';
    soFar += before + own;
    return {
      id: s.id,
      shown: s.targetTokens === null ? 'source' : 'target',
      before,
      spans: readingSpans(tokens, s.formatTable),
    };
  });
}

/** How much of the view is still the source: counts for the screen's one-line summary. */
export function readingProgress(sections: readonly ReadingSection[]): {
  readonly shownTarget: number;
  readonly shownSource: number;
} {
  let shownTarget = 0;
  let shownSource = 0;
  for (const section of sections)
    for (const p of section.paragraphs)
      for (const s of p.segments) {
        if (s.spans.length === 0) continue;
        if (s.shown === 'target') shownTarget++;
        else shownSource++;
      }
  return { shownTarget, shownSource };
}

const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** The view's one-line summary: how many sentences read in the translation, and how many not yet. */
export function readingSummary(progress: {
  readonly shownTarget: number;
  readonly shownSource: number;
}): string {
  const done = `${count(progress.shownTarget, 'sentence', 'sentences')} in the translation`;
  return progress.shownSource === 0
    ? `${done}.`
    : `${done}, ${count(progress.shownSource, 'sentence', 'sentences')} still in the source (grey).`;
}
