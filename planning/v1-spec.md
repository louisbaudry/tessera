# v1 Technical Spec — Personal Trados Substitute

**Status:** draft for review
**Date:** 2026-08-11
**Goal:** a tool the author can use for real paid client work instead of Trados.

v1 is deliberately *not* the commercial MVP. It is the translation engine
proven on real jobs. The commercial wedge (transferable licences, agency
pool) rides on top later and is out of scope here.

---

## 1. Scope

### In

| Area | Decision |
|---|---|
| Source format | DOCX only, import **and** export |
| Inline formatting | Full Trados-style protected inline tags |
| Working unit | Project: many files, many TMs, one write-back target |
| TM matching | **Exact matches only** (100%) |
| TM lifecycle | Write-back on confirm; TMX import and export |
| QA checks | Tags, empty/untranslated, inconsistency, numbers & punctuation |
| Languages | Western European: EN, FR, DE, ES, IT, PT, NL |
| First pair | **EN → ES** — hardened and dogfooded first |
| TM shape | **Multilingual** — one memory, any pair retrievable |
| TM scale | Under 100k units on day one |

### Out (and why)

| Deferred | Reason |
|---|---|
| Bilingual review export (DOCX table / XLIFF) | Confirmed: no one reviews the work before delivery. Clean v1.1 addition if that changes — the segment table already holds everything it needs. |
| Fuzzy matching | Explicit v1 cut. Schema is built fuzzy-ready (§4.3) so it lands later without migration. |
| Concordance search | Falls out almost free once the TM index exists — first candidate for v1.1. |
| Termbase / MT / QA against glossary | No user need yet. |
| XLIFF, XLSX, PPTX, TXT | DOCX is the whole job. |
| CJK, Cyrillic, Nordic, Eastern European | Different tokenizer (CJK) or more abbreviation lists; neither is needed. |
| Auto-localisation of numbers/dates | Real Trados feature, but it interacts with matching in ways worth designing once fuzzy exists. |
| Cloud tier, licensing, collaboration | Separate product surface; a prototype already exists (§2.1). |
| Track changes, comments | Comment text and tracked-change content are not extracted. Footnote/endnote **bodies** *are* extracted — see §3.5. |

### Definition of done

The author translates a real, paid, multi-file DOCX client job end to end
in this tool — import, translate against an imported TMX, run QA, export —
and delivers the exported DOCX without opening Trados. Anything that blocks
that is v1; anything that does not is not.

---

## 2. Stack — pivot: web service (2026-08-30)

**Superseded below.** v1 moves from an installed Electron app to a
browser-accessed web service: a Node/TypeScript API server plus a React
SPA, both served over the internet so the tool is reachable from any
device with fiber and a browser — no install, no per-OS packaging.

This does not touch `@cat-tool/core`, `@cat-tool/db`'s schema, the tag
model, the segmentation engine, or the `.ctm` format: all of it was
built dependency-light and headless from the start (§2.3), specifically
so a hosting reversal would not touch accumulated user data or proven
logic. What changes:

| | Electron plan (superseded) | Web service |
|---|---|---|
| Shell | `desktop/` — Electron main + preload + IPC | `server/` — Node/TypeScript API (Fastify, matching the platform stack already locked for the licensing tier in `conversation-context.md`) |
| UI | `ui/` — React renderer inside Electron | `web/` — the same React SPA, served over HTTP instead of loaded by Chromium |
| File access | Renderer asks main via IPC; main touches disk directly | Browser calls the API; the server touches disk on the user's behalf |
| Storage location | One local folder the desktop app owns | A persistent volume the server owns, one storage root per account (§4.1a) |
| Distribution | electron-builder installers, three platforms | One container image, one deployment target |
| Auth | None — the OS session is the boundary | A login, however minimal, becomes the boundary — see §4.1a |

Nothing about the DOCX filter, segmentation, TM matching, or QA changes.
Epic 6 (editor) and Epic 7 (ship) are re-scoped in the backlog; the epics
before them are untouched.

None of the reasoning in §2.2 was wrong at the time — it compared
Electron against Tauri for a *desktop* build, and cross-platform
rendering consistency was the deciding point either way. A web service
resolves that comparison a different way: one Chromium (or the user's
own browser) renders the editor identically for everyone, with zero
install and zero packaging matrix, which is a stronger version of
"first-class cross-platform" than either desktop option offered. The
original comparison is kept below for the record.

## 2. Stack — decided: Electron (superseded — see pivot above)

**Electron + React + TypeScript, confirmed.** The reasoning is kept below
because the decision was contested by what is on disk, and the
counter-argument is worth being able to revisit deliberately rather than
rediscover.

`planning/conversation-context.md` locks:

- Electron + React + TypeScript (renderer)
- Node.js + TypeScript (main)
- SQLite via better-sqlite3
- pnpm workspaces monorepo, `@cat-tool/*`

The `code/` tree on disk does **none** of that:

| Locked | On disk (`code/`) |
|---|---|
| Electron + Node | Tauri 2 + Rust (`code/desktop/src-tauri`) |
| TypeScript | plain JSX, no TS anywhere |
| better-sqlite3 | `rusqlite` |
| Fastify + Postgres | FastAPI + SQLAlchemy (`code/cloud_backend`) |

The planning doc also says *"Code: not started"*, which is stale.

### 2.1 What the existing code actually is

~450 lines of desktop code plus a FastAPI backend, all aimed at the
**licensing** wedge, not translation:

- `src-tauri/src/commands/license.rs` — licence verification with offline grace
- `cloud_frontend/` — vendor dashboard, licence management, auth
- `cloud_backend/` — auth, licences, billing
- `desktop/src/components/TranslatorEditor.jsx` — two textareas and a
  debounced TM lookup. **No file import, no segmentation, no tags, no QA.**

It is codenamed "Blue Ball" and its `requirements.txt` pulls `openai`, not
the Anthropic SDK the planning doc assumes.

### 2.2 Why Electron

**Decision: keep the Electron + TypeScript lock. `code/` is parked as a
licensing spike and is not carried into the build repo.**

Reasoning, in order of weight:

