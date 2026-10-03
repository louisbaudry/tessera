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
| Track changes, comments | Comment text and tracked deletions (a move's origin included) are not extracted; a tracked insertion's text, or a move's destination's, is. Footnote/endnote **bodies** *are* extracted — see §3.5. |

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
    model/       shared types, tag rules; the SPA's @cat-tool/core/model
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
  is `pretranslate`; `qa` is `runQaRulesFor` over every segment; `export`
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
approve, not a test nobody wrote. Its own CI job, for the gate's
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
| `POST /api/projects` `{name, srcLang, tgtLang, title?, writeTm?}` | creates `<root>/projects/<name>.catdb` with its identity row (`createProject`); 409 if it exists. `writeTm` (backlog #32) attaches that memory first, as the write target, creating it empty if the account has none by that name (§7.5) |
| `GET /api/projects/:name` | identity plus files (`id`, `relPath`, `importedAt`, `segmentCount`) |
| `POST /api/projects/:name/files` (multipart: one DOCX, optional `relPath` field) | `assembleFile` + `insertFile`, exactly `add-file` (§2.4); 409 on a duplicate `rel_path`, 422 on a source language `rulesFor` refuses |
| `GET /api/projects/:name/files/:id/segments` | the file's `Segment[]` as stored |
| `GET /api/projects/:name/files/:id/qa-issues` | every `QaIssue` on the file's segments, dismissed ones included — the grid's QA gutter (backlog #28), and #33's panel |
| `PUT /api/projects/:name/segments/:id/qa-issues/:rule` `{dismissed}` | sets that finding aside, or counts it again: `dismissQaIssue`/`reinstateQaIssue`, logged as `qa.dismissed`/`qa.reinstated`; asking for the state it is in writes nothing; 404 a rule not firing on the segment; → `{issue}` — backlog #33, §7.6 |
| `DELETE /api/projects/:name` | deletes the `.catdb` (and its log with it); 204 — backlog #57 |
| `GET /api/projects/:name/files/:id/export` | the delivered DOCX, `exportFile`, exactly `export` (§2.4) — backlog #57 |
| `PUT /api/projects/:name/segments/:id` `{targetTokens, baseUpdatedAt?}` | the translator's edit: `editSegmentTarget` (§7.2) — what they placed, hidden tags carried, status and origin derived, QA rerun; tokens shape-checked (`parseTokens`); a `status` or `origin` in the body refused (400), a tag structure export could not render refused (400), a write over a newer version refused (409, with the segment as it is), a locked segment 409; → `{segment, changed, rerun, issues}` — backlog #57, reshaped by #29 |
| `GET /api/tms` | the account's memories: `{slug, uuid, name, langs, units, createdAt}` (`peekTm`: described without opening, so no integrity check — a damaged memory lists and is refused when used; backlog #95) — backlog #32, §7.5 |
| `POST /api/tms` `{name}` | a new, empty memory `<root>/tms/<name>.ctm`: 201 with its summary; 409 if it exists |
| `POST /api/tms` multipart `name` + one `.tmx`/`.sdltm` | **202 with a job** (backlog #16a): the import runs on a worker thread into a staging file, renamed to `<root>/tms/<name>.ctm` only once it is whole. 409 if the name exists or this account already has an import running (503 if the server is full), 415 another format, 413 too large |
| `GET /api/jobs/:id` | the account's own job: `{id, kind, tm, state: running\|done\|failed\|cancelled, progress: {stage, fraction, units}\|null, result, error}`; `result` is the new memory's summary and the importer's warnings once `done`, `error` a message with no server path in it; 404 for any other account's id |
| `DELETE /api/jobs/:id` | asks a running job to stop (202; it stops at a safe point or its thread is ended); a failed or cancelled import leaves no memory, no staging file and no upload; 200 and the job as it is if it has already ended |
| `GET /api/projects/:name/tms` | the attached memories in consultation order: `{id, tm, priority, writeTarget, enabled}`, `tm` a slug or `null`, never a path |
| `POST /api/projects/:name/tms` `{tm, writeTarget?}` | attaches one after the rest (`addTmRef`); 404 no such memory, 409 already attached |
| `PUT /api/projects/:name/tms` `{order}` | every ref id once, first consulted first (`reorderTmRefs`); 400 otherwise |
| `POST /api/projects/:name/tms/:refId/write-target` | `setWriteTarget` |
| `DELETE /api/projects/:name/tms/:refId` | `removeTmRef`; the memory itself stays |
| `POST /api/projects/:name/pretranslate` | `pretranslate` over the whole project, exactly `pretranslate` (§2.4); → its counts |

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
Pre-translate and the TM routes arrived with #32's management UI
(§7.5), their first caller; a whole-project QA run is still the CLI's. Export, project deletion and the segment write arrived with
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

Within a paragraph, each run with properties becomes a tag pair, one
per run: the tokenizer merges nothing. Adjacent runs sharing identical
`w:rPr` are merged when a target is rendered (§3.4), and the editor
places look-alike neighbours as one (§7.2). Concretely:

| DOCX construct | Becomes |
|---|---|
| `w:rPr` change (b, i, u, vertAlign, color, rStyle, …) | paired tag `<g id=n>` … `</g>` |
| Hyperlink (`w:hyperlink`) | paired tag, target URL held in format table |
| Footnote / endnote reference | standalone `<ph id=n>` |
| Field (`w:fldSimple`, `w:instrText`/`w:fldChar` runs, `w:pgNum`, date elements) | standalone `<ph id=n>` |
| Bookmark start/end, comment anchors, proofing marks | standalone `<ph id=n>`, hidden (§3.3) |
| Inline drawing / image, `w:contentPart`, equation (`m:oMath`, `m:oMathPara`), ruby | standalone `<ph id=n>` |
| `w:customXml`, `w:dir`, `w:bdo`, `w:subDoc` (not walked) | standalone `<ph id=n>`; the text inside is not translated |
| `w:br`, `w:cr`, `w:tab` | standalone `<ph id=n>` |
| Tracked insertion or move destination (`w:ins`, `w:moveTo`), content control (`w:sdt`) | paired tag, hidden; the text inside is translated |
| Tracked deletion or move origin (`w:del`, `w:moveFrom`), floating shape | standalone `<ph id=n>`, hidden, kept whole (§3.5) |
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
  languages. Order is never enforced; nesting validity and multiset
  equality are, and the editor also nests a pair only as a source's do
  — no formatting in formatting, no link in a link (§7.2).
- Tags are atomic in the editor: never editable as text, deleted whole.
- Hidden tags (`FormatEntry.visible` false) are never a writer's to
  place: every stored target carries its source's by one rule, and any
  structurally valid stream renders to valid OOXML — both §7.2.
- A tag's `fmt` is its own id, its role fits its format (a pair is a
  `run` or `inline` tag, a placeholder `in-run` or `block`), and text
  holds nothing XML cannot carry (`xmlIllegalChar`): `parseTokens`
  refuses anything else at the door (§7.2).

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

As built (checked 2026-09-27): `core` extracts neither SmartArt text
nor image alt-text. Nothing reads `word/diagrams/` or a `descr`
attribute. Treat those two as not yet extracted. The word count (§3.6)
counts what `core` actually extracts.

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

Still not extracted in v1: comment text, tracked deletions (`w:del`, and
a move's origin, `w:moveFrom` — kept whole, hidden), document
properties, embedded objects. Each is a known gap, listed here so it is a
decision rather than a surprise. A tracked insertion (`w:ins`) or a
move's destination (`w:moveTo`) is current text, and is extracted
inside a hidden tag that keeps the revision (§3.2).

Skipped as untranslatable: paragraphs whose extracted text, with tags
removed, is empty or contains no letter in any supported language
(pure numbers, punctuation, whitespace). These are locked, not shown as
segments, and pass through the skeleton unchanged.

### 3.6 What a word is

Decided 2026-09-29 (backlog `#62`). One definition, frozen, in `core`
(`model/words.ts`: `countWords`, `readingText`, `countRegionWords`),
read by everything that quotes, shows or pays by a count: the portal's
advisory estimate (`portal-v0-spec.md` §4), the editor's "words
confirmed / total" (§7, backlog `#34`) and vendor pay (`#49`). Two
splitters had already drifted apart: the portal's `\s+`, and the TM
bench's `[^\p{L}\p{N}]+` (`db/tm/bench/stats.ts`), which reads
`e-mail` as two words and `1,000.50` as three. The bench measures TM
size, not a count anyone is charged for, so it keeps its own splitter;
it is not this definition.

**A word is a run of non-separator characters that holds at least one
letter or number.** A separator is any Unicode whitespace (which
includes a no-break space, U+202F and a byte-order mark) or U+200B, the
zero-width space. Written test vectors (`words.test.ts`):

| Text | Words | Why |
|---|---|---|
| `e-mail` | 1 | a hyphen is not a separator |
| `l'homme` | 1 | nor is an apostrophe |
| `1,000.50` | 1 | nor a thousands or decimal mark |
| `one<TAB>two` | 2 | a tab is whitespace |
| `10<NBSP>000` | 2 | a no-break space separates: a French number is two words, a conservative over-count the admin can see |
| `a — b`, `• item`, `« bonjour »` | 2, 1, 1 | a run with no letter or number is not read as a word |
| `<BOM>one two` | 2 | a byte-order mark neither counts nor joins |

**Placeholders are decided per element, not by whether the translator
sees them** (`readingText`). `visibleText` (`qa/rules.ts`) turns every
placeholder into U+FFFC whatever it is, and `num.*`/`punct.*` rely on
that, so QA keeps its own; a counter that reused it would treat a hidden
`w:proofErr` mid-word like a visible tab. Instead:

| Element | Reads as |
|---|---|
| `w:tab`, `w:ptab`, `w:br`, `w:cr` | a space: it splits |
| `w:noBreakHyphen` | `-`: `e<noBreakHyphen/>mail` is one word |
| `w:softHyphen`, `w:sym` | nothing: they join |
| hidden placeholders (`w:bookmarkStart`, `w:proofErr`, …) | nothing: they join |
| anything else (a drawing, a note reference, a field) | nothing: it joins, so an unlisted element can only under-count |

The counter therefore takes a `TokenizedRegion` (tokens *and* formats),
because the element is in the format entry. A paired tag (bold,
hyperlink) puts nothing between the text on either side of it.

Five further decisions, each the conservative or the consistent one:

- **Locked paragraphs do not count.** A paragraph with no letter (§3.5)
  is locked, never translated and never priced, so a paragraph of
  `2024` or `1,000.50` is zero words. A paragraph with any letter counts
  every word in it, numbers included.
- **Hidden text counts.** Direct `w:vanish` is in the run's format
  entry; a style-inherited one is unreachable, because `core` never
  reads `styles.xml`. A definition that excluded one and counted the
  other would depend on how the author applied the formatting. Hidden
  text is extracted, shown in the editor and translated, so it is a word.
- **A source language that does not space its words has no count.** zh,
  ja, th, lo, km, my and bo (`UNSPACED_LANGUAGES`, by primary subtag)
  give `null`, never a wrong number. What a "word" is for them, or
  whether pay is by character, is a decision for `#49`, not a
  whitespace split.
- **A text box counts once.** Word stores a text box twice, as DrawingML
  in `mc:Choice` and as VML in `mc:Fallback`, and `core` extracts both
  copies as regions. That is right for translation, where both must be
  rendered, and wrong for a count, since the reader sees the text once.
  The count excludes every region inside an `mc:Fallback`, transitively,
  and does so *in the counter*, never in the filter. **`#34` and `#49`
  need the same exclusion** and must not repeat the count's
  by-re-scan, so since `#34` each segment carries it:
  `segment.fallback_copy` (project v10), set at assembly from the same
  scan (`fallbackRegionKeys`, `project/fallback.ts`) and backfilled for
  files stored before. A stored segment's words are `segmentWords`
  (zero for a locked segment or a fallback copy), and over every
  fixture they sum to exactly what the upload count says.
- **The count follows what `core` extracts** (§3.5): body, tables, text
  boxes, headers, footers, footnotes and endnotes. SmartArt text and
  image alt-text are listed in §3.5's first paragraph but nothing reads
  either, so they are not in any count. A count is a lower bound by
  that much, and says so rather than silently inheriting the gap.

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
  fallback_copy INTEGER NOT NULL DEFAULT 0, -- in an mc:Fallback: words counted once (§3.6, v10)
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

v7 rebuilds `qa_issue` and `qa_rule_setting` from a frozen rule list
(backlog #64); v8 rebuilds `audit_event` with `segment.split` and
`segment.merged` in its action CHECK (backlog #30a, §7.4).

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
   - Tag multiset of the TM hit, by `(kind, role)`, equals that of the
     segment's *visible* source tags → insert target as-is,
     `origin = 'tm_exact'`, `status = 'translated'`.
     The hit's tags take the receiving segment's own *visible* tags' ids
     by `(kind, role, order)` (`core/tm/mapping.ts`; a placeholder only
     ever takes a placeholder's id — backlog #29 found a kind-only match
     giving a spell-check marker a run's id, which rendered a `<w:r>`
     with no close). A memory holds no hidden tags (tm-format-spec §3);
     a unit that does — another tool's — is matched against all of the
     source's tags and keeps only the visible. The match's text is made
     XML-legal (`xmlLegalText`) before it is placed.
   - Tag multiset differs → insert the target's **text**, re-tagged by
     position where unambiguous, `origin = 'tm_exact_tagdiff'`,
     `status = 'draft'`, and raise a QA warning. Never silently produce
     tag-invalid targets. **Unless the source has no visible tag**
     (backlog #29): then there is nothing to reapply, the text is the
     whole target, and it is placed as `tm_exact` — a real memory's
     mismatches are mostly hidden ones, a spell-check marker here and
     not there. Either way the stored target gets the source's hidden
     tags (`setSegmentTarget`, §7.2).
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

Rules run per segment on confirm, on every target the editor saves —
that segment and every segment whose consistency findings the edit can
move (same source, or a target reading as the old or the new one), in
the write's own transaction (`rerunQaAfterEdit`, via
`editSegmentTarget`, §7.2) — and across the project on demand
(`runQaRulesFor`, the project read once). The text rules (`num.*`, `punct.*`) read a hidden placeholder
as the nothing the reader sees, not as content (`QaCheckContext.formats`):
where it sits in a target is the carrying rule's doing, not the
translator's.

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
  mark. Visible placeholders are opaque characters for every rule here,
  not dropped, so `word<tab>word` is not a double space and `1<tab>000`
  is not one number; a hidden one is read as nothing (above).
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
- `Ctrl+,` insert next unplaced tag; `Ctrl+Shift+,` tag list (bound by
  #29 with the editor itself, §7.2; the other keys here are #30's).
- `Ctrl+Ins` copy source to target.
- `Ctrl+M` merge with next segment, `Ctrl+Shift+M` split at cursor
  (both within one paragraph only).
- Tags render as compact atomic chips; a "show full tags" toggle reveals
  the underlying formatting.
- QA panel: filter by rule and severity, jump to segment.
- Filter bar: by status, origin, QA state, and plain-text search.
- Progress: segments confirmed / total, words confirmed / total.
- Dark mode, and no layout shift when the QA panel opens.

Autosave on every keystroke, debounced (#31). There is no "save"
action; a crash must never cost more than a few seconds. The audited
write stays at segment boundaries — audit-spec §2.2; the editor saves
when it leaves a segment and on `pagehide` (§7.2) — so keystroke drafts
live outside it, in the browser (§7.2, *Keystroke drafts*), and §2.2
stands unamended.

### 7.1 The segment grid (`@cat-tool/web`, backlog #28)

The first screen of the SPA and the reason it exists: two columns, a
gutter, and nothing re-rendered that is not on screen. Decisions, so
they are not re-derived:

- **A Vite + React SPA, `packages/web`, talking only to `/api/`.** No
  router library, no state library, no component kit: three screens
  (login, project/file picker, grid) are a hash (`#/p/<name>/f/<id>`)
  and a `useState`. Each earns its dependency when a screen needs it.
  In development Vite proxies `/api` to the server on `:3400`; serving
  the built SPA from the server process is #36a's: with `CAT_WEB_DIR`
  set the server serves `/` and `/assets/` from that directory and
  nothing else, and the container image sets it.
- **`@cat-tool/web` imports `core` for types only** — except
  `@cat-tool/core/model`, the token model and tag rules, since #29
  (§7.2). `core`'s index pulls in `node:crypto` (credentials), the DOCX
  filter and the segmenter; none of it belongs in a browser bundle, and
  a runtime import would drag it there. What the grid needs at runtime — a
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
  two chips, `‹1` and `1›`; a placeholder is one, `⟨2⟩`, titled with what
  it stands for (`describeFormat`), as every chip is. Editing them —
  atomic chips in an editable target, insert-next-tag — is #29's
  (§7.2), which also shows a run of look-alike pairs as one chip pair,
  `‹1–31`, here as there; a row not being edited only shows them, and a
  missing target shows empty, never the source.


### 7.2 The target editor (`@cat-tool/web`, backlog #29)

Clicking a target opens it for editing: text and atomic tag chips, one
row at a time, every other row read-only as in §7.1. The card's words —
atomic chips, insert-next-tag, tag list, full-tag toggle, tags never
editable as text, hidden tags carried and never shown — and what four
independent reviews of the first draft found wrong with it, settled as:

**Hidden tags are the server's, by one rule.** A client sends what the
translator placed: text and visible tags. `setSegmentTarget` — the one
write every writer goes through, the editor, pre-translate, propagation
— stores the target with its source's hidden tags carried by
`carryHiddenTags` (`core/model/hidden-tags.ts`), whatever tokens it was
given. So a hidden tag never reaches QA's `tag.missing` as something a
translator must place, and none is lost on export however the target
was made. A target reading exactly as the source's gets the source's
own hidden tags; any other is dressed per container (top level, each
placed visible pair) from the source's content there: the dominant
plain formatting — the hidden run over the most non-space characters,
or none — wraps it; a losing hidden run whose text the translator kept
verbatim, standing apart (a note number raised by hand, a symbol-font
checkbox), wraps that — never a digit of a number (`1` in `1,5` is
not apart); a run that came after all of its container's text, as a
note number does, wraps only an occurrence ending the target's text
there (`2021.1` ends in a note, and a `1` earlier in the sentence is
never it); a wrapper (`w:ins`, `w:moveTo`, `w:sdt`) around all of the
source's text *and every visible tag* wraps all of the target's, unless
the target moves a visible tag into it from outside (either way a link
or a field would land inside a tracked insertion, which OOXML does not
allow); a placeholder before the text, or a range start whose end
follows text, leads; everything else trails, empty. Trailing is only
safe for what shows nothing: a `w:fldSimple` page number, a `w:cr` and
an equation had been hidden by omission from the tokenizer's visible
list, and trailed — "Page 1 of 3" delivered as "Seite von 13" — and a
tracked move's text trailed untranslated. They are visible now (§3.2
lists fields), a move's text walked like an insertion's, and so is
everything else the run and paragraph content models allow that shows
content, but for what stays hidden on purpose: tracked deletions
(§3.5) and floating shapes (`tokenize.ts`). Carried tags sit just
inside the wrapping ones, so a dressed
target begins with opens and ends with closes, and export's fold fuses
neighbouring sentences' runs instead of leaving the space between them
in a bare run. Measured on the corpus: retyping every segment with its
tags in place leaves 45 of 270,571 non-space characters in a font, size
or raise other than the source's (`project/carry.test.ts` pins it).
Deliberately not placed by position: a bookmark over part of a sentence
grows to the whole sentence; a tracked insertion of part of one is
placed empty (its words are no longer knowable in translation).

**Any structurally valid stream renders to valid OOXML** (`renderTokens`).
A dressed target nests what no source does — a bold run tag inside the
hidden run carrying the paragraph's font — and `w:r` inside `w:r` is a
file Word refuses. Content takes the properties of its innermost run tag
(a run tag is a whole `w:rPr`, never a delta), looking no further out
than the nearest `inline` tag (run properties never cross a hyperlink);
run XML is emitted lazily and a paragraph-level element closes the run
first; an empty run pair renders nothing. For tokenizer-shaped streams
the output is byte-identical to before (4,545 corpus streams checked;
the roundtrip gate never renders). Before this, a text-only target
carried onto each of the corpus's 2,602 unlocked segments exported a
run inside a run in 302 of them. The renderer also
refuses a tag in a role its format does not fit and text XML cannot
carry (`xmlIllegalChar`: a vertical tab is how PowerPoint writes a soft
break), and `parseTokens` refuses both — and a `fmt` other than the
tag's own id — at the door. "Valid" means markup Word opens; a field's
begin, separator and end are separate placeholders, and their order is
not something tag structure can check.

**The interactive write is one `db` call** (`editSegmentTarget`), the
route only parsing around it (the CLI rule, §2.4):
- *No visible change, no write.* Same visible target
  (`sameVisibleTarget`: however the text is split, wherever the hidden
  tags sit) → nothing stored: a TM match clicked through keeps its
  origin, a confirmed segment stays confirmed.
- *Status and origin are derived, never sent.* Anything visible →
  `translated`, origin `null` (the translator's own; the audit log's
  previous event keeps what it was — audit-spec decision 4). Nothing
  visible but spaces → `null`, `new`: an untranslated segment again,
  never an empty translation, which export would deliver as a missing
  sentence (`isBlankTarget`, the test confirm uses too).
  Editing a confirmed segment makes it `translated`, to be confirmed
  again before the TM learns it. Accepting a suggestion (a TM hit,
  later an MT draft) will be its own write naming its origin, not this
  one (audit-spec §4).
- *A stale write is refused.* `baseUpdatedAt` is the segment as the page
  last saw it; a write over a newer one — another tab — is a 409 carrying
  the segment as it is; the row is marked not saved, with a note to
  reload the file — never a silent overwrite. Every write of a segment
  moves its version, even within one millisecond (`nextVersion`: now, or
  one past the stored version): a timestamp at that resolution once let
  an import and an edit share a value on a fast CI runner, and a stale
  write then read as current. The
  page keeps one write per segment in flight (`save-queue.ts`), each
  sent with the version the last answer returned. An answer for a write
  a later one has superseded updates the row's version, status and
  issues but not its text, so a slow answer never shows older text the
  translator could then edit on top of; a superseded write's failure is
  not shown. The one exception to the version check is the page going
  away: its write goes at once and cannot wait for the one in flight,
  whose answer would carry the version, so it goes without one and
  replaces any write still waiting. What that risks is overwriting
  another tab's write that landed just before the one in flight; what
  it saves is the last edit, which a refusal on a closing page would
  lose with nobody to see it. The other segments' writes still waiting
  behind one in flight go then too (`SaveQueue.flush`), after the open
  editor's, rather than be lost with the page.
- *A structure export would refuse is refused now* (400), not at
  delivery, where one bad segment would fail the whole file.
- *QA reruns in the same transaction* (`rerunQaAfterEdit`) for the
  segment and every segment whose consistency findings the edit can
  move: those sharing its source (`consistency.target_differs`) and
  those whose target reads as its old or new one
  (`consistency.source_differs`). The answer carries their ids and
  issues, so the gutter follows the edit (the grid takes those of its
  own file's segments; a repetition in another file is that file's
  grid's to show). The project's translated
  segments are read once per pass, not once per segment rerun: that
  was 7 s for one save of a segment with 500 repetitions in a
  10,000-segment project, and is 0.15 s.
- `confirmSegment` refuses a target with nothing visible in it but
  spaces.

**When it saves.** When the editor leaves the segment — blur, Esc, the
row unmounting, and `pagehide` (a `keepalive` request, which unlike a
beacon carries the bearer header; the grid holds the one listener, so
the open editor's write goes before the waiting ones,
`createPageHide`) — and only if the document changed
(ProseMirror document equality, so a split text node is not an edit)
— or if the segment's last write failed, changed or not, so leaving
the row again is the retry. Signing out blurs the editor and waits for
its write before revoking the session. Saving at segment boundaries, never per keystroke, is
audit-spec §2.2's rule; autosave (#31) keeps it, below.

**Keystroke drafts (backlog #31, `drafts.ts`).** Between those writes the
open editor keeps its target in the browser's `localStorage`, 500 ms
after typing pauses (`DRAFT_DELAY_MS`) and at once when it leaves the
segment, until the server answers for that write. A draft is never sent
as it is typed: it is the visible target, the version of the segment
its write would go over (the save queue's), the source's hash, and when
it was written. Decisions, so they are not re-derived:
- *The browser, not the server.* A server-side draft table would be
  translation content changed with no audit event, or §2.2's event
  storm; and what autosave guards against — the tab, the browser or the
  network going — is exactly what a draft already in the browser
  survives. What it does not survive is the machine, which the server's
  last segment-boundary write covers.
- *Recovered once, on the next load of the file, into the one audited
  write* (`recoverDrafts`). A draft over the version still stored is the
  leave-write the page never made: it goes through the save queue like
  any other, so the server derives status and origin, reruns QA and
  audits it. A draft that reads as what is stored is dropped — the
  `pagehide` write landed and nobody was left to hear the answer — and so
  is one typed against another source (a merge, a split, a project made
  again under the same name).
- *A segment saved elsewhere since is never overwritten by a draft* —
  the 409 rule again. Its row is marked not saved, the draft's words in
  the mark, the stored target kept; the draft is then forgotten, so a
  reload shows the segment as it is.
- *Scoped by account and project* (`cat-tool.draft.<account>.<project>.<segment>`;
  the grid reads the account from `/api/me`), so one person's drafts are
  never offered to another signed in on the same browser; a draft older
  than 30 days is pruned unread. Signing out does not clear them: a
  draft still there is an edit whose write failed, the only copy of it.
- *Storage that is absent or throws* (a private window, a full quota)
  is the editor as it was before #31, never an error.

**ProseMirror, not a hand-rolled contentEditable.** The job is one line
of text with atomic inline nodes — exactly ProseMirror's model — and the
hard parts are the browser's: composition (Spanish accents typed with
dead keys on macOS go through it; checked in the smoke run through CDP),
the caret beside a non-editable node, spellcheck replacement, paste,
undo. Its state layer runs in node, so every rule is tested without a
DOM (`target-doc.test.ts`). The cost: the bundle went from 81 to 152 KB
gzipped. The document is `doc(inline*)` with one `tag` atom node;
chips are not selectable (arrows step over one in a press; a selected
chip would hide the caret and be replaced by the next letter).

**What keeps it tag-valid** (`tags.ts`, pure): deleting either chip of a
pair deletes its partner, content kept, with a note saying what went and
that Ctrl+Z (one step) restores it; a stored target that is not valid
is repaired on load and saved as repaired; a pair wraps a selection only
when the selection is balanced; and a pair nests only as a source's do —
formatting holds only text and placeholders and sits in no other
formatting, no link in a link — because a run tag is a whole `w:rPr` and
bold around italic would export as italic alone, silently. Paste from
elsewhere is one line of plain text (breaks and tabs become spaces;
what XML cannot carry, `xmlLegalText`, and DEL are dropped). Paste of
this segment's own copy keeps its chips, so a cut and paste moves a
tag — the EN→ES adjective-after-noun gesture (`pasteOwn`, one undo step): the
selection goes first, and with it any pair it took one chip of, as the
integrity rule would take it; then of the copy's chips, only this
segment's tags, rebuilt from its own format table; only those not
still placed; only whole pairs, and only where they nest as a source's
do (bold pasted into italic, or a link into a link, arrives as its
words). A copy names its project and segment
(`<span data-segment-copy="project/id">`, which also makes ProseMirror
mark every copy as its own, even one that starts with a word), and any
other copy is plain text — another segment's, or segment 12 of another
project: tag ids are per segment, and the same number can be a
different tag. Drop is refused.

**Placing tags.** The palette is the source's visible tags in source
order. `Ctrl+,` places the first unplaced one — with text selected, the
first *pair*, since a selection asks to be wrapped: a pair wraps the
selection or goes in empty with the caret between; a placeholder goes
at the selection's end. `Ctrl+Shift+,` opens the tag list (arrows, Enter,
a tag's number, Esc); choosing a placed tag moves it. Both keys are
literal Ctrl on every platform (Cmd+, is the browser's own settings on a
Mac) and both have a button in the row. Each placement is its own undo
step. A pair left empty when the editor leaves is dropped — it formats
nothing — so it counts as unplaced and QA says so.

**Look-alike pairs are placed as one.** Word splits a run wherever
anything changes, seen or not, and the tokenizer keeps each run's pair
(§3.2's "merged" happens only at render). So a bold phrase can arrive
as many bold pairs side by side: one fixture sentence has 31, the corpus
has such runs in 251 of 2,602 segments, and each pair left unplaced is a
blocking `tag.missing`. Pairs that follow each other directly (only
hidden tags between) and read the same (`describeFormat`) are one
palette entry and one chip pair, numbered `‹1–31`; saved, the first
wraps the text and the rest follow it empty — export renders the text
with the first's properties, and what differed between them is what no
chip ever showed, the same trade the hidden runs make. A target can
also hold a group's pairs apart (a TM match places each by its own
id): then a member the first pair's chip does not carry is a tag of its
own in the bar and the tag list, placed or to place, and moving the
first pair never places a member twice (`tagChoices`, `expandGroups`).
A first pair carrying only some members is saved with exactly those
following it empty, and loads carrying exactly those
(`collapseGroups`), so what the bar showed survives a reload and the
next save; the grid's read-only rows show the same form.

**Full tags** (a grid-wide toggle, remembered per browser): each chip
says what it stands for — `‹1 bold italic`, `link #_Ref4`, `⟨2 footnote⟩`,
`⟨3 field PAGE⟩` — read from the format table's raw XML
(`tag-label.ts`). Both labels are always rendered; a class on the grid
picks one, so toggling re-renders nothing. The editor carries the
target language as `lang` for the browser's spell checker; source cells
carry the source's.

**`@cat-tool/core/model`** is the SPA's one runtime import from `core`:
the token model and tag rules (`token.ts`, `tags.ts`, `hidden-tags.ts`),
so which tags are hidden is one definition in the browser and on the
server. `model/` importing nothing but its own `./` siblings — no other
`core` module, no Node builtin, no package — is now a lint rule, not
just a convention, which is what keeps that entry browser-safe; the
built bundle was checked for `node:crypto` and the DOCX filter.

Measured in a Chromium smoke run against the real server (35 checks):
typing, placing and wrapping, refusal notes, the tag list, save on Esc
with the hidden tags carried and QA rerun, a click-through writing
nothing, pair deletion and its undo, paste from elsewhere, IME
composition, full tags, a 15-pair group placed with one keystroke, a
reload showing what was saved, the caret landing where the click did,
a cut starting on a word moving its tag, another segment's copy — its
tag 1 bold, like this one's — and another project's segment 1 arriving
as words, and `pagehide` saving the open edit through the grid's
listener; the exported DOCX well-formed with no run inside a run.

### 7.3 Confirm, advance and copy source (`@cat-tool/web`, backlog #30)

- **`Ctrl+Enter` confirms, then advances.** The editor first sends any
  change (§7.2), then asks the save queue to confirm; the grid opens the
  next segment that is neither `confirmed` nor `locked` (`nextUnconfirmed`
  — forward only, no wrap: at the end of the file the editor closes) and
  scrolls it into view, without waiting for the answer. `Ctrl+Enter` and
  `Cmd+Enter` both do it. A target with nothing visible in it is not
  confirmed (`isBlankTarget`, as `confirmSegment` refuses it); the editor
  says so and stays.
- **A confirm is the translator's act, and is a request of its own:**
  `POST /api/projects/:name/segments/:id/confirm` with the version the
  editor saw (`baseUpdatedAt`; a stale one is a 409, as for an edit).
  `confirmEditedSegment` (`db/project/confirm-target.ts`) is `confirmSegment`
  — the write-target memory, the audit event, the status — plus that
  version check and a QA rerun, since `seg.empty` and its kin read the
  status. Confirming a confirmed segment writes nothing (`changed:
  false`). A project with no enabled write-target memory refuses with a
  409 naming it (`ConfirmError`); a server-created project has one when
  it was created with one, as the SPA's form does by default (§7.5).
- **The save queue orders it** (`save-queue.ts`): after every write of
  that segment already asked for, on the version the last returned;
  dropped, never sent, if one of those writes fails or another is asked
  for before it goes; not sent on `pagehide`. A confirm approves the text
  as stored, so it can never run ahead of, or past the failure of, the
  write of the text.
- **`Ctrl+Ins` copies the source over the target**, one transaction — so
  `Ctrl+Z` restores the old target — with the source's visible tags as
  chips under the same ids (all placed), hidden tags left to the save
  (`carryHiddenTags`), the caret at the end. The status it leads to is
  the ordinary one: a saved target with anything visible is `translated`,
  no machine origin; it is not a confirm. Both keys have a control in the
  editor's bar (a Mac keyboard has no Insert).
- **Not here:** merge/split (`Ctrl+M`, `Ctrl+Shift+M`) is §7.4 (backlog
  #30a); filter focus is `Ctrl+Shift+F` (§7.7, backlog #34).

Measured in a Chromium smoke run against the real server: type,
`Ctrl+Enter` → segment confirmed and the next one open; `Ctrl+Ins`, then
`Ctrl+Z`; `Ctrl+Enter` on an empty target; and the same in a project with
no write-target memory, where the row carries the refusal and the flow
still advances.

### 7.4 Merge and split (`@cat-tool/db`, `@cat-tool/web`, backlog #30a)

The escape hatch §5.3 promised: `Ctrl+M` merges a segment with the next
one, `Ctrl+Shift+M` splits one at a caret. The pure policy was #14
(`core/segment/edit.ts`); this is the write path it never had.

- **Within one paragraph, never across.** A merge takes the segment and
  the one with the next `para_ord` in the same `(file, part, para_key)`;
  the last segment of a paragraph has no next and is refused. A locked
  segment, either half of a merge included, is refused.
- **What a row does.** A split keeps the row's id on the first half (its
  audit history, its QA rows, its place in the grid) and inserts a new
  row for the second; a merge keeps the first row's id and deletes the
  second's, with its `qa_issue` rows. Later segments of the paragraph
  have their `para_ord`, and of the file their `ord`, moved by one — the
  fold (§3.4) reads `para_ord`, so getting it wrong misorders the
  paragraph on export. Both halves' `source_hash` is recomputed
  (`normalizeTokens`) and their tag ids renumbered from 1, as any segment's
  are (§3.3).
- **The target is never mechanically cut** (`splitEditableSegment`,
  #14): a split leaves the whole target on the first half; the second
  starts empty. A merge joins two targets with a space. Either way the
  result is a `draft` with no `origin` — never `confirmed`, the source it
  was confirmed against is gone — and a segment with no target stays
  `new`. What is *stored* is the translator's part only: visible tags are
  kept by their id where the source still has them, and a tag that belongs
  to the half the target was not kept with is dropped from it; hidden tags
  are carried again from the new source (`carryHiddenTags`, backlog #29),
  as for any write. A pair the split closed and reopened at the seam is
  one pair again after a merge, in the target too: the first target's
  opening and the second's closing stand, the seam's close and open go.
- **A version check, as an edit's** (`baseUpdatedAt`): a stale segment is
  a 409 carrying the current one. Both segments of a merge are checked.
- **Audited, in the same transaction, actor required** (audit-spec §2.2):
  `segment.split` (subject: the row that kept its id;
  `{ new_segment_id, offset, first, second }`) and `segment.merged`
  (subject: the survivor; `{ removed_segment_id, state }`), each halves'
  or the result's state being the ordinary `SegmentStateDetail`, so "what
  did it say" stays one row lookup. The rows of a merge that disappears
  are still in the log under their old id. A new action widens the CHECK:
  project schema v8, `rebuildTable`.
- **QA reruns** for every segment the operation touched, in the same
  transaction, and the answer carries their issues.
- **Export still folds one paragraph.** A merged pair, and a split
  segment, render back into the paragraph's one marker through the same
  fold; a split then a merge returns the original XML, byte for byte
  (tested through the database, on the corpus).
- **Where the caret is.** The source cell is where a break is chosen —
  the target's caret has no place in the source. `Ctrl+Shift+M` splits at
  the caret the translator put in the *source* text (a click; chips count
  for no characters); with none there, the editor says so instead of
  guessing. `Ctrl+M` merges the open segment, or the one whose source
  holds the caret, with the next. Both have a button in the grid's bar,
  for a browser that keeps the chord (the button does not take the caret,
  so a split still finds it there).
  Pending edits of the segments involved are sent, and their answers
  awaited, before the request (the save queue's `whenIdle`), for the same
  reason a confirm is ordered after them (§7.3): the merge reads the
  target *as stored*.
- **The grid re-keys.** The answer lists the segments that now exist in
  place of the ones asked about, and those that are gone; the grid swaps
  them into its list, moves the queue's cached versions, and keeps the
  first half open when it was open.

### 7.5 Projects and memories (`@cat-tool/server`, `@cat-tool/web`, backlog #32)

The screens that make what the grid opens: a project, its documents,
and the memories it consults. Every write is a repository call with
HTTP around it (§2.5); what follows is what had to be decided.

- **A memory is the account's, not a project's.** One `.ctm` per
  memory at `<root>/tms/<slug>.ctm`, beside `projects/`, attached to
  as many projects as use it — the multilingual memory of §4.2, which
  outlives any one job. The slug alphabet is the project's, and is one
  definition (`isSlug`, `core/model/slug.ts`) for the server, which
  builds paths from it, and the SPA, which checks and suggests names.
- **The API speaks slugs, never paths.** `tm_ref.path` stays the
  absolute path the server built (the CLI's convention, which
  `attachTms` reads); a route answers with the slug that path is in the
  account's `tms/` directory, or `null` for a memory attached from
  anywhere else (by the CLI). A path would show the storage root, which
  no response does (§2.5). A deployment that moves the volume (#36)
  moves every stored path with it — recorded here, not solved.
- **A project is born with its write memory, by default.** #30 found
  every server-created project refusing `Ctrl+Enter`, because nothing
  could attach a write target; which memory, then, is the question this
  card had to settle. `POST /api/projects` takes `writeTm`, attached
  first as the write target and created empty if new, all inside the
  creation. The form proposes a new memory named after the project (the
  slug follows the title, the memory the slug, until either is edited)
  and lists the account's memories to pick one instead; emptying it
  creates the project without one, as the API does when it is left out.
  A memory per project is the default rather than the rule because a
  translator's real asset is one memory per client or domain, which
  this lets them choose from the first project on.
- **Priority is an order, not a number.** The screen moves a memory up
  or down; the server takes the whole order (`reorderTmRefs`: every ref
  once, renumbered 1…n) — a partial renumbering could leave two at one
  priority, and §4.1's tie-break would then depend on row order.
- **Every change to the list is in the project's log**
  (`project.setting_changed`, key `tm_refs`, audit-spec §2.4): the whole
  list before and after, in the same transaction as the change, its
  actor the session's. A pre-translate already named the memories it
  read; now so is every attach, move, retarget and detach between runs.
- **Detaching never deletes.** The `.ctm` may serve other projects;
  deleting a memory is not here (nor is deleting a document, nor a
  memory's resumable import): each wants its own decision about what
  depends on it.
- **An import happens in the request.** The upload streams to a file
  under the account's root with a name the server minted (the portal's
  rule: an uploaded filename never becomes a path), is imported into a
  new memory, and is deleted after. The cap is 2 GiB, against a
  document's 100 MB. An import that fails leaves no memory, unlike the
  CLI, which keeps an interrupted TMX import's units for `resume`:
  resuming across requests, and an import that outlasts one, are
  backlog #16a's (off-thread bulk operations). The memory records the
  client's filename as its import's source, not the minted one
  (`importTmxFile`'s `sourceName`).
- **Documents go up one request each**, in the order chosen, a failure
  naming its file without stopping the rest.
- **Pre-translate is the whole project**, from the project screen, and
  its counts are the answer; the grid shows the result when opened.

### 7.6 The QA panel (`@cat-tool/server`, `@cat-tool/web`, backlog #33)

The file's findings, under the grid: filter by severity and rule, jump
to the segment, dismiss. What it settled:

- **A finding is named by its segment and its rule, never its row id.**
  One rule fires at most once per segment (§6.4, backlog #22), so the
  pair names one finding; and it is what a dismissal is already kept
  against (`replaceQaIssues`). The id is not even stable across a
  rerun: QA replaces a segment's rows wholesale, and SQLite gives a
  freed row id to the next insert, so an id the page held can name a
  *different* finding of the same segment once a save has rerun QA —
  a dismissal sent by id would set aside something the translator
  never saw. The route is `…/segments/:id/qa-issues/:rule`.
- **Dismissing is a decision, so it is logged; carrying it is not.**
  `qa.dismissed` and `qa.reinstated` (audit-spec §2.4), subject the
  segment, detail `{ rule }`, in the same transaction as the write, the
  actor the session's — a dismissed error is one that no longer blocks
  export (`isBlocking`), and who decided that is the question an audit
  asks. A rerun that finds the rule again and keeps the dismissal
  records nothing: no one decided anything then.
- **A dismissal can be undone.** "Show dismissed" lists them, struck
  through, with *Reinstate* — a misclick otherwise lasts until the rule
  stops firing.
- **A dismissal waits for the segment's writes already asked for**
  (`queue.whenIdle`). Each save answers with the segment's findings as
  its rerun left them; one landing after the dismissal's answer would
  show the finding undismissed again, though the server kept it.
- **Docked under the grid at a fixed height.** Opening it shortens the
  grid's window and moves no column and no row (§7's "no layout shift";
  the smoke run measures both), where a side panel would rewrap every
  row and re-measure the virtualised heights. Its open state is a
  per-browser preference, as "show full tags" is.
- **A jump opens the segment**, as a click on its target would; a
  locked one is scrolled to and not opened. A filter's count is what
  choosing it lists: severities count within the chosen rule, rules
  within the chosen severities, and a rule with nothing to list is not
  offered (unless it is the one chosen — the list never silently widens
  under the translator).
- **No new key.** §7 names none for the panel, and its controls are
  ordinary buttons in the tab order; a shortcut can come with #34's
  filter-focus key, when there is a set to fit it into.

### 7.7 Filters and progress (`@cat-tool/core`, `@cat-tool/db`, `@cat-tool/web`, backlog #34)

A filter bar over the grid and a progress line in its header. What it
settled:

- **Four filters, all at once**: text (case-insensitive, in the source
  or the target), status (any of the five; a segment locked by the
  filter reads as `locked`, as in the gutter), origin, and QA state
  (any, with findings, with errors, none — by the gutter's mark, so a
  segment whose findings are all dismissed is clean). Logic in
  `web/filter.ts`, tested in node.
- **Origin is offered from the file, not from a list.** Origin is an
  open string (§4.3): the choices are the values the file holds, each
  with its count, `No origin` for none, a known one by its gutter title
  and an unknown one (`tm_fuzzy_85`) verbatim.
- **The open segment stays on screen whatever the filter says.** An edit
  can take a segment out of its filter (a `new` one, typed into); pulling
  the row from under the caret would unmount the editor mid-word.
- **Confirm-and-advance stays within the filter**: the next segment
  still to do *among those shown*, so "New only" is a queue to work
  through. A QA-panel jump to a segment the filter hides clears the
  filter first.
- **`Ctrl+Shift+F` focuses the text filter** — §7's "filter focus".
  Literal Ctrl on every platform, as the editor's keys; `Ctrl+F` stays
  the browser's find. Escape leaves the box (and Chromium clears a
  search box on it, which is the platform's convention).
- **The bar is always there**, so filtering never moves the grid.
- **Progress is "confirmed / to translate"**, for segments and words.
  A locked segment is in neither: it is never translated (§3.5). A text
  box's `mc:Fallback` copy is a segment to confirm, because it is
  rendered too, but its words are its twin's (`segmentWords`, §3.6). A
  source language that does not space its words shows no word count
  (`hasSpacedWords`), never a wrong one. Counted in the browser from the
  segments it already holds, with `core/model`'s functions, so it moves
  as segments are confirmed and cannot differ from the portal's
  estimate or vendor pay; `primarySubtag` moved into `model/lang.ts`
  for that, re-exported from `segment/rules.ts`, still one definition.

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
