# Prior art

**Status:** rules and a register, opened 2026-10-19 (issue #259)
**Extends:** `competitive-research.md` (which products were studied and why)
**Not a spec.** It decides how outside work may enter this repository and
how its authors are credited. Whether a feature gets built is decided by
its own spec and card.

Tessera is public, so everything here is read by the authors we cite and by
anyone who might copy us. Two questions come up for every project we learn
from: _may we use this_, and _how do we say where it came from_. This file
answers both once, so a card does not have to.

## 1. The rule

**Nothing from outside enters the repo, or the build, until its license has
been read at a pinned commit and its row below says so.** A row with
`unread` in the license column may be studied for ideas (kind A) and for
nothing else.

An idea, a file format and an algorithm described in a paper or a standard
are not the author's to license: we cite the spec or the paper, and credit
a project as courtesy where it taught us something. Code, test data, rule
tables, model weights, icons and prose are copyrighted, and they follow the
license of their source.

## 2. The six kinds of use

| Kind | What enters Tessera                                                 | Credit duty                                                                                                       |
| ---- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A    | An idea. Nothing is copied.                                         | None in law. Cite it in the spec or the card as courtesy.                                                         |
| B    | Our own tests or rules, written fresh after reading theirs.         | None if nothing is copied. If a case or table is copied, the license text and copyright notice.                   |
| C    | A tool that checks our output in CI or by hand and ships nowhere.   | None while it stays out of the image and the release. Name it in the doc that explains the check.                 |
| D    | A comparator run offline, with only numbers committed (`research/`) | Cite name, version and commit in the results file. A model's weights and a dataset carry their own license.       |
| E    | An operations tool run beside the server.                           | Same as C. If the image bundles it, it is distribution: kind F's duty.                                            |
| F    | Code, data or an asset copied, ported or bundled.                   | The license in full, the copyright line, and any `NOTICE`; changes marked for Apache-2.0. Copyleft cannot enter.  |

Kind F is not proposed for any repository below. If a card finds a reason,
it comes back to Louis with the license in hand first, and section 5 says
which licenses can be combined with Tessera's own.

## 3. How a license is checked

- **Production dependencies:** `pnpm licenses:check` (and the test that
  runs it inside `pnpm test`) accepts a permissive allowlist and fails on
  copyleft, weak copyleft, source-available, `UNLICENSED` and an unknown
  license. An exception is a named entry with its reason in
  `scripts/license-policy.mjs`, never a loosened allowlist. Development
  dependencies are not shipped and are not checked.
- **Anything else** (code, data, a model, a validator in CI): read the
  `LICENSE` file at a commit, record the SPDX identifier, the commit and the
  date in the register, then decide the kind. A repository with no license
  file is all rights reserved: study it, copy nothing.
- **Reading a repository's files needs access to it.** A session reaches
  only the repositories added to it (`add_repo`), which is a consent step per
  repository, so the register is filled one source at a time as a card needs
  it, not in bulk.

## 4. How authors are credited

Where the credit goes depends on the kind:

1. **`THIRD-PARTY-NOTICES.md`** at the root lists what is included or
   vendored (kinds B-copied and F): name, version, license, copyright line,
   URL, what we took and where it lives. It is the file a distribution ships
   next to the product.
2. **At the point of use**, the file's doc block carries an
   `SPDX-License-Identifier` and a line "derived from X (license)", beside
   the spec section or backlog entry the module already names.
3. **In the record**: a spec section gets a "Prior art" line, and a backlog
   entry cites the source in its _what it taught_ text, so the reasoning
   stays attached to where it came from.
4. **In research**: a results file pins the commit or version of anything
   it ran and cites it.
5. **For standards**, cite the standard (OASIS XLIFF, TMX, SRX, the Unicode
   rules), not the tool that implements it.
6. **On the website**, an acknowledgements page is optional courtesy. It is
   outward-facing, so it goes on the open "website update" issue and is not
   published by a session.

This is working practice, not legal advice. Counsel should read the notice
wording before a commercial release.

## 5. Tessera's own license

Tessera is licensed under **Apache-2.0** (decided by Louis on 2026-10-19,
issue #261): the text is in `LICENSE`, the notice in `NOTICE`, and
`package.json` declares it. Before that the repository had no license and was
all rights reserved although public.

What it means for what may enter:

- **MIT, BSD, ISC, Apache-2.0 and the other allowlisted permissive licenses**
  can be copied or bundled (kind F) with their notice kept, as section 3 and
  `THIRD-PARTY-NOTICES.md` describe.
- **GPL and AGPL code cannot be combined into Tessera's code**: Apache-2.0 is
  compatible with GPL-3.0 only in the direction of the combined work becoming
  GPL, which Tessera is not, and it is not compatible with GPL-2.0-only at
  all. This is why kind F stays closed for any source that is not permissive.
- **LGPL, MPL and EPL** are not allowlisted. As an unmodified dependency they
  may be acceptable, but that is a decision, recorded as a named entry with
  its reason in `scripts/license-policy.mjs`.
- **The copyright holder is "The Tessera authors"** in `NOTICE`, by Louis's
  decision of 2026-10-19. It is a collective name on purpose: the repository is
  public, so no personal or company name is written into it. Changing it later
  is Louis's call.
- Fixtures are synthetic (see _Fixture corpus_ in `CLAUDE.md`) and are
  covered by the same license.

## 6. The register

`unread` means the license has not been read at a commit by a session: no
claim about it is made here. A read row gives the SPDX identifier and the
short commit it was read at (a shallow clone of the default branch, 2026-10-19). Stars and descriptions are from GitHub search on
2026-10-16 and are context, not evidence of anything else.

| Repository                                                                                   | Studied for                                                          | License | Kind | Taken                      | Credit                  |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------- | ---- | -------------------------- | ----------------------- |
| [maxprograms-com/Swordfish](https://github.com/maxprograms-com/Swordfish)                    | Open-standards CAT tool: project and TM model                        | unread  | A    | nothing                    | courtesy                |
| [maxprograms-com/OpenXLIFF](https://github.com/maxprograms-com/OpenXLIFF)                    | XLIFF 1.2 to 2.2 validation, as a check on an XLIFF export           | EPL-1.0 @ 1d24db7 | C    | nothing                    | if the check is added   |
| [microsoft/XLIFF2-Object-Model](https://github.com/microsoft/XLIFF2-Object-Model)            | Typed XLIFF 2 model, as a reference for tokens and tags              | unread  | A    | nothing                    | courtesy                |
| [vslavik/poedit](https://github.com/vslavik/poedit)                                          | Translator-editor UX                                                 | unread  | A    | nothing                    | courtesy                |
| [mozilla/pontoon](https://github.com/mozilla/pontoon)                                        | Review roles, terminology, contribution record                       | unread  | A    | nothing                    | courtesy                |
| [tolgee/tolgee-platform](https://github.com/tolgee/tolgee-platform)                          | In-context translation, TM with MT fallback, API shape               | unread  | A    | nothing                    | courtesy                |
| [lingodotdev/lingo.dev](https://github.com/lingodotdev/lingo.dev)                            | Glossary and brand-voice context for AI drafts                       | unread  | A    | nothing                    | courtesy                |
| [box/mojito](https://github.com/box/mojito)                                                  | Continuous localization with TM leverage                             | unread  | A    | nothing                    | courtesy                |
| [hint-lab/deeptrans-studio](https://github.com/hint-lab/deeptrans-studio)                    | Nearest AI-native competitor: QA and workflow                        | unread  | A    | nothing                    | courtesy                |
| [Supervertaler/Supervertaler-for-Trados](https://github.com/Supervertaler/Supervertaler-for-Trados) | AI in a CAT tool, MCP over a live session, SQLite knowledge base | unread  | A    | nothing                    | courtesy                |
| [segment-any-text/wtpsplit](https://github.com/segment-any-text/wtpsplit)                    | Neural sentence segmentation as a benchmark against our rules        | MIT @ 3ef928c | D    | nothing                    | results file, if run    |
| [nipunsadvilkar/pySBD](https://github.com/nipunsadvilkar/pySBD)                              | Per-language "golden rules" test categories                          | MIT @ 5905f13 | B    | category idea only, no cases | cited in `segmentation-spec.md` section 9; nothing copied |
| [diasks2/pragmatic_segmenter](https://github.com/diasks2/pragmatic_segmenter)                | Origin of those golden rules; abbreviation handling                  | MIT @ 358fe97 | B    | category idea only, no cases | cited in `segmentation-spec.md` section 9; nothing copied |
| [dotnet/Open-XML-SDK](https://github.com/dotnet/Open-XML-SDK)                                | Differential OOXML validation of exports, beside the roundtrip gate  | MIT @ 431ab05 | C    | nothing                    | `scripts/ooxml-validate` (NuGet `DocumentFormat.OpenXml` 3.3.0, dev tool only) |
| [plutext/docx4j](https://github.com/plutext/docx4j)                                          | Real-world Word quirks, as a reading reference                       | unread  | A    | nothing                    | courtesy                |
| [vlcn-io/cr-sqlite](https://github.com/vlcn-io/cr-sqlite)                                    | CRDT merge, compared with the `mergeTm` winner rule                  | unread  | A    | nothing                    | courtesy                |
| [benbjohnson/litestream](https://github.com/benbjohnson/litestream)                          | Continuous SQLite backup, against the migration runner's own backup  | unread  | E    | nothing                    | if adopted              |
| [simonw/datasette](https://github.com/simonw/datasette)                                      | Read-only inspection of a SQLite file, against `openReadOnly`        | unread  | A    | nothing                    | courtesy                |
| [DRYTRIX/TimeTracker](https://github.com/DRYTRIX/TimeTracker)                                | Peppol e-invoicing with time-based billing, for Epic 13              | unread  | A    | nothing                    | courtesy                |
| [meteroid-oss/meteroid](https://github.com/meteroid-oss/meteroid)                            | Usage-based billing model, for v4 (Ring 3)                           | unread  | A    | nothing                    | courtesy                |

Read on 2026-10-19 (each `LICENSE` file opened at the commit in its row):

- **Open-XML-SDK, pySBD, pragmatic_segmenter and wtpsplit are MIT**, with the
  copyright lines ".NET Foundation and Contributors", "Nipun Sadvilkar" (2019),
  "Kevin S. Dias" (2015) and "Benjamin Minixhofer, Markus Frohmann, Igor
  Sterner" (2024). MIT is on the allowlist, so a copy of code or data from any
  of them (kind F) would be permitted with its notice kept in
  `THIRD-PARTY-NOTICES.md`. None is proposed.
- **OpenXLIFF is EPL-1.0**, a weak-copyleft license and not on the allowlist.
  It stays kind C: invoked unmodified as a validator, never copied, ported,
  linked into Tessera or bundled in the image. A card that wants more than
  that comes back to Louis first. Its `licenses/` directory lists the licenses
  of the components it bundles; they were not read.
- **wtpsplit's model weights** (downloaded from a model hub) carry their own
  license, which was not read; the benchmark card must read it before any
  weights are downloaded.
- Open-XML-SDK's own `NOTICE` lists third-party material it incorporates
  (StyleCopAnalyzers is the first entry). That matters only if its source were
  copied, which is not proposed.

Weblate, Okapi, translate-toolkit, Matecat, RapidFuzz and Svix were named in
the same sweep but their search failed, so they have no row: add one when a
card first reads them.

## 7. Cards that follow, each gated on its source's row

- ~~Differential OOXML validation of exports~~ (built, issue #265, `v1-spec.md`
  §3.7: the Open XML SDK runs as a CI-only .NET tool, kind C, MIT, nothing
  copied and nothing shipped; the Rust/Wasm question was asked and the answer
  was to stay in TypeScript).
- ~~A segmentation golden-rules corpus written by us~~ (built, issue #267,
  `segmentation-spec.md` section 9: 127 cases in nine languages, none copied;
  the 16 gaps it found are issues #268 to #274).
- A wtpsplit benchmark under `research/`, hypothesis committed before the
  run (`research/` protocol; numbers only; the row first).
- Design notes on #152, #148, #174 and #171 from the kind A projects: a
  comment on each card, no code.
