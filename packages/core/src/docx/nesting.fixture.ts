/**
 * Test scaffolding for rendered OOXML (excluded from the build, like every
 * `*.fixture.ts`): the two facts a render of an edited target must keep,
 * shared by `render.test.ts` and the corpus-wide carry test so neither
 * holds its own copy.
 */
import type { FormatEntry, Token } from '../model/token.js';

/** Elements that are paragraph content and may never sit inside a run. */
const PARAGRAPH_LEVEL = new Set([
  'w:r',
  'w:hyperlink',
  'w:ins',
  'w:del',
  'w:sdt',
  'w:smartTag',
  'w:proofErr',
  'w:bookmarkStart',
  'w:bookmarkEnd',
]);
/** Elements that exist only as a run's children, and where else they may be. */
const RUN_CHILDREN = new Map<string, readonly string[]>([
  ['w:t', ['w:r']],
  ['w:br', ['w:r']],
  ['w:lastRenderedPageBreak', ['w:r']],
  // A paragraph mark's properties and a tab stop reuse these names.
  ['w:rPr', ['w:r', 'w:pPr']],
  ['w:tab', ['w:r', 'w:tabs']],
]);
/** Where a whole new story starts inside a run: a text box's content. */
const STORIES = new Set(['w:txbxContent']);

/**
 * How `xml` breaks OOXML's run nesting — a run inside a run, paragraph
 * content inside a run, run content outside one. Empty when it does not.
 * A scanner over tags, not a validator: it knows exactly the rules a
 * renderer of paragraph content can get wrong.
 */
export function nestingErrors(xml: string): string[] {
  const errors: string[] = [];
  const stack: string[] = [];
  for (const m of xml.matchAll(/<(\/?)([\w:]+)[^>]*?(\/?)>/g)) {
    const [, closing, name, selfClosing] = m as unknown as [
      string,
      string,
      string,
      string,
    ];
    if (closing) {
      if (stack.pop() !== name) errors.push(`mismatched </${name}>`);
      continue;
    }
    let inRun = false;
    for (let i = stack.length - 1; i >= 0 && !STORIES.has(stack[i]!); i--) {
      if (stack[i] === 'w:r') inRun = true;
    }
    if (PARAGRAPH_LEVEL.has(name) && inRun) errors.push(`${name} inside w:r`);
    const parents = RUN_CHILDREN.get(name);
    if (parents && !parents.includes(stack[stack.length - 1] ?? '')) {
      errors.push(`${name} inside ${stack[stack.length - 1] ?? 'nothing'}`);
    }
    if (!selfClosing) stack.push(name);
  }
  if (stack.length) errors.push(`unclosed ${stack.join(' ')}`);
  return errors;
}

/**
 * Each text character's run properties as rendered: its innermost run
 * tag's, looking no further out than its innermost `inline` tag ('' for
 * a bare run) — the rule `renderTokens` renders by.
 */
export function runOfEachChar(
  tokens: readonly Token[],
  formats: readonly FormatEntry[],
): string[] {
  const byId = new Map(formats.map((f) => [f.id, f]));
  const stack: FormatEntry[] = [];
  const out: string[] = [];
  for (const token of tokens) {
    if (token.t === 'open') stack.push(byId.get(token.fmt)!);
    else if (token.t === 'close') stack.pop();
    else if (token.t === 'text') {
      let run: FormatEntry | undefined;
      for (let i = stack.length - 1; i >= 0 && stack[i]!.placement !== 'inline'; i--) {
        if (stack[i]!.placement === 'run') {
          run = stack[i];
          break;
        }
      }
      for (const _ of token.v) out.push(run?.open ?? '');
    }
  }
  return out;
}
