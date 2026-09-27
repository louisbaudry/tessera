/**
 * The editable target (v1-spec.md §7.2; backlog #29): one segment's
 * target as text and atomic tag chips, in a ProseMirror view over
 * `target-doc.ts`. Only the grid's active row has one; every other row
 * shows read-only chips.
 *
 * `Ctrl+,` places the next unplaced tag, `Ctrl+Shift+,` opens the tag
 * list; both are literal Ctrl on every platform, as in Trados — on a Mac,
 * Cmd+, is the browser's own settings — and both have a button in the
 * row for a keyboard layout where they misfire. The rest of the keyboard
 * model (confirm-and-advance, copy source, merge/split) is backlog #30's.
 *
 * The editor sends what the translator placed when it leaves the segment
 * — blur, Esc, the row going away, the page going away — and only if the
 * document changed, or if the last write of the segment failed: the edit
 * then lives only in the grid's copy, and leaving sends it again. It
 * never re-reads the segment after opening it: a save's answer updates
 * the grid, not the text under the caret.
 */
import type { Segment, Token } from '@cat-tool/core';
import { withoutHiddenTags } from '@cat-tool/core/model';
import { baseKeymap } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import type { Node as PmNode } from 'prosemirror-model';
import { TextSelection, type Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import 'prosemirror-view/style/prosemirror.css';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { fullTagLabel, tagLabel, tagTitle } from './pieces.js';
import { describeFormat } from './tag-label.js';
import {
  choicesIn,
  clipboardSegment,
  createTargetState,
  docFromTokens,
  nextUnplaced,
  pastedSlice,
  pasteText,
  planInsert,
  SegmentClipboard,
  TAG_OP,
  targetFromDoc,
} from './target-doc.js';
import { pairGroups, paletteOf, type PaletteTag, type TagChoice } from './tags.js';

export interface CommitOptions {
  /** The page is going away: the request must outlive it. */
  readonly urgent: boolean;
}

interface TargetEditorProps {
  readonly segment: Segment;
  /** The target language, for the browser's spell checker. */
  readonly tgtLang: string;
  /** Where the click that opened the editor landed, to put the caret there. */
  readonly clickAt?: { readonly x: number; readonly y: number };
  /**
   * The last write of this target failed, if it did — a new object for
   * each failure, so an open editor hears of one: leaving then sends the
   * target again, changed or not.
   */
  readonly failed?: object;
  /** The visible target, when the editor leaves it changed (or `failed`). */
  readonly onCommit: (segmentId: number, tokens: Token[], options: CommitOptions) => void;
  /** Esc: done with this segment. */
  readonly onLeave: () => void;
}

/** Swallows a key the editor must not pass to the browser. */
const swallow: Command = () => true;

/** The chips a document holds, by role and id. */
function chipKeys(doc: PmNode): Map<string, string> {
  const keys = new Map<string, string>();
  doc.forEach((node) => {
    if (node.type.name !== 'tag') return;
    const a = node.attrs as { role: string; id: number; label: string; title: string };
    if (a.role !== 'close') keys.set(`${a.role}${a.id}`, `${a.label} ${a.title}`);
  });
  return keys;
}

export function TargetEditor({
  segment,
  tgtLang,
  clickAt,
  failed,
  onCommit,
  onLeave,
}: TargetEditorProps) {
  // The segment as the editor opened it. A save replaces the grid's copy;
  // the editor keeps its own state (caret, undo) rather than restart.
  const [opened] = useState(segment);
  const [firstClick] = useState(clickAt);
  const formats = opened.formatTable;
  const groups = useMemo(
    () => pairGroups(opened.sourceTokens, opened.formatTable),
    [opened],
  );
  const palette = useMemo(
    () => paletteOf(opened.sourceTokens, opened.formatTable),
    [opened],
  );
  // The document as last rendered, for the unplaced list and the tag list.
  const [doc, setDoc] = useState<PmNode>(
    () =>
      docFromTokens(
        withoutHiddenTags(opened.targetTokens ?? [], opened.formatTable),
        opened.formatTable,
        pairGroups(opened.sourceTokens, opened.formatTable),
      ).doc,
  );
  const [note, setNote] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);

  const shell = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // What was last sent, to tell a change from a click-through; null when
  // the next leave must send whatever is there.
  const committed = useRef<PmNode | null>(null);
  const callbacks = useRef({ onCommit, onLeave });
  useEffect(() => {
    callbacks.current = { onCommit, onLeave };
  });

  useEffect(() => {
    const visible = withoutHiddenTags(opened.targetTokens ?? [], opened.formatTable);
    const place =
      (tag: PaletteTag | undefined): Command =>
      (state, dispatch) => {
        if (!tag) {
          setNote('Every tag is placed.');
          return true;
        }
        const plan = planInsert(state, tag, opened.formatTable);
        if (!plan.ok) setNote(plan.reason);
        else dispatch?.(plan.tr);
        return true;
      };
    const loaded = createTargetState(visible, opened.formatTable, groups, [
      history(),
      keymap({
        'Ctrl-,': (state, dispatch) =>
          place(nextUnplaced(state, palette, opened.formatTable))(state, dispatch),
        'Ctrl-Shift-,': () => {
          setListOpen(true);
          return true;
        },
        Escape: () => {
          callbacks.current.onLeave();
          return true;
        },
        'Mod-z': undo,
        'Mod-y': redo,
        'Shift-Mod-z': redo,
        // One line: a line break is a tag, not a keystroke.
        Enter: swallow,
        'Shift-Enter': swallow,
        'Mod-Enter': swallow,
        // Formatting is tags, never the browser's own bold.
        'Mod-b': swallow,
        'Mod-i': swallow,
        'Mod-u': swallow,
      }),
      keymap(baseKeymap),
    ]);
    // A stored target the editor had to repair has never been saved as
    // shown; one whose last write failed is resent (the effect below).
    committed.current = loaded.repaired ? null : loaded.state.doc;
    const commit = (editor: EditorView, urgent = false) => {
      const doc = editor.state.doc;
      if (committed.current && doc.eq(committed.current)) return;
      committed.current = doc;
      callbacks.current.onCommit(opened.id, targetFromDoc(doc), { urgent });
    };

    const editor = new EditorView(host.current!, {
      state: loaded.state,
      attributes: {
        class: 'target-editor',
        spellcheck: 'true',
        lang: tgtLang,
        role: 'textbox',
        'aria-label': 'Target',
      },
      dispatchTransaction(tr) {
        const before = editor.state.doc;
        editor.updateState(editor.state.apply(tr));
        const after = editor.state.doc;
        if (before === after) return;
        setDoc(after);
        // A chip deleted by a keystroke takes its partner with it; say so,
        // since the translator may not have seen it go.
        const gone = [...chipKeys(before)].filter(([key]) => !chipKeys(after).has(key));
        setNote(
          gone.length > 0 && !tr.getMeta(TAG_OP)
            ? `Removed ${gone.map(([, what]) => what).join(', ')} — Ctrl+Z restores it.`
            : null,
        );
      },
      handlePaste(editorView, event) {
        // This segment's own copy is parsed, chips and all (`pastedSlice`
        // filters it); anything else — another segment's copy too, whose
        // tag ids name other tags — arrives as one line of plain text.
        const html = event.clipboardData?.getData('text/html') ?? '';
        if (clipboardSegment(html) === opened.id) return false;
        editorView.dispatch(
          pasteText(editorView.state, event.clipboardData?.getData('text/plain') ?? ''),
        );
        return true;
      },
      transformPasted: (slice, editorView) =>
        pastedSlice(slice, editorView.state, palette, opened.formatTable),
      // Every copy marked as this segment's (`SegmentClipboard`).
      clipboardSerializer: new SegmentClipboard(opened.id),
      // Dragging would move chips around unchecked; nothing is dropped.
      handleDrop: () => true,
      // Copied text is the words, not the chips' numbers.
      clipboardTextSerializer: (slice) =>
        slice.content.textBetween(0, slice.content.size, '', ''),
      handleDOMEvents: {
        blur(editorView, event) {
          // Focus moving into this editor's own tag list or toolbar is
          // not leaving the segment.
          const to = (event as FocusEvent).relatedTarget as Node | null;
          if (!to || !shell.current?.contains(to)) commit(editorView);
          return false;
        },
      },
    });
    view.current = editor;
    if (firstClick) {
      const at = editor.posAtCoords({ left: firstClick.x, top: firstClick.y });
      if (at) {
        editor.dispatch(
          editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at.pos)),
        );
      }
    }
    editor.focus();

    const onPageHide = () => commit(editor, true);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      commit(editor);
      editor.destroy();
      view.current = null;
    };
  }, [opened, groups, palette, tgtLang, firstClick]);

  // After the one above: a failed write is sent again on leaving, whether
  // it failed before the editor opened or while it is open.
  useEffect(() => {
    if (failed) committed.current = null;
  }, [failed]);

  const insert = (tag: PaletteTag) => {
    const editor = view.current;
    if (!editor) return;
    const plan = planInsert(editor.state, tag, formats);
    if (plan.ok) editor.dispatch(plan.tr);
    else setNote(plan.reason);
    editor.focus();
  };

  const choices = choicesIn(doc, palette, formats);
  const unplaced = choices.filter((c) => !c.placed).map((c) => c.tag);

  return (
    <div className="editor-shell" ref={shell}>
      <div ref={host} />
      {(palette.length > 0 || note) && (
        <div className="editor-bar">
          {unplaced.length > 0 && (
            <span className="unplaced">
              {unplaced.map((tag) => (
                <button
                  key={`${tag.role}${tag.id}`}
                  type="button"
                  className="chip chip-button"
                  title={`Place ${describeFormat(formats.find((f) => f.id === tag.fmt))} (Ctrl+,)`}
                  // Keep the caret where it is in the editor.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insert(tag)}
                >
                  <ChipText tag={tag} formats={formats} />
                </button>
              ))}
            </span>
          )}
          {palette.length > 0 && (
            <button
              type="button"
              className="link"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setListOpen(true)}
              title="Tag list (Ctrl+Shift+,)"
            >
              {unplaced.length > 0 ? 'Tags…' : 'All tags placed · list…'}
            </button>
          )}
          {note && (
            <span className="editor-note" role="status">
              {note}
            </span>
          )}
        </div>
      )}
      {listOpen && (
        <TagList
          choices={choices}
          formats={formats}
          onChoose={(tag) => {
            setListOpen(false);
            insert(tag);
          }}
          onClose={() => {
            setListOpen(false);
            view.current?.focus();
          }}
        />
      )}
    </div>
  );
}

