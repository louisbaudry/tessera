# Translation Memory Format — Specification v1

**Status:** draft for review
**Date:** 2026-08-11
**Provisional extension:** `.ctm`
**Magic:** SQLite `application_id = 0x4341_544D` (`"CATM"`)

Supersedes `v1-spec.md` §4.2.

---

## 0. Why a proprietary format at all

TMX is an *interchange* format. It was designed in 1997 to move memories
between tools, and it is good at that. It is a poor *working* format:

| TMX cannot express | Consequence |
|---|---|
| Context (preceding/following segment) | No context/ICE matching — the single highest-value match type for repeat clients |
| A tag model that survives roundtrip | Inline tags degrade on every export/import cycle |
| Stable unit identity | Two copies of a TM cannot be merged without duplicating |
| Revision history | A bad batch edit is unrecoverable |
| Embeddings | No slot for semantic retrieval |
| Structured metadata | `<prop>` is untyped free text in practice |

Parsing is also the wrong shape: a large TMX is an XML document that must
be read wholly into memory to answer one lookup.

### TMX is not being dropped

**The proprietary format is the working store. TMX stays as import and
export, both directions, permanently.** This is not a hedge — a CAT tool
that cannot hand a translator their own memory back in TMX is unsellable
to the professionals this product targets, and it would invert
differentiator #3 (transferable licences) into lock-in.

The rule: **anything that can be expressed in TMX must survive a TMX
roundtrip.** The proprietary format holds strictly more, and §8 documents
exactly what is lost on export.

---

## 1. Container

A `.ctm` file is a **single SQLite 3 database**. Not a zip, not a custom
binary.

Same choice Trados made for `.sdltm`, for the same reasons: ACID
transactions, B-tree indexes, FTS5, incremental update without rewriting
the file, mature tooling, and zero parsing code to maintain and get wrong.

```sql
PRAGMA application_id = 0x4341544D;  -- "CATM" — identifies the file type
PRAGMA user_version   = 1;           -- format version (§9)
PRAGMA journal_mode   = WAL;         -- concurrent readers during write
PRAGMA foreign_keys   = ON;
```

`application_id` lives in the SQLite header at byte offset 68, so `file(1)`
and any reader can identify a `.ctm` without opening it as a database, and
**without depending on the extension**.

`CATM` — "CAT Memory" — is chosen to be **independent of the product
name**, which is not yet decided. "CAT" is the industry category
(computer-assisted translation), not a brand, so the magic stays accurate
under any commercial name the product eventually takes. It is plain ASCII
and therefore legible in a hexdump and in `file` output.

The user-facing `.ctm` extension may change freely at launch; the magic
number should not, because changing it once users hold files means a
migration. Register `CATM` in SQLite's `magic.txt` before public release
to avoid a future collision.

Text is UTF-8, Unicode **NFC**, everywhere, without exception.
Timestamps are RFC 3339 UTC with milliseconds (`2026-08-11T09:14:22.031Z`).
Language codes are BCP-47.

### 1.1 Access layer

**`better-sqlite3`**, confirming the lock in `conversation-context.md`.

The deciding factor is transactions, not throughput. §10 requires
write-back to roll back atomically with undo, and §7 requires a merge of
thousands of units to be all-or-nothing. `better-sqlite3` provides
`db.transaction(fn)` as a genuine synchronous atomic block. The async
`sqlite3` driver requires hand-serialising every statement, and accidental
interleaving between two in-flight transactions is a quiet corruption bug
in the one file the user cannot reconstruct. Being ~5–10× faster on
indexed reads, and not threading `async` through every repository method,
are secondary.

**The cost is real and must be designed around.** `better-sqlite3` is
synchronous and a native module:

- **Blocking.** A point lookup is microseconds and safe to run inline. Bulk
  work is not: TMX import, merge, `VACUUM`, rehash-on-normalizer-bump, and
  batch find-and-replace **must** run in a `worker_thread`, never on the
  request-handling thread. An architectural rule, not a later optimisation
  — on a server this is also what keeps one user's bulk import from
  stalling another's point lookups.
- **Native ABI.** Requires a prebuild or rebuild matching the Node runtime
  the server actually runs — one target, chosen once at image build time,
  not a matrix. This is *simpler* than the Electron-era risk this section
  used to describe: there is one deployment platform instead of three
  installers, so "works in CI, broken for the user" has nowhere to hide.

Rejected: the npm `sqlite3` driver (async, slower, transaction hazard
above) and `node:sqlite` (synchronous and dependency-free, but still young
— worth revisiting, as it would remove the native-module problem
entirely).

**Nothing in §2 onward depends on this choice, or on the desktop-vs-server
question.** The format, schema, hashing contract, and token model are
unchanged by moving the driver into a Node backend instead of an Electron
main process, and would be unchanged by a future move to `rusqlite`
too.

---

## 2. Schema — multilingual

A memory holds **many languages**, and any pair among them is retrievable.
A unit is not a source/target row; it is a **language-neutral identity
with one variant per language**.

This is structurally the same model TMX itself uses — `<tu>` containing
several `<tuv xml:lang=…>` — which makes §8 mapping substantially cleaner
than a bilingual schema would have been.

### 2.1 `tm` — identity and contract

```sql
CREATE TABLE tm (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  uuid               TEXT    NOT NULL UNIQUE,
  name               TEXT    NOT NULL,
  langs              TEXT    NOT NULL,   -- JSON array of BCP-47 codes present
  created_at         TEXT    NOT NULL,
  format_version     INTEGER NOT NULL,
  generator          TEXT    NOT NULL,   -- e.g. "cat-tool/0.3.1"
  normalizer_version INTEGER NOT NULL,   -- §4
  tokenizer_version  INTEGER NOT NULL,
  read_only          INTEGER NOT NULL DEFAULT 0
);
```

