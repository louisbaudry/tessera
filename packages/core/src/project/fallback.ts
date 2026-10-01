/**
 * Which paragraphs of a part are a text box's second copy (v1-spec.md
 * §3.6). Read by the upload count (`count.ts`, backlog #62) and recorded
 * per segment at assembly (`assemble.ts`, backlog #34), so nothing that
 * counts or pays by a stored segment has to re-scan a part.
 */

import { renderSkeleton, type PartSkeleton } from '../docx/skeleton.js';
import { scanElements } from '../docx/xml-scan.js';

const FALLBACK = new Set(['mc:Fallback']);
const PARAGRAPH = new Set(['w:p']);

/**
 * Keys of the regions that sit inside an `mc:Fallback`. A text box is
 * stored twice, as DrawingML in `mc:Choice` and as VML in `mc:Fallback`,
 * and both copies are regions — right for translation, where both must
 * be rendered, wrong for a count, where the reader sees the text once.
 *
 * The parent's token stream cannot say which copy is which (the whole
 * `mc:AlternateContent` is one opaque placeholder there), so this reads
 * the part itself and keys paragraphs the way `extractSkeleton` does:
 * `s<n>`, n-th `w:p` in document order.
 */
export function fallbackRegionKeys(sk: PartSkeleton): Set<string> {
  const xml = renderSkeleton(sk);
  const fallbacks = scanElements(xml, FALLBACK);
  const keys = new Set<string>();
  if (fallbacks.length === 0) return keys;
  // Both lists are in document order, so one merge decides every
  // paragraph: elements nest properly, so a paragraph that starts inside
  // a fallback ends inside it. (Checking each fallback for each
  // paragraph is quadratic, which a large upload turns into minutes.)
  let next = 0;
  let reach = -1; // furthest end of any fallback that has started
  scanElements(xml, PARAGRAPH).forEach((para, index) => {
    while (next < fallbacks.length && fallbacks[next]!.start <= para.start) {
      reach = Math.max(reach, fallbacks[next]!.end);
      next++;
    }
    if (para.start < reach) keys.add(`s${index + 1}`);
  });
  return keys;
}
