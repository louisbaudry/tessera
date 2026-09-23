# cat-tool

Working name. An AI-native, cross-platform CAT tool and translation-business
platform for professional translators, translation-service providers, and
their clients.

**v1 ("Ring 0")** is a personal Trados substitute — no AI yet, deliberately:
import DOCX, segment, apply a translation memory, run QA, export DOCX. See
[`planning/v1-spec.md`](planning/v1-spec.md) for scope and
[`planning/v1-backlog.md`](planning/v1-backlog.md) for the issue list. Once
that's solid, AI-assisted translation and the rest of the business —
quoting, vendor management, client communication, invoicing — get built
outward from it. See [`planning/ai-platform-vision.md`](planning/ai-platform-vision.md)
for the whole roadmap and why it's sequenced that way.

Ships as a web service (a Node/TypeScript API server plus a React SPA),
not an installed desktop app — see `v1-spec.md` §2 for the reasoning.

**Contributing, including with an AI coding agent?** Read
[`CLAUDE.md`](CLAUDE.md) first — conventions, the working rhythm, and
invariants that aren't obvious from the code alone. `AGENTS.md` is a
pointer to the same file for tools that look for that name specifically;
there is only ever one copy of this guidance.

## Layout

```
packages/
  core/        @cat-tool/core   pure TS — no Electron, no DOM, no HTTP
    model/     tokens, tags, segments, QA types
    docx/      DOCX filter: package I/O, skeleton, tokenize, render
    segment/   sentence segmentation, custom profiles, SRX, Trados lists, manual split/merge
    tm/        Token<->TmToken mapping; TMX import/export and native .sdltm parsing, normalisation, context; exact matcher + pre-translate
    glossary/  termKey — the one definition of "the same term" across core and db
    project/   assembleFile — DOCX import -> persistable file + segments; exportProjectFile — the inverse, segments folded back into DOCX
    qa/        QA rule engine — all thirteen v1-spec.md §6.4 rules, locale tables, numeral matching
  db/          @cat-tool/db     versioned SQLite migration runner; project, platform, .ctm TM, and .ctg glossary schemas; typed repositories over all; TMX import/export and .sdltm import
  cli/         @cat-tool/cli    headless driver — init, add-file, add-tm, pretranslate, qa, export (v1-spec.md §2.4)
  server/      @cat-tool/server Fastify API — login, accounts, projects, file import (v1-spec.md §2.5)
  web/         @cat-tool/web    React SPA                            (not started)
  portal-core/ @cat-tool/portal-core   pure TS — pricing, order lifecycle, notification/production-adapter interfaces for the client-facing translation portal (planning/portal-v0-spec.md)
  portal-server/ @cat-tool/portal-server Fastify API + minimal static UI for the translation portal (client intake/approval, admin order management, SMTP email notifications)
planning/      specs and backlog
fixtures/      real-world DOCX structure with synthetic content (docx/), used by every gate test; the golden end-to-end job's memory and transcript (golden/)
site/          public landing page, deployed to GitHub Pages
scripts/       fixture synthesis (synthesize-fixtures.py)
```

