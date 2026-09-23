/**
 * Trados language-resource list interchange (segmentation-spec.md §5;
 * backlog #12e).
 *
 * Trados Studio cannot export SRX at all — its segmentation rules belong
 * to the translation memory rather than to a file type. What it *does*
 * export is each resource list as plain text, one item per line, one file
 * per resource type. For a translator moving off Trados this is the
 * migration path that actually exists, which is why it ships before SRX.
 */

import {
  mergeListIntoDelta,
  type ProfileDelta,
  type SegmentationProfile,
} from './profile.js';

/** The list-shaped resources Trados exchanges as .txt files. */
export type ResourceKind = 'abbreviations' | 'ordinalFollowers' | 'variables';

/**
 * Parses a Trados resource list.
 *
 * Tolerates a UTF-8 BOM (Trados writes files on Windows), both line
 * endings, and surrounding whitespace. Abbreviation lists as exported by
 * Trados carry a trailing period on each entry (`etc.`); ours store the
 * bare word, so a single trailing period is stripped for that kind.
 */
export function parseResourceList(
  text: string,
  kind: ResourceKind = 'variables',
): string[] {
  const items: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    let item = rawLine.trim();
    if (item.length === 0) continue;
    if (kind === 'abbreviations') item = item.replace(/\.$/, '');
    if (item.length === 0 || seen.has(item)) continue;
    seen.add(item);
    items.push(item);
  }
  return items;
}

/**
 * Serialises a resource list the way Trados expects: one item per line,
 * CRLF endings, and — for abbreviations — the trailing period restored.
 */
export function serializeResourceList(
  items: readonly string[],
  kind: ResourceKind = 'variables',
): string {
  const lines = items.map((item) =>
    kind === 'abbreviations' && !item.endsWith('.') ? `${item}.` : item,
  );
  return lines.join('\r\n') + (lines.length > 0 ? '\r\n' : '');
}

/**
 * Imports a Trados resource list into a profile delta.
 *
 * Additive on purpose: an import extends the effective list rather than
 * replacing it, and never re-adds what the built-in defaults already
 * cover, so the stored delta stays minimal.
 */
export function importResourceList(
  delta: ProfileDelta,
  kind: ResourceKind,
  text: string,
): ProfileDelta {
  return mergeListIntoDelta(delta, kind, parseResourceList(text, kind));
}

/** Exports one of a profile's lists in Trados .txt form. */
export function exportResourceList(
  profile: SegmentationProfile,
  kind: ResourceKind,
): string {
  return serializeResourceList(profile[kind], kind);
}
