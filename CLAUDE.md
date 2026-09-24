# Working in this repo

An AI-native CAT tool and translation-business platform, built outward
from a headless engine. Full context lives in `planning/`; this file is
the fast-orientation layer — conventions and gotchas that aren't obvious
from the code alone. (`AGENTS.md` is a one-paragraph pointer to this
file, for tools that specifically look for that name — not a second
copy. Add new agent-facing guidance here, never there.)

**Read first, in this order:** `planning/v1-backlog.md` (what's been
built and what it taught) and the repo's open GitHub issues (what's
next — one per open backlog entry, labelled by epic and size), then the
specific spec section for whatever you're about to touch
(`v1-spec.md`, `tm-format-spec.md`, `segmentation-spec.md`,
`ai-platform-vision.md`, `smart-glossary-spec.md`). Don't start
implementing a backlog item without reading its spec section — several
early mistakes here came from coding against an assumption the spec had
already settled differently.

## The working rhythm

1. **Spec before code.** A design decision (a new data model, a new file
   format detail, a product-scope change) gets written into the relevant
   `planning/*.md` file before or alongside the implementation, not after.
   `segmentation-spec.md` and `ai-platform-vision.md` were both written
   this way — reasoning kept on the record, not just the conclusion.
2. **One card, one branch, one PR.** Take a single issue from the board,
   branch for it, and end with a PR whose body says `Closes #NN` — on
   merge that closes the issue and moves its card, so the board stays
   true with no bookkeeping. Run the full gate before calling it done:
   `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`,
   `pnpm test`, `pnpm test:gate` if anything under
   `packages/core/src/docx` changed, and `pnpm test:golden` if anything
   under `packages/cli`, `core/qa`, `core/project`, `core/tm`,
   `db/project`, `db/tm` or `fixtures/golden` changed (its transcript
   is what those deliver, so a change there is a diff to read, not a
   red run to regenerate away). Rewrite the backlog entry as
   _record_ in the same change — strike the title through, say where the
   code lives, keep what it taught (a bug caught, a design choice made),
   and drop the issue link. Its **status** is the issue's job, never the
   file's; `v1-backlog.md`'s own header states the two heading forms.
3. **Never merge without being asked.** Push the branch, open the PR,
   describe what it does — then wait. Every merge in this project has
   been an individual, explicit go-ahead, not a default. This holds even
   when the change looks obviously safe.
4. **Branch from `main`, merge back to `main`, promptly.** Never branch
   from another session's branch, and never let one accumulate several
   sessions of work. That is how `main` quietly stopped being trunk
   once already — a PR reading "closed unmerged" while its code was
   live, and `main` a whole epic behind the real backlog until someone
   went looking.
5. **One session at a time on one area.** Every session writes its
   record into `planning/v1-backlog.md`, which makes that file a single
   point of contention by design. Two sessions on the same epic conflict
   there, in entries neither was editing on purpose. Phased work across
   several sessions has its own protocol:
   `planning/multi-session-workflow.md`.
6. **When asking questions to Louis, always propose multiple choices
   and a recommendation.** Never an open-ended question alone — lay
   out the options and say which one you'd pick and why.

## Non-negotiable invariants

- **Skeletons are built by slicing the original XML string, never by
  re-serializing a parsed tree.** A serializer drops namespaces only
  referenced via `mc:Ignorable`, silently breaking documents that use
  them. This is why the roundtrip gate can require byte-identical output.
- **The roundtrip gate (`pnpm test:gate`) is load-bearing.** Zero-edit
  DOCX import → export must reproduce every part byte-for-byte across the
  real-world corpus in `fixtures/docx/`. If a change breaks it, the change
  is wrong, not the gate.
- **`.ctm` (and every other SQLite file this product writes) goes through
  the shared migration runner** (`packages/db/src/migrate.ts`), not a
  bespoke migration path. It already implements the format-version guard,
  the pre-migration backup, and the integrity check — extend it, don't
  duplicate it.
