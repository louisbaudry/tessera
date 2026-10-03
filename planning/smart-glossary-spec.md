# Smart Glossary — spec

**Status:** draft for review
**Date:** 2026-09-14
**Extends:** `ai-platform-vision.md` §3 (Ring 0.5), `tm-format-spec.md`,
`v1-spec.md` §6.4
**Backlog:** Epic 8a (see §9) — sized, sequenced against Epic 6 and Epic 8

The problem this solves: an AI-drafted translation renders the same source
term three different ways across one document, and nobody notices until
the client does. The fix is not a smarter prompt — it is making the
_decision_ (which rendering, for this client) a first-class thing that is
asked once, answered by the translator, and remembered.

This document records the design conversation of 2026-09-14 (ten
decisions, §1) and what the existing codebase forced on top of them (§2).
Every decision below that deviates from the conversation is marked
**Deviation** and explains why.

---

## 1. Decisions taken (2026-09-14)

| #   | Question                          | Decision                                                                                                     |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | What gets flagged                 | **Hybrid**: a term must be _repeated_ (≥ `minOccurrences`, default 3) **and** _genuinely undecided_ (≥ 2 distinct renderings, or the aligner's confidence below threshold) |
| 2   | When the translator is asked      | **Side panel**, non-blocking; never a modal, never a pause in the segment flow                               |
| 3   | What they choose from             | AI-ranked renderings **plus a free-text entry**                                                              |
| 4   | Glossary scope                    | **Per client, per language pair, with a base glossary inherited underneath**                                 |
| 5   | Authority of an existing entry    | **Soft**: proposed and highlighted, never enforced; the translator can override per segment                  |
| 6   | Editing an existing entry mid-job | **Propose, confirm at session end** — no inline mutation of the glossary during translation                  |
| 7   | Architecture                      | **Split**: detection and session logic in `@cat-tool/core`, storage in `@cat-tool/db`, I/O in the server     |
| 8   | Storage                           | Client-scoped, one source of truth, outlives any project — **see Deviation, §2.1**                           |
| 9   | Entry metadata                    | **Immutable history**: every decision is an append-only record; the current entry is derived from them       |
| 10  | When detection runs               | **Post-translation**: over a finished draft, not interleaved with drafting                                   |

Decisions 2, 3, 5 and 6 are consistent with the three Ring 0.5 constraints
already fixed in `ai-platform-vision.md` §3 (context-aware, inline, never
blocking). Decision 5 is the one that keeps the translator the authority —
the same reason `v1-spec.md` §6.1 never overwrites a confirmed segment.

---

## 2. What the codebase forced

### 2.1 Deviation — storage is a `.ctg` file, not `portal.sqlite`

The conversation settled on "the portal DB". Two things already on the
record say otherwise:

- `packages/db/src/portal/schema.ts` declares `portal.sqlite` holds
  "client-facing business data (orders, files, rates), **never translation
  content**". A glossary is translation content.
- `pricing-model.md` §6 and §9 already model **termbases as resources
  parallel to TMs** — personal vs. agency-assigned, read-only under a
  borrowed seat, "any terms added during the project are committed at the
  return handshake". That is a file-shaped resource with the `.ctm`
  lifecycle, not a table in the business database.

What the decision actually wanted — client-scoped, one source of truth,
survives project deletion, reusable across projects — is exactly what a
`.ctm` already is for memories. So: **a glossary is a `.ctg` file**
("CATG", `application_id = 0x43415447`), opened through the shared
migration runner (`db/migrate.ts`, CLAUDE.md invariant), attached to a
project the way a `.ctm` is (`TmRef` → a sibling `GlossaryRef` with
`priority`). One `.ctg` per client. The **base glossary** (decision 4) is
simply a second `.ctg` attached at lower priority — inheritance is
`priority` resolution, the mechanism `tm-refs.ts` already has, not a new
concept.

