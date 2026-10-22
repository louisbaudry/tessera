/**
 * An XLIFF 2.x document read down to its segments (planning/v1-spec.md §3.8).
 *
 * `readXliff` is the one place a file's structure is interpreted, for import
 * and for export alike: both walk the same list in the same order, which is
 * what lets a segment be found again by its position (`unitOrd`, `segOrd`)
 * with no skeleton stored. The XML is never rebuilt; `XliffSegment` keeps the
 * elements' offsets so export can slice.
 */

import {
  XliffError,
  XLIFF_NS,
  elementChildren,
  isCore,
  scanTree,
  type XElement,
} from './scan.js';

export interface XliffSegment {
  /** The unit's position in the document, counting every `<unit>`. */
  readonly unitOrd: number;
  /** The segment's index among its unit's `<segment>` elements. */
  readonly segOrd: number;
  /** The unit's `id`, for messages; never used to find anything. */
  readonly unitId: string;
  /** `translate="no"` held on the unit or an enclosing group or file. */
  readonly translateNo: boolean;
  /** The `<segment>` element. */
  readonly segment: XElement;
  readonly source: XElement;
  /** The `<target>` element, or null when the segment has none. */
  readonly target: XElement | null;
  /** The segment's `state` as written, `initial` when absent (the default). */
  readonly state: string;
}

export interface XliffDocument {
  /** The decoded text. Offsets are into this string. */
  readonly xml: string;
  readonly version: string;
  readonly srcLang: string;
  readonly trgLang: string | null;
  readonly segments: readonly XliffSegment[];
}

const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });

/** The XLIFF 1.2 namespace, named only to refuse it kindly. */
const XLIFF_12_NS = 'urn:oasis:names:tc:xliff:document:1.2';

/**
 * Reads an XLIFF 2.x file.
 *
 * @throws XliffError for bytes that are not UTF-8, XML that does not scan, an
 *   XLIFF 1.2 file, a root that is not `<xliff>`, or a missing `srcLang`,
 *   `<source>` or `id`. The messages name what was found.
 */
export function readXliff(bytes: Uint8Array): XliffDocument {
  let xml: string;
  try {
    xml = decoder.decode(bytes);
  } catch {
    throw new XliffError(
      'the file is not UTF-8 text (UTF-16 and other encodings are not read)',
    );
  }
  const declared = /^﻿?\s*<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(xml)?.[1];
  if (declared && !/^utf-?8$/i.test(declared)) {
    throw new XliffError(`the file declares encoding "${declared}", only UTF-8 is read`);
  }

  const root = scanTree(xml);
  if (root.local !== 'xliff') {
    throw new XliffError(
      `the root element is <${root.name}>, not <xliff>: not an XLIFF file`,
    );
  }
  const version = root.attrs.get('version') ?? '';
  if (root.ns === XLIFF_12_NS || version.startsWith('1.')) {
    throw new XliffError(
      'XLIFF 1.2 is not supported; export XLIFF 2.x from the other tool',
    );
  }
  if (root.ns !== XLIFF_NS || !/^2\.\d+$/.test(version)) {
    throw new XliffError(
      `not an XLIFF 2.x document (version "${version}", namespace "${root.ns ?? 'none'}")`,
    );
  }
  const srcLang = root.attrs.get('srcLang');
  if (!srcLang) throw new XliffError('<xliff> has no srcLang');

  const segments: XliffSegment[] = [];
  let unitOrd = 0;

  const walk = (container: XElement, translateNo: boolean) => {
    for (const child of elementChildren(container)) {
      if (!isCore(child, 'file') && !isCore(child, 'group') && !isCore(child, 'unit'))
        continue;
      const own = child.attrs.get('translate');
      const no = translateNo || own === 'no';
      if (!isCore(child, 'unit')) {
        walk(child, no);
        continue;
      }
      const unitId = child.attrs.get('id');
      if (unitId === undefined)
        throw new XliffError(`a <unit> at offset ${child.start} has no id`);
      let segOrd = 0;
      for (const piece of elementChildren(child)) {
        if (!isCore(piece, 'segment')) continue;
        const parts = elementChildren(piece);
        const source = parts.find((p) => isCore(p, 'source'));
        if (!source) {
          throw new XliffError(`a <segment> in unit "${unitId}" has no <source>`);
        }
        segments.push({
          unitOrd,
          segOrd: segOrd++,
          unitId,
          translateNo: no,
          segment: piece,
          source,
          target: parts.find((p) => isCore(p, 'target')) ?? null,
          state: piece.attrs.get('state') ?? 'initial',
        });
      }
      unitOrd++;
    }
  };
  walk(root, false);

  return {
    xml,
    version,
    srcLang,
    trgLang: root.attrs.get('trgLang') ?? null,
    segments,
  };
}
