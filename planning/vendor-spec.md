# Vendor Component — spec (draft)

Status: draft, decisions recorded from a scoping conversation on
2026-09-21 — not yet broken into issues. This is Epic 9
(`v1-backlog.md`, Ring 1: "Language Provider tools") getting its first
real design pass, the way `segmentation-spec.md` and
`portal-v0-spec.md` were written before their epics started.

Extends: `v1-spec.md`, `ai-platform-vision.md` §2–3, `portal-v0-spec.md`.

## 0. Why this is heavy, and why it's a separate component

A vendor is a translator. Not a business record referenced by a job —
the same person who opens the segment editor and does the work. That
single fact is why this can't be modelled as a CRM-style profile bolted
onto the portal: it needs a real, authenticated seat inside
`@cat-tool/server`, with real authorization into `core`/`db/project`,
not a portal-style access token that only ever sees a submission form.

This is written from direct experience in all three roles this product
models — owner, vendor, and translator — specifically because the
tooling available to a vendor today (across every tool tried) has been
poor. Vendor v1 is scoped to fix that experience first (see §7), not to
build a matching/marketplace engine first.

## 1. Decisions already made (2026-09-21)

Recorded here so the reasoning survives past this conversation, the same
way `ai-platform-vision.md` §5 records its own deferred-scope decisions.

1. **A vendor is a first-class account**, not a separate identity system.
   Vendors log into the same `@cat-tool/server` as owners/PMs and use the
   real segment editor — not a lighter, vendor-specific editing surface.
   Rejected alternative: a portal-style admin/client split (own login,
   own limited UI). That would mean building and maintaining a second
   editing surface, which duplicates work `core`/`db/project` already
   does for the owner-facing editor.
2. **One `account` table, a role, and a project-scoped authorization
   table** — not a separate `vendor_account` table. `account.role`
   distinguishes owner/PM from vendor; `project_authorization`
   (`account_id`, `project_id`, `scope`) is what actually gates access,
   independent of role. This is deliberate: an owner can also be a
   vendor on their own projects (true of this product's real triangle —
   Louis is both), so "vendor" is a scope a project grants an account,
   not a fixed identity an account has.
3. **Vendor business data lives in its own SQLite file** (working
   extension `.ctv`), through the shared migration runner
   (`packages/db/src/migrate.ts`), not as tables in `platform.sqlite`
   or `portal.sqlite`. Same reasoning as the `.ctg` decision recorded in
   `CLAUDE.md`: `platform.sqlite` is accounts/sessions, `portal.sqlite`
   is client-order business data, and vendor rates/capacity/performance
   is neither — a third thing gets a third file, not a column stuffed
   into one of the other two.
4. **Storage stays SQLite for now.** A move to Postgres/MySQL was raised
   during scoping but is a platform-wide decision (it would touch
   `.ctm`/`.ctg` portability, the migration runner, and `ATTACH`-based
   cross-file queries — several standing invariants in `CLAUDE.md`), not
   a Vendor-scoped one. It is **out of scope for this document** —
   tracked separately in `planning/storage-architecture.md` (§0 there).
   Vendor's `.ctv` schema is designed to be one bounded, portable schema
   specifically so that a later RDBMS migration (if it happens) can take
   it as a self-contained unit rather than untangling it from
   `platform.sqlite`.
5. **New packages**: `packages/vendor-core` (headless domain logic,
   same discipline as `core`/`portal-core` — no DB, no HTTP, no
   Electron/DOM) and `packages/vendor-server` (or, if the surface turns
   out small, routes added directly to `@cat-tool/server` — see §6)
   for the vendor- and PM-facing HTTP surface. `.ctv` schema and
   repositories live in `packages/db/src/vendor/`, alongside
   `db/tm`, `db/glossary`, `db/portal`.
