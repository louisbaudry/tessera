/**
 * Inline tag and token model.
 *
 * See planning/v1-spec.md §3.3 (project tokens) and
 * planning/tm-format-spec.md §3 (TM tokens).
 */

/**
 * What a tag *is*, structurally. Never carries document-specific payload —
 * see {@link TmToken}.
 */
export type TagKind =
  | 'b'
  | 'i'
  | 'u'
  | 'strike'
  | 'sup'
  | 'sub'
  | 'link'
  | 'style'
  | 'br'
  | 'tab'
  | 'field'
  | 'footnote'
  | 'image'
  | 'bookmark'
  | 'other';

/**
 * A token in a project segment.
 *
 * `fmt` indexes the owning file's format table, which holds the actual
 * `w:rPr` / hyperlink target / placeholder payload. That index is only
 * meaningful within its file.
 */
export type Token =
  | { readonly t: 'text'; readonly v: string }
  | { readonly t: 'open'; readonly id: number; readonly fmt: number }
  | { readonly t: 'close'; readonly id: number }
  | { readonly t: 'ph'; readonly id: number; readonly fmt: number };

/**
 * A token as stored in the translation memory.
 *
 * Deliberately reduced: it records *that* a bold span opened, never which
 * `w:rPr` produced it. A match retrieved into today's document must apply
 * today's formatting, not the origin document's. `k` is a hint used for
 * re-mapping tags onto the receiving segment, not payload.
 */
export type TmToken =
  | { readonly t: 'text'; readonly v: string }
  | { readonly t: 'open'; readonly id: number; readonly k?: TagKind }
  | { readonly t: 'close'; readonly id: number }
  | { readonly t: 'ph'; readonly id: number; readonly k?: TagKind };

/** Any token shape that carries tag structure. */
export type AnyToken = Token | TmToken;

/**
 * What a tag id points at: enough XML to reconstruct it, plus a hint for
 * the editor.
 *
 * The payload is raw XML rather than a parsed property set. The filter
 * models formatting only as far as it must; anything it does not
 * understand still has to survive, and carrying the bytes is how.
 *
 * Lives in `model/`, not `docx/`, alongside `Token`: a project `Segment`
 * needs its own format table to mean anything (`Token.fmt` is an index
 * into it), and `model/` is the layer everything else imports from, never
 * the reverse — `docx/tokenize.ts` re-exports this rather than defining
 * its own, so existing imports from there keep working.
 */
export interface FormatEntry {
  readonly id: number;
  readonly kind: TagKind;
  /**
   * Whether the translator sees and places this tag.
   *
   * Spell-check markers, bookmarks and page-break hints carry no meaning
   * for a translation and would be pure noise in the editor — a Spanish
   * paragraph should not sprout four junk tags because Word left
   * `w:proofErr` behind. They travel with the segment and are re-emitted
   * automatically.
   */
  readonly visible: boolean;
  /**
   * Where this tag's XML may legally sit, which the renderer needs in
   * order to rebuild valid OOXML.
   *
   * - `run` — the paired tag *is* a `w:r`; text inside it needs only a
   *   `w:t` wrapper.
   * - `inline` — paired and contains runs, like `w:hyperlink`.
   * - `in-run` — a placeholder that must be inside a run: `w:br`,
   *   `w:tab`, a footnote reference, a drawing.
   * - `block` — a placeholder that must *not* be inside a run:
   *   `w:proofErr`, `w:bookmarkStart`, a whole `w:del`.
   */
  readonly placement: 'run' | 'inline' | 'in-run' | 'block';
  /** XML emitted before the content; the whole payload for a placeholder. */
  readonly open: string;
  /** XML emitted after the content. Empty for a placeholder. */
  readonly close: string;
}

export interface TokenizedRegion {
  readonly tokens: readonly Token[];
  readonly formats: readonly FormatEntry[];
}

export function isText(token: AnyToken): token is { t: 'text'; v: string } {
  return token.t === 'text';
}

export function isTag(token: AnyToken): boolean {
  return token.t !== 'text';
}

/** Concatenates text tokens, discarding all tags. */
export function plainText(tokens: readonly AnyToken[]): string {
  let out = '';
  for (const token of tokens) {
    if (token.t === 'text') out += token.v;
  }
  return out;
}
