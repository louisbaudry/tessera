#!/usr/bin/env python3
"""Replace the *content* of DOCX fixtures while keeping their *structure*.

Why this exists: `fixtures/docx/` began as pseudonymised client documents,
and the pseudonymisation missed things (see `fixtures/docx/README.md`).
This script turns a real document into a synthetic one that Word's
structure survives intact — every part, every element, every run split,
every attribute that means something — while every word a person wrote,
every picture, and every link target is replaced.

How the text is replaced:

- Each word (a run of letters) maps to a pseudo-word of the same length,
  same case pattern, and the same accented/unaccented letter positions.
  The map is keyed by the lower-cased word, so a word repeated anywhere in
  the corpus — or across a `<w:r>` boundary — maps the same way everywhere,
  and a repeated sentence stays a repeated sentence (TM and context tests
  depend on that).
- The map is an HMAC under a random key that is generated per run and
  never written anywhere. A fixed or committed key would let anyone
  recover the originals by hashing a dictionary of guesses, which is the
  same mistake as committing a scrub script's replacement table.
- Punctuation, whitespace, entities, and a short list of function words and
  abbreviations are kept, so segmentation (sentence ends, `St.`, `Mr.`,
  `¿…?`) behaves as it did on the original. Digits are permuted by a fixed
  bijection, so lengths and number shapes survive but values do not.
- Images are redrawn as flat placeholders of the same format and pixel
  size. Hyperlink targets become example.org addresses.

Usage:
  python3 scripts/synthesize-fixtures.py OUT_DIR IN.docx [IN.docx ...] \
      [--tmx IN.tmx]

Every input is rewritten under OUT_DIR with the same basename. A `--tmx`
file is mapped with the *same* key in the same run, so a memory built
from a fixture's sentences still matches the synthetic fixture.
Requires Pillow (`pip install pillow`).
"""

from __future__ import annotations

import hashlib
import hmac
import io
import os
import re
import secrets
import sys
import zipfile

from PIL import Image

KEY = secrets.token_bytes(32)

# Kept verbatim: they carry segmentation behaviour or keep mixed-language
# text looking like its language, and identify no one.
KEEP = {
    # abbreviations the segmenter knows about
    "st", "mr", "mrs", "ms", "dr", "fr", "sr", "sra", "srta", "rev", "jr",
    "no", "nr", "vs", "etc", "eg", "ie", "inc", "ltd", "co", "ave", "vol",
    "pp", "cf", "ed", "eds", "ibid", "op", "cit", "art", "cap", "ca",
    # English
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
    "is", "are", "was", "be", "by", "at", "as", "it", "this", "that", "we",
    "our", "you", "your", "i", "he", "she", "they", "not", "all", "from",
    # Spanish / Italian / French / German
    "el", "la", "los", "las", "de", "del", "y", "que", "en", "un", "una",
    "por", "con", "se", "es", "il", "lo", "e", "di", "che", "le", "les",
    "et", "des", "du", "une", "der", "die", "das", "und", "ist", "mit",
}

CONSONANTS = "bcdfghjklmnprstvz"
VOWELS = "aeiou"
ACCENTED = "áéíóúñüàèç"
DIGITS = str.maketrans("0123456789", "7418529630")


def _stream(word: str):
    """Deterministic keyed byte stream for one (lower-cased) word."""
    counter = 0
    while True:
        block = hmac.new(KEY, f"{word}\x00{counter}".encode(), hashlib.sha256).digest()
        yield from block
        counter += 1


def _is_hangul(ch: str) -> bool:
    return 0xAC00 <= ord(ch) <= 0xD7A3


def _is_cjk(ch: str) -> bool:
    return 0x4E00 <= ord(ch) <= 0x9FFF


