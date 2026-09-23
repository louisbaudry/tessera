# Telemetry — spec

Status: design, 2026-09-23. Not yet built, no backlog entries or issues
yet. The owner asked for the spec first, to review before it is broken
into cards. Written now, before any surface emits anything, for the same
reason `audit-spec.md` was: **an event nobody declared, once it ships, is
data nobody reviewed.** It is cheaper to decide what may leave the process
than to find out afterwards what already has.

**Confirmed with Louis, 2026-09-23:** telemetry answers four questions
(§2); it goes only to a **self-hosted, EU-owned** backend (§8); payloads
carry **ids, counts, durations and enums only**, enforced by a typed
catalogue and a test, never by a denylist (§4); consent is **ops always
on, usage opt-out for staff and opt-in for vendors and clients**, with
people identified by a keyed hash (§6); **translation productivity is
derived from `audit_event`, not collected as telemetry** (§7); only the
**API server** emits from day one (§5); raw data is kept **30 days**,
aggregates **13 months** (§9); tenants never see the ops stack, only
product numbers inside the product (§10).

Extends: `audit-spec.md` §1 decision 9 and §5 ("application logs are not
the audit trail"), `worldwide-and-compliance-spec.md` §5.2 (EU-owned
providers) and §6.2 controls 10 and 15, `ai-platform-vision.md` §5,
`vendor-spec.md` §4 (performance history).

## 0. Why now

Nothing is instrumented today. The only runtime output is Fastify's
default logger (`logger: true`) in `server/src/app.ts` and
`portal-server/src/app.ts`. It already breaks the rule this spec sets.
Fastify's default request log line carries `req.url`, and here the URL
carries the project slug (`/api/projects/:name`). Project names are chosen
by users and are often a client's name. Some error replies interpolate
that name too (`a project named "..." already exists`). None of this is
secret-grade today, but it shows the default pattern. The first real
client job would put a client name into a log line that is rotated,
shipped and kept outside any access control the product has.

Three things on the backlog make that worse if nothing changes:

1. **Deployment (#36).** The first time logs leave the developer's machine,
   whatever they carry leaves with them.
2. **Vendors (Epic 9).** Per-person numbers about freelancers are
   performance monitoring. That is a harder GDPR question than error
   rates, and some jurisdictions have rules of their own for it (§6.2).
3. **AI (Epic 8).** Cost per engine and per client is a business number
   the owner needs from the first paid call. The content sent is exactly
   what must not be logged.

## 1. Three records, three jobs

Three different records hold data about "what happened". They must not
blur into one another:

| Record | Question it answers | Lives in | Content allowed | Retention | Reader |
|---|---|---|---|---|---|
| **`audit_event`** (`audit-spec.md`) | who changed what, provably | each data file | yes, client content (target snapshots) | the file's own | the product, access-controlled |
| **Telemetry** (this spec) | is it working, how is it used, what does it cost | the ops backend | **never** | 30 d raw / 13 mo aggregate | the operator only |
| **Product numbers** (§7, §10) | how productive, how much leverage, what AI spend per client | derived from `audit_event` + billing | as the source | the source's | tenants, in the product UI |

The rule that follows: **telemetry never becomes a second record of the
work.** If a number is about a specific translation, segment or person's
output, it is derived from `audit_event`, where it already has an actor,
a retention and an access control. Telemetry holds only what has no other
home: latencies, failures, feature counts, costs.

## 2. What telemetry answers

| Purpose | Examples | Source |
|---|---|---|
| **Ops health** | error rate by route, p95 latency, DOCX import failures by cause, migration outcomes, upload sizes, SMTP failures | telemetry |
| **Product usage** | projects created, files imported, pretranslate runs, exports, QA runs, which QA rules fire most | telemetry (server-side events only until the SPA exists, §5) |
| **Translation productivity** | time between confirms, edit distance from a TM/MT/AI draft, leverage by match tier, per-vendor review changes | **`audit_event`**, §7 |
| **AI cost & quality** | tokens and cost per engine, model, tenant; latency and errors per provider; share of drafts accepted unchanged | cost and latency: telemetry. Acceptance: `audit_event`, §7 |

## 3. Decisions

1. **One catalogue, declared once.** Every telemetry event, metric and
   span attribute is declared in `core/telemetry/catalogue.ts`: its name,
   its attributes and each attribute's kind (§4). That is the same shape
   as the `audit_event` action list and `QA_RULES`, and the same reason
   applies: something undeclared is something unreviewed. It lives in
   `core` because it is a cross-package fact (the portal server and the
   SPA will emit from the same list), per the one-definition invariant.
2. **`core` only declares; the shell emits.** `core` holds the catalogue
   types and a `Telemetry` interface with a no-op implementation. The
   OpenTelemetry-backed implementation lives in `server`. The
   `NotificationService`/`SmtpNotificationService` split is the precedent.
   `core` stays headless and gains no dependency.
3. **Instrument at the route, not inside the repository.** A route
   already *is* one repository call with HTTP around it (CLAUDE.md, the
   API server), so timing and counting that call at the route covers it.
   `db` and `core` functions do not take a telemetry parameter. The
   exception is anything the route cannot see (a count of segments
   produced, a match-tier breakdown): the repository *returns* those, as
   `countSegments` and `pretranslate`'s `PretranslateSummary` already do,
   and the route
   records them.
4. **Off unless configured.** No OTLP endpoint configured means the no-op
   exporter: tests, the CLI and a fresh checkout emit nothing and need no
   collector. `buildApp({ logger: false })` in tests keeps working.
5. **The CLI never phones home.** It has no login, runs on the user's own
   machine, and has no consent surface (§5).
6. **Tenants see no ops data** (§10).

## 4. The content boundary

### 4.1 Attribute kinds

Every attribute in the catalogue has one of these kinds. There is no
`string` kind:

| Kind | What it is | Example |
|---|---|---|
| `enum` | one of a closed list declared in the catalogue | `route`, `status_class`, `error_code`, `engine`, `match_tier`, `qa_rule` |
| `count` | non-negative integer | `segments`, `files`, `tokens_in` |
| `bytes` | non-negative integer | `upload_bytes` |
| `duration_ms` | non-negative number | `import_ms` |
| `money_micro` | integer micro-units + an `enum` currency | AI cost |
| `bool` | — | `cache_hit` |
| `pid` | a **pseudonymous id**, §6.3 | `tenant`, `actor` |
| `lang` | a BCP-47 primary subtag, validated | `src_lang` |

A free-text attribute does not compile, because the emitter's parameter
types come from the catalogue. That makes the typed catalogue the first
line of defence: a developer who wants to log a filename has to add a
kind, and that change is visible in review.

### 4.2 Specifically never

- Segment text, tokens, TM or glossary entries, AI prompts or responses.
  Not even as a hash: a digest of a short segment is a lookup table away
  from its text.
- Filenames, project names or slugs, client names, email addresses.
- The raw URL. Log the **route template** (`req.routeOptions.url`,
  `/api/projects/:name`), never `req.url`.
- **Error messages.** Ours interpolate names (`a project named "..."`),
  and a thrown parser error can quote document XML. An error is recorded
  as its class, a declared `error_code` enum and stack frames (file and
  line of our code). The first line of a stack is the message, so it is
  dropped. An error with no code is `error_code: unknown`, and "how many
  `unknown`s" is itself a metric worth watching.
- Request or response bodies, headers other than a declared few
  (`content-length`), IP addresses. Rate-limiting and abuse detection
  (later) are the reverse proxy's job, with their own retention.

### 4.3 Enforcement: the sentinel test

The type system stops a new attribute from being free text. It cannot
stop a library from logging something on its own, such as Fastify's
request line or an error serializer. So there is a test that proves the
real output:

`server/src/telemetry.test.ts` drives the app through `inject` with a
capturing exporter and a capturing log stream. It uses a project named
`SENTINEL-PROJECT-…`, an email `sentinel-…@example.test`, an upload named
`SENTINEL-FILE-….docx`, a DOCX whose text contains `SENTINEL-TEXT-…`, and
a request that fails with an error naming the project. It then asserts
that **no sentinel appears anywhere in anything emitted**: log lines,
span attributes, metric labels or event payloads. This follows the
roundtrip gate's logic, which trusts real output rather than intentions.
A new route gets a sentinel case in the same PR.

## 5. Surfaces

| Surface | Day one? | Notes |
|---|---|---|
| `@cat-tool/server` | **yes** | the only emitter in the first slices |
| `@cat-tool/portal-server` | later | same catalogue, same test. Order-lifecycle timings and SMTP failures are the obvious first events |
| SPA / editor (#28–#35) | later | design now, wire with the editor: browser errors, web vitals, feature usage. Needs the consent UI (§6), since usage there is per person |
| `@cat-tool/cli` | **never** remote | may print timings locally behind a flag. No network |

## 6. Consent and identity

### 6.1 Lawful basis per purpose

| Data | Basis | Default |
|---|---|---|
| Ops health (errors, latency, failures) | legitimate interest, GDPR Art. 6(1)(f): running a secure, working service | **always on**, disclosed in the privacy notice |
| Usage, agency staff | legitimate interest, with an objection right | **on, opt-out** per account |
| Usage, vendors and portal clients | consent | **off, opt-in** per account |
| AI cost per tenant | contract (it is what gets billed) | always on, per tenant, never per person |
| Productivity | not telemetry (§7) | — |

Until vendor roles exist (Epic 9), every account is staff. The switch is
a per-account setting in `platform.sqlite`. **A change to it is an
`audit_event`** (`account.setting_changed`, a new action widening
`audit-spec.md` §2.2's `platform.sqlite` list), because under Art. 7(1) the
operator must be able to *show* consent was given, and the audit log is
where "provably" lives.

The consent check sits in the `Telemetry` implementation, not at each
call site. The catalogue marks each event `ops` or `usage`, and a `usage`
event for an account without consent is dropped before export.

### 6.2 Why vendors get opt-in

Per-person numbers about freelancers are performance monitoring. A
privacy-notice line does not cover that for a healthcare or public-sector
client's DPO. France (CNIL guidance on worker monitoring) and Germany
(works councils, once an agency has employees) have specific expectations.
Keeping per-person performance out of telemetry entirely (§7) is most of
the answer. Opt-in covers the rest.

### 6.3 Pseudonymous ids

A person or tenant appears in telemetry only as a `pid`:
`HMAC-SHA256(telemetry_key, "account:3")`, truncated to 16 hex characters.
`telemetry_key` is an installation secret held by the server, **not** by
the telemetry backend. The operator can re-link a pid when debugging a
specific support case; someone with only the backend cannot.

**This is pseudonymisation, not anonymisation.** Under GDPR the data is
still personal data, because the operator holds the key. It lowers the
damage from a telemetry-store leak. It does not remove any obligation.

Erasure works without touching the backend:

- raw events (the only place a person's pid appears) expire in 30 days
  (§9), which is within the one-month response time GDPR allows for an
  erasure request;
- **aggregates have no person dimension**: they are keyed by tenant pid,
  route, enum values, never by actor pid. There is nothing per person to
  erase after 30 days.

That rule is enforced in the catalogue. `actor` is allowed on raw events
only, and a metric declaration with an `actor` label is a type error.

## 7. Productivity from `audit_event`

Everything in the "translation productivity" row of §2 is computable from
events `audit-spec.md` already defines:

| Number | From |
|---|---|
| Leverage by tier | `segment.target_set` `origin` (`tm_exact`, `propagated`, `mt_draft`, …) at the segment's first target |
| Edit distance from a draft | the `target_tokens` of the draft-origin `target_set` versus the one at `segment.confirmed` |
| AI draft acceptance | `origin` `mt_*` followed by `confirmed` with no intervening human `target_set` (`audit-spec.md` §4) |
| Time per segment | interval between successive `confirmed` events by the same actor in one file |
| Reviewer changes | `target_set` by a reviewer after a translator's `confirmed` (`vendor-spec.md` §4) |

Why derive rather than collect:

- **One record, not two.** The numbers can never disagree with the
  history, the same reasoning as `preferredVariant` being derived from
  `term_decision`.
- **Right basis, right place.** They are about the work, under the
  contract, and live in the project file with its confidentiality and
  retention, not in an ops store with a 30-day horizon.
- **Access control for free.** A vendor's numbers are visible to whoever
  may see the project (issue #17), not to whoever can read the ops
  dashboards.

**Accepted limitation:** "time per segment" is *time between confirms*,
not active editing time. A coffee break counts. Real active time would
need focus and keystroke events from the editor, i.e. a second, much finer
record of a person's work. That was rejected for now. Revisit only if
pricing needs it, and then as `usage` under §6.

The derivation is a pure function in `core` (events in, numbers out) with
a repository in `db`, following the QA engine's split. It depends on
`audit_event` existing (#55/#56) and is built after it.

## 8. Stack

- **Instrumentation: OpenTelemetry** (traces, metrics) and **pino**
  (Fastify's own logger, structured JSON with the OTel trace and span ids
  injected), exported over **OTLP**. That is vendor-neutral: the backend
  is a deployment choice, not a code choice.
- **Backend: deferred to the hosting decision (#36)**, under one
  constraint: **self-hosted on an EU-owned provider**
  (`worldwide-and-compliance-spec.md` §5.2). SigNoz (one app) and the
  Grafana stack (Loki/Tempo/Mimir) both qualify. Self-hosting adds no
  subprocessor beyond the hosting provider already on the list
  (control 10).
- **Local development:** a `docker-compose` file with an OTel collector
  printing to stdout, for anyone who wants to see what is emitted. It is
  never required.
- **Metrics are pre-aggregated in-process** (OTel counters and
  histograms), not computed from raw events at query time, so the 13-month
  store never needs raw data.

## 9. Retention

| Data | Kept |
|---|---|
| Raw logs, traces, events | **30 days** |
| Aggregated metrics | **13 months** (year-over-year) |

The backend's own retention setting enforces this, and it is part of
§6.2 control 7 (deletion and retention) like any other store. Backups of
the telemetry store, if there are any, follow the same limits. Ops data
does not need a backup that outlives its own retention.

## 10. What tenants see

Nothing from the ops stack. An agency's productivity, leverage and AI
spend are **product features** computed from its own `audit_event` and
billing data (§7), shown in the product UI under the product's access
control. That keeps the ops backend operator-only, so it needs no tenant
access control, and it keeps the numbers a tenant sees consistent with
the record it can audit.

## 11. Relation to compliance controls

- **Control 15 (incident response):** telemetry is the *detect* half.
  Error-rate and auth-failure alerting (`auth.login_failed` counts, by
  tenant pid) is how a breach is noticed inside the 72 hours. Alert rules
  are designed with the backend (#36), not here.
- **Control 10 (subprocessor list):** unchanged if self-hosted (§8).
- **Control 7 (retention):** §9.

## 12. Slices (proposed, not yet cards)

In order. Each one would become a backlog entry and issue once the owner
approves this spec:

- **T1. Catalogue and boundary.** `core/telemetry/` (kinds, catalogue,
  `Telemetry` interface, no-op). Server logs route templates, error
  codes instead of messages, and injects request ids. **The sentinel
  test.** This fixes the §0 leak before anything is deployed.
- **T2. OTel export.** The server's OTLP implementation and config (endpoint
  unset means no-op), the first ops metrics (per-route latency and errors,
  import/export durations and failures by `error_code`, migration
  outcomes), and the local `docker-compose` collector.
- **T3. Consent.** The per-account usage switch in `platform.sqlite`
  (migration via the shared runner), its `audit_event`, and the drop of
  `usage` events for accounts without consent. The first usage events.
- **T4. Productivity derivation** (after #55/#56). §7's numbers, `core`
  function plus `db` repository. Product-side, not telemetry. Listed here
  because this spec moved it here.
- **T5. AI cost metrics** (with Epic 8). Tokens, cost, latency and errors
  per engine/model/tenant pid.
- **Later:** the portal server (same catalogue, same test), SPA telemetry
  with the editor, backend and alerting with #36.

## 13. Open, deliberately deferred

- **Which backend.** Decided with #36.
- **Alert rules and SLOs.** Need a deployment and real traffic to set
  thresholds against.
- **Browser consent UI and wording.** With the editor. It also needs a
  lawyer's read of the privacy notice, as for `worldwide-and-compliance-spec.md`
  §5.4.
- **Sampling.** Irrelevant at pilot volume. Revisit when trace volume
  costs something.
- **Whether `telemetry_key` rotates.** Rotating breaks continuity of
  per-person raw events, which only live 30 days anyway. Probably yearly,
  decided with T3.
