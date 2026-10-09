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
- ~~How a vendor gets an account (signup, an owner's invitation, or only an
  operator)~~ — decided 2026-10-08 (issue #125), see the note after this list:
  an **owner's invitation**, built as backlog `#111`; the operator script is
  all there is until then.

**Decision: how a vendor gets an account (2026-10-08, issue #125).**
A vendor is a platform account with `role = vendor` that an owner puts on
their roster; the question was how that account comes to exist. Three
options, one chosen:

- **Operator-only** (`create-account --vendor`, what exists since `#52a`) is
  kept as the only path for now. It is fine for a pilot with a handful of
  vendors the operator already knows, and costs nothing to keep.
- **Self-signup is rejected.** It needs a public registration endpoint with
  nothing behind it (spam, abuse, a bot filling the roster picker), and
  `v1-spec.md` §4.1a deliberately ships with no registration flow. A vendor
  also has no use for an account until an owner has put them on a roster, so
  an account nobody invited gives them nothing.
- **An owner's invitation is the target**, built as backlog `#111`, not now.
  The owner is the one who knows the vendor, so the invitation is the
  owner vouching for an email, which keeps "the roster decides who is a
  vendor" (`#52a`) true: the invited address becomes an account and a roster
  member in one step, and an account the roster does not list stays invisible
  to every owner. The link is a hashed, expiring, single-use token, so the
  platform stores no password-setting capability in the clear.

Why not build it now: it needs a token store and email delivery, and
`@cat-tool/server` has no mail sender (the SMTP service is
`portal-server`'s), so the card carries a second decision (a sender in the
server, or the link shown to the owner to pass on) that nothing yet forces.
The pilot has no vendor the operator would not create by hand. Cheap to
reverse: the invitation is additive to `create-account`, which stays as the
operator's path, and nothing in the roster or the index changes.

**Implementation note (#111, issue #145), written with the code (2026-10-09).**
The invitation the decision above chose, and the second decision it left to this
card: **the link is shown to the owner to pass on; the server sends no mail.**
`@cat-tool/server` has no mail sender, and sending would be a new outbound data
flow that nothing in the pilot asks for. The cost is that the owner copies a link
into their own mail or chat; nothing else in the design depends on it, so a sender
is additive later (a follow-up issue).

- **A token is a 256-bit random secret kept only as its SHA-256 hash**
  (`generateSessionToken`/`hashSessionToken`, the sessions' way), in
  `vendor_invitation` (platform schema v6). It is returned once, in the response
  that creates it; a lost link is replaced by inviting the address again, which
  withdraws the earlier pending one (logged `invitation.revoked`, `superseded`).
- **The state is derived, not stored.** `invitationStatus` (`vendor-core`) reads
  `accepted_at`, `revoked_at` and `expires_at`: an act outranks the clock, so a used
  link stays `accepted` after its date and a withdrawn one stays `revoked`. A trigger
  makes those columns final once a row is accepted or revoked, so single use is the
  table's property and not a route's habit. A link lives seven days.
- **One refusal for every link that cannot be used**, unknown, used, withdrawn or
  expired: a 404 with one message, so a stranger learns nothing about which tokens
  were ever real. Likewise `POST /api/invitations/:id/revoke` is a 404 for another
  owner's invitation and for a missing one.
- **An address that already has an account is refused at acceptance, never at
  invitation.** Refusing at invitation would let an owner ask which addresses have
  accounts. The invitee is told to sign in; the link stays pending. (An existing
  vendor joining a *second* owner's roster is a different act, proof of who they are
  plus a membership, and is not built here: a follow-up issue.)
- **One transaction makes the account.** `acceptInvitation` creates the `vendor`
  account, writes the `roster_membership` index row and marks the link used together.
  The roster file's own entry is a second file no transaction covers, so it is written
  after, and **mended against the invitations rather than repeated**:
  `bringRosterLevel` adds the vendor of any accepted invitation the roster lacks, after
  an accept and whenever the owner lists their invitations. The index row comes first,
  as `#52a` requires: a failure between leaves a row that shows its account nothing.
- **The invitee is signed in on acceptance** and lands on the vendor feed with the
  owner's roster entry in place (the owner's name for them becomes its display name).
  A password is 10 to 200 characters (`passwordProblem`); the operator script has no rule.
- **Two `/api/` paths answer without a session**, besides login: `POST
  /api/invitations/open` (the address the link was made for) and `.../accept`. They are
  exact paths in one `PUBLIC_PATHS` set, so a route added later is behind the gate
  unless named there. The token travels in the request body and in the link's `#`
  fragment (`#/invite/<token>`), never a path or a query, so no access log, proxy or
  `Referer` header holds it; a test pins that the log holds neither the token nor the
  password.
- **Audit** (`audit-spec.md` §2.5): `invitation.created`, `.accepted` and `.revoked`,
  subject the invitation, in the transaction of the change. `created` and `revoked` have
  the owner as actor. `account.created` names the owner as actor too, because they
  vouched for the account; `invitation.accepted` names the **new account**, because they
  are the one who did it. The invitee's email is in `vendor_invitation` and `account`,
  never in a hashed `detail`. Expiry writes no event: nothing happens when a link's date
  passes, and the status is read from the date.
- **Screens:** `#/vendors` for an owner (the invite form, the link shown once, the
  invitations with Withdraw, the roster) and `#/invite/<token>`, the one screen reached
  without a session.

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
- **The tier vocabulary is the conventional one, and the owner confirmed
  the fuzzy bands** (2026-10-06, `v1-spec.md` §6.1a). Decision 9 says "no-match /
  fuzzy bands / 100% / ICE" and does not name them: they are `no_match`,
  `fuzzy_50_74`, `fuzzy_75_84`, `fuzzy_85_94`, `fuzzy_95_99`, `exact`
  (100% and repetitions) and `ice` (101%). `RATE_TIERS` in `vendor-core`
  is the one definition, and a pre-translate writes `tm_fuzzy_<score>`,
  which `tierForOrigin` maps onto it. Changing a band later is a migration
  that rebuilds `rate_card_entry` (nothing references it) and a mapping for
  the rows already there.
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

**As built (backlog #52).** The feed is the vendor's home screen and the job
opens at `#/jobs/<owner>/<id>`. The offer shows the tier table and the vendor's
own rates side by side with no total; once delivered, the same screen shows
what locked. Declining asks twice. "Open the project" reaches the owner's
project through the ordinary editor, with owner-only controls hidden.

**As built (backlog #53): a forecast, not a running sum.** Decision 10's
"running total as segments are confirmed" needs each confirmed segment's tier,
and an edit clears it (§7, `#49`). So the editor shows what delivery will lock
(frozen words × the rates at the offer), labelled as such, and reads the locked
figure after delivery. Revisit only if per-segment tiers are ever frozen too.

**As built (backlog #54).** Capacity is on the home screen, above the feed: the
three statuses and a note, saved as they are chosen, one row per roster the vendor
is on. Unset reads "Not set" and is never defaulted to available.

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

**Implementation note (#49b), 2026-10-04.** The analysis `#49` said must be
frozen is: `assignment_analysis` (tier, words > 0) and
`assignment.analysed_at`, v3 of the `.ctv`, written by `createDirectOffer`/
`postToPool` in the offer's transaction and copied to a reposted job. The
table refuses an `UPDATE` or `DELETE` by trigger. The owner's route reads
the project's words by tier at the moment of the offer; the owner's view
carries `{ at, words }`, a vendor's does not yet (`#50`). The rate card to
price it with is the one in force at the offer's date, which the assignment's
`created_at` already records.

**Implementation note (#50), written before the code (2026-10-04).** The
vendor's two reads, JSON only (the screens are `#52`); accept, decline and
claim already exist (`#48`).

- **The feed is `GET /api/assignments?owner=<id>`**, a vendor's, on the
  roster `?owner=` names (the owner's own id is not a vendor's feed and gets
  the same 404 as a roster the caller is not on; the owner's list is `#51`).
  Four groups, newest first: `needsResponse` (`offered`, and `claimed`, a
  pool claim not yet accepted), `claimable` (the pool jobs they may claim),
  `active` (`accepted`, `in_progress`) and `delivered` (`delivered`,
  `reviewed`, the latest twenty). `declined` is a vendor's own answer and
  is not a job to act on, so it is not listed.
- **The offer detail is `GET /api/assignments/:id/offer?owner=<id>`**, for
  the assignee or a pool member, and the same identical 404 for anyone else.
  It carries what decision 11 asks for before an answer: deadline and the
  PM's instructions; the words by tier **from the frozen analysis**
  (`#49b`) with their total as the job's estimated size; a **source
  preview** (the first five translatable segments, each capped at 300
  characters, with the project's translatable segment count); and the
  vendor's **own rate card for the project's pair, as it stood at the
  offer's date** (`vendorRateCardAt`), so the tier words are legible as pay.
  **Deliberately no total:** decision 10's "no single precomputed number".
  An offer made without an analysis has `analysis: null` and says so rather
  than showing a breakdown that was never taken.
- **The preview is the one place a vendor reads the owner's project
  before accepting**, so it is capped, plain text, and reached only through
  the assignment (never a project route, never a grant): a vendor who
  declines has seen five sentences, not the file. A project the owner has
  since deleted gives an offer with no preview, not an error.
- **The rate card is the vendor's own** (a pool job: the requesting
  vendor's), never the roster's.

**Implementation note (#51), written before the code (2026-10-04).** The
owner's side of the lifecycle, and the decision `#47` left to it.

- **The `reviewed` gate is both, and it has no override.** §4 asked
  "QA gate, PM read, or both". Both: only the owner's route moves
  `delivered → reviewed` (the machine already makes `reviewed` the PM's
  edge, so a vendor cannot reach it), **and** the move is refused while the
  project has an issue `isBlocking` calls blocking (`core/model/qa.ts`: an
  undismissed error): one definition of must-not-ship, as the CLI's `qa`
  uses. The refusal is a 409 that says how many. There is **no override**:
  a PM who must close over a blocking issue dismisses it, which is a
  decision logged with its actor (`qa.dismissed`), where an override flag
  would be a second, unlogged way to the same end. The gate is
  `reviewAssignment`'s precondition, beside `transitionAssignment`, never
  inside it (`#47`). Asked of an assignment not yet `delivered` it is the
  machine's 409, not the gate's.
- **Reviewing ends the vendor's access.** `reviewed` is terminal, so the
  `assigned_translator` grant (`#45`, given at accept) is revoked after the
  move commits: two files again, so not one transaction, and
  `revokeProjectAuthorization` is idempotent. A failure between them leaves
  a reviewed job whose translator can still open the editor; the
  reconciliation that mends it (this and `#48`'s accept-then-grant) is not
  built, and is an issue.
- **The owner lists their own assignments**: `GET /api/assignments` with no
  `?owner` (a vendor's feed names the owner it is on), newest first, in the
  owner's view.
- **The roster's own routes** are the owner's, on their `.ctv`:
  `GET`/`POST /api/vendors` (adding an account that exists and has the
  `vendor` role; the list carries the account id and the display name, never
  an email) and `GET`/`PUT /api/vendors/:accountId/rates` (a rate is a row:
  the `PUT` adds one, with `#46`'s rules). A rate's refusals are 400s.
- **Not here:** a vendor's `start` and `deliver` routes (nothing in `#50` or
  `#51` asks for them; they belong with the running payable and the delivery
  lock, `#53`), withdrawing an offer, and a missed deadline or declined offer
  becoming a pool post (§4's open question).

**Implementation note (#120), written before the code (2026-10-04).** The
vendor's last two moves and what "the payable locks at delivery" (decision
10) means once the inputs are already frozen.

- **Both moves are explicit vendor acts, over HTTP**: `POST
  /api/assignments/:id/start` (`accepted → in_progress`) and `.../deliver`
  (`in_progress → delivered`), through `moveAssignment` like every other
  move, addressed `?owner=` with the same identical 404 for a stranger.
  `start` is not implied by a first confirmed segment: an act the machine
  already has an edge for, and one the editor's UI (`#52`/`#53`) can call
  when the vendor opens the job, is simpler than inferring it from segment
  writes.
- **What locks is a record, not a number that could change.** The words are
  frozen at the offer (`#49b`) and a rate in force at a date can never be
  rewritten (`#46`), so the amount at the offer's date is already
  immutable. Locking at delivery stores that computation (`assignment_payable`
  and its lines, immutable by trigger) in the delivery's own transaction, so
  what the vendor was shown as final is a row, not a recomputation that
  depends on code and tier mapping staying the same. The words priced are
  the frozen analysis; the rates are those of the offer's date
  (`assignment.created_at`, which for a reposted pool job is the repost's);
  the pair is the project's.
- **A tier with no rate is stored as such, never as zero**: its line has a
  null rate and no amount, and the payable is marked `complete = 0`, so the
  PM reads that the vendor was not fully priced rather than a total that
  silently omits them (`computePayable`'s `unpriced`).
- **Delivery never fails for want of a payable.** An offer made without an
  analysis, a project that has since been deleted (no pair), and a source
  language with no per-word count have **no payable row**: the job is still
  delivered, and `payable` reads `null`. The vendor's work is done; a gap in
  the owner's configuration is the owner's to see and fix, not a reason to
  refuse the delivery.
- **The vendor sees the final amount once it exists**, which is what
  decision 10 asks ("no stage where the vendor does not know what they are
  being paid"): the offer detail carries `payable` (null until delivered),
  as does the owner's view. Decision 10's "no precomputed total" is about the
  offer, before an answer; after delivery the total is a fact.
- **Not decided here, and left to the PM**: whether `deliver` refuses a
  project with blocking QA (the review gate, `#51`, already refuses to close
  over one) and whether it requires every segment translated. Each, if wanted,
  is a precondition beside `transitionAssignment`, never inside it.

**Implementation note (#121), written before the code (2026-10-04).** The
accept and the review each change two files with no transaction between them
(the assignment in the owner's `.ctv`, the grant in `platform.sqlite`), done
as "commit the move, then the idempotent grant or revoke". Repeating an
accept mends a failed grant; **nothing mends a failed revoke**, because
`reviewed` is terminal. The repair is a reconciliation, not a retry.

- **What should exist is derived from the roster.** A vendor's account has
  an `assigned_translator` grant on the owner's project exactly while some
  assignment of theirs on it is `accepted`, `in_progress` or `delivered`; an
  assignment that is `reviewed` or `declined` gives none, and two assignments
  on one project keep the grant while either is active.
- **It governs only the pairs the roster knows.** A grant is reconciled only if
  the roster has at least one assignment for that (account, project); a grant
  the roster has never heard of is not this function's to remove, so a grant
  made for another reason is safe from it.
- **It reports what it did, and names an actor.** The result is the grants it
  added and the ones it removed; each goes through the ordinary
  `grantProjectAuthorization`/`revokeProjectAuthorization`, so each is its own
  `authorization.*` event in the platform's log under the owner's actor. A
  grant it cannot make (an account that no longer exists) is reported as
  skipped, not thrown: one bad row must not stop the rest being mended.
- **It is on demand, the owner's:** `POST /api/assignments/reconcile`. It
  is idempotent, so a run that finds nothing wrong writes nothing. Running it
  on a schedule, or after a failed grant, is for whoever wants it (`#52`'s
  screens can offer it); the routes do not call it themselves, since a repair
  that ran inside the failing step would fail with it.

**Implementation note (#52a), written before the code (2026-10-04).** `#52`'s
screens turned out to need a backend `#50` did not give them: a vendor's feed
is read per owner (`?owner=`), but a vendor has no way to learn *which*
owners' rosters they are on, and §7 wants one feed across all of them. The
roster is each owner's own file, so the answer cannot be a query.

- **A membership index in `platform.sqlite`** (v5, `roster_membership`:
  `(owner_id, account_id)`), written when an owner adds a vendor. It is a
  **derived index of the rosters, not a second truth**: the roster decides who
  is a vendor, and a membership that has no roster entry behind it shows its
  vendor nothing (the feed finds no vendor on that roster). So it is written
  *before* the roster entry: a failure between the two leaves a harmless
  index row, never a vendor on a roster the index does not know. It records
  no audit event of its own, the roster's `vendor.added` being the act.
- **It is rebuildable.** `reconcileMemberships` derives it from the roster
  (every vendor on it gets a row) and the owner's `POST
  /api/assignments/reconcile` runs it with the grants, which also backfills
  rosters written before the index existed.
- **One feed across owners: `GET /api/vendor/feed`**, the signed-in account's
  own. For each owner whose roster lists them it reads `vendorFeed` and merges
  the four groups, each assignment carrying its `owner` (an account id) and
  `offeredAt`, newest first. An owner with no roster file, or whose roster no
  longer lists the account, is skipped, never an error. It takes no `?owner`:
  a vendor cannot be asked to name the owners who engage them.
- **`/api/me` says what the account is** (`role`), so the SPA can send a vendor
  to the feed and an owner to their projects without guessing.
- **A vendor account can be created**: `create-account` takes `--vendor`.
  There was no way to make one outside a test. How a vendor *gets* an account
  was decided separately (§3: an owner's invitation, backlog `#111`; the script
  stays the operator's path until then).

**Implementation note (#112, issue #153), written before the code (2026-10-08).**
The owner's side of "locked at delivery": which locked payables are unpaid,
marking one paid, and getting the list out. Tessera moves no money; this is
the record of it.

- **A payment is an event, never an edit of the payable.** `assignment_payable`
  stays immutable by trigger. A new `assignment_payment_event` (vendor schema
  v5) is append-only like `assignment_event`, with a required actor: kind
  `paid` (with the date it was paid) or `reopened` (a correction, no date).
  The state of a payable is its **latest** event: none or `reopened` is
  unpaid, `paid` is paid. Recording a payment on a paid payable, or reopening
  an unpaid one, is a 409, so a wrong date is corrected by reopening and
  paying again, and the log keeps both. The two kinds are a frozen literal in
  the migration (`PAYMENT_KINDS` in `vendor-core`, tied by
  `check-lists.test.ts`).
- **Why not `audit_event`.** `assignment_event` is already "the whole record
  of a transition" in this file, with the actor on the row; a payment is the
  same kind of fact, and putting it in `audit_event` too would be two records
  of one act. The one thing that is not a change to the roster but leaves it
  is the CSV, so **`payables.exported`** is a new `audit_event` action
  (widened by migration, `rebuildTable`): its detail is the row count and the
  digest of the bytes sent, never a name or an amount, as `project.exported`
  records the digest of the document.
- **A date, not a timestamp, and not before the payable.** `paid_on` is a
  `YYYY-MM-DD` the owner states: the day the money moved, which is not the
  day they clicked. It may not be in the future and may not precede the day
  the payable locked (a payment cannot settle what did not yet exist).
- **Totals are per currency and never converted.** A list reports one total
  per currency (and one for a payable with no currency: its tiers had no
  rate, so it is `complete = 0` and 0 owed), split into unpaid and paid. No
  exchange rate exists in this product, and a sum across currencies is a
  number in none. An incomplete payable is **listed with its flag, never
  hidden and never counted as zero owed without saying so**: the owner pays
  what was priced and sees what was left out.
- **The period is the day the payable locked** (`locked_at`), inclusive on
  both ends, optional on both. It is the one date every payable has, and it
  is immutable, so a period's list never moves under a reader once the
  period is over. "Paid in this period" is a different question and not
  asked here.
- **A vendor sees their own record and nothing else**: `GET
  /api/vendor/payments`, across every roster that lists them (the feed's
  shape): per job the locked amount, whether it is paid, the paid date and
  the days from locking to payment. Never another vendor's row, and never
  an owner's total.
- **The CSV is a formula-injection surface.** A project or vendor name that
  begins `=`, `+`, `-`, `@`, tab or carriage return runs as a formula in a
  spreadsheet. `payablesCsv` (pure, `vendor-core`) prefixes such a cell with
  `'` and quotes per RFC 4180; money is written from the integer micros as a
  decimal string, never through a float.
- **Routes, all the owner's own roster** (`openRoster(me)`: a vendor reaches
  nothing): `GET /api/payables`, `GET /api/payables.csv` (`?vendor=<account
  id>&from=&to=&status=paid|unpaid`), `POST /api/assignments/:id/payment`
  (`{ paidOn, note? }`) and `.../payment/reopen`. A vendor and a stranger get
  the identical 404.
- **Not built here:** a payment note shown to the vendor, an email when a payment is
  recorded, and the vendor-confirmed statement of issue #158. The routes are
  the contract the screens use.

**The screens (#113, issue #167).** `#/payables` for an owner (a "Pay run" link
in the top bar) and `#/payments` for a vendor. They add no route and no rule;
the decisions worth keeping are in the backlog entry: the CSV is fetched with the
token and saved from a `Blob`, "today" is the UTC date the server counts, an
unpriced payable is "Not priced" and never `0.00`, and the list is read again after
every write so the totals stay the server's.