- **`@cat-tool/core` stays headless:** no Electron, no DOM, no HTTP.
  Every filter, segmenter, matcher, and QA rule must be provable from a
  test with no UI or server in the loop. This is also what made the
  desktop-to-web-service pivot cost nothing — `core` never knew which
  shell was calling it, and it still shouldn't.
- **Compare binary payloads by digest (SHA-256), never `toEqual()`.** Deep
  equality on a multi-megabyte `Uint8Array` is slow enough to matter
  across a whole fixture corpus.
- **`TextDecoder` needs `{ ignoreBOM: true, fatal: true }`** wherever DOCX
  XML is decoded — the defaults silently strip a leading BOM and turn
  malformed UTF-8 into replacement characters instead of an error.
- **A TM match applies the _receiving_ document's formatting, never the
  origin document's.** `TmToken` deliberately carries no format payload,
  only a `kind` hint (`core/tm/mapping.ts`) — a bold span from a 2023
  client file must render with today's document's bold, not a run
  property carried over from wherever the memory entry came from.
- **A column with a frozen contract never receives a value computed some
  other way — carry the foreign value as provenance instead.**
  `prev_hash`/`next_hash` mean "SHA-256 of the normalised neighbouring
  segment" (`tm-format-spec.md` §4, §5) and nothing else; the ICE tier
  is only trustworthy because that is the column's single meaning. A
  Trados `.sdltm` has its own per-occurrence context hashes, and backlog
  #18b's "done when" asked for them to be written there — they are not.
  They go into `tu_attr` (`x-sdltm-contexts`) verbatim, and the import
  says plainly that no `.sdltm`-sourced unit can be an ICE match. Two
  reasons, either fatal alone: the algorithm is Trados's, not §4's, and
  a foreign value there is indistinguishable at read time from a real
  one; and Trados records a _left_ context only, so §5's both-neighbours
  condition could never be met from it however the hash were decoded.
  Provenance loses nothing — the raw occurrences are all still there if
  the algorithm is ever recovered — where a column that means two things
  loses the feature it exists for.
- **A frozen, cross-package fact gets exactly one definition, always
  imported, never duplicated.** `primarySubtag` (segmentation and TM
  retrieval need the same BCP-47 split) and `NORMALIZER_VERSION`
  (`db/tm/schema.ts` imports it from `core/tm/normalize.ts` rather than
  declaring its own) are both fixes for the same mistake made twice —
  two definitions of one fact can drift silently; one can't. Same
  reasoning caught `qualifySchema`/`ALIAS` (`db/schema-alias.ts`) about
  to become a _third_ copy of an identical four-line regex check —
  `glossary/terms.ts` had it once already for `.ctg`, backlog #19
  needed the same thing for `.ctm`, so it moved to one shared module
  before landing twice.
- **A repository read that can also run against an `ATTACH`ed file uses
  `(db, params, options: { schema? })`** — a third argument, not a field
  stuffed into `params` — matching `qualifySchema` above. `tm/retrieve.ts`'s
  `retrievePair` and `glossary/terms.ts`'s `findRendering` both follow
  this; a new priority-ordered cross-file query (a future `.ctm` merge,
  #15d) should too, rather than inventing its own shape.
- **`core`'s internal layering is one-directional: `model/` → (`docx/`,
  `segment/`) → `project/`.** `model/` is the base layer — nothing may be
  imported into it from any other `core` module. `docx/` and `segment/`
  each import from `model/` but never from each other in the forbidden
  direction (`segment/` imports `docx/`'s tokenizer types, so `docx/`
  must never import from `segment/`). Anything that needs both — like
  `assembleFile`, which tokenizes a DOCX region and then segments it —
  goes in `project/`, a layer above both, rather than being bolted onto
  either. This came up twice in backlog #16 alone: `FormatEntry`/
  `TokenizedRegion` had to move from `docx/tokenize.ts` into
  `model/token.ts` before `model/segment.ts` could reference them without
  creating `model/` → `docx/`, and `assembleFile` had to become its own
  `project/` module rather than living in `docx/document.ts`, which would
  have created `docx/` → `segment/`. Work out the dependency direction
  before writing the glue code, not after the cycle shows up.

