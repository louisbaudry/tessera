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

export class TokenShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenShapeError';
  }
}

const isIndex = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/**
 * A character XML 1.0 cannot carry, even escaped: a C0 control other than
 * tab, line feed and carriage return, U+FFFE, U+FFFF, or half a surrogate
 * pair. A part holding one is a file Word will not open. Text from a DOCX
 * never has one — its parser would have refused it — but a paste can (a
 * vertical tab is PowerPoint's soft line break), and so can a memory.
 */
const XML_ILLEGAL =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The first character in `s` XML cannot carry, as `U+XXXX`, or null. */
export function xmlIllegalChar(s: string): string | null {
  const match = XML_ILLEGAL.exec(s);
  if (!match) return null;
  return `U+${match[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Whether a tag token's role fits its format: a pair (`open`/`close`) is
 * a `run` or `inline` tag, a placeholder an `in-run` or `block` one. The
 * other way round is XML with no close, or a close with nothing open —
 * a mismatched TM remap once produced exactly that, silently.
 */
export function roleFits(
  role: Exclude<Token['t'], 'text'>,
  placement: FormatEntry['placement'],
): boolean {
  return role === 'ph'
    ? placement === 'in-run' || placement === 'block'
    : placement === 'run' || placement === 'inline';
}

/**
 * Checks that `value` — JSON from outside, e.g. a request body — is a
 * `Token[]` export could render, and returns it typed: every tag one of
 * the table's, its `fmt` its own id (as everywhere a segment's tokens are
 * made, and what the renderer looks it up by), in a role its format fits
 * (`roleFits`), and text XML can carry (`xmlIllegalChar`). Shape only: a
 * well-formed target with the wrong tags is QA's to flag (`tag.*`), and
 * a broken structure is the caller's to refuse or flag.
 */
export function parseTokens(value: unknown, formats: readonly FormatEntry[]): Token[] {
  if (!Array.isArray(value)) throw new TokenShapeError('tokens must be an array');
  const byId = new Map(formats.map((f) => [f.id, f]));
  const fitting = (where: string, role: Exclude<Token['t'], 'text'>, id: number) => {
    const format = byId.get(id);
    if (!format)
      throw new TokenShapeError(`${where}: tag ${id} is not in this file's format table`);
    if (!roleFits(role, format.placement)) {
      throw new TokenShapeError(
        `${where}: tag ${id} is a ${format.placement} tag, not a ${role}`,
      );
    }
  };
  return value.map((raw: unknown, i): Token => {
    const token = raw as Record<string, unknown> | null;
    const where = `token ${i}`;
    if (typeof token !== 'object' || token === null) {
      throw new TokenShapeError(`${where} is not an object`);
    }
    switch (token['t']) {
      case 'text': {
        if (typeof token['v'] !== 'string') {
          throw new TokenShapeError(`${where}: text needs a string "v"`);
        }
        const illegal = xmlIllegalChar(token['v']);
        if (illegal) {
          throw new TokenShapeError(
            `${where}: text holds ${illegal}, which XML cannot carry`,
          );
        }
        return { t: 'text', v: token['v'] };
      }
      case 'close': {
        const id = token['id'];
        if (!isIndex(id)) throw new TokenShapeError(`${where}: bad "id"`);
        fitting(where, 'close', id);
        return { t: 'close', id };
      }
      case 'open':
      case 'ph': {
        const { id, fmt } = token;
        if (!isIndex(id)) throw new TokenShapeError(`${where}: bad "id"`);
        if (!isIndex(fmt) || fmt !== id) {
          throw new TokenShapeError(`${where}: "fmt" must be the tag's own id`);
        }
        fitting(where, token['t'], id);
        return token['t'] === 'open' ? { t: 'open', id, fmt } : { t: 'ph', id, fmt };
      }
      default:
        throw new TokenShapeError(`${where}: unknown kind ${JSON.stringify(token['t'])}`);
    }
  });
}
