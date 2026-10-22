import { describe, expect, it } from 'vitest';

import { elementChildren, scanTree, XLIFF_NS, XliffError } from './scan.js';

describe('scanTree', () => {
  it('reports offsets that slice back to the source text', () => {
    const xml = '<a><b x="1">hi &amp; bye</b><c/></a>';
    const root = scanTree(xml);
    const [b, c] = elementChildren(root);
    expect(xml.slice(b!.start, b!.end)).toBe('<b x="1">hi &amp; bye</b>');
    expect(xml.slice(b!.contentStart, b!.contentEnd)).toBe('hi &amp; bye');
    expect(b!.children[0]).toMatchObject({ kind: 'text', text: 'hi & bye' });
    expect(c!.selfClosing).toBe(true);
    expect(xml.slice(c!.start, c!.end)).toBe('<c/>');
  });

  it('resolves default and prefixed namespaces, and skips comments and PIs', () => {
    const xml = `<?xml version="1.0"?><!-- <x> --><p:a xmlns:p="${XLIFF_NS}"><p:b/><b xmlns="urn:other"/></p:a>`;
    const [b1, b2] = elementChildren(scanTree(xml));
    expect(b1).toMatchObject({ local: 'b', ns: XLIFF_NS });
    expect(b2).toMatchObject({ local: 'b', ns: 'urn:other' });
  });

  it('decodes character references and CDATA, and reads a > inside an attribute', () => {
    const root = scanTree('<a t="x>y"><![CDATA[1 < 2]]>&#65;&#x42;</a>');
    expect(root.attrs.get('t')).toBe('x>y');
    expect(root.children.map((c) => (c.kind === 'text' ? c.text : ''))).toEqual([
      '1 < 2',
      'AB',
    ]);
  });

  it.each([
    ['<a><b></a>', /does not match/],
    ['<a>', /never closed/],
    ['<a>&nbsp;</a>', /undefined entity/],
    ['<a x=1/>', /not quoted/],
    ['<a/><b/>', /second root/],
    ['text<a/>', /text outside the root/],
    ['<!DOCTYPE a><a/>', /DOCTYPE/],
    ['<a x="1" x="2"/>', /given twice/],
  ])('refuses %s', (xml, message) => {
    expect(() => scanTree(xml)).toThrow(XliffError);
    expect(() => scanTree(xml)).toThrow(message);
  });
});