def pseudo_word(word: str) -> str:
    low = word.lower()
    if low in KEEP or len(word) == 1:
        return word
    # Roman numerals (chapter numbers, list labels) carry structure only.
    if re.fullmatch(r"[IVXLC]{1,5}", word):
        return word
    bytes_ = _stream(low)
    out = []
    for i, ch in enumerate(word):
        b = next(bytes_)
        if _is_hangul(ch):
            out.append(chr(0xAC00 + (b * 97 + i) % (0xD7A3 - 0xAC00)))
        elif _is_cjk(ch):
            out.append(chr(0x4E00 + (b * 131 + i) % (0x9FFF - 0x4E00)))
        elif ord(ch) > 0x7F and ch.lower() != ch.upper() or ch in "ßñçü":
            out.append(ACCENTED[b % len(ACCENTED)])
        else:
            # Alternate consonant/vowel so the result is pronounceable.
            out.append(VOWELS[b % 5] if i % 2 else CONSONANTS[b % len(CONSONANTS)])
    res = "".join(out)
    if word.isupper() and len(word) > 1:
        return res.upper()
    if word[0].isupper():
        res = res[0].upper() + res[1:]
    # Keep any interior capitals (McDonald, iPhone) where they were.
    return "".join(
        r.upper() if o.isupper() else r for r, o in zip(res, word)
    )


WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)
ENTITY_RE = re.compile(r"(&[#\w]+;)")
URL_RE = re.compile(r"(?:https?://|www\.)[^\s\"'<>]+", re.I)
EMAIL_RE = re.compile(r"(?:mailto:)?[\w.+-]+@[\w-]+(?:\.[\w-]+)+", re.I)


def _tag(value: str) -> str:
    return hmac.new(KEY, value.encode(), hashlib.sha256).hexdigest()[:8]


def fake_url(m: re.Match) -> str:
    return f"https://example.org/{_tag(m.group(0))}"


def fake_email(m: re.Match) -> str:
    prefix = "mailto:" if m.group(0).lower().startswith("mailto:") else ""
    return f"{prefix}person-{_tag(m.group(0))}@example.org"


def map_text(text: str) -> str:
    """Map raw XML character data (entities left intact)."""
    parts = ENTITY_RE.split(text)
    for i, part in enumerate(parts):
        if i % 2:  # an entity
            continue
        part = URL_RE.sub(fake_url, part)
        part = EMAIL_RE.sub(fake_email, part)
        # Placeholders just produced must not be re-mapped.
        chunks = re.split(r"(https://example\.org/\w+|(?:mailto:)?person-\w+@example\.org)", part)
        for j in range(0, len(chunks), 2):
            chunks[j] = WORD_RE.sub(lambda m: pseudo_word(m.group(0)), chunks[j]).translate(DIGITS)
        parts[i] = "".join(chunks)
    return "".join(parts)


# Elements whose character data is human-written text.
TEXT_ELEMS = re.compile(
    r"(<(w:t|w:delText|a:t|vt:lpstr|dc:title|dc:subject|dc:description|"
    r"cp:keywords|cp:category|Company|Manager|vt:lpwstr)(?:\s[^>]*)?>)([^<]*)(</\2>)"
)
# Attributes whose values are human-written (alt text, titles, tooltips,
# form-field help, picture names that are often original file names).
TEXT_ATTRS = re.compile(
    r"(\s(?:descr|title|alt|o:title|w:tooltip|string|name)=\")([^\"]*)(\")"
)
# Attributes on form-field help text.
HELP_ATTRS = re.compile(r"(<w:(?:helpText|statusText)\b[^>]*\sw:val=\")([^\"]*)(\")")
INSTR = re.compile(r"(<w:instrText(?:\s[^>]*)?>)([^<]*)(</w:instrText>)")
REL_TARGET = re.compile(r"(Target=\")([^\"]*)(\"[^>]*TargetMode=\"External\")")


def map_attrs(xml: str) -> str:
    """Rewrite human-written attributes, but only on drawing, VML and
    hyperlink elements — `name=` elsewhere (styles, fonts, properties) is
    structural and must not move."""

    def element(m: re.Match) -> str:
        return TEXT_ATTRS.sub(lambda a: a.group(1) + map_text(a.group(2)) + a.group(3), m.group(0))

    xml = re.sub(
        r"<(?:wp:docPr|pic:cNvPr|v:shape|v:imagedata|v:textpath|w:hyperlink|a:hlinkClick)\b[^>]*>",
        element,
        xml,
    )
    return HELP_ATTRS.sub(lambda m: m.group(1) + map_text(m.group(2)) + m.group(3), xml)