6. **v1 ships manual assignment, through two offer channels: direct and
   pool.** A PM can push an offer straight to one named vendor, or post
   a job open to a set of eligible vendors who see it in a shared pool
   and claim it first-come. Both are still manual — no scoring or
   recommendation picks the vendor in either path (see decision 11).
   Matching/scoring (which vendor best fits a job — language pair,
   specialty, capacity, past QA performance) stays real, designed-for
   work but deferred to Ring 1's "AI-assisted quoting and project setup"
   per `ai-platform-vision.md` §3 and `v1-backlog.md`'s Epic 9
   placeholder — not pulled into v1 just because the data model will
   eventually need to support it.
7. **Landing screen is a single job feed**: offered jobs needing a
   response at the top, active (in-progress) jobs below, recently
   delivered further down. One place answering "what do I have and
   what's new" — not a separate capacity/calendar view or a multi-panel
   dashboard.
8. **Capacity/availability is a vendor-set status toggle**
   (available / busy / away) plus a free-text note, not a maintained
   words-per-day number or a blocked-dates calendar. A number the
   vendor has to keep accurate goes stale; a status they flip themselves
   doesn't. A real capacity number can layer on top later once there's
   real data to calibrate it against — this is deliberately the cheap,
   honest version first.
9. **Rates are tiered by TM match category** (no-match / fuzzy bands /
   100% / ICE — repetitions and exact matches), not a single flat
   per-word rate and not a per-job negotiated figure. This is the
   real-world standard for how translation work is paid, matches your
   own experience being paid this way, and is why a running payable
   total is worth building at all: it has to read match tier off the
   same TM retrieval `core`'s `retrievePair` already computes
   (`db/tm/retrieve.ts`), not a flat word count. `db/vendor`'s
   assignment/payable calculation depends on `db/tm`'s retrieval output
   — a real cross-package dependency to design for explicitly, not an
   accident of two packages happening to both touch match data.
10. **Payable amount is visible in three stages, reconciled as
    follows**: at offer time the vendor sees their rate card and the
    job's match-tier word breakdown (so they can judge the job, not a
    single precomputed total — see decision 11, the offer screen
    deliberately doesn't show one aggregate number); once work starts,
    a running total is computed live inside the editor from
    tier-weighted word count × rate as segments are confirmed; at
    delivery, that total locks as the final payable amount. No stage
    where the vendor doesn't know what they're being paid, which is the
    point (see decision 11).
11. **The top vendor-experience pain point to fix in v1: jobs offered
    with no context.** From direct experience, being asked to accept a
    job before seeing the deadline, the source material, or the PM's
    instructions is the single worst part of existing tooling. An
    offer — whether pushed directly or posted to the pool — must carry,
    before accept/decline: deadline, estimated word/segment count,
    a source-material preview, the applicable TM/glossary match-tier
    breakdown (decision 9's rate tiers, so the vendor can judge pay and
    effort together), and any PM instructions/notes specific to the job
    (style, terminology, client preferences) — the free-text brief that
    would otherwise arrive by separate email, possibly after
    acceptance. See §7.

## 2. Package responsibilities

Following the `core`/`db`/HTTP split already established for every other
epic in this repo (QA engine, smart glossary, portal):

- **`vendor-core`** — pure TS, no I/O. Vendor profile shape (languages,
  specialties, rate card, capacity/availability); the assignment
  lifecycle state machine (§4); rate/payable calculation (distinct from
  `portal-core`'s client-facing `pricing.ts`, though the two may share
  primitives — worth checking once both exist rather than assuming);
  authorization-scope helpers (what `project_authorization.scope`
  values mean and what they permit). Testable with no DB or server in
  the loop, same rule as `core` and `portal-core`.