function chipLabels(tag: PaletteTag, formats: Segment['formatTable']) {
  const role = tag.role === 'pair' ? 'open' : 'ph';
  const words = describeFormat(formats.find((f) => f.id === tag.fmt));
  const last = tag.members.length > 0 ? tag.members[tag.members.length - 1] : undefined;
  return {
    role,
    short: tagLabel(role, tag.id, last),
    full: fullTagLabel(role, tag.id, words, last),
    title: tagTitle(words, tag.members),
  };
}

function ChipText({
  tag,
  formats,
}: {
  tag: PaletteTag;
  formats: Segment['formatTable'];
}) {
  const labels = chipLabels(tag, formats);
  return (
    <>
      <span className="chip-short">{labels.short}</span>
      <span className="chip-full">{labels.full}</span>
    </>
  );
}

/**
 * Every tag the source has for the translator to place, placed ones
 * marked — choosing one of those moves it. Arrow keys and Enter, or a
 * tag's number; Esc returns to the editor.
 */
function TagList({
  choices,
  formats,
  onChoose,
  onClose,
}: {
  choices: readonly TagChoice[];
  formats: Segment['formatTable'];
  onChoose: (tag: PaletteTag) => void;
  onClose: () => void;
}) {
  const palette = choices.map((c) => c.tag);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      choices.findIndex((c) => !c.placed),
    ),
  );
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => list.current?.focus(), []);

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'ArrowDown') setActive((i) => Math.min(palette.length - 1, i + 1));
    else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1));
    else if (e.key === 'Enter' && palette[active]) onChoose(palette[active]);
    else if (e.key === 'Escape') onClose();
    else if (/^\d$/.test(e.key)) {
      const i = palette.findIndex((t) => String(t.id).startsWith(e.key));
      if (i >= 0) setActive(i);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <ul
      className="tag-list"
      role="listbox"
      aria-label="Tags"
      tabIndex={0}
      ref={list}
      aria-activedescendant={`tag-option-${active}`}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onClose();
      }}
    >
      {choices.map(({ tag, placed: isPlaced }, i) => {
        const labels = chipLabels(tag, formats);
        return (
          <li
            key={`${tag.role}${tag.id}`}
            id={`tag-option-${i}`}
            role="option"
            aria-selected={i === active}
            className={i === active ? 'active' : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChoose(tag)}
          >
            <span className={`chip chip-${labels.role}`}>{labels.short}</span>
            <span>{labels.title}</span>
            {isPlaced && <span className="muted">placed {'✓'}</span>}
          </li>
        );
      })}
    </ul>
  );
}