1. **Differentiator #1 is "first-class cross-platform."** Tauri ships the
   OS webview — WebKitGTK on Linux, WebView2 on Windows, WKWebView on
   macOS. A dense, virtualised, keyboard-driven editor grid is exactly the
   kind of UI where those three diverge. Electron ships one Chromium and
   renders identically everywhere. Choosing Tauri means fighting your own
   headline claim.
2. **The hard part of v1 is the DOCX tag filter, and it is a solo build.**
   Velocity in TypeScript beats velocity in Rust for one person, and the
   filter is ~all of the risk.
3. **Nothing is lost.** The prototype contains zero CAT logic. The licence
   flow it does contain is a different milestone and can be ported or
   rewritten against the Node main process when the commercial tier starts.

The counter-argument is real and worth recording: Tauri binaries are
~10 MB against Electron's ~150 MB, with materially lower idle memory, and
"fast and calm" is differentiator #2. The decision weighs render
consistency above bundle size. If real-world memory use on the editor grid
turns out to undercut differentiator #2, that is the signal to revisit —
not before.

**Everything below is stack-neutral.** The data model, tag model,
segmentation rules, QA rules, and the entire TM format hold under either
choice, so a future reversal would not touch accumulated user data.

### 2.3 Target layout

```
packages/
  core/          @cat-tool/core       pure TS, no Electron, no DOM, no HTTP
    docx/        filter: parse, skeleton, render
    segment/     SRX-lite segmenter + abbreviation lists
    tm/          TMX read/write, exact matcher
    qa/          QA rule engine
    model/       shared types
  db/            @cat-tool/db         better-sqlite3, migrations, repos
  cli/           @cat-tool/cli        headless driver — the test harness
  server/        @cat-tool/server     Fastify API — auth, uploads, project/TM
                                       access, calls into core and db
  web/           @cat-tool/web        React SPA, talks to server over HTTP
```

`core` must stay dependency-light and headless: every filter, segmenter,
matcher, and QA rule is testable from `cli` with no UI, no server, and no
DOM in the loop. This is what makes the tag roundtrip provable, and what
made the desktop-to-web pivot (§2, 2026-08-30) free — `core` never knew
which shell called it.

### 2.4 The CLI (`@cat-tool/cli`, backlog #25)

The headless driver §2.3 promises: a full job — project, files, memory,
pre-translate, QA, export — with no UI, no server and no DOM in the loop.
It is the proof that `core` and `db` are complete on their own; if a
step needs something only a shell can do, that is the finding, not a
feature request for the CLI.

```
cat-tool init         <project.catdb> --src <lang> --tgt <lang> [--name <n>]
cat-tool add-file     <project.catdb> <file.docx> [--rel-path <name>]
cat-tool add-tm       <project.catdb> <memory.ctm|file.tmx|file.sdltm>
                                      [--priority <n>] [--write-target]
cat-tool pretranslate <project.catdb> [--file <id>]
cat-tool qa           <project.catdb> [--file <id>]
cat-tool export       <project.catdb> [--out <dir>] [--file <id>]
cat-tool history      <project.catdb> <segment-id>
cat-tool audit-verify <project.catdb>
```

Decisions, so they are not re-derived:

- **Each command is one repository call, never a second implementation
  of one.** `init` is `createProject`; `add-file` is `assembleFile` +
  `insertFile`; `add-tm` is `addTmRef` (plus `createTm`/`importTmx`/
  `importSdltm` when the memory has to be made first); `pretranslate`
  is `pretranslate`; `qa` is `runQaRules` over every segment; `export`
  is `exportFile` (§3.4); `history` is `listEvents` and `audit-verify`
  is `verifyAudit` (`audit-spec.md` §7, backlog #56). The CLI parses arguments, opens the database,
  prints, and sets the exit status — nothing else. Any logic it would
  need that `core`/`db` lack goes into `core`/`db`, where the editor
  (Epic 6) can reach it too.
- **`add-tm` takes the memory in whatever form the translator has.** A
  `.ctm` is attached as it is, or created empty first when the path does
  not exist yet (the usual way to get a write target for a new job). A
  `.tmx` or `.sdltm` is imported into a fresh `.ctm` beside it (same
  basename), which is then attached; an existing `.ctm` at that path is
  refused, never overwritten. Priority defaults to "after every memory
  already attached", so the order of `add-tm` calls is the consultation
  order unless said otherwise.
- **Segmentation uses `rulesFor(project.srcLang)`.** A stored
  `seg_profile` lives in a `.ctm` (tm-format-spec.md), not in the
  project, and the CLI does not consult one yet; a language `rulesFor`
  has no rules for refuses `add-file` too, with `rulesFor`'s own
  message.
- **`qa` exits non-zero when a blocking issue remains** — `isBlocking`
  (`core/model/qa.ts`: severity `error`, not dismissed), the one
  definition of "this must not ship". Warnings and dismissed findings
  never fail the run. That is what lets a script chain `pretranslate`,
  `qa` and `export` and stop where a translator would.
- **`export` writes every file (or one, with `--file`) under its original
  `rel_path` in `--out`** (default: the working directory), and reports
  per file how many paragraphs were rebuilt and how many segments carried
  a target. An untouched paragraph is spliced from its original XML
  (§3.4), so a project exported before anything is translated reproduces
  every part of the source byte for byte — the roundtrip gate's own
  per-part property (the zip container around them is rewritten, as it
  is in the gate), now holding through the database.
- **Every write names its actor, `cli:<OS user>`** (backlog #56,
  `audit-spec.md` §2.1) — self-asserted, since the CLI has no login, and
  refused outright when the process has no user name to give rather than
  logged as someone made up. `history` prints one line per event (id,
  time, actor, action, the state it recorded, tags marked `{1}`…`{/1}`);
  `audit-verify` exits 1 when the hash chain is broken.
- **No CLI framework.** Arguments go through `node:util`'s `parseArgs`;
  a dependency for eight subcommands would be the first non-workspace
  dependency outside `core`'s `fflate` and `db`'s `better-sqlite3`.
  Human-readable lines on stdout, one per outcome; errors on stderr with
  exit status 1.

Not here: `confirm`. Confirming is the translator's act on a segment
they have read, which is the editor's job (§7) — a CLI that confirms
everything pre-translate produced would write unreviewed targets into
the memory, exactly what §6.2's write-back is not for.

**The golden end-to-end test (backlog #26, `cli/golden.test.ts`,
`fixtures/golden/`).** The roundtrip gate (§3.1) proves a zero-edit
export is byte-identical; this proves the rest of the pipeline with a
memory in the loop and a translator's edits applied. One real document
(`prose-short.docx`) and a Trados-shaped TMX of its own sentences in
German go through every command above in script order; the two things
pre-translate leaves for a human — reapplying a dropped tag on a
tag-diff draft and confirming it, dismissing a false positive — are done
through the repository, since the CLI has no `confirm` by the decision
above; and everything the job prints, plus the text of every segment of
the delivered document, is compared to a committed transcript, byte for
byte. Since backlog #56 the transcript ends with the reviewed segment's
`history` and an `audit-verify` of the whole job. A golden file rather than a list of assertions on purpose: a
change to what the pipeline says or delivers becomes a diff to read and
approve, not a test nobody wrote. `UPDATE_GOLDEN=1 pnpm test:golden`
regenerates it; the diff is the review. Its own CI job, for the gate's
reason: drift in what is delivered should be unmistakable.

### 2.5 The API server (`@cat-tool/server`, backlog #27)

The shell everything after #8 runs behind: one Fastify process that owns
`platform.sqlite` (§4.1a) and the storage volume, runs `core` and `db`
in-process, and speaks JSON to the SPA (`@cat-tool/web`, from #28). The
browser never touches SQLite.

| Route | |
|---|---|
| `POST /api/login` `{email, password}` | → `{token, expiresAt, account}`; the one `/api/` path outside the gate |
| `POST /api/logout` | revokes the bearer session |
| `GET /api/me` | the account, without its password hash or storage root |
| `GET /api/projects` | every project under the account's root: `{name, project, fileCount}` |
| `POST /api/projects` `{name, srcLang, tgtLang, title?}` | creates `<root>/projects/<name>.catdb` with its identity row (`createProject`); 409 if it exists |
| `GET /api/projects/:name` | identity plus files (`id`, `relPath`, `importedAt`, `segmentCount`) |
| `POST /api/projects/:name/files` (multipart: one DOCX, optional `relPath` field) | `assembleFile` + `insertFile`, exactly `add-file` (§2.4); 409 on a duplicate `rel_path`, 422 on a source language `rulesFor` refuses |
| `GET /api/projects/:name/files/:id/segments` | the file's `Segment[]` as stored |
| `GET /api/projects/:name/files/:id/qa-issues` | every `QaIssue` on the file's segments, dismissed ones included — the grid's QA gutter (backlog #28), and #33's panel |
| `DELETE /api/projects/:name` | deletes the `.catdb` (and its log with it); 204 — backlog #57 |
| `GET /api/projects/:name/files/:id/export` | the delivered DOCX, `exportFile`, exactly `export` (§2.4) — backlog #57 |
| `PUT /api/projects/:name/segments/:id` `{targetTokens, status, origin}` | `setSegmentTarget`; tokens shape-checked (`parseTokens`) against the segment's format table; `confirmed`/`locked` refused (their own acts); 409 on a locked segment — backlog #57 |

Decisions, so they are not re-derived:

- **One login gate, the portal's mechanism.** A bearer session token,
  stored only as its SHA-256 hash, 30-day TTL: `account_session` (§4.1a)
  is `admin_session` (`portal-v0-spec.md` §7) with the account's foreign
  key, and the password and token functions are the same four, moved
  from `portal-core` into `core/auth/credentials.ts` so that both
  products import one definition (`CLAUDE.md`'s rule; the alternative
  was the CAT server depending on the portal product for a hash
  function). An `onRequest` hook answers 401 to every `/api/` path but
  login without a live session, before any handler runs.
- **The storage root is resolved per session before any path is
  touched — by construction, not by checking.** Every path is built by
  `server/src/storage.ts` from two things the server minted itself: the
  account's `storage_root` (`u/` + 96 random bits, hex, minted by
  `createAccount` and never chosen by a caller) and a project name
  validated against `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`. No function
  accepts a path from a request, so there is nothing to sanitise. Two
  accounts may use the same project name: the files are under different
  roots. A project the account does not have is a 404 whoever else has
  one by that name.
- **A project is addressed by a slug that is also its file's basename.**
  `title` is the human name in the identity row; the slug is the URL and
  the filename. One `.catdb` per project, opened per request and closed
  after it — no connection cache until there is a reason for one.
- **One account, seeded by a script, not an endpoint.**
  `pnpm --filter @cat-tool/server run create-account -- <email> <password>`,
  the portal's `create-admin` reasoning. Running it again with another
  email is how a second account arrives: additive, as §4.1a promised.
- **Each route is a repository call or two with HTTP around it**, the
  CLI's discipline (§2.4). `countSegments` was the one thing `db` lacked
  — a file listing must not load every segment's tokens to count them.
- **Every write names the session's account** (backlog #57,
  `audit-spec.md` §2.5). `auditActor(account)` builds the one
  `AuditActor` a route passes to the `db` write it wraps; no handler
  builds its own. Logins (and refused ones), logouts, project creation
  and deletion, and downloads are `audit_event`s in `platform.sqlite`;
  a segment edit or an export is one in the project's own file. The
  request logger carries method, URL and status, never a body.

Not here: the SPA. `@cat-tool/web` starts with #28, where there is a
grid to show; a login page with nothing behind it would be scaffolding.
Also not here: pre-translate, QA and TM routes — #32's management UI
is where they get a caller, and each is one repository call away when
it does. Export, project deletion and the segment write arrived with
backlog #57, whose audit trail needed a download and an edit to
record; the editor (#28+) is the segment route's real caller.

---

## 3. The DOCX filter

The riskiest component. Everything else is bookkeeping.

### 3.1 Skeleton + payload

Do **not** rebuild the document on export. Preserve it.

1. Unzip the DOCX; keep every part byte-identical except the ones holding
   translatable text — `word/document.xml`, headers, footers, and
   `word/footnotes.xml` / `word/endnotes.xml` (§3.5). Each such part gets
   its own skeleton; a real manuscript can carry ten or more footers.
2. Walk `w:body`. For each `w:p`, collect its `w:r` children in order.
3. Replace each translatable text region with a marker; the resulting
   XML is the **skeleton**, stored per file.
4. Extracted content becomes **segments**; the run properties (`w:rPr`)
   they came from are stored in a per-file **format table**, keyed by id.

Export splices rendered targets back into the skeleton. Any part of the
document not extracted is returned untouched — that is what protects
styles, numbering, tables, images, and everything else v1 never models.

### 3.2 Paragraph → tagged text

Within a paragraph, adjacent runs sharing identical `w:rPr` are merged.
A change in `w:rPr` opens a tag pair. Concretely:

| DOCX construct | Becomes |
|---|---|
| `w:rPr` change (b, i, u, vertAlign, color, rStyle, …) | paired tag `<g id=n>` … `</g>` |
| Hyperlink (`w:hyperlink`) | paired tag, target URL held in format table |
| Footnote / endnote reference | standalone `<ph id=n>` |
| Field (`w:fldSimple`, `w:instrText` runs) | standalone `<ph id=n>` |
| Bookmark start/end, comment anchors | standalone `<ph id=n>` |
| Inline drawing / image | standalone `<ph id=n>` |
| `w:br`, `w:tab` | standalone `<ph id=n>` |
| Soft hyphen, non-breaking space | literal characters, not tags |

Tag ids are numbered per segment, starting at 1, in source order. They are
stable across a reopen of the same file — ids derive from position in the
segment, not from a global counter.

### 3.3 Segment token model

A segment's source and target are each an ordered token array, stored as
JSON:

```ts
type Token =
  | { t: 'text'; v: string }
  | { t: 'open';  id: number; fmt: number }   // fmt → file format table
  | { t: 'close'; id: number }
  | { t: 'ph';    id: number; fmt: number }
```

Rules the editor and validator both enforce:

- `open`/`close` are matched pairs and must nest, never interleave.
- The target's tag multiset must equal the source's (§6.1).
- Target tag *order* may differ from source — word order changes between
  languages. Only nesting validity and multiset equality are enforced.
- Tags are atomic in the editor: never editable as text, deleted whole.

### 3.4 Paragraph vs segment

One paragraph yields one or more segments (§5). A tag pair opened in one
sentence and closed in another is **split at the boundary**: each resulting
segment gets a balanced pair. On export, adjacent identical formatting is
re-merged, so the split is invisible in the output.

**Export folds a paragraph back from its segments (backlog #25,
`core/project/export.ts`).** The rule has two halves, and the first is
what keeps the roundtrip gate true through the database:

- A paragraph none of whose segments has a target is **not rendered at
  all** — its original region XML is spliced back verbatim
  (`renderSkeleton`'s default). Re-rendering an unedited paragraph from
  tokens would be a normal form, not the original bytes, and
  `segmentTokens` drops whitespace-only groups, so the segments alone
  cannot reproduce it anyway. Untouched means untouched.
- Otherwise every segment of the paragraph contributes one region —
  its target tokens when it has any, its source tokens when it has
  none, each over the segment's own format table — and the regions are
  folded in `para_ord` order with `mergeSegments(a, b, { separator:
  ' ' })` (the same fold `edit.test.ts` already proves over the corpus),
  then rendered with `renderTokens`. A target is used whatever its
  status — draft, translated or confirmed — because that is what the
  segment says its target is; deciding otherwise is a review question,
  not an export one. The separator is inserted only when neither side
  brings boundary whitespace, which is exactly the asymmetry between the
  two kinds of piece: a source piece after the first carries the
  inter-sentence space the segmenter left on it, a target typed or
  matched into a segment does not.

A nested region (a text box inside a drawing) survives either way: the
drawing is a `ph` whose XML carries the child's marker, so the marker is
still there for `renderSkeleton` to resolve after the fold.

### 3.5 Extraction boundaries

Extracted: body paragraphs, table cell paragraphs, headers, footers,
text boxes, SmartArt text, alt-text on images, **and footnote / endnote
bodies**.

Footnote bodies are in scope because the source texts this tool is built
for — scholarly, legal, religious — carry real content in their notes. A
DOCX handed back with translated body text and untranslated footnotes is
not deliverable, and doing them by hand in Word afterwards puts the job
outside the tool exactly where it is most tedious.

This has three consequences the design must carry:

1. **Skeletons are per part, not per document.** `word/footnotes.xml` and
   `word/endnotes.xml` each get their own skeleton alongside
   `word/document.xml`, headers and footers (§3.1).
2. **Segments record which part they came from** (`segment.part`, §4.1), so
   export splices each target back into the right skeleton.
3. **Note references remain inline `ph` tags** in the referring segment
   (§3.2). The reference and the note body are separate segments; the
   reference must survive in the body text regardless of what happens to
   the note.

Ordering: footnote bodies sort after all body segments, in note-number
order, so the editor presents the document then its notes rather than
interleaving them mid-sentence.

Still not extracted in v1: comment text, tracked-change content, document
properties, embedded objects. Each is a known gap, listed here so it is a
decision rather than a surprise.

Skipped as untranslatable: paragraphs whose extracted text, with tags
removed, is empty or contains no letter in any supported language
(pure numbers, punctuation, whitespace). These are locked, not shown as
segments, and pass through the skeleton unchanged.

---

## 4. Data model

SQLite, one file per project (`project.catdb`), plus one file per TM
(`<name>.cattm`) so TMs can be shared across projects and backed up
independently. `ATTACH` the TMs at query time.

### 4.1 Project database

```sql
CREATE TABLE project (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  name          TEXT NOT NULL,
  src_lang      TEXT NOT NULL,          -- BCP-47, e.g. 'en-GB'
  tgt_lang      TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  schema_version INTEGER NOT NULL
);

CREATE TABLE file (
  id            INTEGER PRIMARY KEY,
  rel_path      TEXT NOT NULL UNIQUE,   -- original DOCX name
  original_blob BLOB NOT NULL,          -- untouched source DOCX
  skeleton      TEXT NOT NULL,          -- JSON PartSkeleton[] (core/docx/skeleton.ts) — one per translatable part, each carrying its regions' original XML, needed to reproduce an untouched region byte-for-byte
  part_map      TEXT NOT NULL,          -- JSON string[] of part names present — a denormalised projection of skeleton, not independent data
  imported_at   TEXT NOT NULL
);

CREATE TABLE segment (
  id            INTEGER PRIMARY KEY,
  file_id       INTEGER NOT NULL REFERENCES file(id),
  part          TEXT NOT NULL,          -- 'document' | 'footnotes' | 'header3' …
  ord           INTEGER NOT NULL,       -- document order
  para_key      TEXT NOT NULL,          -- marker id in that part's skeleton
  para_ord      INTEGER NOT NULL,       -- nth segment within paragraph
  source_tokens TEXT NOT NULL,          -- JSON Token[]
  format_table  TEXT NOT NULL,          -- JSON FormatEntry[] — this segment's own table; Token.fmt indexes into it
  target_tokens TEXT,                   -- JSON Token[], NULL when untranslated
  source_hash   TEXT NOT NULL,          -- normalised, see 4.3
  status        TEXT NOT NULL,          -- new|draft|translated|confirmed|locked
  origin        TEXT,                   -- NULL|tm_exact|tm_exact_tagdiff|propagated
  locked        INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  UNIQUE (file_id, ord)
);
CREATE INDEX segment_hash ON segment(source_hash);

CREATE TABLE tm_ref (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL,          -- path to .cattm
  priority      INTEGER NOT NULL,       -- 1 = consulted first
  is_write_target INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX tm_one_write_target
  ON tm_ref(is_write_target) WHERE is_write_target = 1;

CREATE TABLE qa_issue (
  id            INTEGER PRIMARY KEY,
  segment_id    INTEGER NOT NULL REFERENCES segment(id),
  rule          TEXT NOT NULL,
  severity      TEXT NOT NULL,          -- error|warning|info
  message       TEXT NOT NULL,
  dismissed     INTEGER NOT NULL DEFAULT 0,
  run_at        TEXT NOT NULL
);
```

Beyond the tables above: `glossary_ref` (v2), `qa_rule_setting` (v3),
`qa_untranslated_allowlist` (v4) and `audit_event` (v5) — the
append-only, hash-chained history of every change, specified in
`audit-spec.md` §2 and written by the same repository call as the
change it records (backlog #56).

v6 adds no table: `qa_issue_segment`, an index on `qa_issue(segment_id)`
(backlog #28). Every read of a segment's issues — the rerun on each
confirm, the grid's file-wide list — was a scan of the whole table
without it; the file-wide one, a nested loop over the file's segments,
took 0.9 s at 10,800 segments and 2,176 issues, where the index makes it
a lookup per segment.

Multiple TMs with `priority` is what "projects, multiple TMs" buys: on a
tie between two exact hits, lowest `priority` wins. Exactly one TM may be
the write target, enforced by the partial unique index.

**Correction (2026-08-30, backlog #16):** `format_table` moved from
`file` to `segment`, and `skeleton`/`part_map` were tightened to match
what #7/#9 actually built. This table was drafted before the skeleton
and tokenizer existed; once they did, a per-region `{tokens, formats}`
pair (`TokenizedRegion`) turned out to already be the natural,
self-contained shape a segment is tokenized into (`segmentTokens` /
`renumberRegion` give each split-off sentence its *own* renumbered
format table for exactly this reason — see `segmenter.ts`). A single
file-wide format table would have meant inventing a cross-region
id-renumbering and deduplication scheme that nothing else in the
filter does or needs. Free to fix in place — no project database has
ever been written, the same situation as `tm-format-spec.md`'s
`seg_profile` and normalisation-list corrections.

### 4.1a Accounts and storage roots (web service pivot)

The schema above is unchanged: `project.catdb` and `<name>.cattm` are
still one file each, `ATTACH`ed at query time. What changes on a server
is *who may reach which files*.

```sql
-- A separate, tiny database (platform.sqlite), never attached to a
-- project or TM: it is server bookkeeping, not translation data.
CREATE TABLE account (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  storage_root  TEXT NOT NULL UNIQUE,   -- e.g. "u/3f9a2c…" under the volume
  created_at    TEXT NOT NULL
);
```

```sql
-- backlog #27: one row per login, the bearer token stored only as its
-- SHA-256 hash with a 30-day expiry — admin_session's shape
-- (portal-v0-spec.md §7), because it is the same problem, and the
-- hashing is the same code (core/auth/credentials.ts, one definition
-- for both products).
CREATE TABLE account_session (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES account(id),
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
```

Schema v3 (backlog #57) adds `audit_event`, the same append-only,
hash-chained table every file with a log carries, generated by
`auditEventDdl` (`audit-spec.md` §2, §2.5). It holds logins,
refused logins, logouts, accounts and projects created or deleted,
and downloads. It never holds translation content: a segment edit is
logged in its project's own file.

Every project and TM file lives under its owner's `storage_root`; the
server resolves a path only after checking the authenticated session
against that account (how: §2.5 — the root is `u/<96 random bits>`,
minted by `createAccount`, and every path is built from it and a
validated slug, never from anything a request sent). **v1 ships with exactly one account, created at
deploy time** — this is still a personal tool, reached over the internet
rather than installed. The reason for the table is what it costs to skip:
retrofitting an owner column onto files that were never scoped means a
migration across every existing user's data. Scoping storage from the
first row costs nothing now and means opening registration later is
purely additive — a signup flow and a session-count decision, not a data
migration.

Nothing about `project`, `file`, `segment`, `tm_ref`, or `qa_issue`
changes: they stay scoped to one project file, exactly as designed.

### 4.2 TM database — own format

The TM is **not** a loose SQLite schema. It is a specified, versioned,
proprietary format: **`planning/tm-format-spec.md`** is authoritative and
this section is a summary only.

Headline decisions from that spec:

- Single SQLite file, `.ctm`, driven by `better-sqlite3`, identified by
  `application_id = "CATM"` — chosen to be independent of the product
  name, which is not yet decided.
- **Multilingual.** A unit is a language-neutral identity (`tu`) with one
  variant per language (`tuv`), the same shape TMX itself uses. Any pair
  is retrievable, in either direction, from one memory.
- Reduced token model: TM tags are **structural**, carrying a kind hint
  (`b`, `i`, `link`, `ph`…) but never the source document's `w:rPr`.
  A match applies *this* document's formatting, not the 2023 client's.
- `prev_hash` / `next_hash` per variant, populated from the first write,
  enabling context/ICE matching later. Context not recorded at write time
  is unrecoverable — the source document is gone.
- `uuid` + per-variant `rev` + tombstones, so two copies of a memory can
  be merged — including memories covering different language sets.
- `tuv_history`, so a bad batch edit is survivable.
- `tu_attr` key/value metadata, so no new metadata field ever needs a
  schema migration.
- `tuv_vec` reserved for embeddings.
- `normalizer_version` stored in the file (§4.4).

**The project is bilingual; the memory is multilingual.** A project
declares one `src_lang` / `tgt_lang` pair (§4.1) because one job produces
one target language. The memories it attaches may hold many languages and
be shared across projects with different pairs. This keeps the editor and
matcher simple while letting one accumulated memory serve every job.

**TMX is retained permanently**, both directions, as the interchange
format. Losses on export are enumerated in the format spec §8 and are
carried in `x-catm-*` props so our own roundtrip stays lossless.
Multilingual TMX files import whole rather than being flattened to a pair.

### 4.3 Fuzzy-ready without fuzzy

Cheap decisions now that avoid a migration later:

1. `source_plain` / `target_plain` on every TU, though exact matching does
   not read them. Fuzzy and concordance both need them.
2. `tu_fts` (FTS5) exists from day one — free concordance, and the standard
   candidate-retrieval stage in front of an edit-distance scorer.
3. `segment.origin` is a free-text discriminator, not a boolean. Adding
   `tm_fuzzy_85` or `tm_ice` later needs no schema change.
4. `tu_vec` and the context columns exist and are populated or reserved
   before there is any feature reading them.

### 4.4 Normalisation (`source_hash`)

Defined normatively in the format spec §4 as **`normalizer_version = 1`**,
and frozen under that version. Summary: strip tags, NFC, collapse
whitespace, canonicalise typographic variants (curly quotes, dashes, NBSP,
ellipsis), preserve case; SHA-256.

The version number is stored in every `.ctm` file. Changing a rule without
incrementing it would silently invalidate every hash in every existing
memory — which is why the rule list is frozen rather than merely written
down.

---

## 5. Segmentation

SRX-lite. Rules are data, not code, so a language is added by adding a file.

### 5.1 Algorithm

Over the paragraph's plain text (tags ignored for boundary detection, then
mapped back onto tokens):

1. Candidate boundary after `.`, `!`, `?`, `…`, `:`, `;` — plus any run of
   closing quotes/brackets immediately following.
2. Require following whitespace, then a character that can open a sentence.
3. Apply exception rules, in order:
   - **Abbreviation list** per language — no break after `etc.`, `cf.`,
     `Dr.`, `z.B.`, `p. ej.`, `art.`, and so on.
   - **Ordinals** — DE/NL: no break on `1.` `2.` when followed by a
     lowercase word or a month name.
   - **Single initial** — no break after `J.` in `J. Smith`.
   - **Decimal / thousands** — no break inside `3.14`, `1.000`.
   - **Ellipsis** — `...` breaks only when followed by an uppercase word.
   - **Enumerations** — no break after `a)` `1.` at paragraph start.
4. `;` and `:` are candidates but **off by default** for all seven
   languages; they are per-language switches, not hardcoded.

### 5.2 Per language

**EN and ES are curated first and held to a higher bar** — they are the
working pair (§1) and the one that must survive a real job. The other five
ship with reasonable lists and are hardened when a job demands it.

| Lang | Notes |
|---|---|
| **EN** | Baseline. Abbreviations, titles, initials. **Priority.** |
| **ES** | `¿` `¡` open sentences — a boundary may be *followed* by them, which the naive "next char is uppercase" rule gets wrong. **Priority.** |
| FR | Narrow no-break space before `!?;:` and inside guillemets. `:` off. |
| DE | Ordinals are the dominant failure mode. Large abbreviation list. |
| IT | Close to EN; apostrophe elision must not break. |
| PT | Close to ES, without inverted marks. |
| NL | Ordinals like DE; `'s` at word start must not break. |

### 5.3 Re-segmentation

Segmentation is applied once at import and the result is stored. Changing
rules later does **not** silently re-split a file in progress — that would
orphan targets. Re-segmentation is an explicit, per-file action offered
only when the file has no confirmed segments, or after a confirmation that
existing targets will be dropped.

Merge and split of adjacent segments within one paragraph is a manual
editor action (§7) and is v1 scope — no rule set is ever perfect and the
translator needs an escape hatch.

---

## 6. Matching and QA

### 6.1 Exact matching

On pre-translate, for each unlocked segment:

1. Compute `source_hash`.
2. Query each enabled TM in `priority` order; first hit wins.
3. If found:
   - Tag multiset of the TM hit's source equals the segment's source →
     insert target as-is, `origin = 'tm_exact'`, `status = 'translated'`.
   - Tag multiset differs → insert the target's **text**, re-tagged by
     position where unambiguous, `origin = 'tm_exact_tagdiff'`,
     `status = 'draft'`, and raise a QA warning. Never silently produce
     tag-invalid targets.
4. **Internal propagation**: two segments in the project sharing a
   `source_hash` — when one is confirmed, the other is populated with
   `origin = 'propagated'`, `status = 'draft'`. Never overwrite a
   confirmed segment.

Pre-translate is idempotent and never touches `confirmed` or `locked`
segments.

### 6.2 Write-back

Confirming a segment upserts into the write-target TM, keyed on
`source_hash`. Same source with a different target **updates** the TU and
keeps the old one only if the two differ in tags. Undo of a confirm rolls
back the TM write in the same transaction.

### 6.3 TMX

Import: TMX 1.4b. Map `<bpt>`/`<ept>`/`<ph>`/`<it>` onto the token model;
unknown inline elements degrade to `ph`. Warn, do not fail, on language
codes that mismatch the TM's declared pair (`en-US` vs `en-GB` is a match;
`en` vs `fr` is not).

Export: TMX 1.4b with `<bpt>`/`<ept>`/`<ph>`, `creationdate`,
`changedate`, `creationid`. Must round-trip through Trados — that is the
acceptance test, not schema validity.

### 6.4 QA rules

| Rule | Severity | Fires when |
|---|---|---|
| `tag.missing` | error | Source tag id absent from target |
| `tag.extra` | error | Target has a tag id not in source |
| `tag.unbalanced` | error | `open` without `close`, or bad nesting |
| `seg.empty` | error | `status` ≥ translated with empty target |
| `seg.untranslated` | warning | Target identical to source (suppressed when source has no letters, or is on a per-project allow-list) |
| `consistency.target_differs` | warning | Same `source_hash`, different target text across the project |
| `consistency.source_differs` | info | Same target text for different sources |
| `num.missing` | error | A number in source absent from target |
| `num.altered` | warning | Number present but reformatted (`1,000` → `1 000`) — locale-aware per target language |
| `punct.terminal` | warning | Source ends in `.!?` and target does not, or vice versa |
| `punct.brackets` | error | Unbalanced `()[]{}` or quote pairs in target |
| `punct.inverted` | error | ES only: `?` without a matching `¿`, or `!` without `¡` |
| `punct.spacing` | warning | Double space, space before `,.;:`, missing FR narrow no-break space |

Rules run per segment on confirm and across the project on demand.

Two rules are load-bearing for **EN→ES** specifically, the working pair:

- `num.altered` must know that `1,000.50` in EN equals `1.000,50` in ES —
  decimal comma and period thousands separator. Get this wrong and it
  fires on every correctly translated number, the translator learns to
  ignore QA, and that is worse than having no QA at all. Same argument for
  FR `1 000,50` and DE `1.000,50`.
- `punct.inverted` has no analogue in the other six languages. Dropping the
  opening `¿` or `¡` is one of the easiest Spanish errors to make and one
  of the easiest to check mechanically.

**How the `num.*` and `punct.*` rows are read (backlog #24, 2026-09-19)** —
each had a false-positive trap the table alone did not settle:

- **A numeral is compared three ways, strictest first, and only the last
  resort is a finding.** *Surface*: the same characters — a number copied
  verbatim is never reported, even where the target locale would write it
  differently (version numbers, codes and dates would drown everything
  else). *Value*: the same number once each side is read under its *own*
  locale's conventions (`core/qa/locale.ts` — `en` `1,000.50`; `fr`
  `1 000,50` with U+0020, U+00A0, U+202F or U+2009 as the group; `de`,
  `es`, `it`, `pt`, `nl` `1.000,50` with spaces also accepted; `es-MX` and
  `es-US` English-style; `de-CH`, `fr-CH`, `it-CH` `1'000.50`). *Digits*:
  the same digit string with every separator removed — present that way
  but not readable as the same value under the target locale is
  `num.altered`. Anything else is `num.missing`, after one non-consuming
  *components* look: a numeral the locale could not read as one number
  (`12.03.2025`, `3.2.1`) is a sequence of digit groups, so `03/12/2025`
  is found inside German `12.03.2025`. There is no `num.extra`.
- **French groups by space, never by point** (CLDR, Imprimerie nationale):
  `1.000` in a `fr` target is `num.altered`. A translator who writes it
  that way has the per-project switch.
- **An unknown language gets a generic format** — whitespace grouping,
  no decimal separator — so the rules compare digits and never vouch for
  a separator convention they do not know.
- **Known, recorded misses**, not special-cased: a number written out in
  words (`3` → `trois`) and a 12-hour to 24-hour time change (`5 p.m.` →
  `17 h`) both read as `num.missing`. One dismissal each; the alternative
  is a lexicon per language, and guessing costs more real findings than
  it saves.
- `punct.terminal` is presence only (`.` `!` `?` `…`), looking past
  closing quotes, brackets and a trailing placeholder; a `?` rendered
  with a `.` is a translation choice. Which quote closes is the
  locale's — German closes `„…“` with U+201C and `»…«` with U+00AB, the
  marks English opens with — so every mark that closes somewhere is
  looked past (the golden test, #26, was the first German sentence to
  end in `.“` and be told it had no full stop).
- `punct.brackets` counts `()` `[]` `{}` `«»` as pairs and `"` and
  `“ ” „` as one parity family each (German `„…“`, Dutch `„…”`, reversed
  guillemets `»…«` all balance), and fires only where the target's
  imbalance differs from the source's — a segment split mid-parenthesis
  or an `a)` list style is not the translator's error. A leading `a)`
  enumerator is ignored outright.
- `punct.inverted` counts *runs* (`¡¿Qué?!`, `¡Hola!!!` balance) and only
  runs in sentence position — a URL's `?` is not a question.
- `punct.spacing` is a profile per *target* locale, never the source's:
  plain `fr` wants a no-break space (U+00A0, U+202F or U+2009) before
  `; : ! ? »` and after `«`; `fr-CA` before `:` and inside guillemets
  only (OQLF); `fr-CH` nothing. Outside French, `,` `.` `;` `:` take no
  space; with no target language known, only `,` and `.` are judged. A
  mark inside a token (`10:30`, `http://`, `?id=`) is not a sentence
  mark. Placeholders are opaque characters for every rule here, not
  dropped, so `word<tab>word` is not a double space and `1<tab>000` is
  not one number.
- The rules take the project's language pair through
  `QaCheckContext.srcLang`/`tgtLang` (from the `project` row); with no
  pair known, `num.*`, `punct.inverted` and the locale-specific half of
  `punct.spacing` report nothing rather than guess.

Every rule is individually switchable per project, and issues are
dismissible with the dismissal persisted against the segment.

---

## 7. Editor

Keyboard-first, per the locked working style. Not a full UI spec — the
behaviours v1 cannot ship without:

- Two-column grid, source left, target right, virtualised. Status,
  origin, and QA flag in a gutter.
- `Ctrl+Enter` confirm and advance to next unconfirmed.
- `Ctrl+,` insert next unplaced tag; `Ctrl+Shift+,` tag list.
- `Ctrl+Ins` copy source to target.
- `Ctrl+M` merge with next segment, `Ctrl+Shift+M` split at cursor
  (both within one paragraph only).
- Tags render as compact atomic chips; a "show full tags" toggle reveals
  the underlying formatting.
- QA panel: filter by rule and severity, jump to segment.
- Filter bar: by status, origin, QA state, and plain-text search.
- Progress: segments confirmed / total, words confirmed / total.
- Dark mode, and no layout shift when the QA panel opens.

Autosave on every keystroke, debounced. There is no "save" action; a crash
must never cost more than a few seconds.

### 7.1 The segment grid (`@cat-tool/web`, backlog #28)

The first screen of the SPA and the reason it exists: two columns, a
gutter, and nothing re-rendered that is not on screen. Decisions, so
they are not re-derived:

- **A Vite + React SPA, `packages/web`, talking only to `/api/`.** No
  router library, no state library, no component kit: three screens
  (login, project/file picker, grid) are a hash (`#/p/<name>/f/<id>`)
  and a `useState`. Each earns its dependency when a screen needs it.
  In development Vite proxies `/api` to the server on `:3400`; serving
  the built SPA from the server process is #36's, where the container
  image is.
- **`@cat-tool/web` imports `core` for types only.** `core`'s index
  pulls in `node:crypto` (credentials), the DOCX filter and the
  segmenter; none of it belongs in a browser bundle, and a runtime
  import would drag it there. What the grid needs at runtime — a
  status's label, an origin's abbreviation — is a `Record` keyed by
  `core`'s union types, so a status added in `core` fails the web
  typecheck instead of rendering blank.
- **The login and picker are the least that reaches the grid.** Project
  creation, uploads and TM attachment are #32's; the picker lists and
  opens, nothing else. The bearer token lives in `localStorage` — the
  server's session is 30 days, and a token that dies with the tab
  would make that a lie; a 401 from any call clears it and returns to
  login.
- **Virtualised with measured, variable row heights**
  (`@tanstack/react-virtual`). A segment is one line or twelve; a fixed
  row height either clips a long sentence or wastes most of the screen
  on short ones. Rows are estimated from their text length, measured
  once rendered, and only the visible window plus an overscan is in the
  DOM — at 10k segments that is a few dozen rows, not ten thousand.
  The fixture corpus is 2,706 segments across 21 files; 10k is the
  card's bar, and the smoke run measures it against a synthetic file.
- **The gutter is three facts, each from one field.** Status from
  `segment.status` (and `locked`); origin from `segment.origin`, known
  values abbreviated (`tm_exact` → `TM`, `tm_exact_tagdiff` → `TM≠`,
  `propagated` → `⇣`), an unknown one shown verbatim rather than hidden
  — origin is a widened string (§4.3) and a future `tm_fuzzy_85` must
  not render as nothing; QA from the worst *undismissed* severity among
  the segment's issues, with the count. A dismissed issue does not
  colour the gutter — that is what dismissing is for — but is still
  loaded, because #33's panel lists it.
- **Listing a file never reads its blob.** The project route and every
  file-id check use `listFileSummaries`/`getFileSummary` (id, path,
  import time, segment count); `listFiles`/`getFile` decode the
  original DOCX and skeleton and are export's. Measured on the smoke
  run: 749 ms to list a 23-file project before, under 0.1 s after.
- **QA arrives by its own route, not folded into `/segments`.** The
  segments route is `listSegments` as stored; the QA route is one
  `db` call (`listFileQaIssues`), which #33's panel needs anyway. The
  grid fetches both and joins by `segmentId` in the browser.
- **Tags render as read-only chips, numbered by their tag id; invisible
  ones are not rendered** (`FormatEntry.visible`, §3.3). A paired tag is
  two chips, `‹1` and `1›`; a placeholder is one, `⟨2⟩`, titled with its
  `kind`. Editing them — atomic chips in an editable target, insert-next-
  tag — is #29; the grid only shows them, and a missing target shows
  empty, never the source.


---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Tag roundtrip corrupts client DOCX | Skeleton preservation (§3.1) means untouched content is byte-identical. Corpus test: N real DOCX files, import → export with no edits → assert semantic XML equality. This gate exists before any UI work. |
| Segmentation wrong on real files | Rules are data; merge/split is a first-class editor action, not a v2 feature. |
| Exact-only matching feels thin in daily use | Accepted, and revisit after the first real job. FTS index (§4.3) means concordance is days, not weeks. |
| ES number QA false positives | Locale-aware `num.altered` from the start. A noisy QA panel is worse than none. |
| Multilingual schema costs more than it returns | Only EN and ES are exercised in v1. The cost is a self-join at retrieval; the schema is otherwise no harder than bilingual, and it removes the one migration that would have been genuinely painful later. |
| Solo scope creep into commercial features | Definition of done (§1) is a single real delivered job. |

---

## 9. Decisions taken

All blocking questions from the first draft are now resolved:

| Question | Decision |
|---|---|
| Stack | **Electron** — lock confirmed (§2.2). Tauri prototype parked. |
| TM driver | **better-sqlite3** (TM format spec §1.1) |
| TM shape | **Multilingual** — one memory, any pair (TM format spec §2) |
| First pair | **EN → ES** |
| Review step | **None** — direct delivery. Bilingual export stays out of v1. |
| TM scale | **Under 100k units** — no chunked import needed |
| Format magic | **`CATM`** (`0x4341544D`) — product-name-independent |

Remaining, non-blocking:

1. **Permanent file extension** — `.ctm` is working-name-derived. Free to
   change at product naming, unlike the magic number.
2. **Language variant granularity** — are `es-ES` and `es-419` one
   language or two? Current model: distinct BCP-47 codes with
   region-insensitive fallback at retrieval.