There is no `src_lang` / `tgt_lang`. `langs` is a denormalised convenience
listing the languages actually present, maintained on write — it lets a UI
show what a memory contains without scanning it. It is recomputed from
`tuv` on every write rather than edited incrementally, so it cannot drift,
and that recomputation seeks `tuv_lookup` once per language instead of
reading it whole (§11.2, backlog #20a). Lookups never read it: they take
the languages from `tuv`'s index directly (#19a), so even a stale `langs`
could only mislead a display, never hide a match.

`normalizer_version` is the field most formats forget. Every `hash` in the
file is a function of the normalisation rules that produced it. If those
rules change, **every stored hash is silently wrong** and exact matching
quietly stops working. Storing the version means a reader detects the
mismatch and rehashes instead of returning wrong results. Same argument for
`tokenizer_version` against segmentation drift.

### 2.2 `tu` — unit identity

```sql
CREATE TABLE tu (
  id             INTEGER PRIMARY KEY,
  uuid           TEXT    NOT NULL UNIQUE,  -- stable across copies and merges
  rev            INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  created_by     TEXT,
  origin_doc     TEXT,
  origin_project TEXT,
  deleted        INTEGER NOT NULL DEFAULT 0  -- tombstone, §7
);

CREATE INDEX tu_updated ON tu(updated_at);
```

The unit carries identity and provenance only. No text lives here.

### 2.3 `tuv` — one variant per language

```sql
CREATE TABLE tuv (
  id           INTEGER PRIMARY KEY,
  tu_id        INTEGER NOT NULL REFERENCES tu(id) ON DELETE CASCADE,
  lang         TEXT    NOT NULL,          -- BCP-47
  rev          INTEGER NOT NULL DEFAULT 1,

  tokens       TEXT    NOT NULL,          -- JSON TmToken[] (§3)
  plain        TEXT    NOT NULL,          -- tags stripped, normalised (§4)
  hash         TEXT    NOT NULL,          -- SHA-256 of plain

  prev_hash    TEXT,                      -- §5 context, in THIS language
  next_hash    TEXT,

  quality      INTEGER NOT NULL DEFAULT 1,-- §6
  usage_count  INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,

  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  updated_by   TEXT,

  UNIQUE (tu_id, lang)
);

CREATE INDEX tuv_lookup ON tuv(lang, hash);
CREATE INDEX tuv_ctx    ON tuv(lang, hash, prev_hash, next_hash);
```

Retrieval for a pair is a self-join:

```sql
SELECT t.tokens, t.quality
FROM   tuv s
JOIN   tuv t ON t.tu_id = s.tu_id AND t.lang = :tgt_lang
JOIN   tu  u ON u.id    = s.tu_id AND u.deleted = 0
WHERE  s.lang = :src_lang AND s.hash = :src_hash
ORDER  BY t.quality DESC, t.updated_at DESC;
```

Reverse lookup (ES→EN from a memory built EN→ES) is the same query with
the languages swapped, and costs nothing extra — it falls out of the model
rather than needing a feature.

Three things are deliberately **per variant, not per unit**:

- **Context** (`prev_hash`, `next_hash`) — the segment preceding an English
  sentence is an English sentence. Context is language-specific and storing
  it on the unit would be wrong.
- **Quality** — an ES translation may be reviewed while the DE is a draft.
- **`rev`** — variants change independently, so merge (§7) resolves per
  variant, not per unit.

### 2.4 `tu_attr` — typed metadata

```sql
CREATE TABLE tu_attr (
  tu_id INTEGER NOT NULL REFERENCES tu(id) ON DELETE CASCADE,
  key   TEXT    NOT NULL,
  value TEXT    NOT NULL,
  PRIMARY KEY (tu_id, key)
) WITHOUT ROWID;

CREATE INDEX tu_attr_kv ON tu_attr(key, value);
```

Unit-level, because client, domain and subject describe the unit rather
than a language. This is the extensibility escape hatch: **no new metadata
field ever requires a schema migration.** Reserved keys: `client`,
`domain`, `subject`, `register`, `project`, `note`. Anything else is
user-defined and passes through untouched.

### 2.5 `tuv_history` — revisions

```sql
CREATE TABLE tuv_history (
  tuv_id     INTEGER NOT NULL REFERENCES tuv(id) ON DELETE CASCADE,
  rev        INTEGER NOT NULL,
  tokens     TEXT    NOT NULL,
  quality    INTEGER NOT NULL,
  changed_at TEXT    NOT NULL,
  changed_by TEXT,
  PRIMARY KEY (tuv_id, rev)
) WITHOUT ROWID;
```

History is what makes a bad find-and-replace across tens of thousands of
units survivable, and `rev` doubles as the merge conflict discriminator
(§7).

### 2.6 `tuv_fts` — full-text index

```sql
CREATE VIRTUAL TABLE tuv_fts USING fts5(
  plain,
  content = 'tuv',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);
```

Maintained by triggers on `tuv`. Because every language is a `tuv` row,
one index serves concordance in **all** languages and both directions;
callers filter by joining back to `tuv.lang`.

`remove_diacritics 2` matters for Spanish: it makes concordance on
`accion` find `acción`.

### 2.7 `seg_profile` — segmentation rules

```sql
CREATE TABLE seg_profile (
  lang  TEXT PRIMARY KEY,   -- BCP-47 primary subtag
  delta TEXT NOT NULL       -- JSON ProfileDelta, its own versioned schema
) WITHOUT ROWID;
```

Segmentation rules live **in the memory, not the project** — the Trados
model, adopted deliberately (segmentation-spec.md §2): leverage is only
meaningful if a query is segmented the way the memory was built, and
storing the rules here makes that automatic.

The value is a **delta** from the built-in defaults, serialised by
`serializeProfileDelta` and carrying its own `version` field, so profile
evolution does not force a format version bump. What is stored is what
the user changed, never a copy of the defaults — a memory created today
still benefits when the built-in lists improve. A malformed delta is
refused loudly on read (`parseProfileDelta`), never partially applied.

This table was added while `user_version` was still 1 and no `.ctm` file
had ever been written, so it ships inside format version 1 rather than
forcing a bump.

### 2.8 `tuv_vec` — embeddings, reserved

```sql
CREATE TABLE tuv_vec (
  tuv_id INTEGER NOT NULL REFERENCES tuv(id) ON DELETE CASCADE,
  model  TEXT    NOT NULL,
  dim    INTEGER NOT NULL,
  vec    BLOB    NOT NULL,        -- float32 little-endian, dim * 4 bytes
  PRIMARY KEY (tuv_id, model)
) WITHOUT ROWID;
```

Empty in v1. Declared now because `transformers.js` semantic matching is
already in the locked stack, and multilingual embedding models make
cross-language retrieval genuinely interesting later.

### 2.9 `tm_import` — import runs (format version 2)

```sql
CREATE TABLE tm_import (
  id            INTEGER PRIMARY KEY,
  format        TEXT    NOT NULL CHECK (format IN ('tmx')),
  source_name   TEXT    NOT NULL,   -- the file's base name, display only
  source_bytes  INTEGER NOT NULL,   -- its size; a resume refuses a different one
  started_at    TEXT    NOT NULL,
  finished_at   TEXT,               -- NULL: incomplete
  units_done    INTEGER NOT NULL DEFAULT 0,
  variants_done INTEGER NOT NULL DEFAULT 0
);
```

One row per TMX import, written in the same transaction as the units it
counts (backlog #18c; the decision is §12.4). `finished_at IS NULL` is
the **visible incomplete state**: a memory holding a prefix of a file,
whole units only, with `units_done` saying how many. A reader shows it;
nothing hides it. `units_done` is also the resume point — the ordinal
of the next `<tu>` in document order — which is why it is a count, not
a byte offset: a count is independent of encoding and chunking, and
re-parsing the skipped prefix costs a fraction of writing it.

`source_bytes` is a guard, not an identity. Resuming against a file of
a different size is refused; the same size with different content is
not caught. A content hash would catch it, at the price of reading the
whole file once more before the import starts, and the realistic
failure (a crash, then the same command again) does not need it.

`format` is `'tmx'` only. `.sdltm` import is still one transaction
(§12.3, §12.4), so it has no incomplete state to record; widening the
`CHECK` is how it joins, never free text.

---

## 3. Token model in the TM

The project database's `Token` carries `fmt`, an index into a *per-file*
format table (`v1-spec.md` §3.3). That index is meaningless outside its
file. The TM therefore stores a **reduced** token:

```ts
type TmToken =
  | { t: 'text';  v: string }
  | { t: 'open';  id: number; k?: TagKind }
  | { t: 'close'; id: number }
  | { t: 'ph';    id: number; k?: TagKind }

type TagKind =
  | 'b' | 'i' | 'u' | 'strike' | 'sup' | 'sub'
  | 'link' | 'style'
  | 'br' | 'tab' | 'field' | 'footnote' | 'image' | 'bookmark'
  | 'other'
```

**Tags are structural, not decorative.** The TM records *that* a bold span
opened, never *which* `w:rPr` produced it. When a unit from a 2023 client
file matches a segment in today's document, the bold applied must be
*today's document's* bold. Carrying the old run properties would import
foreign formatting into a file that never asked for it.

`k` is a hint, not payload. It drives tag re-mapping on retrieval: TM tags
are matched to the current segment's tags by `(kind, order)`. All kinds
match → clean insert. Otherwise the `tm_exact_tagdiff` path in
`v1-spec.md` §6.1 applies.

Writing a variant: drop `fmt`, derive `k` from the file's format entry,
renumber `id` from 1 in source order.

---

## 4. Normalisation contract — `normalizer_version = 1`

Applied in order to produce `plain`, then SHA-256 (lowercase hex) to
produce `hash`:

1. Drop all tag tokens; concatenate text tokens.
2. Unicode NFC.
3. Collapse runs of whitespace to a single U+0020; trim both ends.
4. Canonicalise typographic variants (codepoints spelled out, not just
   glyphs — the previous revision of this list lost its two most common
   entries, U+2018/U+2019, to exactly the kind of silent quote-mangling
   this rule exists to undo; see the implementation note below):
   - Single quotes → `'` (U+0027): U+2018 `‘`, U+2019 `’`, U+201A `‚`,
     U+201B `‛`.
   - Double quotes → `"` (U+0022): U+201C `“`, U+201D `”`, U+201E `„`,
     U+201F `‟`, U+00AB `«`, U+00BB `»`.
   - Dashes → `-` (U+002D): U+2013 `–`, U+2014 `—`, U+2012 `‒`.
   - Spaces → ` ` (U+0020): U+00A0 (NBSP), U+202F (NNBSP), U+2009 (thin
     space).
   - Ellipsis U+2026 `…` → `...` (three U+002E).
   - Primes: U+2032 `′` → `'` (U+0027); U+2033 `″` → `"` (U+0022).
   - Soft hyphen U+00AD → removed.
5. Case is **preserved**. Diacritics are **preserved** — `ácido` and
   `acido` are different units. (Diacritic folding happens only in the FTS
   index, §2.6, where it aids search rather than deciding equality.)

Step 4 is what makes exact matching work against real Trados exports,
where the same sentence differs only by an invisible non-breaking space.

**Implementation note (2026-08-30, backlog #17):** caught while
implementing this section against real text — U+2018/U+2019, the two
curly single quotes Word's own AutoCorrect actually produces by
default, were missing from the single-quote list above. At some earlier
point the literal example characters in this file were silently
straightened, defeating the one example most likely to matter in real
documents. Fixed here, before any `.ctm` file had ever been written
(same situation as §2.7's `seg_profile` addition — nothing to migrate
away from), and now spelled out by codepoint specifically so this class
of corruption can be caught by inspection next time, not by accident
during implementation.

This list is **frozen for `normalizer_version = 1`**. Changing any rule
requires incrementing the version, and any file carrying an older version
is rehashed on open. Editing these rules in place would silently corrupt
matching across every existing memory.

---

## 5. Context matching — the payoff

`prev_hash` and `next_hash` on a variant hold the `hash` of the
neighbouring segments **in that same language**, from the document the
variant came from (`NULL` at document boundaries).

This buys match tiers TMX structurally cannot express:

| Tier | Condition | Meaning |
|---|---|---|
| **ICE / 101%** | `hash` **and** both neighbours match | Same sentence, same surrounding context. Safe to accept unreviewed. |
| **100%** | `hash` matches, context does not | Same sentence, different context. Review it. |

For repeat client work — updated manuals, revised contracts, new releases
of the same product — this is the difference between re-reading every 100%
match and confidently skipping the genuinely unchanged ones. It is the
strongest single argument for owning the format, and it costs two indexed
columns.

Not wired into v1's matcher (exact-only, `v1-spec.md` §6.1), but
**populated from the first variant written**. Context not recorded at
write time is unrecoverable — the source document is gone. Storing it now
is what makes the feature possible at all.

**Implementation note (2026-09-08, backlog #17a):** "neighbouring
segment" skips locked/untranslatable segments (`v1-spec.md` §4.1's
`segment.locked`) — a run of structural content (a page-break marker, an
empty table cell) between two translatable sentences is not part of
either one's surrounding context, and it never becomes a `tuv` itself
(locked segments are never confirmed, so they're never written). The
neighbour chain is built over translatable segments only, in document
order (`segment.ord`); a translatable segment with no translatable
neighbour on one side gets `NULL` there, exactly as at a real document
boundary. `@cat-tool/core/tm/context.ts`'s `documentContext` is the one
place this walk happens.

---

## 6. Quality levels

Per variant (§2.3).

| `quality` | Meaning |
|---|---|
| 0 | Machine translation, unedited |
| 1 | Draft — translated, not confirmed |
| 2 | Confirmed by the translator |
| 3 | Reviewed / approved by a second pair of eyes |
| 4 | Client-approved or authority reference |

Retrieval prefers the highest quality on a tie. Write-back never lowers an
existing variant's quality: re-confirming something already reviewed
leaves it reviewed.

---

## 7. Merge and sync

Units carry `uuid`; variants carry `rev`. Merging two `.ctm` files walks
units by `uuid`, then variants by `lang`:

- **Unit present in one only** → copy across with all variants.
- **Unit in both** → union the variants, resolving each `lang`
  independently:
  - same `rev` → identical, no action;
  - different `rev` → higher wins; on a tie, later `updated_at` wins;
    the loser is retained in `tuv_history`.
- **A language present in one file only** → copied across. This is where
  multilingual pays off: merging an EN/ES memory with an EN/DE memory
  yields EN/ES/DE, with shared units linked automatically by `uuid`.
- **`tu.deleted = 1`** propagates as a tombstone. Tombstones are purged
  only by explicit compaction — a delete that resurrects on the next merge
  is worse than a file with dead rows.
- **Different `uuid`, same `hash` in the same language** → both kept. Two
  legitimately different translations of one sentence is normal; the
  translator disambiguates at retrieval. Silently collapsing them loses
  work.

Deliberately last-writer-wins with full history rather than CRDTs. That is
the right complexity for a format whose realistic concurrency is one
translator on two machines, or an agency handing a memory to a freelancer
and taking it back — exactly the transferable-licence workflow in the
commercial wedge.

---

## 8. TMX interoperability

The multilingual model maps onto TMX **directly**: `tu` ↔ `<tu>`,
`tuv` ↔ `<tuv xml:lang>`. A bilingual schema would have needed to flatten
here; this does not.

### Import (TMX 1.4b → `.ctm`)

- Every `<tuv>` becomes a `tuv` row. Multilingual TMX files — which the
  standard permits and most tools discard down to a pair — import
  **whole**.
- `<bpt>`/`<ept>` → `open`/`close`, paired on `i`. `<ph>`/`<it>` → `ph`.
  Unknown inline elements degrade to `ph`, never dropped.
- `<prop type="x">` → `tu_attr`. Trados `x-*` props map onto reserved keys
  where recognised.
- `creationdate`, `changedate`, `creationid`, `changeid` map directly.
- `prev_hash` / `next_hash` are `NULL` — TMX has no context. Units
  imported from TMX can never be ICE matches. Unavoidable, and worth
  telling the user once, at import.
- `quality` defaults to 2 (confirmed); TMX carries no quality signal.
- `uuid` generated fresh; `tuid` preserved in `tu_attr` when present.
- **Streamed, never held whole** (backlog #18c). The reader takes the
  document in chunks and yields one `<tu>` at a time, so memory is
  bounded by one unit plus one batch, not by the file: a 2 GiB TMX is a
  string V8 cannot even hold. Units are written in batches (default
  10,000), each batch one transaction that also advances the file's
  `tm_import` row (§2.9). A batch boundary is always a unit boundary, so
  an interrupted import leaves whole units only, and says so.
- An import from a string (`importTmx(db, xml)`) is the single-batch
  case: one transaction, all-or-nothing, and its `tm_import` row is
  finished in that same transaction.
- `<body>` holds `<tu>` elements and comments, nothing else (TMX 1.4b's
  content model). Anything else there is a `TmxError`, not skipped:
  the streaming reader cannot skip an element it does not know without
  parsing it, and a silently skipped element is a lost unit.
- A malformed `xml:lang` is reported once per distinct value with a
  count, not once per variant (the "warning per occurrence" gotcha in
  `CLAUDE.md`, at 5M-unit scale).

### Export (`.ctm` → TMX 1.4b)

Export takes an optional language filter; the default is everything, which
is valid TMX.

Lossy in exactly these ways, and only these:

| Lost | Mitigation |
|---|---|
| `prev_hash` / `next_hash` | `<prop type="x-catm-prev">` — read back on our own import |
| `tuv_history` | Not exported. Current revision only. |
| `tuv_vec` | Not exported; recomputable. |
| `quality` | `<prop type="x-catm-quality">` |
| `uuid`, `rev` | `<prop type="x-catm-uuid">`, `x-catm-rev` |
| Tag `k` hints | Approximated onto `<bpt>` `type` |

Every `<prop>` is namespaced `x-catm-*` so other tools ignore it cleanly
and our own importer restores a full-fidelity roundtrip. **Acceptance test
is not schema validity — it is that Trados imports the output with tags
intact.**

Implementation notes (backlog #21), settled here rather than left to
whoever writes the exporter next:

- **`<header srclang>`** is the one TMX header attribute with no
  multilingual-friendly value in the base spec — `.ctm` has no
  designated source language (source/target is a project concept, not a
  memory one). Exported as `srclang="*all*"`, the convention several TMX
  consumers already recognise for "any language here can be a source".
  `creationtool`/`creationtoolversion` are this product's name/version;
  `datatype="plaintext"`, `segtype="sentence"`, `adminlang="en"`,
  `o-tmf="cat-tool"`.
- **`tu_attr` round-trips through three different shapes on export, not
  one** — matching how §8's *import* side already special-cases the
  same two keys: the `tuid` key becomes the `<tu tuid="...">` attribute
  (never a `<prop>`), the `note` key becomes a `<note>` child element
  (never a `<prop type="note">`), and every other key becomes an
  ordinary `<prop type="{key}">{value}</prop>` — including a reserved
  key (`client`, `domain`, ...) verbatim, with no `x-` prefix added back
  on, since import's `mapReservedProp` already recognises the bare key
  form on the way back in.
- **`<bpt i>`/`<ept i>` reuse the `TmToken`'s own numeric `id`** for
  TMX's `i` correlation attribute — already exactly what pairs an
  `open`/`close` token, so no separate id scheme is needed. `<ph>`
  carries no `i`/`x` at all: import assigns placeholder ids locally, in
  document order, so nothing is lost by leaving TMX's optional
  correlation attribute off.
- **`tuv` has no `created_by` column**, only `updated_by` — so a
  variant's exported `creationid` and `changeid` are both that one
  stored value. This is a pre-existing asymmetry (§2.3), not something
  export introduces; re-importing it is idempotent (`changeid` wins
  when both are read back).
- **A `tu` with zero variants left after the language filter is omitted
  from the export entirely**, never written as a `<tu>` with no
  `<tuv>` — the same rule TMX import already enforces the other
  direction (`parseTu` throws on exactly that shape).

---

## 8a. Native `.sdltm` — reverse-engineered, not yet a supported input

Backlog #18 imports TMX only. While validating that path against a real
Trados memory (2026-09-13), the memory's *native* `.sdltm` file — itself
just a SQLite database — was inspected directly for comparison, and turned
up enough to record here even though nothing reads `.sdltm` yet.

**Caveat before anything else: this is reverse-engineered from one sample
file** (SQLite schema cookie `0x2f`, `parameters.VERSION = 8.06`), not from
published Trados documentation. Table and column names below are observed,
not contractual — a different Studio version could differ. Treat this
section as a lead for backlog #18b, not a schema to code against blindly.

**`.sdltm` is bilingual, unlike `.ctm`.** One `translation_units` row
holds *both* `source_segment` and `target_segment` for the one language
pair `translation_memories.source_language`/`target_language` names —
there is no `tu`/`tuv` split. This is the concrete case for owning a
multilingual format (§0): a Trados memory is locked to one pair; merging
an EN→ES and an EN→DE Trados memory means starting over, where `.ctm`
gets EN/ES/DE for free (§7).

**The native segment representation is richer than TMX's.** Instead of
`bpt`/`ept`/`ph`, a segment is a small XML fragment of its own:
```xml
<Segment><Elements>
  <Tag><Type>Start</Type><Anchor>1</Anchor><TagID>52</TagID><CanHide>true</CanHide></Tag>
  <Text><Value>Page </Value></Text>
  <Tag><Type>End</Type><Anchor>1</Anchor><TagID>52</TagID><CanHide>true</CanHide></Tag>
  ...
</Elements><CultureName>en-US</CultureName></Segment>
```
`CanHide` maps directly onto `FormatEntry.visible` (`core/model/token.ts`)
— TMX's `bpt`/`ept`/`ph` carries nothing equivalent, so a segment read
from `.sdltm` directly could in principle recover more than one read via
a TMX round-trip ever can.

**Real per-occurrence context data exists — and TMX serialises it lossily
as repeated `<prop>` values, which is what #18's "warn on repeated prop
type" fix (this session) was actually looking at.** A
`translation_unit_contexts` table pairs `left_source_context`/
`left_target_context` — **signed 64-bit integer** hashes of the preceding
segment, one per language — against a `translation_unit_id`. The width is
not a detail: see §8a.2, where reading one as a JavaScript number cost
three digits in silence. This is Trados's own version
of exactly what §5's `prev_hash`/`next_hash` is for. The difference: a
segment that recurs at many distinct document locations (a running header
repeated on every page, in the sample file's case) gets **one context row
per occurrence** — 25,563 context rows across 20,684 units in the sample
— and Trados's TMX exporter serialises *all* of them onto one `<tu>` as
repeated `x-Context`/`x-ContextContent` props (up to ~180 on a single unit
observed). TMX import cannot turn this into real `prev_hash`/`next_hash`
even in principle: the hash algorithm differs from this format's
SHA-256-of-normalised-text (§4), and `tuv` holds one context pair per
variant, not per occurrence. A native `.sdltm` reader is the only path to
recovering this as real ICE context.

**`attributes` + `string_attributes` is Trados's own escape-hatch
metadata mechanism** — directly analogous to `tu_attr` (§2.4): a small
`attributes` table names custom fields (`StructureContext`, `Quality`,
`SourceFile`, `TargetFile` in the sample; user-defined ones would appear
here too), and `string_attributes` holds `(translation_unit_id,
attribute_id, value)` rows. Only 4 attribute definitions and 15,501
string values existed in the sample — most of the props seen in the TMX
export (`x-Context`, `x-Origin`, `x-ConfirmationLevel`, `x-LastUsedBy`,
…) are *not* sourced from this table at all; they're synthesised by
Trados's TMX exporter from other native columns
(`translation_unit_contexts`, `change_user`, bit-packed `flags`, etc.).

**Fields `.ctm` already has a column for, confirmed present natively:**
`usage_counter` → `usage_count`, `last_used_date`/`last_used_user` →
`last_used_at`/`updated_by`, `creation_date`/`creation_user` →
`created_at`/`created_by`, `change_date`/`change_user` →
`updated_at`/`updated_by`. All of these were already being read from
TMX's `usagecount`/`lastusagedate`/`creationid`/`changeid` attributes
(backlog #18) — this confirms that mapping is drawing from the same
source data, not an approximation.

### 8a.1 What the importer actually does with all this (2026-09-15, #18b Phase 2b)

`db/tm/import-sdltm.ts` turns a parsed memory into `tu`/`tuv`/`tu_attr`
rows in one transaction, the same shape and the same guarantee as TMX
import. Four decisions were forced while writing it, and three of them
say *no* to something §8a's first draft assumed was available.

**Context is carried as provenance, never as `prev_hash`/`next_hash` —
and no `.sdltm`-sourced unit is ICE-capable.** This reverses the
expectation the backlog item was written with ("the first real
ICE-capable import path this product will have"), for two independent
reasons, either of which alone is fatal:

1. `translation_unit_contexts` records a **left** context only. §5's ICE
   tier needs *both* neighbours to match. Even with a perfect
   understanding of Trados's hash, `next_hash` would still be `NULL` on
   every imported variant, so the ICE condition could never be met.
2. The hash algorithm is Trados's, not §4's SHA-256-of-normalised-text.
   A value from it in `prev_hash` is indistinguishable, at read time,
   from a real one — the column would stop meaning one thing, which is
   the only reason the ICE tier can be trusted at all.

So the occurrences go into `tu_attr` under `x-sdltm-contexts`, as a JSON
array of `{s, t}` pairs, verbatim and complete (all ~180 of them on the
sample file's worst unit), plus `x-sdltm-id` holding the source file's
own `translation_units.id`. Nothing is discarded; it is simply not
claimed to be something it is not. If the algorithm is ever recovered,
everything needed to promote these into real `prev_hash` values is still
in the file — which would not be true had they been collapsed to one
per variant to fit the column.

**`CanHide: true` tags do not enter the token stream.** This is the one
place the native format's extra fidelity is consumed as designed:
`CanHide` is Trados's own statement that the translator never places
this tag, the same fact `FormatEntry.visible === false` records on our
side. A receiving document re-emits its own invisible tags
automatically, so carrying the origin file's would add placement
obligations corresponding to nothing. A pair survives only if **both**
halves are visible — dropping half a pair would leave an unclosed tag,
a match that can never be placed.

**Imported tags carry no `k` kind hint, because `.sdltm` has none.** A
`<TagID>` is a document-local Trados id, not a structural kind, and
`TmToken.k` exists to be matched against the receiving segment's own
tags (§3). Inventing one would be exactly the guessed correspondence
`remapTmTokens` refuses to make. The consequence is deliberate and worth
stating plainly: **a `.sdltm`-sourced match that has tags takes
`v1-spec.md` §6.1's `tm_exact_tagdiff` path** — target text placed, tags
dropped, flagged for review — rather than a full tagged placement.
Text-only units, the large majority of a real memory, are unaffected.
Recovering kinds (from `TagID` plus the originating document, or from
Trados's own tag definitions if they turn out to be stored) would be its
own item.

**A segment whose tags do not nest validly is imported as text only.**
`validateTagStructure` runs on every variant before it is written; a
failure drops the tags for that segment rather than storing a token
stream that can never be placed. It costs matching nothing — §4 discards
tags before hashing, so `plain`/`hash` are identical either way.

**The bilingual-to-multilingual step is the part that pays.** One
`translation_units` row becomes one language-neutral `tu` with one `tuv`
per language, so retrieval works in both directions with no reverse-
lookup path (§2.3), and two Trados memories sharing a source language —
which Trados itself cannot combine at all — import into one `.ctm` with
three languages in it. That is §7's argument, made concrete.

**Reading a file whose schema differs from the sample's.** Since the
schema is observed rather than documented, the reader is written to
survive disagreement: unit columns are discovered with `PRAGMA
table_info` rather than assumed, a missing `translation_unit_contexts`/
`attributes`/`string_attributes` table degrades to a warning, a tag
`<Type>` never observed becomes a placeholder rather than vanishing
content, and a `<CultureName>` disagreeing with the memory's own pair is
reported. `translation_memories.tucount` is compared against what was
actually read and any disagreement warned — the cheapest available
signal that this reader has misunderstood the file it was handed. Every
repeated problem is tallied by cause and reported once, never once per
occurrence (backlog #18's 4,615-line report).

**Still open, and the reason #18b is not closed:** none of this has been
run against a real `.sdltm`. Everything above is exercised against
synthetic databases built from `db/tm/sdltm.fixture.ts`, which is this
project's *belief* about Studio 8.06's schema written as executable DDL
— useful, but it cannot falsify itself. A real file (ideally a second
Studio version, and a second language pair) is what closes the item; see
backlog #13a for the two real EN↔KO/EN↔VI memories that should be
pseudonymised into `fixtures/` first.

---

### 8a.2 What the first real file proved (2026-09-18)

§8a opened by warning that it was reverse-engineered from one sample and
should be treated as a lead, not a schema to code against blindly. The
first time a *second* real memory was read — a 2013 client file,
thirteen years older than the sample — it produced three differences
before it produced a single unit. The warning was right, and the answer to
backlog #18b's open question is now on the record: **the schema does vary
across Studio versions, in ways that break a naive reader.**

**Context hashes are signed 64-bit integers, and reading one as a
JavaScript number corrupts it silently.** The 2013 file carries
`-8331597179047842233`. A JS number cannot hold it: `better-sqlite3`
returns `-8331597179047842000` with no error, no warning and no way to
tell; Node's own `node:sqlite` throws `ERR_OUT_OF_RANGE` on the identical
value. Whether this corrupts data or crashes therefore depended on which
driver, and which Node version, happened to be underneath — a bug that
could ship green on one platform and wrong on another. `readContexts`
(`core/tm/sdltm.ts`) now does the conversion in SQL with
`CAST(... AS TEXT)`, so the digits never pass through a double at all.

This is not a cosmetic fix. §8a.1's whole argument for carrying these as
provenance rather than forcing them into `prev_hash` is that *nothing is
lost* if Trados's hash algorithm is ever recovered. Truncated, they were
lost — the invariant was false in exactly the case it was written for.

**`sdltm.fixture.ts` declared these columns `TEXT`, and that is why no
test caught it.** SQLite's TEXT affinity quietly converted every synthetic
int64 to a string on the way in, so the reader was never handed the value
that breaks it. A fixture wrong in the same direction as the code proves
nothing, however green it is; the declaration is now `INTEGER`, and the
regression test fails without the fix.

**`string_attributes` has no `id` column** in the 2013 file. Anything
rewriting those rows has to address them by `rowid`.

**Seven tables exist that §8a never recorded:** `fuzzy_data`,
`date_attributes`, `numeric_attributes`, `picklist_attributes`,
`picklist_values`, `resources`, `tm_resources`. `fuzzy_data` had exactly
one row per translation unit (66/66) and is presumably Trados's
fuzzy-match index. **Its contents have not been examined**, and that
matters twice over: this reader ignores it, and anything pseudonymising a
`.sdltm` for public use must establish whether it holds derived source
text before assuming a scrubbed file is clean.

**What is still not known:** whether the 8.06 sample or the 2013 file is
the outlier, since two files do not make a series; what `fuzzy_data`
holds; and the context-hash algorithm itself, unchanged from §8a.1.

### 8a.3 Four real files, read by shape only (2026-09-19 → 09-23)

Issue #26 asks for the importer to be run against a real `.sdltm`. Before
that could happen, four real memories were examined on the owner's machine
with a read-only probe that prints the file's *shape* (tables, declared vs
stored types, value widths, whether any column holds recoverable text) and
refuses to print at all if a single word from the memory would appear in
its output. No memory content reached a session, and nothing was imported.
The files:

| File | Units | Size | Schema |
|---|---|---|---|
| Client A (the §8a.2 file) | 66 | 0.3 MB | older: 15 unit columns, 7 unmodelled tables |
| Client A, main | 454 | 0.8 MB | older, same as above |
| Client B, EN→KO | 529 | 1.3 MB | newer: 24 unit columns, 14 unmodelled tables |
| Client B, EN→VI | 2,866 | 5.2 MB | newer, same as above |

**`parameters.VERSION` is `8.06` in all four, and in the original sample.**
It does not tell the two schemas apart, so it cannot be what a reader
switches on. The newer files add these `translation_units` columns:
`source_tags`, `target_tags`, `source_token_data`, `target_token_data`,
`alignment_data`, `align_model_date`, `insert_date`,
`tokenization_sig_hash` and `fragment_hash`. They also add these
`translation_memories` columns: `fga_support`, `data_version`,
`text_context_match_type` and `id_context_match`. And they have seven more
tables: `translation_unit_fragments`, `translation_unit_idcontexts`,
`trans_model`, `trans_model_rev`, `vocab_src`, `vocab_trg` and
`vocabfilter`. Column discovery by `PRAGMA table_info` (§8a.1) exists for
exactly this. Nothing the importer reads went missing.

**The `application_id` guard rejects every real file.** `parseSdltm`
refuses anything whose `PRAGMA application_id` is not `1112754007`, the
value observed on the original sample. All four real files have `0`. As
shipped, the importer would refuse every real memory it has ever been
shown, before reading a unit. The guard was one file's value promoted to a
rule. The check is to be dropped, and the file recognised by its tables
instead (`translation_units` and `translation_memories` present).

**`sdltm.fixture.ts` gets the schema wrong in six places.** This is the
§8a.2 lesson again: each mistake is one the reader was written to match,
so no test could catch it.

- `PRAGMA application_id` defaults to the sample's value. Real files have `0`.
- `translation_units.tm_id`. The real column is `translation_memory_id`
  in all four files. The reader only scopes by it when a file holds more
  than one memory, which is why no real file has tripped over it yet.
- `translation_memories.created_date` / `last_updated_date` do not exist.
  The real columns are `creation_date`, `creation_user`,
  `expiration_date`, `last_recompute_date` and others.
- `translation_unit_contexts` has no `id` column in any real file (the
  same shape as `string_attributes` in §8a.2).
- `parameters` is keyed by `name` in the fixture. Real files have
  `(translation_memory_id, name, value)` with `translation_memory_id`
  NULL.
- `attributes` lacks the real `guid BLOB` and `type INT` columns.

**Every integer hash is 64-bit, not only the context hashes.**
`source_hash` and `target_hash` (both schemas), plus `fragment_hash` and
`tokenization_sig_hash` (newer schema), all hold values beyond ±2^53.
§8a.2's `CAST(... AS TEXT)` covers the context columns the reader keeps.
Any column that is ever read later needs the same treatment.

**Dates are declared `DATETIME` and stored as text** in every file. This
is harmless for a reader that parses strings, and worth knowing before
assuming a numeric timestamp.

**§8a.1's context design holds on the newer schema.**
`translation_unit_contexts` is still there and still left-only. In the
EN→KO file it has 622 rows over 527 of 529 units: one per occurrence, as
in the sample.

**What holds text, and what does not.** The probe tried every column and
every blob as UTF-8, Latin-1 and UTF-16LE (both byte alignments), raw and
after zlib, gzip and raw-deflate inflation:

- **`fuzzy_data` holds no recoverable text** in any of the four files,
  which settles §8a.2's open question. It has one row per unit. `fi1` and
  `fi8` are short non-prose strings; `fi2` and `fi4` are always NULL.
- **The newer schema's token blobs hold no text either.**
  `source_token_data` and `target_token_data` are low-entropy binary with
  no recoverable words. `source_tags`, `target_tags` and `alignment_data`
  are NULL throughout.
- **`resources.data` is plain XML and does contain memory text.** It
  appears only in the newer files, as two rows each (a UTF-8 BOM and an
  `<?xml` header), linked through `tm_resources`. Only a little memory
  text appears there, but it is there.
- **User names sit in plain text** in `creation_user`, `change_user` and
  `last_used_user` on every unit, and in
  `translation_memories.creation_user`. `attributes.name` in the EN→KO
  file contains a word from the memory itself.

**The consequence is for fixtures, not for the reader.** The plan in
§8a.2 and backlog #13a was to pseudonymise real `.sdltm` files into
`fixtures/`, the way `fixtures/docx/` was done. A scrub that rewrites
segments, attribute values and the memory's name is not enough. It would
still ship `resources.data`, every user name and `attributes.name`. And a
check that looks only at segment words would pass that file as clean.
Each round of this exercise found another place text hides. So whether
*any* scrubbed `.sdltm` should be committed is an open decision, not a
matter of one more scrub revision. The alternative on the table: fixtures
built from each real schema's DDL **verbatim**, filled with synthetic rows
of the real storage types (64-bit integers, text dates, NULL blobs), with
the real files used only for a local, uncommitted run of the importer that
checks unit count against `tucount`.

**Still to do, none of it started:** drop the `application_id` guard;
correct the six fixture mistakes and add a regression test built on the
older schema's real shape; decide between the two fixture approaches
above; then the local real-file run that issue #26 asks for.

## 9. Versioning

`PRAGMA user_version` is the format version, a single integer.

- A reader **must refuse** a file whose `user_version` exceeds the highest
  it knows, with a clear message. Never open-and-hope: a partial read of a
  translator's memory that silently drops units is the worst failure this
  product can have.
- A reader **must offer** to upgrade a file below its maximum, and **must**
  back up the file first (§10).
- Additive changes still increment the version. The cost of a bump is a
  line in a migration table; the cost of ambiguity is unbounded.

---

## 10. Durability

A translation memory is the most valuable file a translator owns. It is
years of work and it is not reconstructible.

- All writes in transactions. WAL mode. `synchronous = FULL` on the write
  path — the throughput cost is irrelevant at human typing speed.
- Automatic timestamped backup before every schema migration, every bulk
  import, and every batch find-and-replace. Retained until the user clears
  them.
- `PRAGMA integrity_check` on open, surfaced rather than swallowed.
- Compaction (`VACUUM` + tombstone purge) is always explicit, never
  automatic, and always preceded by a backup.

Encryption at rest is **not** in v1, but the format reserves the option:
SQLCipher operates below this schema and changes nothing above it. Worth
revisiting when agency clients with confidentiality clauses appear — which
the transferable-licence model makes likely.

**Revisited 2026-09-23:** encryption at rest is now a first-priority
control, to be decided before launch rather than retrofitted onto files
clients already hold (`worldwide-and-compliance-spec.md` §6.3).

---

## 11. Sizing

Target: **under 100k units** on day one, from existing Trados memories.
That target is unchanged. What changed on 2026-09-23 is that the ceiling
above it is now measured rather than estimated. An agency master TM for
a worldwide deployment could reach 1–10M units, and the earlier sentence
here ("the design holds to roughly 2M units") was a guess.

### 11.1 Measured, on synthetic data

`pnpm bench:tm` (`packages/db/src/tm/bench/`, kept out of `pnpm test`)
builds en→fr memories of 100k, 1M and 5M units through the real code
path (`createTm`, the shared migration runner, `importTmx` in 50k-unit
TMX slices, one transaction each), then times the real repository
functions against them. Each size runs in its own process, so peak RSS
belongs to one size. Generated files go to the OS temp dir and are
deleted as the run proceeds. The full run takes about 75 minutes and
needs free disk of two to three times the largest file (7.5 GiB at
5M) at its peak.

**These are synthetic numbers.** The corpus is two 6,000-word
pseudo-vocabularies drawn Zipf(1.07), 3–40 words per sentence (median
13), ~25% near-duplicates of a recent unit, ~2% same-source/new-target,
~10% numbers and ~10% inline tags. It was built to stop FTS and fuzzy
from looking artificially good, but it is not a real memory. §11.3 says
what that leaves open.

Machine: Intel(R) Xeon(R) Processor @ 2.80GHz, 4 cores, 15.7 GiB RAM, linux 6.18.44-fc-v37, Node v22.22.2, SQLite 3.49.2.

| Units | File | After VACUUM (time) | Build, 50k-unit `importTmx` slices (peak RSS) | Single-file `importTmx` (TMX size, peak RSS) | Copy | Online backup |
|---|---|---|---|---|---|---|
| 100k | 150 MiB | 144 MiB (2.3 s) | 25 s (404 MiB) | 26 s (40 MiB, 530 MiB) | 394 ms | 663 ms |
| 1M | 1,496 MiB | 1,438 MiB (26 s) | 335 s (1071 MiB) | 363 s (395 MiB, 4119 MiB) | 8.1 s | 8.1 s |
| 5M | 7,503 MiB | 7,212 MiB (133 s) | 2282 s (1051 MiB) | **fails** after 15 s (1,975 MiB): Error: Cannot create a string longer than 0x1fffffe8 characters | 36 s | 48 s |

Latency, p50 / p99 (samples):

| Units | Exact: `retrievePair` as shipped | Exact: same, after `ANALYZE` | Exact: index-friendly rewrite | Concordance, common word | Concordance, rare word | Concordance, 2-word phrase | `writeBack` (one confirm) |
|---|---|---|---|---|---|---|---|
| 100k | 161 ms / 213 ms (366) | 0.07 ms / 0.18 ms (10000; ANALYZE 217 ms) | 0.02 ms / 0.08 ms (10000) | 17 ms / 99 ms ranked; 0.07 ms / 0.16 ms unranked | 0.16 ms / 0.39 ms ranked; 0.07 ms / 0.13 ms unranked | 0.91 ms / 45 ms ranked; 0.27 ms / 0.99 ms unranked | 24 ms / 37 ms (300) |
| 1M | 1.7 s / 1.8 s (36) | 0.08 ms / 0.18 ms (10000; ANALYZE 2.4 s) | 0.03 ms / 0.11 ms (10000) | 209 ms / 1.4 s ranked; 0.10 ms / 0.23 ms unranked | 1.2 ms / 2.1 ms ranked; 0.16 ms / 0.46 ms unranked | 5.6 ms / 334 ms ranked; 0.71 ms / 3.3 ms unranked | 247 ms / 314 ms (238) |
| 5M | 8.7 s / 9.2 s (20) | 0.09 ms / 0.24 ms (10000; ANALYZE 13 s) | 0.03 ms / 0.10 ms (10000) | 1.2 s / 6.5 s ranked; 0.10 ms / 0.24 ms unranked | 5.7 ms / 10 ms ranked; 0.15 ms / 0.35 ms unranked | 31 ms / 2.8 s ranked; 1.1 ms / 9.3 ms unranked | 1.3 s / 1.4 s (47) |

Fuzzy baselines, per query sentence, p50 / p99 (queries); recall = the shortlist contained the best match the naive scan found:

| Units | Naive: score every source variant | FTS top-50, all query words | FTS top-50, stopwords dropped |
|---|---|---|---|
| 100k | 907 ms / 1.6 s (40) | 147 ms / 270 ms, recall 95% | 3.1 ms / 9.3 ms, recall 90% |
| 1M | 9.4 s / 13 s (6) | 1.9 s / 3.4 s, recall 83% | 43 ms / 186 ms, recall 67% |
| 5M | 58 s / 59 s (3) | 9.6 s / 15 s, recall 67% | 177 ms / 502 ms, recall 67% |

Warm page cache throughout: the machine had 15.7 GiB of RAM, so the
whole 7.5 GiB file fit in memory. Hits and misses are interleaved 1:1 in
the exact-lookup columns. Every sampled hit was found by all three
lookup variants, and every miss returned nothing. A budget of 60 s per
measurement is why the full-scan columns have fewer samples than 10,000.
Concordance and the fuzzy shortlist query `tuv_fts` directly, because no
repository function for either exists yet. "Ranked" is `ORDER BY rank
LIMIT 50`; "unranked" is the first 50 hits in rowid order. Fuzzy uses
word-level Levenshtein; recall has 40 queries at 100k, but only 6 at 1M
and 3 at 5M (the naive scan is what limits it), so those two recall
figures are indicative only.

### 11.2 What the numbers say

**The format holds at 5M; two of today's queries do not hold at 100k.**
A size problem in the file itself would show up as an indexed lookup
slowing down, and it doesn't. An exact lookup that seeks the
`(lang, hash)` index costs 0.03 ms at 100k units and still 0.03 ms at
5M. The file grows linearly at about 1.5 KiB per bilingual unit, so
1M ≈ 1.5 GiB, 5M ≈ 7.3 GiB and 10M ≈ 15 GiB by extrapolation. `VACUUM`
recovers only 4%. Everything that went wrong is in code that reads or
writes the format, and every such case can be fixed without a format
change.

*Broken today, at any agency size* — each is a code fix, not a format one:

- **`retrievePair` scans the whole `tuv` table on every lookup.**
  `primary_subtag(s.lang) = primary_subtag(@srcLang)` wraps the indexed
  column in a function, so the plan is `SCAN s` with a JS callback per
  row: 161 ms at 100k units, 1.7 s at 1M and 8.7 s at 5M. At 1M,
  pretranslating a 5,000-segment document would take 2.4 hours. The
  rewrite in the table reads the matching languages from `tm.langs`
  and matches `lang` by equality. Its plan is `SEARCH … (lang=? AND
  hash=?)`, it returns the same rows, and it measured 0.03 ms. Running
  `ANALYZE` alone also rescues the shipped query: SQLite then
  skip-scans the index (0.09 ms). But that depends on `sqlite_stat1`
  existing, and nothing in this codebase ever runs `ANALYZE`, so it
  belongs as a complement to the rewrite rather than a substitute. The
  same pattern is in the glossary's `findRendering`
  (`term_variant_lookup`).

  *Fixed by backlog #19a (2026-09-24), differently from the rewrite
  above in one respect.* `retrievePair` and `findRendering` now match
  `lang IN (…)`, where the list is built by `matchingLangs`
  (`db/lang-match.ts`): a recursive loose index scan that reads the
  distinct stored tags straight off the `(lang, …)` index, one seek per
  language, and keeps those whose `primary_subtag` matches. It does not
  read `tm.langs`. That column is a projection the write paths maintain
  (§2.1), and a lookup that trusted it would silently miss every row a
  stale projection left out — a failure no test on the lookup itself
  would see, and one #20a's rework of `refreshLangs` could introduce.
  The price is a few seeks per lookup: re-measured at 1M units, 0.16 ms
  p50 / 0.33 ms p99, against 0.03 ms for the `tm.langs` version and
  1.7 s before. Both plans are now `SEARCH`, and tests pin them
  (`retrieve.test.ts`, `terms.test.ts`, via `query-plan.fixture.ts`).
  The target side keeps `primary_subtag(t.lang)`: it is reached through
  `(tu_id, lang)` and only filters one unit's few variants.
- **`writeBack` gets slower with every unit already in the memory.**
  It calls `refreshLangs`, whose `SELECT DISTINCT lang FROM tuv` walks
  the whole index on every confirm: 24 ms at 100k units, 247 ms at 1M
  and 1.3 s at 5M. At 5M, each segment confirm would stall for more
  than a second.

  *Fixed by backlog #20a (2026-09-24).* `tm.langs` stays a projection
  recomputed from `tuv` on every write, as §2.1 says, but the read is
  now `distinctLangs` (`db/lang-match.ts`): the same recursive loose
  index scan `retrievePair` uses (#19a), one seek on `tuv_lookup` per
  distinct language instead of a walk of every entry. Re-measured at
  1M units, `writeBack` is 1.1 ms p50 / 25 ms p99, against 247 ms /
  314 ms before. The p99 tail is no longer `refreshLangs`, whose plan
  is now seeks only (a test pins it); it has not been profiled, and a
  WAL checkpoint landing on a confirm is the likeliest cause.
- **Single-file `importTmx` cannot take an agency-sized TMX.** It needs
  the whole document as one string plus the whole parse tree in memory.
  At 1M units (a 395 MiB TMX) it peaked at **4.1 GiB RSS**, twice a
  2 GB server. At 5M (a 2 GiB TMX) it fails before parsing begins,
  because V8 cannot hold a string longer than 2^29 characters. Import
  in 50k-unit slices, each its own transaction, stayed near 1 GiB peak
  RSS at every size. That figure is mostly V8 heap left uncollected
  between slices, not live data, and it is still unproven under a
  capped heap.

  *Fixed by backlog #18c (2026-09-24).* `importTmxFile` streams the
  file through `TmxStreamParser` and commits every 10,000 units (the
  contract is §12.4). Measured by `pnpm bench:tm --probe-only`, in a
  process capped at a 2 GB heap (`--max-old-space-size=2048`):

  | Units | TMX | Time | Peak RSS | Before (whole string) |
  |---|---|---|---|---|
  | 100k | 40 MiB | 26 s | 293 MiB | 26 s, 530 MiB |
  | 1M | 395 MiB | 407 s | 243 MiB | 363 s, 4,119 MiB |
  | 5M | 1,975 MiB | 2,676 s | 288 MiB | fails: string too long |

  Peak memory no longer grows with the file. The price is time: at 1M
  the import is 12% slower than one transaction, and at 5M it is 17%
  slower than the 50k-unit slices in §11.1 (2,282 s). That is 100 and
  500 extra commits, each with a `tm_import` update and a
  `refreshLangs` (one seek per language since #20a). It has not been
  tuned: a larger batch, or `synchronous = NORMAL` during a bulk import,
  are the obvious levers, and §10 says why the second needs arguing
  first.

*Comfortable* — fine for a 2 GB server as measured:

- Exact lookup once it seeks the index: under 0.25 ms at p99 at every
  size.
- Unranked concordance: under 10 ms at p99 at every size, for common
  words, rare words and phrases alike. Ranked concordance on a rare
  word also stays fast (10 ms at p99 at 5M).
- Copying the file (a stand-in for backup or a move between regions):
  8.1 s at 1M (1.5 GiB), 36 s at 5M. SQLite's online backup
  API, which is the right tool for a live WAL file, took 48 s at 5M.
  Both scale linearly, at roughly 150–210 MiB/s on this disk.

*A risk on a 2 GB server* — works, but not comfortably:

- **Ranked concordance on common words** scales with how often the word
  occurs, because bm25 has to score every hit before it can return the
  top 50: 209 ms p50 and 1.4 s p99 at 1M, 1.2 s and 6.5 s at 5M. A
  concordance UI should return unranked hits first, or cap the ranked
  query.
- **Bulk import throughput falls as the memory grows**: 4,700 units/s
  into an empty file, 1,850 units/s by the time it holds 4.95M. That
  makes a 5M import 38 minutes and a 10M one plausibly two hours or
  more. It needs a `worker_thread` (§1.1), resumable progress, and
  probably deferred FTS building. SQLite's default 2 MiB page cache was
  left untuned; a bigger `cache_size` is an obvious lever that has not
  been measured.
- **Nothing here measured a cold cache.** Once the file is larger than
  RAM, which on a 2 GB server means anything past about 1M units, an
  indexed lookup still touches only a handful of pages. But any
  full-scan path (the shipped `retrievePair`, `refreshLangs`, naive
  fuzzy) becomes disk-bound and far slower than the figures above.
- **`VACUUM` and the pre-migration backup (§10) each need about one
  extra file's worth of free disk**, 7+ GiB at 5M. `VACUUM` also took
  133 s holding a write lock.

*Fuzzy* (v1-spec.md §4.3's plan, checked — fuzzy is still not built):
scoring every unit takes 0.9 s at 100k units, 9.4 s at 1M and 58 s at
5M. As expected, that is not an option. The FTS shortlist fixes the
latency: dropping the 100 most frequent words and taking the top 50 by
bm25 costs 177 ms p50 at 5M. What it does not hold is *recall*: 90% at
100k and 67% at 1M. As the memory grows, more near-identical candidates
compete for 50 places, and a pure bag-of-words rank does not favour the
one closest in edit distance. The shortlist-then-score design stands.
The shortlist's size and ranking have to be designed for scale rather
than assumed. See §12.

### 11.3 What only a real multi-million-unit memory can confirm

A real memory differs from this corpus in exactly the ways that move
these numbers:

- **The vocabulary is larger.** A real memory has tens of thousands of
  distinct words plus product names, codes and numbers, not 6,000. That
  changes FTS posting-list lengths, and with them ranked-concordance
  cost and shortlist recall, in a direction nobody can predict from
  here.
- **Boilerplate and repetition are heavier.** Legal and software memories
  repeat the same segment with small variations far more than 25% of the
  time. That is the case most likely to break a 50-candidate shortlist.
- **Segments and tag payloads are longer.** Real Trados exports carry
  more and larger tags and more `<prop>`s per unit, so expect a bigger
  file per unit than 1.5 KiB.
- **Multilingual units.** A master TM with 5–10 languages per unit
  multiplies the number of `tuv` rows. The indexed paths should not
  care; the full-scan paths above would get proportionally worse.
- **The deployment box itself.** Nothing here ran on 2 GB of RAM, a
  capped Node heap, a cold cache, network storage, or with concurrent
  readers during an import.

Before quoting any of this to a client, rerun it against a real
multi-million-unit memory: import time and RSS, file size per unit,
concordance on the most common real words, and shortlist recall against
a naive scan. Then treat the synthetic figures above as the floor, not
the forecast.

The bench has a mode for exactly that, `pnpm bench:tm -- --sdltm <file>
--src en --tgt es`. It imports a real Trados memory whole through
`importSdltm` (opened read-only, so the original is never touched),
takes "common" and "rare" words and stopwords from the memory's own
source sentences by document frequency, and runs every measurement
above on it. That makes it a measurement of `.sdltm` import at scale
too, which nothing had measured before. A client's memory never leaves
the owner's machine for this. The run writes its `.ctm` to the OS temp
dir and deletes it (a crashed run can leave one behind), and its
results files hold timings, counts, query plans and the language tags,
never text, so only the numbers come back into this section.

### 11.4 The first real memory (2026-09-23)

A 2022 en-US→es-ES client memory, run on the owner's machine: Intel
i5-10500T, 12 threads, 15.8 GiB RAM with only about 1.8 GiB free,
Windows 11, Node 22.23, SQLite 3.49.2. That is a different and slower
machine than §11.1's, so compare shapes rather than absolute
milliseconds.

| Units | `.sdltm` | `.ctm` (after VACUUM) | `importSdltm`, whole file (peak RSS) | Copy / online backup |
|---|---|---|---|---|
| 86,240 | 574 MiB | 154 MiB (148 MiB, 2.7 s) | 31 s (396 MiB) | 111 ms / 988 ms |

| Exact: `retrievePair` as shipped | after `ANALYZE` | index-friendly rewrite | Concordance, common word | rare word | 2-word phrase | `writeBack` |
|---|---|---|---|---|---|---|
| 214 / 267 ms (278) | 0.10 / 0.23 ms | 0.04 / 0.10 ms | 11 / 46 ms ranked; 0.10 / 0.24 ms unranked | 0.10 / 1.7 ms ranked; 0.05 / 0.49 ms unranked | 0.51 / 6.5 ms ranked; 0.28 / 1.1 ms unranked | 16 / 46 ms |

| Fuzzy: naive | FTS top-50, all words | FTS top-50, stopwords dropped |
|---|---|---|
| 1.0 / 1.3 s (40) | 49 / 209 ms, recall 100% | 2.4 / 68 ms, recall 100% |

(p50 / p99, samples in brackets.)

What it says:

- **The synthetic corpus held up at this size.** Every shape in §11.1's
  100k row reappears: `retrievePair` as shipped scans (214 ms), and the
  rewrite seeks (0.04 ms); `writeBack` costs tens of milliseconds;
  ranked concordance on a common word is the one slow FTS path; the
  naive fuzzy scan takes about a second. Shortlist recall was 100% on
  real text at 86k units, against 90–95% synthetic at 100k. That makes
  §11.2's recall worry no worse on real data at this size. It does not
  settle it at 1M.
- **A `.ctm` is about 3.7× smaller than the `.sdltm` it came from**:
  1.8 KiB per unit against Trados's 6.8 KiB. The `.ctm` figure is 20%
  above the synthetic 1.5 KiB, partly because of the 110,960 Trados
  context occurrences carried as provenance (§8a.1). **Megabytes of
  `.sdltm` are not a unit count.** This "huge" 574 MB memory is under
  the 100k day-one target. At 6.8 KiB a unit, a 10M-unit agency memory
  would be about 65 GB as `.sdltm` and about 18 GiB as `.ctm`.
- **`importSdltm` has the same whole-file memory shape as `importTmx`.**
  It parses every unit before writing any: 396 MiB peak for 86k units,
  or roughly 3.5 KiB per unit above the process baseline. Extrapolated
  linearly (not measured), a 2 GB server runs out somewhere around
  half a million units. §12.4 applies to both importers.
- **Issue #26's first check passed on this file.** Units read matched
  the file's own `tucount` (the importer's mismatch warning did not
  fire); 6 units with no source text were skipped by design. Two things
  §8a had not recorded turned up: a tag `<Type>` of `TextPlaceholder`
  (26 tags, carried as placeholders), and a Trados attribute
  (`StructureContext`) repeated within one unit (254 units, first value
  kept). 7,888 `CanHide` tags were left out as designed, and 15,356
  variants carry tags without a kind hint (§12.3). The file's
  `application_id` is 0, like every real file in §8a.3. The bench wraps
  the file so the guard lets it through; the product still refuses it
  until #68 drops the guard.

---

## 12. Open questions

1. **Permanent extension.** `CATM` is settled and name-independent. The
   `.ctm` extension is still working-name-derived and should be revisited
   at product naming — a free change, unlike the magic number. Readers
   must key off `application_id`, never the extension, so that this stays
   free.
2. **Language variant granularity.** Are `es-ES` and `es-419` one language
   or two in a memory? Current model treats BCP-47 codes as distinct, with
   region-insensitive fallback at retrieval. Fine for one translator;
   worth revisiting if agencies use the format.
3. **Native `.sdltm` import (§8a).** Reader and importer exist
   (`core/tm/sdltm.ts`, `db/tm/import-sdltm.ts`), validated only against
   synthetic data built from a schema reverse-engineered from one real
   file — see backlog #18b, still open for exactly that reason.
   `CanHide`-accurate tag visibility is recovered as promised (§8a.1);
   per-occurrence context is **not** ICE context and is carried as
   provenance instead, because Trados records a left context only and
   hashes it differently from §4. Recovering tag *kinds*, which `.sdltm`
   does not record either, is the other thing a fully-placed match from
   a Trados memory would still need.
   **Priority, decided 2026-09-23: TMX first.** Translators and
   language providers routinely export TMX, and that path is enough.
   Native `.sdltm` import is a nice-to-have: keep what exists, and let
   issue #26 (drop the `application_id` guard, fix the fixture) wait
   behind the TMX work in §12.4. One real file has now been through it
   (§11.4, `tucount` matched), which is further than the
   reverse-engineering needed to go for now.
4. **Import at agency scale (§11.2, §11.4).** Both importers build the
   whole memory in memory before writing: `importSdltm` peaked at
   396 MiB for a real 86k-unit memory, so a 2 GB server runs out
   somewhere around half a million units (extrapolated).
   `importTmx(db, xml: string)`
   cannot import a TMX of more than about 1M units on a 2 GB server,
   and cannot import one of 5M units anywhere: a V8 string tops out at
   2^29 characters. An agency master TM needs a streaming TMX reader
   (and a paged `.sdltm` reader, since `parseSdltm` has the same shape)
   that feeds units into bounded transactions (the 50k-unit slices in
   §11.1 stayed near 1 GiB peak RSS), run in a `worker_thread` per
   §1.1, and it needs a resume point. One more design question comes
   with it: whether one import is still one transaction (§7's
   all-or-nothing) when it takes 38 minutes, or whether resumable
   slices plus a visible "incomplete import" state are the honest
   contract.
   **Decided 2026-09-24 (backlog #18c), for TMX: resumable batches with
   a visible incomplete state, not one transaction.** Four reasons:
   - *All-or-nothing protects a merge, not an import.* §7's guarantee is
     there because a half-applied merge leaves units whose variants were
     resolved against a memory that no longer exists. An import only
     appends new units, and every batch ends on a unit boundary, so any
     prefix of it is a consistent memory. It is incomplete, never
     inconsistent. The risk is *not knowing* it is incomplete, which is
     what `tm_import.finished_at IS NULL` answers (§2.9).
   - *One 38-minute transaction holds the write lock for 38 minutes.*
     The memory being imported into may be a project's write target;
     every confirm against it would wait (or time out) for the whole
     import.
   - *It costs a second file's worth of disk.* The WAL cannot be
     checkpointed past an open transaction, so a 5M-unit import grows
     it to the size of the finished memory (7+ GiB, §11.1) before the
     commit can shrink it.
   - *A crash at minute 37 loses 37 minutes.* With batches it loses at
     most one batch, and running the same import again resumes after
     the last committed unit.

   What stays all-or-nothing: an import from a string (one batch), and
   `.sdltm` import, until its reader is paged too. Off-thread execution
   is still #16a.
5. **Fuzzy candidate retrieval at scale (§11.2).** In the synthetic
   corpus, a top-50 FTS shortlist lost the best edit-distance match
   10% of the time at 100k units and a third of the time at 1M. Open:
   a larger or adaptive shortlist, a rank that rewards length
   similarity, n-gram rather than word terms, or embeddings
   (`tuv_vec`, §2.8) as a second candidate source. Measure against a
   real memory before choosing (§11.3).
6. **Query statistics.** Nothing ever runs `ANALYZE` or
   `PRAGMA optimize`, so the planner never has statistics. §11.2 shows
   that statistics alone turned the pre-#19a `retrievePair` from a table
   scan into an index skip-scan. Worth deciding whether imports and
   `VACUUM` should end with `PRAGMA optimize` as a safety net, even
   once every hot query seeks its index by construction.
7. **One file per client, or one master file?** The format holds a 5M
   memory, but every whole-file operation grows linearly with it: copy,
   online backup, `VACUUM`, and the pre-migration backup (§10), all
   36–133 s at 5M and each needing a file's worth of free disk. How an
   agency deployment splits memories across files (per client, per
   language pair, per region), and how the `priority` resolution that
   already exists for attached TMs (`tm_ref`) covers the split, is a
   product decision that these numbers now inform rather than a
   performance problem.