"Per language pair" needs no schema either: the file is multilingual the
way `.ctm` is (a term identity with one variant per language, §3), and a
pair is a self-join — the same reason `retrievePair` needed no reverse
lookup (backlog #15e).

The portal's `client` row gets a nullable `glossary_path` column when the
portal and the CAT tool are actually joined (`portal-v0-spec.md` §8's
`CatToolProductionAdapter`). Not before; that join is Epic 8's, not this
spec's.

### 2.2 No AI translation exists yet, and the editor is partial

Epic 6 (#27–#35) was unbuilt when this was written; the server (#27),
the grid (#28) and the tag-aware target editor (#29) have landed since,
with no side panel. Epic 8 is still a placeholder. A "side panel
during AI translation" therefore has nowhere to live today. This spec
splits accordingly (§9): the format, repositories, deterministic
detection and the session state machine are buildable and provable now,
headless, exactly as `portal-core` was built ahead of a UI; the aligner's
Claude implementation and the panel itself wait on Epic 8's own spec and
the editor. Nothing here should be built against a guessed editor.

### 2.3 Layering

`core/glossary/` is a new sibling of `core/tm/`: it imports from
`model/` (the `Segment` type) and from `tm/normalize.js` (term text is
compared under the same `normalizer_version = 1` rules as segment text —
one definition of "the same string", never two). Nothing in `model/`,
`docx/`, `segment/` or `tm/` may import from `glossary/`. `project/`
may, as the layer above everything, when a glue function eventually
needs both a segmented file and its glossary.

---

## 3. `.ctg` format

Deliberately the `.ctm` shape with the vocabulary changed, so that every
lesson that format already paid for (identity vs. variant, per-variant
`rev`, tombstones, history, merge by `uuid`) carries over unchanged.

### 3.1 `glossary` — identity and contract

```sql
CREATE TABLE glossary (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  uuid               TEXT    NOT NULL UNIQUE,
  name               TEXT    NOT NULL,
  client             TEXT,                -- label; NULL for a base glossary
  langs              TEXT    NOT NULL,    -- JSON array of BCP-47 codes present
  created_at         TEXT    NOT NULL,
  format_version     INTEGER NOT NULL,
  generator          TEXT    NOT NULL,
  normalizer_version INTEGER NOT NULL,    -- imported from core, never redeclared
  read_only          INTEGER NOT NULL DEFAULT 0
);
```

`client` is a label, matching `tu_attr`'s reserved `client` key in the
TM format — the two should agree for one client, which is a convention
until the portal join (§2.1) makes it a foreign key.

### 3.2 `term` — identity

```sql
CREATE TABLE term (
  id          INTEGER PRIMARY KEY,
  uuid        TEXT    NOT NULL UNIQUE,   -- stable across copies and merges
  rev         INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0 -- tombstone, tm-format-spec §7
);
```

No text lives here. A term is language-neutral: the EN "invoice" and the
ES "factura" are two variants of one term, so an EN/ES glossary is also
an ES/EN one for free.

### 3.3 `term_variant` — one rendering per language, current state

```sql
CREATE TABLE term_variant (
  id          INTEGER PRIMARY KEY,
  term_id     INTEGER NOT NULL REFERENCES term(id) ON DELETE CASCADE,
  lang        TEXT    NOT NULL,          -- BCP-47
  rev         INTEGER NOT NULL DEFAULT 1,
  text        TEXT    NOT NULL,          -- as the translator wants it shown
  plain       TEXT    NOT NULL,          -- normalised (tm-format-spec §4), for matching
  note        TEXT,                      -- context: "in reference to software, not equipment"
  forbidden   INTEGER NOT NULL DEFAULT 0,-- a rendering the client rejected; see §6
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  updated_by  TEXT,
  UNIQUE (term_id, lang, plain)
);
CREATE INDEX term_variant_lookup ON term_variant(lang, plain);
```

**Implementation note (#39):** `plain` is `termKey(text)` —
`normalizeText` (the frozen `normalizer_version = 1` rules) **then
case-folded** with `toLowerCase()`. Segment hashing deliberately keeps
case (`tm-format-spec.md` §4: "case does not" hash equal); a glossary
lookup that did the same would miss every sentence-initial occurrence,
so this is its own function in `core/glossary/key.ts`, not a flag on
`normalizeText` — two different facts about two different things.

`UNIQUE (term_id, lang, plain)` rather than `(term_id, lang)`: a term may
legitimately carry **several** renderings in one language — one
preferred, others forbidden, or two acceptable synonyms with different
notes. Which one is _preferred_ is not a column; it is the most recent
non-forbidden decision (§3.4) — derived, not stored, so it can never
disagree with the history that justifies it.

### 3.4 `term_decision` — the immutable record (decision 9)

```sql
CREATE TABLE term_decision (
  id             INTEGER PRIMARY KEY,
  term_id        INTEGER NOT NULL REFERENCES term(id) ON DELETE CASCADE,
  lang           TEXT    NOT NULL,
  chosen         TEXT    NOT NULL,       -- plain of the chosen term_variant
  rejected       TEXT    NOT NULL,       -- JSON string[] of the alternatives offered and not taken
  kind           TEXT    NOT NULL CHECK (kind IN ('accepted_suggestion','custom','override','deprecation')),
  source_project TEXT,                   -- project name/uuid the decision was made in
  source_segment INTEGER,                -- segment ord where the term was first seen
  decided_by     TEXT,
  decided_at     TEXT    NOT NULL
);
CREATE INDEX term_decision_term ON term_decision(term_id, lang, decided_at);
```

Append-only. **Never updated, never deleted except by tombstone
compaction.** This is what "immutable history" means here: not a
`tuv_history`-style copy of the previous row (that exists too, §3.5, for
merge parity), but a log of _what was offered, what was chosen, by whom,
where_. Six months later the question "why is it `logiciel` and not
`programme` for this client?" has an answer with a project name on it.

`kind`:

- `accepted_suggestion` — picked one of the aligner's renderings;
- `custom` — typed a rendering not offered;
- `override` — a segment-level override of the current preferred
  rendering that the translator chose to _record_ (not every override is
  recorded — see §6);
- `deprecation` — marked the rendering forbidden (`term_variant.forbidden = 1`).

### 3.5 `term_variant_history` — merge parity

Identical in shape and purpose to `tuv_history` (`tm-format-spec.md`
§2.5): the pre-change row, keyed `(term_variant_id, rev)`. Exists so
`.ctg` merge can be `.ctm` merge with the table names swapped — the
merge rules in `tm-format-spec.md` §7 apply verbatim (union by `uuid`,
per-`lang` `rev` resolution, tombstones propagate, same-`plain`-different-
`uuid` kept as distinct). `term_decision` rows merge by union — they are
facts about the past and never conflict.

### 3.6 Deliberately absent

- **No `usage_count` / `confidence_score` on the entry.** Both derive from
  `term_decision` (count of decisions, share of `override` among them).
  Storing them would be the second definition of a fact the log already
  holds.
- **No `seg_profile`, no `_vec`, no FTS.** A glossary is small (hundreds,
  not hundreds of thousands); `term_variant_lookup` on `(lang, plain)` is
  the whole retrieval story. FTS is added the day concordance wants it,
  as a migration.

---

## 4. Detection — `core/glossary/`, headless

Runs **after** a draft exists (decision 10), over `Segment[]` with both
`sourceTokens` and `targetTokens` populated. Two stages, deliberately
separated so the deterministic half is provable without any model in the
loop — the same split `segment/segmenter.ts` makes between `findBoundaries`
and `segmentTokens`.

### 4.1 Stage 1 — candidate terms (deterministic)

`extractCandidates(segments, {srcLang, minOccurrences, maxWords})` →
`Candidate[]`.

Walks the source text of every non-locked segment, normalises it
(`normalizeTokens`, so `Logiciel` / `logiciel` / `logiciel ` are one
term), and counts 1..`maxWords`-word n-grams (default 3), dropping
n-grams that begin or end with a stopword for `primarySubtag(srcLang)`
(a small per-language list in `glossary/stopwords.ts` — data, not code,
like `segment/rules.ts`). A candidate is an n-gram with
`occurrences ≥ minOccurrences` (default 3), carrying the `ord` of every
segment it occurs in. Longer n-grams absorb their sub-grams when the
sub-gram occurs nowhere else ("tax invoice" ×4 suppresses "invoice" ×4,
not "invoice" ×7).

This is the _repetition_ half of decision 1. It is cheap, it needs no AI,
and its tests are sentence lists — no XML, no DB, no network.

### 4.2 Stage 2 — renderings (the `TermAligner` seam)

For each candidate, something has to say how the target renders it in
each segment. That is alignment, and honest alignment across languages is
a model's job. It sits behind an interface, the way `NotificationService`
and `ProductionAdapter` do in `portal-core`:

```ts
interface TermAligner {
  align(request: AlignRequest): Promise<AlignResult>;
}
interface AlignRequest {
  readonly srcLang: string;
  readonly tgtLang: string;
  readonly term: string; // candidate, source-language
  readonly pairs: readonly { ord: number; source: string; target: string }[];
}
interface AlignResult {
  readonly renderings: readonly {
    readonly text: string; // as found in the target
    readonly ords: readonly number[]; // segments rendering it this way
    readonly confidence: number; // 0..1, the aligner's own
  }[];
}
```

`core` ships one implementation, `StaticTermAligner` — a lookup table for
tests, no I/O. `ClaudeTermAligner` lives in the server package alongside
`SmtpNotificationService`, because it is HTTP: `core` stays headless.
Its prompt is Epic 8's to design; this spec only fixes the contract.

The aligner is called **only for a project whose client has AI
processing on** (`ai-platform-vision.md` §5 — opt-in per client, one
click off). With it off, Stage 2 is skipped and the panel shows Stage 1
candidates with no renderings — still useful: "this term repeats 11
times, decide it once".

### 4.3 Stage 3 — flagging (deterministic again)

`flagTerms(candidates, alignments, glossary, {minConfidence})` →
`TermFlag[]`. A candidate is flagged when any of:

- ≥ 2 distinct renderings after normalisation (**inconsistent**);
- one rendering, but `confidence < minConfidence` (**uncertain**);
- its glossary entry exists and some rendering differs from the preferred
  one (**glossary mismatch** — decision 5's "highlight", never an error).

Not flagged: one consistent, confident rendering that matches the
glossary or has no entry. The aim is a panel with the five decisions
worth making, not fifty.

**Implementation note (#40).** What the build settled that §4's sketch
left open:

- **What a word is** (`candidates.ts`): letters and digits, with `-` and
  `.` allowed _inside_ (`e-mail`, `U.S`, `3.5`) and never at the end, so
  `Mons.` is the word `Mons` and its full stop is punctuation. Between two
  words of one n-gram there may be only spaces or an apostrophe (an
  elision: `l'accord` is `l` and `accord`); a comma, quote, bracket, dash or
  full stop ends the run, so a term never spans a clause ("invoice, tax" is
  not one). A number alone is never a term and ends the run.
- **Absorption is by occurrence, not by candidate.** §4.1's rule ("tax
  invoice" ×4 suppresses "invoice" ×4, not "invoice" ×7) is implemented as:
  every sub-span of every _qualifying_ multi-word occurrence is covered, and
  a shorter candidate stays only if its **uncovered** occurrences still
  reach `minOccurrences`. That agrees with both of §4.1's examples and
  also decides the case between them — "invoice" ×5 with "tax invoice" ×4
  has one left over and is dropped, since it is no longer repeated on its
  own and would otherwise be a second decision about one thing. A term
  with a stopword _inside_ ("cruz de tenerife") is a term; one that begins
  or ends with one is not.
- **A four-word name is two terms at the default `maxWords` of 3.** "Santa
  Cruz de Tenerife" gives "santa cruz" and "cruz de tenerife", overlapping,
  and the panel offers both. `maxWords: 4` keeps it whole (and is tested).
  The default stays at §4.1's 3 until a real manuscript says which costs
  more: a four-word default makes every prepositional phrase a candidate.
- **Occurrences count every occurrence; `ords` name each segment once.**
  Locked segments are skipped, as are a text box's `mc:Fallback` copies —
  the twin's duplicate would count every term in it twice, as it would a
  word (backlog #34). Result order is most occurrences, then longer, then
  by key, so a run reads the same as the last.
- **Stopwords are data, and the lists are small on purpose**
  (`stopwords.ts`): function words only, plus the bare stems an elision
  leaves (`l`, `d`, `qu`, `s`). A language with no list throws
  (`UnsupportedGlossaryLanguage`), as `rulesFor` does — for zh/ja/th an
  n-gram of whitespace-separated words means nothing.
- **`flagTerms` takes `null` for "Stage 2 did not run"** and flags each
  repeated, undecided candidate `unaligned` with no renderings — §4.2's
  "this term repeats 11 times, decide it once". A candidate whose glossary
  entry already has a preferred rendering is not asked again. With
  alignments, a candidate the aligner returned nothing for is not flagged:
  there is nothing to choose between. Renderings that are the same
  `termKey` are one (`Factura`/`factura` is not an inconsistency); their
  segments are united and the aligner's best confidence kept.
- **The glossary is a function, not a connection** (`GlossaryLookup`: a
  source term's `termKey` to `{ termId, preferred }` or null), so `core`
  stays headless and the wiring to `resolveRendering` is the caller's —
  #42 and #43 — not this card's. `toSessionFlag` is the one place #40 and
  #41 meet: renderings offered most-used first, the glossary's preferred
  one appended last if the aligner did not find it, so the translator can
  still go back to it.
- **Not yet tuned: `minOccurrences` = 3** (§10.1). The committed corpus is
  synthetic text (`fixtures/docx/README.md`), so what repeats in it is the
  synthesiser's doing: `footnotes-manuscript` gives 1,678 candidates over
  1,304 segments, which says nothing about a real manuscript. The number
  needs a real one, on the owner's machine, with only counts coming back.

---

## 5. The session — `core/glossary/session.ts`

Decision 6 (propose, confirm at session end) makes the panel's state a
small explicit state machine, pure, like `portal-core/order.ts`:

```
flag ──choose(rendering | custom)──▶ decided ──┐
  │                                            ├─▶ commit() ─▶ term_decision rows
  ├──propose_edit(existing entry)──▶ proposed ─┘                + term_variant upsert
  └──skip──▶ skipped  (nothing written; re-flagged next session)
```

- `choose` records the pick and the rejected alternatives in memory.
- `propose_edit` queues a change to an _existing_ entry; nothing touches
  the `.ctg` until `commit`.
- `commit` is the one write: every decided flag becomes a `term_decision`
  row plus a `term_variant` upsert (`rev + 1`, old row to history), in one
  `db.transaction()` — the `insertFile` rule, a session's decisions are
  never half-written.
- `discard` drops everything. Skipped flags are not remembered: a term
  the translator did not decide is re-asked next time, by design — silence
  is not a decision.

The session is serialisable (`toJSON`/`fromJSON`) so the server can keep
it per project between requests without the panel holding it in a browser
tab that may close.

**Implementation note (#41).** What the build settled that §5's sketch
left open:

- **`core` decides, `db` writes.** `GlossarySession` (`core/glossary/
  session.ts`) is pure and holds no connection. `commit(write)` hands the
  decided entries, in flag order, to a writer it is given and closes the
  session only if the writer returns: a failed write leaves the session
  open and every decision in it. `commitGlossarySession`
  (`db/glossary/session.ts`) is that writer inside one `db.transaction()`.
  The seam is the `TermAligner`/`NotificationService` one, and keeps
  `core` headless.
- **The session's input is a `SessionFlag`, not `#40`'s `TermFlag`.** It
  carries what a decision needs — the source term, the renderings offered,
  the existing entry if there is one, the segment where it was first seen —
  and nothing about how it was found. `#40`'s `flagTerms` maps onto it;
  neither depends on the other.
- **The kind is derived, not claimed.** `choose` records
  `accepted_suggestion` when the rendering is one that was offered (by
  `termKey`) and `custom` when it is not; a caller never names it, as an
  editor's save never names a status (`v1-spec.md` §7.2). `propose_edit`
  takes `override` or `deprecate`, and only on a flag that has an existing
  entry: an edit to nothing is not a proposal.
- **Any open state can change until `commit`.** A flag is `flagged`,
  `decided`, `proposed` or `skipped`; `choose`, `propose_edit` and `skip`
  each replace the last, and `reopen` returns a flag to `flagged`. After
  `commit` or `discard` every operation throws. A decided and a proposed
  flag each write exactly one `term_decision` row; a skipped or reopened one
  writes none and is remembered nowhere.
- **The variant upsert bumps `rev` only for a real change.** A chosen
  rendering with a variant of that `termKey` already there keeps its text;
  it changes (`rev + 1`, the old row to history — `updateVariant`) only if
  its `forbidden` flag does. A rendering with no variant yet is added.
  `deprecate` sets `forbidden`; **choosing a forbidden rendering clears
  it**, and says so in the log: the translator is the authority (decision 5)
  and the decision row is what records that they overrode "never call it X".
- **A flag with no entry yet creates one**, unless a live term already has
  that source rendering in the source language, which is reused. Terms are
  language-neutral (§3.2), so the source variant and the target variant
  land on one term.
- **`decided_by` is the actor's label**, as `.ctm`'s `updated_by` is
  (`audit-spec.md` §2.1): those files are portable, and the principal
  (`account:3`) means nothing outside the installation. The actor is a
  required parameter of the commit, never defaulted.
- **Serialisable, and strict about it.** `toJSON` writes a versioned
  plain object; `fromJSON` re-validates all of it and throws on anything it
  does not recognise, since it reads what a client held.

---

## 5a. The panel and its API (backlog #43a, #43b)

Written 2026-10-03, before the code. §9 said the panel's interaction
design belonged to "Epic 8's editor spec", which does not exist; nothing
in it needs the AI, so it is settled here instead.

**What the server has today: no glossary at all.** `@cat-tool/server` has
routes for projects and memories (`/api/tms`, `/api/projects/:name/tms`,
backlog #32) and none for glossaries: no `storage.ts` path for a `.ctg`,
no create or attach route, nothing that runs detection. A panel needs
all of it, so #43 is three cards, in this order, each its own PR:

- **#43a — glossary API (server).** Everything §4–§5 built, behind
  HTTP, with no UI.
- **#43b — the panel (web).** The side panel over #43a.
- **#43c — mismatches (§6).** Added when #43a was built: the panel's
  second tab waits for it.

### 5a.1 The API (#43a)

Each route is a repository call with HTTP around it (the CLI rule,
`v1-spec.md` §2.4); nothing here decides anything `core` or `db` do not.

- **Storage mirrors memories.** `glossariesDir`/`glossaryPath` in
  `server/src/storage.ts`, built from the account's `storage_root` and a
  slug validated by `isSlug`; no function takes a path from a request, and
  a response names a glossary by slug, never by path.
- **Glossaries:** `GET`/`POST /api/glossaries` (a glossary is created with
  nothing but its name: `createGlossary` takes a name and a generator, and
  the identity row's `langs` stays empty, since languages live on the
  variants (§3.3)). Per project,
  `GET`/`POST /api/projects/:name/glossaries` attaches one after every one
  already there (`addGlossaryRef`, with the next priority), optionally as
  the write target. The panel needs a write target to commit into; a
  project with none gets a 409 on commit that says so, not a silent
  default.
- **The session lives in server memory, keyed by account, project and
  file** — §5 says the server keeps it between requests so that the panel
  need not. It is deliberately _not_ persisted: a session is a proposal,
  and a server restart loses undecided work the way closing the tab of an
  unsaved form would. Persisting it is a schema change to answer only if
  that ever costs a translator real work.
- **Detection:** `POST /api/projects/:name/files/:fileId/glossary/session`
  runs `extractCandidates` over the file's segments, `flagTerms` with
  `alignments = null` (Stage 2 is not run, §4.2: no AI client or opt-in
  exists yet, backlog #42), maps each flag with `toSessionFlag`, with the
  glossary lookup wired to `resolveRendering` — the wiring §4.3 left to
  "#42 and #43" — and returns the session as `toJSON` plus, per flag, the
  segment ords it occurs in. Starting one while another is open for the
  same file replaces it, and says so in the response.
- **Transitions:** `POST …/session/choose` (a rendering offered, or free
  text: decision 3), `…/skip`, `…/propose` (`override` | `deprecate`, only
  with an existing entry), `…/reopen` — each the `GlossarySession` method
  of the same name, each returning the session. A client names a flag by
  its `key`, never by index, so a reorder cannot move a decision.
- **Commit and discard:** `POST …/session/commit` is
  `commitGlossarySession` with `sessionActor(req)` and the project's name
  as `sourceProject`; `DELETE …/session` is `discard`. A commit that
  throws leaves the session open (§5, #41's note).
- **Mismatches (§6) are not in #43a.** Matching a target against a
  glossary's preferred or `forbidden` renderings needs its own design —
  a `db` listing of a glossary's entries for a language pair, a pure
  `core` matcher over tokens (word boundaries, inflection), then
  `GET …/glossary/mismatches` — so it is **#43c**, written into §6 before
  its code. Never a QA finding (§6).
- **Audit:** the `.ctg`'s own append-only `term_decision` log is the
  record of a commit. A platform-log entry for it needs a new action in
  `platform.sqlite`'s frozen CHECK (a migration, `rebuildTable`) and is
  left for when something reads it, not added speculatively. Attaching a
  glossary and moving its write target are changes to the project, so they
  are logged there (`project.setting_changed`, key `glossary_refs`) — which
  `glossary-refs.ts` did not do until this card.

**Implementation note (#43a).** What the build settled that §5a.1's sketch
left open:

- **Detection consults the write target only.** `resolveRendering` walks
  every attached glossary in priority order, which is right for drafting
  (§6) and wrong here: a flag's `termId` names a row in one file, and a
  commit writes into the write target. A term that exists only in a
  glossary further down the list is a flag with no entry, and committing
  it writes a rendering into the write target — a client glossary
  overriding a base one, which is what attaching it over the other means
  (§2.1). With no write target no entry is known, and a commit is a 409.
- **A commit refused leaves the session open** with every decision in it,
  whether for want of a write target or because the write threw
  (`TermError`, a `GlossarySessionError`): both 409.
- **A source language with no stopword list is 422** with
  `UnsupportedGlossaryLanguage`'s own message (ko and vi have segmentation
  rules and no stopwords): the panel says why, instead of showing none.
- **Mismatches moved to #43c**, as above.

### 5a.2 The panel (#43b)

- **A side panel, fixed width, opened from the toolbar.** The QA panel
  docks under the grid at a fixed height so that opening it moves no
  column (`v1-spec.md` §7); this one is the same rule on the other axis —
  it takes a fixed strip beside the grid, never the grid's own width
  changing under the cursor mid-edit.
- **One list, in `flagTerms`'s order.** Each flag is a card: the term, how
  many times and in how many segments it occurs (each a jump to its first
  segment), and one button per rendering offered, most-used first, the
  glossary's preferred one last (`toSessionFlag`). Beside them a free-text
  field (decision 3: a translator may always type their own) and **Skip**.
  A flag with an existing entry also offers **Override** and
  **Deprecate**, which are `propose_edit`. A decided card shows what was
  picked and a **Reopen**.
- **Nothing is written until the footer's Confirm.** The footer counts what
  Confirm would write ("4 decisions, 2 skipped — skipped terms are asked
  again next time") and has **Discard**. Confirm is disabled with nothing
  decided, and with no write target explains why instead of failing.
- **With Stage 2 off, every flag reads "repeated, undecided"** with no
  renderings to pick, only the free-text field: §4.2's "this term repeats
  11 times, decide it once", which is still the useful part.
- **Mismatches are a second tab, not a layer on the first.** Each row is a
  segment, the term, the preferred rendering and a jump; the translator
  fixes the segment, leaves it, or **records the override**
  (`kind = 'override'`). A mismatch never turns a segment's status or the
  QA panel red (§6).
- **Pure logic is a `.ts` module** (`glossary-panel.ts`: card state, the
  footer's counts, which buttons a flag offers), tested in node; the
  component renders and nothing more (the SPA rule in `CLAUDE.md`).

---

## 6. Applying an entry (decision 5 — soft)

When Epic 8 drafts a segment, the current preferred rendering for every
glossary term in the source is in the prompt ("Suggestions ignore
glossary" is the first named failure in `ai-platform-vision.md` §3). When
the translator edits a segment whose target lacks the preferred rendering
(or contains a `forbidden` one), the panel shows a **glossary mismatch**
for that segment. It is never a QA `error`. The translator can:

- fix the segment;
- leave it (an unrecorded per-segment override — the common case, "this
  sentence is the exception");
- **record** the override (`term_decision.kind = 'override'`), which is
  how a preferred rendering eventually changes: enough recorded overrides
  and the panel proposes flipping the preference.

`forbidden` exists because clients say "never call it X" more often than
"always call it Y", and a glossary that can only express the positive
half cannot record that instruction.

### 6.1 The mismatch list (#43c) — design

Written 2026-10-03, before the code. Three pieces, each in the layer it
belongs to (§2.3): a `db` listing, a pure `core` matcher, one route.

- **The listing (`db`).** `listTermEntries(db, { srcLang, tgtLang }, { schema? })`
  returns, per non-tombstoned term that has a source-language variant and a
  target-language one: the source forms (non-forbidden variants), the
  _preferred_ target rendering (`preferredVariant`, so derived from the
  decision log, never stored), the other acceptable target renderings and
  the `forbidden` ones. Languages match by primary subtag like every other
  read here. A term with no preferred rendering (only forbidden ones) is
  still listed: forbidding is a rule on its own.
- **The matcher (`core/glossary/mismatch.ts`).** Entries and segments in,
  mismatches out; no DB. A segment is looked at only if it has a target
  with text (an untranslated segment is not a mismatch, it is untranslated:
  `qa` says so). Per segment and term, at most one row, as in QA (one finding
  per rule per segment): `forbidden` if a forbidden rendering occurs,
  otherwise `missing_preferred` if the preferred rendering does not. Both
  carry `found`: the forbidden text, or another acceptable rendering the
  translator used instead (what "record the override" would name), or null.
  An acceptable synonym that is not the preferred one is still a mismatch,
  as §6 says: if it were silent, overrides would never surface and the
  preference could never flip.
- **What "occurs" means: a word, with its endings.** Both sides are compared
  under `termKey` (case-folded, normalised), and an occurrence must begin
  and end at a word boundary (a letter or digit on neither side), so
  `account` is not in `accounting`. The last word may carry an ending from
  a closed per-language list (`core/glossary/inflection.ts`, data like
  `core/qa/locale.ts`): German `-e -en -er -es -em -n -s`, Spanish `-s -es`,
  French `-s -x -e -es`, English `-s -es`; any other language matches the
  exact word only. A forbidden occurrence that lies inside an occurrence
  of an acceptable rendering does not count (forbidden `account`,
  preferred `customer account`).
- **What it does not do, on purpose.** No stemming or lemmatising: an
  irregular form (`Haus` / `Häuser`, `œil` / `yeux`) is a missed match, so
  a false _mismatch_ — never a false pass — and the translator leaves it.
  No German compounds (`Bankkonto` does not contain `Konto`). A false
  mismatch costs a glance; the §6 rule that it is never an error is what
  makes that the right side to err on.
- **The route.** `GET /api/projects/:name/files/:fileId/glossary/mismatches`
  answers `{ glossary, mismatches }`, `glossary` the write-target glossary's
  slug or null with no write target (an empty list, not an error: there is
  nothing to compare against). Only the write target is consulted, for the
  reason §5a.1 gives: a row carries a `termId`, and recording an override
  writes into one file. Each row: `ord`, `segmentId`, `termId`, `term` (the
  source form that matched), `kind`, `preferred`, `found`. It is computed on
  request from the stored targets, never stored, so it cannot go stale.
- **Cost.** Entries are indexed by the first word of their source forms, so
  a segment is searched against the handful that could match rather than
  all of them. Measured (synthetic, 10,000 segments × 500 entries, a high
  hit rate): 1,115 ms with a search per pair, 148 ms indexed.

**QA integration is deferred.** `QA_RULES` is a closed set baked into the
project schema's CHECK constraint (`db/project/schema.ts`), so a
`term.glossary_mismatch` rule is a project-format migration, not a
constant added: it widens `qa_issue` and `qa_rule_setting` with
`rebuildTable` (`db/migrate.ts`), as project v7 did (backlog `#64`).
It lands with Epic 8's semantic QA (`v1-spec.md` §6.4 extended), where
it belongs, and as `warning` at most.

---

## 7. Confidentiality

Everything in `ai-platform-vision.md` §5 applies unchanged. Specifically:
Stage 2 sends source and target sentences containing the candidate to the
aligner — client content. It runs only under a paid/enterprise API tier,
only for a client with AI processing enabled, and the `.ctg` itself never
leaves the storage root except by explicit export. A base glossary shared
across clients contains only terms explicitly promoted to it (§8) — a
client-specific rendering is never inherited _upward_ by accident.

---

## 8. Not in this spec

- **Promotion to the base glossary** — moving a term from a client `.ctg`
  to the base one. Needs a UI; needs the merge code (§3.5). Later.
- **Import/export** (TBX, CSV). TBX is the TMX of termbases; same
  argument as `tm-format-spec.md` §8 — interoperate, don't adopt.
  Separate item once a real client glossary needs to come in from Trados
  MultiTerm.
- **Pre-emptive glossary extraction from the source before drafting.**
  Decision 10 says post-translation; extracting terms first to feed the
  draft is a different, earlier feature that this design does not
  preclude (Stage 1 runs on source only and would serve it unchanged).
- **Cross-file consistency across a whole project.** Stage 1 runs per
  file today; project-wide is a loop over files, not a design change.

---

## 9. Backlog placement — Epic 8a

Sequenced so the headless, testable part lands independent of the
editor, exactly as Epics 1–5 were proven headless before Epic 6.

**#39 · `.ctg` format + repositories · M** — `db/glossary/`: §3 schema
through `openAndMigrate`, `createGlossary`/`openGlossary` (the
`createTm`/`openTm` split), `GlossaryRef` on the project schema
(migration; mirrors `tm_ref` including priority), `lookupTerm(lang,
plain)` with priority resolution across attached files. _Done when:_ a
created file is `CATG` by header alone; a client `.ctg` attached over a
base `.ctg` returns the client's rendering and falls through to the
base's when absent; `term_decision` cannot be updated (a trigger raises).

**#40 · Candidate extraction + flagging · M** — `core/glossary/`:
`extractCandidates`, `StaticTermAligner`, `flagTerms`, stopword lists
for the seven v1 languages. _Done when:_ on the manuscript fixture,
extraction finds the recurring honorifics and place names (`Mons.`,
the same names `segment/rules.ts` already protects) and nothing from the
stopword lists; a hand-built inconsistent draft flags exactly the
inconsistent term and nothing else.

**#41 · Session state machine · S** — `core/glossary/session.ts`, §5,
serialisable, with `commit` writing through #39 in one transaction.
_Done when:_ a session with three decided, one proposed and two skipped
flags commits exactly four rows and re-flags the two skipped ones on the
next run.

**#42 · `ClaudeTermAligner` · M — with Epic 8, not before.** Server-side,
opt-in gated (§4.2). _Done when:_ on a hand-inconsistent EN→ES fixture it
returns the two renderings with the right `ords`, and is never called for
a client with AI off. _Prerequisites (2026-10-03):_ an AI client in the
server package and the per-client/per-project AI opt-in flag
(`ai-platform-vision.md` §5) — neither exists yet, and the flag's scope
is undecided; they belong to Epic 8, ahead of this card.

**#43 · Glossary panel · M — after #28–#35.** The side panel, §5's
transitions as buttons, free-text entry (decision 3), mismatch highlight
(§6). Designed in §5a, not in Epic 8's editor spec: nothing in it needs
the AI. Split because the server had no glossary routes at all — **#43a** the
API (§5a.1), **#43b** the panel (§5a.2), and **#43c** the §6 mismatch
list, which the panel's second tab waits for.

**#44 · `term.glossary_mismatch` QA rule · S — with Epic 8 semantic QA.**
Project-format migration extending `QA_RULES`. Severity `warning`.

#39–#41 have no dependency on Epic 6 or Epic 8 and can be built now.

---

## 10. Open, deliberately deferred

1. **`minOccurrences` default.** 3 is a guess; the manuscript corpus will
   say. #40 shipped with 3 untuned: the only corpus in the repo is
   synthetic, so it cannot say (§4 implementation note). Needs a real
   manuscript's counts.
2. **Stopword lists** — start from the segmenter's abbreviation-list
   discipline (EN and ES to a higher bar). Not a linguistics project.
3. **When the base glossary is consulted for _flagging_** (as opposed to
   lookup) — does a client rendering that contradicts the base one
   deserve a flag? Lean: no, client wins silently; revisit if it bites.
4. **The portal join** — `client.glossary_path`, and which side owns
   creating a client's first `.ctg`. Epic 8's `CatToolProductionAdapter`
   question, recorded here so it isn't lost.