## Auditability

`planning/audit-spec.md` (backlog #55–#58). Designed before most of it
is built, because history not recorded at write time is gone. Before
writing any new write path, know these three rules:

- **A change that matters writes an `audit_event` in the same
  transaction**, in the same file as the data it describes. The table is
  append-only by trigger. Its row type, action list and hash chain live
  once, in `core/audit/`. A new action widens the `CHECK`; it never
  becomes free text.
- **The actor is a required parameter, never optional or defaulted.**
  A write that can't name who caused it shouldn't compile. In `db` it is
  an `AuditActor` (`core/audit/actor.ts`), written through
  `appendAuditEvent` (`db/audit/events.ts`) — the one writer every
  database's log shares; tests pass `TEST_ACTOR`
  (`db/audit/actor.fixture.ts`).
- **Actor and `origin` are separate facts.** An AI engine or a TM match
  is an `origin`, never an actor. The accountable human (or a named
  `system:` job) is the actor.

## The smart glossary (`.ctg`)

Epic 8a (`planning/smart-glossary-spec.md`) is a `.ctm`-shaped SQLite
format for glossaries, through the same shared migration runner —
`db/glossary/schema.ts`, `createGlossary`/`openGlossary` mirroring
`createTm`/`openTm`. Two things worth knowing before touching it:

- **A glossary is a `.ctg` file, never a table in `portal.sqlite`.**
  `db/portal/schema.ts` declares that database "never translation
  content"; a glossary is. A client glossary attached over a base
  glossary is `priority` resolution — the same mechanism `tm_ref` already
  has (`db/project/glossary-refs.ts` shares `attached-refs.ts`'s
  `ATTACH`/`DETACH` plumbing with `tm-refs.ts` rather than duplicating it).
- **`term_decision` is an append-only log, enforced by the schema itself**
  (`BEFORE UPDATE`/`BEFORE DELETE` triggers that `RAISE(ABORT, ...)`), not
  by repository convention. The current preferred rendering of a term
  (`preferredVariant` in `db/glossary/terms.ts`) is _derived_ from that
  log, never stored — it can never disagree with the history that
  justifies it. Glossary term matching is case-folded (`termKey`,
  `core/glossary/key.ts`), which segment hashing deliberately is not
  (`tm-format-spec.md` §4) — the two are different facts, kept as two
  functions.

## The translation portal (`portal-core`/`portal-server`)

Epic 10a (`planning/portal-v0-spec.md`) pulled a client-facing intake/
delivery surface forward, ahead of the Ring 0-3 sequence above, for a
real pilot client. It's a separate product surface from the CAT
engine, but follows the same discipline:

- **`@cat-tool/portal-core` stays headless**, same rule as `core` above —
  pricing (`pricing.ts`), the order lifecycle state machine (`order.ts`),
  and the `NotificationService`/`ProductionAdapter` interfaces
  (`notify.ts`/`adapter.ts`) are pure TS, no DB/HTTP/SMTP. An
  implementation that needs real I/O (SQLite repositories, the SMTP
  notification sender) lives in `packages/db/src/portal/` or
  `packages/portal-server/` instead — see `SmtpNotificationService`
  (`portal-server/src/notification/smtp.ts`) next to
  `ConsoleNotificationService` (`portal-core/src/notify.ts`) for the
  pattern: same interface, the I/O-bearing implementation in the shell,
  not the core.
- Its `.sqlite` file goes through the same shared migration runner as
  everything else — no bespoke portal migration path.
- **An uploaded filename never becomes a path.** The API server's rule
  ("no function takes a path from a request") holds here too, and v0
  broke it once: `portal-server/src/storage.ts` stored uploads under
  `part.filename` until 2026-09-22. The on-disk name is server-minted
  (`mintStoredName`); the client's name survives only as display
  metadata (`displayFilename`, its last path segment) and in the
  download's `Content-Disposition`. A download route takes an order id
  and a file id and looks the file up scoped to that order
  (`getSourceFile`/`getDeliveredFile`), so a file id from another order
  is a 404 — never a lookup by file id alone.
- **Admin auth is a real account, not a shared-secret env var**:
  `admin_user`/`admin_session` (schema migration v2), a bearer session
  token from `POST /api/admin/login`. Password hashing and session-token
  generation/hashing are pure functions in `portal-core/src/auth.ts`
  (`node:crypto` only — same headless rule as everything else in
  `portal-core`); `db/src/portal/admin.ts` is the repository that stores
  and looks them up. One admin account exists in practice, created once
  via `pnpm --filter @cat-tool/portal-server run create-admin`, not an
  HTTP endpoint. Client auth is still a private-link `access_token`,
  deliberately — see `portal-v0-spec.md` §7 before changing either.

## The QA engine

Backlog #22 (`v1-spec.md` §6.4) is another instance of the core/db split
above, not a new pattern: `core/qa/rules.ts` holds pure `QaCheck`s (tokens
in, `QaFinding[]` out, no DB); `db/project/qa-issues.ts`'s `runQaRules`
is the orchestration (load the segment, run the registry, persist);
`db/project/qa-settings.ts` is the per-project switches. All thirteen
§6.4 rules are in the one `QA_CHECKS` registry (backlog #22 the tag
rules, #23 `seg.*`/`consistency.*`, #24 `num.*`/`punct.*`); a new rule
goes there, never into a second one. The locale-aware rules keep their
tables as data in `core/qa/locale.ts` (number formats, French spacing
profiles) and their numeral matching in `core/qa/numbers.ts`; the
decisions behind both — surface, then value under each side's own
locale, then digits, then components; French groups by space, never
point; a verbatim copy never fires — are recorded in `v1-spec.md` §6.4,
so read that before "fixing" a case one of them deliberately lets
through. Those rules also need the project's language pair
(`QaCheckContext.srcLang`/`tgtLang`) and are silent without it.

- **One finding per rule per segment, not one per occurrence.**
  `tag.missing` on a target missing three tags is one row naming all
  three ids, not three rows. `qa_issue` has no per-occurrence column,
  the QA panel (backlog #33) filters and jumps by rule, and — the part
  that makes this load-bearing rather than cosmetic — it is what makes
  dismissal-by-rule (below) mean anything at all.
- **A dismissal must survive the rule firing again, or "persisted
  dismissals" (spec §6.4) is a lie.** `replaceQaIssues` (backlog #16)
  was already wholesale-not-diffed — delete a segment's issues, insert
  the fresh run — which quietly stopped being safe once QA started
  running on every confirm: a naive rewrite reset `dismissed` to
  `false` on every single rerun, so dismissing anything would have
  been pointless the moment the same rule fired again. Fixed by keying
  the carry-forward on **rule alone, not message** — note which rules
  were dismissed before deleting, reapply `dismissed = true` to any
  fresh finding with a matching rule even though its wording (which
  ids, which structural errors) may have changed. A rule that stops
  firing still loses its dismissal along with the issue — there is no
  dismissal record independent of a live issue to preserve. Don't
  "simplify" `replaceQaIssues` back to a plain delete-and-reinsert;
  that silently reintroduces this bug with nothing loud enough to
  necessarily catch it in review.
- **`qa_rule_setting` is absence-based**, the same reasoning `origin`'s
  missing CHECK constraint gets a bullet for above, applied to a table
  instead of a column: a rule with no row is enabled, so a rule added
  to `QA_RULES` later is on by default for every existing project with
  no migration touching their data.

## The CLI (`@cat-tool/cli`)

Backlog #25 (`v1-spec.md` §2.4) is the headless driver §2.3 promised —
`init`, `add-file`, `add-tm`, `pretranslate`, `qa`, `export`, and since
backlog #56 `history`/`audit-verify` — and the proof that `core` and
`db` are complete on their own. Two rules keep it that:

- **Each command is one repository call, never a second implementation
  of one.** The CLI parses arguments, opens the database, prints, and
  sets the exit status. Logic it would need that `core`/`db` lack goes
  into `core`/`db`, where the editor (Epic 6) reaches it too — that is
  how `core/project/export.ts` and `db/project/export.ts` came to exist
  (nothing could turn a project file back into a DOCX before #25).
- **Export never re-renders an untouched paragraph.** A paragraph none
  of whose segments has a target is spliced from its original XML; only
  a paragraph with a target is folded from tokens (`v1-spec.md` §3.4,
  the fold rule). That is what keeps the roundtrip gate's property
  holding through the database, and it is deliberate: re-rendering an
  unedited paragraph gives a normal form, not the original bytes.

`qa`'s exit status comes from `isBlocking` (`core/model/qa.ts`), the one
definition of "must not ship"; don't invent a second one in the server.

**The golden end-to-end test (backlog #26) is the gate's sibling, not a
unit test.** `packages/cli/src/golden.test.ts` runs one real job through
every command and compares everything it prints, plus the delivered
document's text, to `fixtures/golden/prose-short.en-de.expected.txt`
byte for byte. It is excluded from `pnpm test` like the gate and has its
own script (`pnpm test:golden`, a positional filter like `test:gate`)
and its own CI job. When it goes red, read the diff before touching
anything: a changed transcript line is the pipeline saying or delivering
something different, which is either the point of your change or a
regression. `UPDATE_GOLDEN=1 pnpm test:golden` rewrites the expected
file; never do that to make a red run green without having read what
moved. `fixtures/golden/README.md` says what each unit of the memory is
there to exercise, so a new case goes into that file and that README
together.

## The API server (`@cat-tool/server`)

Backlog #27 (`v1-spec.md` §2.5) is the shell everything after #8 runs
behind: Fastify, `platform.sqlite` (accounts, sessions and their audit
log, never translation data) and the storage volume, with `core` and
`db` in-process and JSON to the SPA. Four things to keep true:

- **No function takes a path from a request.** `server/src/storage.ts`
  builds every path from the account's minted `storage_root` and a
  project slug it validates; that alphabet is the whole defence against
  traversal, and there is nothing to sanitise because nothing arrives.
  A new route that reads or writes a file goes through `projectPath`,
  never `join` on something the client sent.
- **Password and session primitives have one home,
  `core/auth/credentials.ts`.** They began in `portal-core`, which now
  re-exports them; `db/portal/admin.ts` and `db/platform/accounts.ts`
  are the two stores. Don't add a third copy for the next login.
- **Each route is a repository call with HTTP around it** — the CLI rule
  (§2.4) again. `countSegments` is the model: when a route needs
  something `db` lacks, add it to `db`, where the CLI and the editor
  reach it too.
- **A route's actor is `sessionActor(req)`, never built in the
  handler** (`audit-spec.md` §2.5). A write in the project goes to the
  project's log; one about the platform (login, a project's creation or
  deletion, a download) to `platform.sqlite`'s, and nothing personal
  goes in either log's hashed `detail` — erasure can only reach
  `actor_label`.

Tests drive the app through Fastify's `inject` — no port, no browser:
`buildApp({ config, logger: false })`, then `app.inject(...)`. A WHATWG
`FormData` is accepted as the payload for a multipart upload.

## TM-format parsers (TMX and native formats)

Both TMX (interchange) and native Trados `.sdltm` (SQLite) follow a
three-layer pattern, split across `core` and `db` to respect the headless
constraint and dependency isolation:

- **`core/tm/parse*.ts`** — Pure parsing logic, no I/O. `TmxStreamParser`
  takes a TMX document in string chunks and returns each `<tu>` as it
  completes; `parseTmx(xmlString)` is its one-push convenience, not a
  second reader. `parseSdltm(db)` accepts a Database handle (not a file
  path). These return strongly-typed interfaces (`ParsedTmx`, `ParsedSdltm`).
  Tests in this layer use synthetic data (hand-built XML, in-memory SQLite).
- **`db/tm/import-*.ts`** — Database integration layer. `importTmxFile`
  reads a file in chunks and writes batches, each its own transaction
  that also advances the file's `tm_import` row; `importTmx` is the
  in-memory, one-transaction case. This is where real-file I/O, schema
  decisions, and error handling live. Tests here validate against real
  pseudonymised fixtures (see `fixtures/` and
  `planning/tm-format-spec.md` §2).
- **An import is bounded by a batch, never by the file** (backlog #18c).
  A TMX importer that needs the whole document as one string cannot
  read an agency memory at all: V8 caps a string at 2^29 characters.
  A batch ends on a unit boundary, so an interrupted import leaves whole
  units and an incomplete `tm_import` row (`finished_at IS NULL`), which
  `resume` continues. Why an import may be incomplete when a merge may
  not is `tm-format-spec.md` §12.4; don't "restore" one transaction.
- **Schema and repository** — `db/tm/schema.ts` owns `.ctm` schema versioning
  and writes through the shared migration runner. Pair retrieval
  (`retrievePair`) lives in `db/tm/retrieve.ts`, not in `core`.

Why this split? Because:

1. `core/tm/` can be tested without `better-sqlite3` or file I/O
2. Real file validation (catching real-world quirks) happens in `db/tm/`
3. A future different storage backend (cloud, API) can implement new
   `db/tm/import-*.ts` without touching the core parsers

See backlog #18 (TMX import, now complete) and #18b (`.sdltm` import —
built, and since 2026-09-18 read against one real file, which broke it
three ways; see `tm-format-spec.md` §8a.2) for worked examples of this
pattern.

- **`*.fixture.ts` is test scaffolding that the build excludes** (see
  `packages/db/tsconfig.json`; it is still typechecked). There is one:
  `db/tm/sdltm.fixture.ts`, the reverse-engineered `.sdltm` schema as
  executable DDL. It exists because two test files needed it and a
  `CREATE TABLE` block copy-pasted into each is a second definition of
  a fact — the mistake the invariant above names. Reach for the same
  pattern before duplicating a schema into a test.

- **The `.ctm` scale benchmark is `pnpm bench:tm`** (`db/tm/bench/`,
  tm-format-spec.md §11), kept out of `pnpm test` and out of the build:
  it runs from source under Node's type stripping against the built
  `@cat-tool/db`, which is why `db/tsconfig.check.json` allows `.ts`
  import specifiers. It writes multi-GB files to the OS temp dir and
  deletes them; its numbers are synthetic, and §11 says what that
  leaves unproven. A change to a TM query's shape is worth one
  `pnpm bench:tm --sizes 1000000` before and after. With
  `--sdltm <file> --src en --tgt es` it measures a real Trados memory
  instead, imported whole through `importSdltm`: client data, so it
  runs on the owner's machine and only the numbers (its results files
  hold no text) come back into §11.

## Gotchas that have already cost time once

- `pnpm test:gate` is `vitest run gate.test` — a **positional filter**,
  not a glob. Passing a glob here silently matches nothing and exits
  non-zero looking like a real failure.
- `tsconfig.check.json` (not `tsconfig.json`) includes test files —
  vitest only transpiles, so a type error inside a `*.test.ts` file is
  invisible to `pnpm build` and only caught by `pnpm typecheck`.
- pnpm 10 blocks postinstall scripts for native modules unless listed
  under `onlyBuiltDependencies` in `pnpm-workspace.yaml`
  (`better-sqlite3`, `electron`, `esbuild` are there already — add a new
  native dependency there too, or its install silently no-ops).
- Prettier will happily rewrite `cat-tool-project.code-workspace` and
  break it; it's excluded via `.prettierignore`. Don't remove that
  entry without checking why it's there.
- A pipeline like `cmd | tee log` masks `cmd`'s exit code — use
  `set -o pipefail` in any script that pipes a check's output.
- `better-sqlite3`'s `db.function(name, fn)` throws if the same name is
  registered twice on one `Database` — guard a per-connection custom SQL
  function's registration (e.g. with a module-level `WeakSet<Database>`),
  or a second call on an already-open connection blows up. See
  `db/lang-match.ts`'s `primary_subtag` registration for the pattern.
- **`packages/db` cannot typecheck or build against `@cat-tool/core`
  until `core` has been built.** `core`'s `package.json` resolves its own
  types through `"./dist/index.d.ts"`, which only exists once `tsc` has
  run — a fresh checkout has no `dist/` yet. So `pnpm build` comes before
  `pnpm typecheck`, which is the order `ci.yml`'s `check` job uses; run
  the same order locally after a clean clone or a `git clean -fdx`, or a
  `db` file importing `@cat-tool/core` fails `TS2307` with nothing at all
  wrong in your code. This failed identically on six consecutive `main`
  merges before anyone ran a truly clean checkout and saw why.
- **`.gitattributes` forces LF on checkout (`* text=auto eol=lf`)**, for
  every text file on every platform, because Windows git defaults
  `core.autocrlf=true` and otherwise rewrites the whole working tree to
  CRLF on checkout — at which point `prettier --check` (its `endOfLine`
  defaults to `"lf"`) flags every file in the repo at once. Found only
  after fixing the build-order gotcha above let the Windows CI job reach
  the format-check step for the first time. The `*.docx binary` rule
  below it is deliberate and order-dependent: last match wins, so the
  fixtures keep their bytes.
- **Invisible or lookalike Unicode characters** (NBSP, curly quotes, thin
  space, soft hyphen — anything `tm-format-spec.md` §4 normalises) go in
  source as explicit `\uXXXX` escapes, never as bare glyphs. A bare glyph
  can be silently re-mangled by an editor, a terminal, or a copy-paste —
  which is exactly how `tm-format-spec.md`'s own normalisation rule list
  once lost its two most common curly-quote entries. Verify a suspect
  file's actual bytes with `[...s].map(c => c.codePointAt(0))` rather
  than trusting what's rendered on screen.
- **`pnpm run <script> -- <args>` forwards the `--` itself.** The script
  sees `['--', ...args]`, so a naive `process.argv.slice(2)` takes `--`
  as its first argument — backlog #27's `create-account` smoke run made
  an account whose email was `--` before anyone noticed. Strip a leading
  `--` in any script that takes positional arguments (`create-account`
  does; `portal-server`'s `create-admin` is documented with the same
  `--` and has the same exposure).
- **A warning that fires once per occurrence, not once per report, is a
  bug even when it's technically correct.** Backlog #18's TMX importer
  first warned per repeated `<prop>` key as soon as it saw one — correct,
  but a real 20k-unit Trados export produced 4,615 near-identical lines,
  which is not a report anyone could act on. Tally across the whole
  import and emit one summary line per distinct cause instead. Any
  per-item warning path needs to be sanity-checked against something
  larger than a hand-built test fixture before it ships, or the failure
  mode only shows up on a real file.
- **`github.base_ref` is empty on `push` events**, and a workflow
  expression that reads it will quietly choose the wrong branch of a
  ternary on every push. Combined with a job-level `if:` that skipped the
  `pull_request` run as a duplicate, this disabled `ci.yml`'s three-OS
  matrix outright: the push run saw no `base_ref` and picked Linux, the
  PR run that would have expanded it never executed, and **three PRs
  merged into `main` having never run on macOS or Windows** — days after
  `check (windows-latest)` had been the only job to catch a Windows-only
  file-locking bug. Key a matrix off `github.event_name` instead, which
  is true on the event carrying it and cannot be disarmed by whether some
  other event ran. The wider lesson is the nastier half: **a skipped job
  still reports a green check**, so CI that silently stopped running looks
  exactly like CI that passed. When a workflow's coverage changes, read
  the job list on a real PR rather than the colour of the summary.
- **A function around an indexed column turns a lookup into a table
  scan, and nothing at test scale shows it.** `retrievePair` matched
  `primary_subtag(s.lang) = primary_subtag(@srcLang)` so region-
  insensitive matching could live in SQL — which also meant the
  `(lang, hash)` index could never seek, and every exact lookup scanned
  all of `tuv`, calling a JS function per row: 161 ms at 100k units,
  1.7 s at 1M (tm-format-spec.md §11). Every unit test was green
  because every unit test had a dozen rows. Read `EXPLAIN QUERY PLAN`
  for any new query on a table that grows with the customer, and look
  for `SCAN` where you expected `SEARCH`. Region-insensitive language
  matching against an indexed `lang` goes through `matchingLangs`
  (`db/lang-match.ts`, backlog #19a), and `query-plan.fixture.ts`
  lets a test assert the plan rather than trusting a green run.
- **A matrix job's real check name is the expanded one.**
  `name: 🚦 roundtrip gate` with a two-OS matrix produces
  `🚦 roundtrip gate (ubuntu-latest)` and `(windows-latest)`; the bare
  string only ever appears on a _skipped_ run. Branch protection asking
  for the bare name would be satisfied by a job that did nothing — worth
  checking the settings against the names GitHub actually reports before
  trusting a required check.

## Fixture corpus

`fixtures/docx/` is real Word documents' structure with synthetic
content — real documents are what actually break a DOCX filter, but
their words, images and links are not ours to publish. Every word, image
and link target was replaced by `scripts/synthesize-fixtures.py`, which
leaves parts, runs, tags and attributes exactly as Word wrote them.
Pseudonymisation alone was tried first and leaked (names, a logo,
photographs, a real URL — `fixtures/docx/README.md` has the story), so
**a new fixture goes through that script before it is committed, never
a hand scrub.** See the same README for per-file provenance and known
quirks (a couple of fixtures fail strict XSD validation _in their
original form_ and are kept that way on purpose — the gate must
preserve them, not repair them).

**TM-format work (TMX, `.ctm`) has no equivalent committed corpus yet.**
Backlog #18 was validated against real Trados exports and native
`.sdltm` files ad hoc, in-session, not against anything checked in —
which is exactly how it found bugs a hand-built fixture never would
(see the gotcha above). Backlog #13a records real reference material
(two more real `.sdltm` files) that should be pseudonymised into
`fixtures/` the way `fixtures/docx/` was, before that item is picked
up — don't assume TM-format code is real-file-tested just because
`core/tm/tmx.test.ts` is green. The same warning applies twice over to
`.sdltm`: `db/tm/sdltm.fixture.ts` builds synthetic databases from a
schema reverse-engineered from _one_ file, so a green
`import-sdltm.test.ts` proves the importer writes correctly given that
belief — never that the belief is right.

**That stopped being hypothetical on 2026-09-18.** The first real
`.sdltm` ever read — a 2013 client memory, thirteen years older
than the file the schema came from — produced three differences before
it produced a single unit: int64 context hashes that `better-sqlite3`
truncates _silently_, a `string_attributes` table with no `id` column,
and seven tables nobody had recorded. Written up in `tm-format-spec.md`
§8a.2.

The transferable lesson is about the fixture, not the format:
**`sdltm.fixture.ts` declared those context columns `TEXT`, and that is
precisely why forty-nine green tests missed the bug.** SQLite's TEXT
affinity converted every synthetic int64 to a string before the reader
saw it, so no test ever handed the code the value that breaks it. A
fixture that is wrong in the same direction as the code proves nothing,
however green it is — which is the failure mode a synthetic corpus has
and a real one does not. When a fixture encodes a belief about someone
else's format, the belief is the thing under test; check it against a
real file before trusting the tests that rest on it.

## Current status

Don't trust this file for "what's done" — that goes stale immediately.

Two places, deliberately split: **open GitHub issues** carry status,
ordering and what's in flight (one per open backlog entry, linked from
that entry); **`planning/v1-backlog.md`** carries the record of what
shipped and why.
Check the issues before assuming what's left, and the backlog before
assuming a decision was never made. Updating a backlog entry's _status_
in markdown is the thing not to do — move the card instead.