- **`db/vendor`** (inside `packages/db`) — `.ctv` schema and versioning
  through the shared migration runner; repositories for vendor profiles,
  rate history, assignment records, performance history. Also owns the
  `account`/`project_authorization` reads and writes that live in
  `platform.sqlite` (account role is identity, not vendor business data,
  so it stays in the existing accounts file — see decision 3 above for
  why the split is at "business data" rather than "everything
  vendor-related").
- **`vendor-server`** (or routes on `@cat-tool/server` — see §6) — one
  repository call per route, the same rule `CLAUDE.md` states for the
  CLI and the API server. Two audiences: PM-facing routes (manage
  vendor profiles, assign jobs, review performance) and vendor-facing
  routes (see offered/active jobs, accept/decline, view rates and
  earnings — the vendor's own dashboard, distinct from the segment
  editor itself, which is `@cat-tool/server`'s existing surface).
- **`@cat-tool/server`** — unchanged in shape, extended in
  authorization: a vendor account opening a project's segment editor is
  authorized via `project_authorization`, the same way an owner account
  is today. No new editing surface.

## 3. Open questions (not yet decided)

- ~~Exact `project_authorization.scope` values~~ — decided in backlog `#45`,
  see the implementation note after this list: `assigned_translator` is
  the only scope in v1, a reviewer/proofreader scope is Ring 1.
- ~~Whether `vendor-server` is its own deployable service or a route module
  mounted into `@cat-tool/server`~~ — decided in backlog `#48`: routes on
  `@cat-tool/server`, see the §4 implementation note (#48) below.
- ~~Whether `.ctv` is per-account or a single shop-wide file~~ — decided in
  backlog `#46`, see the implementation note after the §5 field list: one
  per **owner** account.

**Implementation note (#45), written before the code (2026-10-03).**
What `#45` settled that decision 2 left open:

- **A project is named by its owner and its slug, and there is no project
  table.** `ProjectRef` (`db/platform/audit.ts`) is already the platform's
  name for one: the owner's account id and the slug, the two coordinates
  its path is built from. `project_authorization` is therefore
  `(account_id, owner_id, project_name, scope)`, not `(account_id,
  project_id, scope)`: a registry of projects would be a second record of a
  fact the filesystem and the audit log already agree on.
- **`owner` is not a scope and has no row.** An owner's access is that the
  project is in their own storage root; a row saying so would be a second
  source of truth that could disagree with the path. The table holds only
  what an owner has granted to someone else. A grantee is never the owner
  (`CHECK (account_id <> owner_id)`).
- **`assigned_translator` is the only scope in v1.** A reviewer or
  proofreader scope is Ring 1, and when it exists it is a migration that
  widens the `CHECK` with `rebuildTable` (nothing references this table).
  What a scope permits is `core/auth/authorization.ts`, three actions:
  `read` (the project, its files, segments and QA findings), `edit` (save,
  confirm, split, merge, dismiss a finding) and `manage` (everything
  else: settings, memories, glossaries, files, export, pre-translate,
  delete). `assigned_translator` may `read` and `edit`; the owner may do
  all three. Export is the owner's: a file leaving the system is audited
  against the person who sends it, and a translator delivers through the
  assignment (§4), not by downloading.
- **`role` classifies; it never permits.** `account.role` is `owner` (the
  default: owner or PM) or `vendor`, and gates nothing: decision 2 says
  `project_authorization` is what gates, independent of role, and an owner
  can be a vendor on someone else's project. The role is for the vendor
  features that list or offer work (`#46` onward), which need to know who
  is a vendor without reading every grant. The core constants are
  `ACCOUNT_ROLES` and `PROJECT_SCOPES`, each a frozen literal in the
  migration (backlog `#64`).
- **Where the helpers live.** §2 puts "authorization-scope helpers" in
  `vendor-core`, which does not exist until `#47`. They are in
  `core/auth/` instead, next to the credentials: what an account may do to
  a project is about accounts, not vendor business, and the server needs it
  now. If `vendor-core` wants them, moving a pure module is cheap.
- **A project is addressed by `?owner=<account id>`** on the project
  routes, defaulting to the session's own account. A vendor may be on two
  owners' projects with the same slug, so the slug alone cannot name one.
  The route resolves the project from the owner named, then asks the table;
  **no row is a 404, never a 403** (another account's project is "no such
  project", whether or not it exists), and a row whose scope does not allow
  the action is a 403, since the project is theirs to know about. Every
  call site of the opener names the action it needs, so adding a route
  without deciding is a type error.
- **Only the editor routes are reachable by a grantee.** Project detail,
  file segments and QA findings (`read`); saving a target, confirming,
  splitting, merging and dismissing a finding (`edit`). The glossary panel,
  memories, pre-translate and export stay `manage`, owner-only, until a
  card says otherwise.
- **A grantee's edits land in the owner's project, under the grantee's
  actor.** `account:<id>` with their email as label, in the project's own
  log (audit-spec §2.5), so the log says who wrote each target. A confirmed
  segment writes to the project's write-target memory as the owner has set
  it: whether a vendor's unreviewed work should reach a memory is the
  review gate's question (`#51`), not this card's.
- **Grants are audited, and deleting a project revokes them.**
  `authorization.granted` / `.revoked` (already in the platform vocabulary)
  are written in the transaction of the row, subject the project, detail
  `{ grantee, scope }` (an account id is installation-local, not personal,
  audit-spec §2.5). A grant outliving its project would hand a deleted
  project's name, and so its next owner's work, to whoever held it:
  deleting a project revokes every grant on it in the same transaction.
- **No route grants yet.** Granting and revoking are `db` functions; the
  PM-facing route that calls them is `#51`. Until then the table is
  written only by tests, and the enforcement is what this card proves.

## 4. Assignment lifecycle

An `assignment_event`-style append-only history, same pattern as
`portal-v0-spec.md` §2's `order_event`, but with a required actor and
append-only triggers from its first migration (`planning/audit-spec.md`
§8.2): every transition is a row, legal
transitions enforced in `vendor-core` (`transitionAssignment` or
equivalent), not scattered across routes. This is what the job-feed
screens in §7 read from, and — same reasoning as `order_event` — the
hook a future notification-on-every-transition feature needs without a
schema change.

```
                    +-> declined (terminal)
                    |
pool_open -> claimed --> accepted -> in_progress -> delivered -> reviewed
    ^            |            |
    |            +-> declined |
    |                         |
offered -----------------------
    |
    +-> declined (terminal)
```

- `offered`: PM pushed this job to one named vendor (decision 6, direct
  channel). Only that vendor can act on it.
- `pool_open`: PM posted this job to the set of eligible vendors
  (decision 6, pool channel). Any of them can claim it; claiming removes
  it from the others' feeds.
- `claimed`: a vendor claimed a pool job but hasn't yet accepted — kept
  as a distinct state from `accepted` in case claim and accept end up
  needing to be separate steps (e.g. a claim window); collapse the two
  if that distinction turns out not to matter once this is built.
- `accepted` / `declined`: vendor's response to an `offered` or claimed
  `pool_open` job. `declined` is terminal — for a pool job, it does not
  reopen `pool_open` for that vendor but leaves it open for the rest.
- `in_progress`: vendor is working in the segment editor. This is where
  the running payable total (decision 10) is live.
- `delivered`: vendor has finished; payable amount locks (decision 10).
- `reviewed`: terminal. PM (or a reviewer scope, per §3's open question)
  has signed off. What "reviewed" requires — QA gate, PM read, both — is
  not yet decided; the QA engine's `isBlocking` (`core/model/qa.ts`) is
  the likely dependency, same "one definition of must-not-ship" rule
  the CLI's `qa` command already follows.

Not yet decided: whether a `declined` or missed-deadline `offered` job
auto-converts to `pool_open` (so a direct offer that falls through
doesn't require the PM to manually re-post it), or whether that's a
deliberate PM decision every time. Revisit once real usage shows which
is more common.

**Implementation note (#47), written before the code (2026-10-03).** The
diagram above leaves four edges to be read off its prose; reading them
once, here, is what `vendor-core/src/assignment.ts` encodes:

- **One state machine per assignment, and an assignment is one job with at
  most one vendor.** A direct offer is born `offered` (one named vendor); a
  pool post is born `pool_open` (no vendor yet). `initialStatus(channel)` is
  the only way in; nothing transitions *into* `offered` or `pool_open`.
- **The legal edges:** `offered → accepted | declined`; `pool_open →
  claimed`; `claimed → accepted | declined`; `accepted → in_progress →
  delivered → reviewed`. `declined` and `reviewed` are terminal. That is
  the whole table; `offered → delivered`, or any move back, throws.
- **A declined claim does not reopen the assignment.** §4's "leaves it open
  for the rest" is about the *job*, not the row: claiming takes the row out
  of the others' feeds (decision 6), so the row has a vendor and is no
  longer pool-open. The rest get a **new `pool_open` assignment** that
  excludes the decliner, which is the repository's act at creation
  (`#48`), not a transition. Keeping this out of the machine is what keeps
  `declined` terminal and the history of each vendor's answer intact.
- **Each edge names who makes it.** `vendor` for every move up to and
  including `delivered`, `pm` for `delivered → reviewed`. The function
  takes the party (`pm` | `vendor`) and a vendor cannot review, nor a PM
  accept on a vendor's behalf: that is a different error from an illegal
  edge, because a route answers one with 403 and the other with 409. It
  is only the *kind* of party: that the vendor is the one named on an offer,
  or the PM is the project's, is the repository's check (`#48`), as the
  portal's `assertCanApprove` leaves "is it this client's order" to its
  route.
- **`reviewed` is reachable and ungated.** What it requires (a QA gate via
  `isBlocking`, a PM read, both) is `#51`'s decision; this card ships the
  state and the edge, as the issue asked, with the gate to be added as a
  precondition beside `transitionAssignment`, never inside it.
- **Not in the machine, because §4 does not decide them:** a PM
  withdrawing an offer or pool post (no `cancelled` state), a missed
  deadline, and a failed direct offer becoming `pool_open`. Each, when
  decided, is a new status (a migration that widens the `CHECK` with
  `rebuildTable`, since `ASSIGNMENT_STATUSES` is frozen into it like every
  closed set) and a row in the table.

**Implementation note (#48), written before the code (2026-10-03).** What
`#48` settled that §4 and §7 left open:

- **An assignment is one job for one project, and lives in the owner's
  `.ctv`.** `assignment` holds the project's slug (the owner is the file's),
  the channel, the status, the vendor (null only while `pool_open`: a
  `CHECK` says so), an optional deadline and the PM's instructions. Scope
  is the whole project, not a file; per-file assignments are a later
  question, and the estimates, preview and tier breakdown §7 wants on an
  offer are `#50`'s read, not stored here.
- **The pool is a set of eligible vendors, kept.** `assignment_pool_member`
  records who may claim a `pool_open` job, and stays after the claim as the
  record of who was eligible. Only a member can claim.
- **`assignment_event` is the log**, as `order_event` is the portal's
  (decision 7 there): `from_status`, `to_status`, a required actor
  (`NOT NULL`, no default) and its label, a note and when, append-only by
  trigger from the first migration (`audit-spec.md` §8.2). It is the whole
  record of a transition; there is no second `audit_event` row for the same
  fact.
- **One function moves an assignment.** `moveAssignment` reads the row,
  asks `vendor-core`'s `transitionAssignment` whether the edge exists and
  whose it is, checks that the vendor acting is the one on the row (or, for
  a claim, a pool member), then makes the move with `UPDATE … WHERE
  status = <the status it read>` and checks one row changed. **That
  conditional `UPDATE`, not the read, is what makes a claim safe**: two
  vendors claiming one pool job at once resolve to exactly one claim and
  one rejection (`AssignmentConflictError`, a route's 409), on one
  connection or two, in one process or two. Everything the other routes do
  (`accept`, `decline`, and the later `start`, `deliver`, `review`) is the
  same function with a different edge.
- **A declined claim reposts the job to the rest.** `#47` kept `declined`
  terminal; the pool job's reopening is done here, in the same transaction
  as the decline: a new `pool_open` assignment with the same project,
  deadline and instructions, `reopened_from` pointing at the declined one,
  and the same pool minus the decliner. Each vendor's answer stays in its
  own row's history.
- **Accepting gives access to the project, and it is not atomic.** On
  `accept` the route grants the vendor `assigned_translator` on the owner's
  project (`#45`), so the editor opens. The assignment is in the `.ctv` and
  the grant in `platform.sqlite`, two files no one transaction spans: the
  move is committed first and the grant, which is idempotent, follows. A
  failure between them leaves an accepted assignment with no access, which
  repeating the grant mends; a reconciliation that does it on its own is
  `#51`'s. The grant is not revoked at delivery here either (`#51`).
- **The routes are the owner's and the vendor's, and addressed the way
  projects are.** The owner (PM) creates an assignment with `POST
  /api/assignments`, on their own roster, naming the project, the channel
  and the vendors by account id. A vendor acts with `POST
  /api/assignments/:id/claim|accept|decline?owner=<account id>`: the
  roster is the owner's, found by `?owner=` as a project is (`#45`), and a
  vendor who is not on that roster, or on it but not eligible for that
  assignment, gets the **same 404 as an assignment that does not exist**.
  `GET /api/assignments/:id` answers the assignment as that party may
  see it; the richer offer detail of §7 is `#50`.
- **Not in `#48`:** the roster's own management routes (adding a vendor,
  setting rates: `#51`), the job feed (`#50`), and review's gate (`#51`).
  A roster entry exists today only because something wrote it into the
  `.ctv`.

## 5. Vendor profile fields

Grounded in §7's daily experience and decisions 8–9 above, not a guess:

- **Identity/contact** — name, email (this is an `account` row per
  decision 2, so these may already exist there rather than being
  duplicated into `.ctv`; resolve when the schema is written).
- **Languages** — source/target pairs the vendor works in.
- **Specialties** — tags (legal, medical, marketing, technical, ...);
  free-form initially, controlled vocabulary later if it needs
  filtering/matching (Ring 1).
- **Rate card** — per language pair, a rate for each match tier
  (decision 9): no-match, fuzzy bands, 100%, ICE. Versioned/dated
  (`rate history`, per §2's `db/vendor` responsibilities) rather than a
  single current value, since a rate change shouldn't retroactively
  change what a past delivered job paid.
- **Capacity status** — the available/busy/away toggle plus free-text
  note (decision 8). Vendor-set, timestamped, no history requirement
  beyond "what is it right now" unless a later need for a capacity
  audit trail shows up.
- **Performance history** — read-only from the vendor's own perspective;
  written by whatever QA/review process closes out an assignment (§4's
  `reviewed` state). Not designed yet — depends on §4's open question
  about what "reviewed" actually checks.

**Implementation note (#46), written before the code (2026-10-03).** What
`#46` settled that §3 and §5 left open:

- **One `.ctv` per owner account, never per vendor and never shop-wide.**
  It is the *owner's* roster: the vendors this owner engages and what this
  owner pays them. Per vendor would put one owner's rates in a file the
  vendor can see and another owner can't; shop-wide would put every
  owner's in one file, against the rule that storage is scoped by account
  from the first row (`v1-spec.md` §4.1a) which is what lets opening
  registration later be additive. It lives beside the owner's other files
  (`<storage root>/<account root>/vendors.ctv`) and is the owner's to
  carry, as `.ctm` and `.ctg` are, which is the portability decision 3 and
  decision 4 want. One consequence, recorded not solved: a vendor working
  for two owners has two roster entries, so two capacity statuses. v1 has
  one owner; flipping it everywhere is a later problem.
- **A vendor is a roster entry keyed by its platform account.** `vendor`
  holds the `account_id` (installation-local, like an audit actor id) and a
  display name. **Email is not copied**: §5 asked this be resolved, and a
  second copy of an address is one the account can disagree with. The
  roster shows the display name, falling back to the account's email, which
  the server reads from `platform.sqlite`.
- **Languages are pairs of primary subtags; so are rates.** `en-GB` and
  `en-US` into `de` are one pair and one rate: agencies price by language,
  not region, and a region-keyed rate card would need a row per region for
  the same price. Writes normalise with `primarySubtag`; there is no
  region-insensitive SQL to get wrong (`CLAUDE.md`'s indexed-column gotcha),
  because every one of these tables is one vendor's rows.
- **A rate is a row, never an edit.** `rate_card_entry` is append-only by
  trigger, from its first migration: `(vendor, pair, tier)` with a rate
  and an `effective_from` date. The rate in force at a date is the latest
  entry effective on or before it (`vendorRateAt`). **A new entry may not be
  dated before today, nor before the newest entry already there for the
  same vendor, pair and tier**: otherwise a "newer" row could rewrite what
  a past period paid, which is the one thing §5 says a rate history must
  not do. A job's payable is also locked at delivery (decision 10, `#49`),
  so this is the second wall, not the only one. A mistaken entry is
  corrected by a later one, never by deleting.
- **Money is an integer: `rate_micros`, millionths of a currency unit per
  word**, with the currency beside it. A float would be wrong in the last
  place on a total of tens of thousands of words, and a payable is a
  number a vendor checks against their own.
- **The tier vocabulary is provisional.** Decision 9 says "no-match / fuzzy
  bands / 100% / ICE" and does not name the bands; fuzzy matching and its
  bands are `#61`'s. Until then the tiers are the conventional ones:
  `no_match`, `fuzzy_50_74`, `fuzzy_75_84`, `fuzzy_85_94`, `fuzzy_95_99`,
  `exact` (100% and repetitions) and `ice` (101%). `RATE_TIERS` in
  `vendor-core` is the one definition; when `#61` fixes the real bands it
  is a migration that rebuilds `rate_card_entry` (nothing references it)
  and a mapping for the rows already there. Said here so nobody mistakes
  these for the settled bands.
- **Capacity is one row per vendor, current only** (decision 8: no history
  until a need shows up): `available`, `busy` or `away`, a free-text note,
  when, and who set it (an account id: the vendor's own, or an owner's on
  their behalf). It is not audited: a toggle flipped many times a day is
  not a change that matters, and a log of it is the capacity history
  decision 8 declines to build.
- **Rates and the roster are audited; the `.ctv` has its own
  `audit_event`**, the shared table (`audit-spec.md` §2), in the same
  transaction as the row it describes, actor required: `vendor.added`,
  `vendor.profile_changed` (detail: which of name, languages, specialties,
  never their text, since a name is personal and the detail is hashed) and
  `vendor.rate_set` (the pair, tier, rate, currency and date: a price, not
  a person). A rate is what an owner pays someone; "who set it and when"
  is a question that will be asked.
- **Specialties are free-form tags**, lower-cased and trimmed, as §5 says
  for v1.
- **No server routes in this card.** It is the file and its repositories:
  `createVendorFile`/`openVendorFile` through the shared migration runner,
  and the reads and writes above. `#48` adds the assignment log to this
  file; `#50`/`#51` put it behind HTTP.

## 6. `vendor-server` vs. routes on `@cat-tool/server`

Decided in backlog `#48`: **routes on `@cat-tool/server`.** The surface is
small (five write routes in `#48`, two reads in `#50`, a few in `#51`),
the vendor and the owner share the one process, the one session and the
one editor, and a second deployable would have to re-implement login and
`project_authorization`. `portal-server` is separate because its clients
are not accounts; vendors are. Revisit if notifications or a dashboard make
the surface large (§7 lists both as not designed).

## 7. The vendor's daily experience

The actual point of this component, per §0. Decisions 6–11 above came
from walking through this directly; this section is where they resolve
into an actual flow.

**The core failure this fixes:** being asked to accept a job before
seeing what it actually is. Decision 11 names this as the single
biggest pain point from direct experience across all three roles this
product models — worse than rate ambiguity, worse than unclear status.
An offer that arrives as a bare accept/decline prompt forces a decision
on faith; everything below exists to make that decision informed
instead.

**Login → job feed.** One screen (decision 7): offered jobs needing a
response at the top, active jobs below, recently delivered further
down. A pool-posted job the vendor hasn't claimed appears here too,
distinguishable from a direct offer — the vendor can see both what's
been sent to them specifically and what's generally available to claim.

**Opening an offer (direct or pool).** Before accept/decline/claim, the
vendor sees, per decision 11:

- Deadline and estimated word/segment count
- A preview of the source material
- The TM/glossary match-tier breakdown for the job (how much is
  no-match, fuzzy, 100%, ICE) — this is the same data the running
  payable total will later be computed from, shown here so the vendor
  can judge both effort and pay before committing
- The rate card that applies (decision 9), so the tier breakdown is
  legible as a payable range, not just a percentage split
- Any PM instructions/notes specific to this job — style, terminology,
  client preferences — attached to the offer itself rather than arriving
  separately by email, possibly after acceptance

Deliberately absent: a single precomputed "this job pays $X" number
(decision 10). The vendor has the rate card and the tier breakdown and
can read the total off those directly; the system doesn't collapse it
into one figure at this stage. Revisit if usage shows people want the
arithmetic done for them.

**Accepting.** Moves the assignment to `accepted` (§4). For a pool job,
this also removes it from other eligible vendors' feeds — needs a
concurrency-safe claim (two vendors accepting the same pool job at
once must resolve to exactly one acceptance), a `db/vendor` repository
concern, not a UI one.

**Working.** Vendor opens the real segment editor (`@cat-tool/server`,
authorized via `project_authorization` per decision 1–2 — no separate
vendor editing surface). A running payable total is visible somewhere
in that view, computed live from confirmed segments' match tier × rate
(decision 10) — the implementation detail worth flagging now: this
means the editor UI needs a read on `db/vendor`'s rate card and the
segment-level match-tier data as segments are confirmed, not just at
export time. Capacity status (decision 8) is a toggle the vendor can
flip from anywhere, not tied to any specific job.

**Delivering.** Vendor marks the job delivered; the running total locks
as the final payable amount (§4 `delivered`, decision 10). What happens
between `delivered` and `reviewed` — PM read, QA gate, both — is §4's
open question, not resolved here.

**What this deliberately does not cover yet:** notifications/alerting
when a job is offered or a deadline approaches; the PM-facing side of
posting to the pool vs. pushing directly; performance-history display.
Each needs its own pass once the flow above is validated against real
use, not designed speculatively here.

**Implementation note (#49), 2026-10-03.** The payable is arithmetic over
two inputs kept apart: words per tier (`analyseTierWords`, from a project)
and a rate per tier (`vendorRateAt`, from the `.ctv`, at the offer's date,
so a later rate never moves it). A segment's tier is `tierForOrigin` of the
origin it was pre-translated with and is **only meaningful at analysis
time**, because a translator's edit clears `origin`: decision 10's running
total therefore needs the analysis frozen with the assignment, not re-read
from live segments. A tier with words and no rate is reported unpriced, a
card in two currencies is refused, and an unspaced source language has no
per-word payable until its unit is decided.
