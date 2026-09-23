# Golden end-to-end fixtures

Backlog #26. One real job, frozen: what the pipeline prints and delivers
when a real document meets a memory that covers it, with a translator's
review in between. `packages/cli/src/golden.test.ts` runs it; `pnpm
test:golden` is the command, and CI runs it as its own job next to the
roundtrip gate.

| File                             | What it is                                                                                                                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prose-short.en-de.tmx`          | The memory: `fixtures/docx/prose-short.docx`'s own sentences, translated into German by hand (then made synthetic, see below), in the shape of a Trados Studio TMX export (header props, `x-Context`/`x-Origin` unit props, `en-US`/`de-DE`) |
| `prose-short.en-de.expected.txt` | The transcript: every CLI command the job runs, everything it prints (stdout and stderr, with exit codes), the review step, and the text of every segment of the delivered document                                                          |

## What the memory is built to exercise

The document is the corpus's plain-prose baseline with Word's real run
fragmentation — nearly every sentence sits inside a pair of invisible
run tags, and one carries ten. The memory is not a clean set of
matches; it is shaped like a memory a job actually inherits:

- **Fourteen exact matches with tags**, typed the way this tool writes
  them (`<bpt type="other">`, `type="i"`, `type="style"`), so the match
  lands on the receiving document's own formatting by `(kind, order)`.
  One of them carries seven `other`, one `i` and two `style` tags — the
  most tag-dense sentence in the file.
- **One unit whose tags carry no kind hint**, the way a Trados export
  writes them (`<bpt i="1">&lt;cf size="14"&gt;</bpt>`). Pre-translate
  cannot place its tags and falls back to text only — `tm_exact_tagdiff`,
  a draft — and `qa` then blocks on the dropped tag. The review step
  reapplies the tag and confirms the segment, which writes it into the
  job's own memory.
- **One unit for a sentence the document misspells.** The memory says
  "Your …"; the document, through a run split, says "Y our …". No match, correctly — the segment is delivered in English.
- **One sentence missing from the memory** (the first of a two-sentence
  paragraph) so the export has to fold a paragraph back from one
  untranslated and one translated segment (`v1-spec.md` §3.4).
- **A citation rendered the German way** — a `(… 14:2)` chapter-and-verse
  reference as `(… 14,2)` — which `num.missing` reads as one decimal number
  where two were expected. That is a false positive of a real
  convention; the review step dismisses it, and the transcript shows the
  dismissal surviving the next `qa` run (`(dismissed)`, no longer
  blocking) — the carry-forward `db/project/qa-issues.ts` exists for.
- **A unit whose target is its source** (`Bomo.`, a one-word closing line), so `seg.untranslated`
  fires as the warning it is.
- **Noise a real memory has**: a unit for a sentence not in the document,
  and an `en-US`/`fr-FR` unit for a sentence that is — retrieval matches
  the pair by primary subtag and ignores it.

Two double-space warnings in the transcript are real: the source
document has them and the memory kept them.

## Provenance

The source sentences are `prose-short.docx`'s. The German was a hand
translation made for this fixture; both sides were then rewritten into
synthetic text by `scripts/synthesize-fixtures.py` in the same run as the
document (see `fixtures/docx/README.md`), so the memory still matches it
word for word and the German side keeps its German function words and
punctuation. The Trados-shaped header and unit properties are
modelled on real Studio exports but this file is **not** a real export
and does not close the gap `CLAUDE.md` names — TM-format code still has
no pseudonymised real-file corpus. Backlog #13a records the real material
that should become one.

## Regenerating the transcript

```sh
UPDATE_GOLDEN=1 pnpm test:golden
git diff fixtures/golden/
```

The diff is the review. A changed line means the pipeline now says or
delivers something different; decide whether that was the intent of the
change you just made before committing it. Never regenerate to make a
red run green without reading what moved.

Paths in the transcript are normalised — the job's temp directory as
`<job>`, the repository as `<repo>`, separators as `/` — so the file is
the same on every machine and OS.
