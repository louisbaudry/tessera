/**
 * Reading a package's relationships (planning/v1-spec.md §3.9, §3.10).
 *
 * An OOXML package says which part follows from which in `_rels/*.rels`
 * files: a presentation's slides, a workbook's sheets and shared strings, a
 * sheet's tables. The PPTX and XLSX filters both need the order and the
 * targets those files give, so the reading lives here once.
 *
 * Read with regular expressions over the raw string, like everything else
 * here: relationship files are small, machine-written and never rewritten.
 */

import { getPart, type DocxPackage } from './package.js';

const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });

/** Attributes of every `<tag ...>` start tag in `xml`, by name, in document order. */
export function startTags(xml: string, tag: string): Array<Map<string, string>> {
  const out: Array<Map<string, string>> = [];
  for (const m of xml.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))) {
    const attrs = new Map<string, string>();
    for (const a of m[0].matchAll(/\s([\w:.-]+)="([^"]*)"/g)) attrs.set(a[1]!, a[2]!);
    out.push(attrs);
  }
  return out;
}

/** `target` relative to the part `from`, as a package path. */
export function resolveTarget(from: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = from.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}

/** The relationships file of `part`: `ppt/slides/slide1.xml` has `ppt/slides/_rels/slide1.xml.rels`. */
export function relsOf(part: string): string {
  const i = part.lastIndexOf('/');
  return `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`;
}

/** One internal relationship of a part: its id and the package path it points at. */
export interface Relationship {
  readonly id: string | undefined;
  readonly target: string;
}

/**
 * A part's internal relationships whose type ends in `/<typeSuffix>` (`slide`,
 * `worksheet`, `table`), in file order. The suffix, not the whole type: the
 * transitional and the strict namespaces differ in everything before it.
 * Empty when the part has no relationships file.
 */
export function relationships(
  pkg: DocxPackage,
  part: string,
  typeSuffix: string,
): Relationship[] {
  const rels = getPart(pkg, relsOf(part));
  if (!rels) return [];
  return startTags(decoder.decode(rels), 'Relationship')
    .filter(
      (r) =>
        r.get('Type')?.endsWith(`/${typeSuffix}`) && r.get('TargetMode') !== 'External',
    )
    .map((r) => ({
      id: r.get('Id'),
      target: resolveTarget(part, r.get('Target') ?? ''),
    }));
}

/** {@link relationships}, as package paths only. */
export function related(pkg: DocxPackage, part: string, typeSuffix: string): string[] {
  return relationships(pkg, part, typeSuffix).map((r) => r.target);
}