(Two directories share the name `tm/` for two different things: `core/tm/`
is pure logic with no SQLite — `toTmTokens`/`remapTmTokens` (token
mapping), `normalizeText`/`hashOf`/`normalizeTokens` (normalisation +
hashing, `NORMALIZER_VERSION`), `documentContext`/`sourceDocumentContext`
(context capture — a segment's `prev_hash`/`next_hash` neighbours, skipping
locked segments on both sides), `confirmedTargetContext` (the same
neighbour-chain, but over already-confirmed siblings' target hashes,
plus the segment currently being confirmed — backlog #20), `parseTmx`/
`serializeTmx` (TMX 1.4b parsing and its inverse — a `.ctm` export shape
into TMX text — no DB in either, backlog #18/#21), `placeMatch` (the
pre-translate placement decision — remap a match's tags by `(kind,
order)`, or fall back to its plain text when they don't correspond),
and `parseSdltm`/`parseSdltmSegment`/`sdltmSegmentToTokens` (native
Trados `.sdltm` SQLite parsing) exist. `db/tm/` is the `.ctm` file's
own SQLite schema plus pair retrieval, both importers, TMX export, and
write-back — `createTm`/`openTm`, `importTmx` (writes a parsed TMX
document in as one transaction), `importSdltm` (the same for a native
Trados memory, opening it read-only and turning each bilingual row into
one language-neutral `tu` with a `tuv` per language), `exportTmx(db,
options?)` (the reverse of `importTmx` — every non-tombstoned unit,
current revision only, with an optional language filter),
`retrievePair(db, params, options?)` (both directions and, via
`options.schema`, an `ATTACH`ed TM's alias), and `writeBack(db, params,
options?)` (upserts a source + target `tuv` pair together, keyed on the
source's `(lang, hash)`, never lowering an existing quality — backlog
#20) — which exist. `refreshLangs` lives with `writeBack` and every
importer calls it; spec §6's quality table is `schema.ts`'s `QUALITY`,
read by write-back, import, and export alike; import-only decisions
live in `db/tm/import-common.ts`.
`core/glossary/` is `termKey`, the case-folded matching rule glossary
lookups share across `core` and `db`; `db/glossary/` is the `.ctg`
format below.)

`db/project/` mirrors this split: `assembleFile` (`core/project/`) turns
a DOCX into data; `db/project/{project,files,segments,tm-refs,qa-issues,
pretranslate,confirm}.ts` persist it and act on it — `insertFile` writes
a `file` row and every `segment` row it assembles into as one
transaction, `attachTms` brings every enabled `.ctm` onto the connection
under a stable alias, `pretranslate(db, {fileId?})` is what actually
queries across them: an exact-hash TM hit in `tm_ref` priority order,
falling back to internal propagation from an already-confirmed sibling
segment sharing the same source hash — v1-spec.md §6.1, backlog #19 —
and `confirmSegment(db, segmentId, options?)` writes a confirmed
segment's source and target into the enabled write-target `.ctm` and
flips its status to `confirmed`, both as one transaction —
v1-spec.md §6.2, backlog #20.

`db/glossary/` is the `.ctg` glossary format (`planning/smart-glossary-spec.md`
§3) — the `.ctm` shape with the vocabulary changed: a language-neutral
`term` with one `term_variant` per language, plus an append-only
`term_decision` log (schema triggers refuse `UPDATE`/`DELETE` on it) that
the current preferred rendering is _derived_ from, never stored.
`createGlossary`/`openGlossary` mirror `createTm`/`openTm`. A project
attaches `.ctg` files the same way it attaches `.ctm` files —
`db/project/glossary-refs.ts`, sharing the `ATTACH`/`DETACH` mechanism
in `attached-refs.ts` with `tm-refs.ts` — so a client glossary layered
over a base glossary is priority resolution, not a new concept.

`core` stays headless and dependency-light — no Electron, no DOM, no HTTP.
Every filter, segmenter, matcher and QA rule must be testable without a UI
or a server in the loop. That's what made the DOCX tag roundtrip provable
before any editor existed, and what made a later pivot from a desktop
shell to a web service cost nothing: `core` never knew which one called it.

## Development

Requires Node 22+ and pnpm 10+.

```sh
pnpm install
pnpm test        # vitest, excludes the roundtrip gate
pnpm test:gate   # the roundtrip gate — byte-identical DOCX import/export
pnpm test:golden # the golden end-to-end job — a real DOCX and TMX through every CLI command, against a committed transcript
pnpm test:all    # everything
pnpm typecheck   # includes test files — vitest only transpiles
pnpm lint
pnpm build
```

A whole job runs headless through the CLI once `pnpm build` has run:

```sh
pnpm cat-tool init job.catdb --src en --tgt fr
pnpm cat-tool add-file job.catdb client/brief.docx
pnpm cat-tool add-tm job.catdb client/memory.tmx        # imported into client/memory.ctm, then attached
pnpm cat-tool add-tm job.catdb job.ctm --write-target   # created empty if missing
pnpm cat-tool pretranslate job.catdb
pnpm cat-tool qa job.catdb                              # exit 1 while a blocking issue remains
pnpm cat-tool export job.catdb --out delivery/
```

The API server (`v1-spec.md` §2.5) keeps `platform.sqlite` and a storage
volume under `./data` by default; a deployment overrides `CAT_PORT`,
`CAT_DB_PATH` and `CAT_STORAGE_ROOT`:

```sh
pnpm --filter @cat-tool/server run create-account -- you@example.com <password>   # once per deployment
pnpm --filter @cat-tool/server start                                               # http://localhost:3400 — POST /api/login first
```

CI runs install/build/typecheck/lint/format/test on Windows, macOS and
Linux — build before typecheck, because `packages/db` resolves
`@cat-tool/core`'s types through `core`'s built `dist/`, which a fresh
checkout doesn't have — plus a separate roundtrip-gate job on Linux and
Windows, and the golden end-to-end job on Linux. `.gitattributes` forces LF on checkout on every platform, so
Windows's `prettier --check` sees the same line endings Linux and macOS do.

All three platforms run on **pull requests into `main` and on `main`
itself**; a feature-branch push with no PR open yet runs Linux only, for
fast feedback at a fraction of the cost, and picks up the other two the
moment a PR exists. The roundtrip gate runs on those same two paths into
`main`. Scoping like this is worth stating precisely rather than loosely,
because it was wrong once: an expression reading `github.base_ref` (empty
on `push`) silently reduced every PR to Linux alone while still showing a
full row of green checks — see CLAUDE.md's gotcha list.

## Key documents

| Document                                                                   | What it covers                                                                                                                      |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [`planning/v1-spec.md`](planning/v1-spec.md)                               | v1 ("Ring 0") scope, DOCX filter design, data model, segmentation, matching, QA                                                     |
| [`planning/tm-format-spec.md`](planning/tm-format-spec.md)                 | The `.ctm` translation memory format — authoritative                                                                                |
| [`planning/segmentation-spec.md`](planning/segmentation-spec.md)           | Custom segmentation: editable profiles, SRX, Trados resource lists                                                                  |
| [`planning/ai-platform-vision.md`](planning/ai-platform-vision.md)         | The roadmap beyond v1 — AI-assisted translation, vendor management, client-facing tools, and why they're sequenced the way they are |
| [`planning/v1-backlog.md`](planning/v1-backlog.md)                         | Sequenced issue list, Ring 0 through Ring 3                                                                                         |
| [`planning/portal-v0-spec.md`](planning/portal-v0-spec.md)                 | Translation Portal v0 (Epic 10a) — order lifecycle, pricing, notifications, auth                                                    |
| [`planning/smart-glossary-spec.md`](planning/smart-glossary-spec.md)       | Smart glossary (Epic 8a) — the `.ctg` format, detection/flagging pipeline, session state machine                                    |
| [`planning/multi-session-workflow.md`](planning/multi-session-workflow.md) | The phased, one-phase-per-session pattern large backlog items (TMX/`.sdltm` import, exact matching) are built with across sessions  |

## Decisions worth knowing before contributing

- **The DOCX roundtrip gate (backlog #8) blocks all UI work.** Import →
  export with zero edits must reproduce the file, byte for byte, across a
  corpus of real client documents. If that cannot hold, the approach needs
  rethinking. Mark `🚦 roundtrip gate` as a required status check on `main`.
- **The TM format is versioned and specified.** It accumulates years of
  irreplaceable user work. Do not change the schema, the normalisation
  rules, or `application_id` without reading
  [`planning/tm-format-spec.md`](planning/tm-format-spec.md) §4 and §9. The
  versioned migration runner in `@cat-tool/db` (`migrate.ts`) is shared by
  every SQLite file this product writes — extend it there, not per-schema.
- **Bulk TM/DB operations must run off the request-handling thread.**
  `better-sqlite3` is synchronous; a large import inline would stall
  whatever else the server is doing for other requests.
- **v1 stays AI-free on purpose.** AI-assisted translation is a deliberate
  second phase (`ai-platform-vision.md` §3), designed only once the plain
  editor is solid — bolting AI onto an unfinished editor is exactly the
  failure mode it's built to avoid.
- **An interop format isn't done until a real vendor export has been run
  through it.** Backlog #18 (TMX import) passed its hand-built test suite
  cleanly, then found two real bugs (silent data loss on a repeated
  `<prop>` key, an unmapped `usagecount`/`lastusagedate` field) the moment
  a real 20k-unit Trados export went through it. `fixtures/docx/` gets
  this for free from real client files; TM-format work doesn't have an
  equivalent committed corpus yet (backlog #13a notes this gap directly)
  — until it does, treat a hand-built fixture as a starting point, not a
  sign-off. `.sdltm` import (#18b) is the standing example: parser,
  importer and 49 tests are all built and green against a schema
  reverse-engineered from _one_ file, and the item was closed without a
  real memory ever going through it — so treat that path as unproven
  against real input until someone does.
- **A column with a frozen contract never receives a value computed some
  other way.** `prev_hash`/`next_hash` mean "SHA-256 of the normalised
  neighbouring segment" (`tm-format-spec.md` §4, §5) and nothing else. A
  Trados `.sdltm` carries its own per-occurrence context hashes, and
  putting them there would have been indistinguishable at read time from
  real ones — so they are carried as `tu_attr` provenance instead, intact,
  and every import says plainly that no `.sdltm`-sourced unit can be an
  ICE match. See `tm-format-spec.md` §8a.1: the context data is also
  _left_-only, so the ICE tier could never be satisfied from it anyway.
- **A glossary is a `.ctg` file, not a table in the portal database.**
  `portal.sqlite` is declared "never translation content"; a glossary is.
  See `planning/smart-glossary-spec.md` §2.1 before routing glossary data
  anywhere else.