def map_xml(xml: str) -> str:
    xml = TEXT_ELEMS.sub(lambda m: m.group(1) + map_text(m.group(3)) + m.group(4), xml)
    xml = INSTR.sub(
        lambda m: m.group(1)
        + EMAIL_RE.sub(fake_email, URL_RE.sub(fake_url, m.group(2)))
        + m.group(3),
        xml,
    )
    return map_attrs(xml)


def map_rels(xml: str) -> str:
    def target(m: re.Match) -> str:
        t = m.group(2)
        if t.lower().startswith("mailto:"):
            t = EMAIL_RE.sub(fake_email, t)
        else:
            t = f"https://example.org/{_tag(t)}"
        return m.group(1) + t + m.group(3)

    return REL_TARGET.sub(target, xml)


PALETTE = [(214, 222, 235), (226, 214, 232), (216, 232, 220), (240, 226, 206)]


def placeholder_image(data: bytes, name: str) -> bytes:
    img = Image.open(io.BytesIO(data))
    fmt = img.format
    colour = PALETTE[int(_tag(name), 16) % len(PALETTE)]
    mode = "RGBA" if img.mode in ("RGBA", "LA", "P") and fmt == "PNG" else "RGB"
    out_img = Image.new(mode, img.size, colour + ((255,) if mode == "RGBA" else ()))
    if fmt == "GIF":
        out_img = out_img.convert("P")
    buf = io.BytesIO()
    out_img.save(buf, format=fmt)
    return buf.getvalue()


def synthesize_docx(src: str, dst: str) -> None:
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w") as zout:
        for info in zin.infolist():
            data = zin.read(info.filename)
            name = info.filename
            lower = name.lower()
            if lower.endswith(".rels"):
                data = map_rels(data.decode("utf-8")).encode("utf-8")
            elif lower.endswith(".xml") and not lower.startswith("[content_types]") and "/theme/" not in lower:
                data = map_xml(data.decode("utf-8")).encode("utf-8")
            elif "/media/" in lower and lower.rsplit(".", 1)[-1] in ("png", "jpg", "jpeg", "gif"):
                data = placeholder_image(data, name)
            zout.writestr(info, data, compress_type=info.compress_type)


SEG_RE = re.compile(r"(<seg>)(.*?)(</seg>)", re.S)
INLINE_RE = re.compile(r"(<(bpt|ept|ph|it|ut)\b[^>]*?(?:/>|>.*?</\2>))", re.S)


def synthesize_tmx(src: str, dst: str) -> None:
    with open(src, encoding="utf-8") as f:
        tmx = f.read()

    def seg(m: re.Match) -> str:
        pieces = INLINE_RE.split(m.group(2))
        # split() with two groups yields [text, whole-tag, tag-name, text, ...]
        out = []
        i = 0
        while i < len(pieces):
            out.append(map_text(pieces[i]))
            if i + 1 < len(pieces):
                out.append(pieces[i + 1])
            i += 3
        return m.group(1) + "".join(out) + m.group(3)

    with open(dst, "w", encoding="utf-8", newline="") as f:
        f.write(SEG_RE.sub(seg, tmx))


def main(argv: list[str]) -> None:
    if len(argv) < 2:
        sys.exit(__doc__)
    out_dir, rest = argv[0], argv[1:]
    os.makedirs(out_dir, exist_ok=True)
    tmx = []
    if "--tmx" in rest:
        i = rest.index("--tmx")
        tmx = rest[i + 1 :]
        rest = rest[:i]
    for path in rest:
        synthesize_docx(path, os.path.join(out_dir, os.path.basename(path)))
        print(f"synthesized {path}")
    for path in tmx:
        synthesize_tmx(path, os.path.join(out_dir, os.path.basename(path)))
        print(f"synthesized {path}")


if __name__ == "__main__":
    main(sys.argv[1:])
