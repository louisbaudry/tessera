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

- Exact `project_authorization.scope` values beyond `owner` and
  `assigned_translator` — does a reviewer/proofreader role exist in v1,
  or is that Ring 1?
- Whether `vendor-server` is its own deployable service or a route
  module mounted into `@cat-tool/server`'s Fastify instance. Leaning
  toward the latter (one running server, since vendors and owners share
  the same editor process) but not decided — revisit once §7's fields
  are drafted and the route count is known.
- How rate calculation in `vendor-core` relates to `portal-core`'s
  `pricing.ts` (client-facing quote) — margin is the gap between the
  two, and that gap is presumably a real product feature (PM-visible
  margin per job), not an accident of two separate calculators existing.
- Whether `.ctv` is per-account (a vendor's own portable file, mirroring
  `.ctm`/`.ctg` portability) or a single shop-wide file. `.ctm`/`.ctg`
  are portable because a translation memory or glossary is a real
  hand-off artifact; it's not obvious a vendor roster is the same kind
  of thing. Needs a decision before the schema is written.

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

## 6. `vendor-server` vs. routes on `@cat-tool/server` (placeholder)

See §3. Decide once the route surface for §7's "vendor's daily
experience" is sketched — a small surface argues for folding into the
existing server; a large one (dashboard, earnings, job feed,
notifications) argues for a separate service the way `portal-server` is
separate from `@cat-tool/server` today.

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
