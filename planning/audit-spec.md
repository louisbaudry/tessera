# Auditability — spec

Status: design, 2026-09-23. `#55` (`core/audit`), `#56` (`project.catdb`)
and `#57` (`platform.sqlite`) built 2026-09-24; `#58` not yet
(`v1-backlog.md`, "Cross-cutting — Auditability"). Written now, ahead of
the epics that need it, for the same reason the `.ctm` context columns
were populated before any feature read them (`v1-spec.md` §4.3): **history
not recorded at write time cannot be recovered afterwards.** The context
hash of a segment whose document is gone is lost; so is the name of whoever
changed a segment that was simply overwritten.

**Confirmed with Louis, 2026-09-23:** the hash chain from day one (§3),
a full snapshot of the target after each change rather than a diff (§2.2),
logs kept in each data file rather than a central store (decision 5),
logging reads only when content leaves the system (decision 9), and
erasure by pseudonymised label (§5). **Sequencing:** `#55`/`#56` are built
next, ahead of the editor (`#28`–`#35`) and vendor work (`#45`+). That way
the editor's and vendor routes' write paths are written against a
required actor from their first line, and every edit made on real jobs
from then on keeps its history.

Extends: `v1-spec.md` §4, `tm-format-spec.md` §2.5, `smart-glossary-spec.md`
§3.4, `portal-v0-spec.md` §2, `vendor-spec.md` §4, `ai-platform-vision.md`
§3 (Ring 0.5) and §5.

## 0. Why now, not later

Today one person writes every segment, so "who changed this?" has one
answer. Three things already on the backlog end that:

1. **Vendors edit project files** (Epic 9, `vendor-spec.md` decision 1). A
   vendor is a real account in the real editor, so a project will have
   several authors — and `vendor-spec.md` §4's `reviewed` state and
   "performance history" both need to know which of them wrote which
   target, and what the reviewer changed.
2. **AI writes drafts** (Epic 8, Ring 0.5). `ai-platform-vision.md` §5
   commits to *disclosure* and to a per-client *opt-out*. Neither is
   provable after the fact unless each AI-produced target is recorded as
   such at the moment it lands, with the engine that produced it.
3. **Clients see deliveries** (Epic 10a/10). "What exactly did we send
   them, when, and who approved it" is a question a client dispute asks
   of the record, not of anyone's memory.

What the product records today is uneven:

| Store | What it keeps | Actor? | Enforced append-only? |
|---|---|---|---|
| `.ctm` — `tuv_history` | every prior variant revision | `changed_by`, free text | no (repository convention) |
| `.ctg` — `term_decision` | every glossary decision | `decided_by`, free text | **yes**, triggers |
| `portal.sqlite` — `order_event` | every order transition | **no** | no |
| `project.catdb` — `segment` | **current state only**: `target_tokens` is overwritten, `updated_at` is the only trace | **no** | — |
| `platform.sqlite` | accounts, sessions | — | — |

`term_decision` is the model to copy (`smart-glossary-spec.md` §3.4): a log
enforced by the schema, current state derived from or consistent with it.
The project database — where the translation actually happens — is the
biggest gap: every edit destroys the one before it. That is the thing this
spec exists to close first.

## 1. Decisions

1. **Every change that matters is an append-only event, written in the
   same transaction as the change.** Not a log shipped afterwards, not an
   application log line: a row that commits or rolls back together with
   the state it describes. If the change happened, its event exists;
   if the event is missing, the change did not happen.
2. **Append-only is enforced by the schema**, `term_decision`'s way:
   `BEFORE UPDATE` / `BEFORE DELETE` triggers that `RAISE(ABORT, ...)`.
   Repository convention is not enforcement — `replaceQaIssues` (CLAUDE.md,
   the QA engine) is the standing example of a convention quietly
   broken by a later, reasonable-looking change. The single exception is
   erasure of a person's label (§5), and the trigger itself says so.
3. **The actor is required, never defaulted.** Every repository function
   that writes an audited change takes an `actor` — a required field, not
   an optional one filled with `'unknown'`. A write path that forgets its
   actor must fail to compile, not produce an anonymous row. (`confirmSegment(..., { confirmedBy? })`, as it stood before
   backlog #56, was exactly the optional shape this rules out.)
4. **Actor and origin are different facts, kept in different fields.**
   The *actor* is the accountable principal who caused the change — a
   person, or a named unattended job. The *origin* is the mechanism that
   produced the content — `tm_exact`, `propagated`, `mt_draft`
   (`segment.origin`, `v1-spec.md` §4.3). **An AI engine is never an
   actor.** A translator who accepts a DeepL draft is the actor; DeepL is
   the origin, with its provenance in the event's detail (§4). This is
   what lets "who is answerable for this sentence" and "how was it
   produced" both have one true answer.
5. **The log lives in the file whose data it describes.** A project's
   history is in `project.catdb`, travelling with the project; a TM's is
   in the `.ctm`; account and access events are in `platform.sqlite`. No
   central audit database. Same reasoning as `.ctg` not being a table in
   `portal.sqlite`: a log in a different file from its data can be
   separated from it — by a backup, a hand-off, a restore — and then
   describes nothing.
6. **One event shape, one definition.** Every database that gains a log
   gains the *same* `audit_event` table (§2), and its row type, action
   vocabulary, and chain function live once in `core/audit/`. Per the
   one-definition invariant: a second hand-written copy of the table or
   the hash is the mistake `qualifySchema` was moved to prevent.
7. **Existing logs are extended, not duplicated.** `tuv_history`,
   `term_decision` and `order_event` stay the record of their facts. The
   new table covers what none of them does; it never re-records an order
   transition or a TM revision a second way.
8. **Hash-chained from the first row.** Each `audit_event` carries
   `chain_hash = SHA-256(prev.chain_hash ‖ canonical(row))`. Cheap now;
   impossible to add meaningfully later, because rows written before the
   chain existed can never be proven untouched. §3 says what it does and
   does not prove.
9. **Reads are not audited; content leaving the system is.** Opening a
   segment in the editor is not an event — per-view logging is the
   4,615-line warning storm (backlog #18) waiting to happen. An export,
   a download, a delivery, and an AI request (client content sent to a
   third party) *are* events: they are the moments data leaves.

## 2. `audit_event`

The same table in `project.catdb` (schema v5), `platform.sqlite` and
`portal.sqlite`, through the shared migration runner in each case:

```sql
CREATE TABLE audit_event (
  id           INTEGER PRIMARY KEY,
  at           TEXT    NOT NULL,          -- ISO-8601 UTC
  actor        TEXT    NOT NULL,          -- §2.1, e.g. 'account:3'
  actor_label  TEXT,                      -- display snapshot; erasable, §5
  action       TEXT    NOT NULL,          -- §2.2 vocabulary, CHECKed
  subject_type TEXT    NOT NULL,          -- 'segment' | 'file' | 'project' | 'account' | ...
  subject_id   TEXT,                      -- id within this file; TEXT so non-integer keys fit
  batch_id     INTEGER REFERENCES audit_event(id),  -- the batch-level event, §2.3
  detail       TEXT,                      -- JSON, shape fixed per action in core/audit
  chain_hash   TEXT    NOT NULL           -- §3
);
CREATE INDEX audit_event_subject ON audit_event(subject_type, subject_id, id);
CREATE INDEX audit_event_batch   ON audit_event(batch_id) WHERE batch_id IS NOT NULL;

CREATE TRIGGER audit_event_no_delete BEFORE DELETE ON audit_event
BEGIN SELECT RAISE(ABORT, 'audit_event is append-only'); END;

-- The one permitted UPDATE: erasing a person's display label (§5).
-- actor_label is outside the chain for exactly this reason.
CREATE TRIGGER audit_event_no_update BEFORE UPDATE ON audit_event
WHEN NEW.id IS NOT OLD.id OR NEW.at IS NOT OLD.at
  OR NEW.actor IS NOT OLD.actor OR NEW.action IS NOT OLD.action
  OR NEW.subject_type IS NOT OLD.subject_type OR NEW.subject_id IS NOT OLD.subject_id
  OR NEW.batch_id IS NOT OLD.batch_id OR NEW.detail IS NOT OLD.detail
  OR NEW.chain_hash IS NOT OLD.chain_hash
  OR NEW.actor_label IS NOT '[erased]'
BEGIN SELECT RAISE(ABORT, 'audit_event is append-only'); END;
```

`action` gets a `CHECK (action IN (...))` generated from `core`'s action
list, the way `qa_issue.rule` is generated from `QA_RULES` — adding an
action is a migration that widens the CHECK, deliberately: an action
nobody declared is a write path nobody reviewed.

### 2.1 Actor

A string `kind:id`, parsed and formatted only by `core/audit/actor.ts`
(pure — the CLI and server supply the facts, `core` never calls `os`):

| Kind | Id | Strength |
|---|---|---|
| `account` | `platform.sqlite` `account.id` | authenticated session |
| `admin` | `portal.sqlite` `admin_user.id` | authenticated session |
| `client` | portal order id | **the private link, not a person** — whoever holds it (`portal-v0-spec.md` §7) |
| `cli` | OS user name | **self-asserted** — the CLI has no login |
| `system` | a named job, e.g. `system:migration` | unattended; the job's name is the answer |

**The grammar** (backlog #55, `core/audit/actor.ts`). The string splits
on its *first* `:`, so a `cli:` user name may itself contain one. Each
kind's id has exactly one spelling, because two spellings of one
principal would be two actors to every query that groups by `actor`:

- `account`, `admin`, `client`: a positive decimal integer, no sign, no
  leading zero (`account:3`, never `account:03`) — they are all
  `INTEGER PRIMARY KEY`s.
- `cli`: any non-empty name with no control character and no leading
  or trailing whitespace. Windows user names contain spaces; the CLI
  passes what the OS gives it and `core` refuses only what could not
  be a name at all.
- `system`: `[a-z][a-z0-9._-]*` — a job name is this codebase's own
  constant, never input, so it gets the narrow alphabet.

Anything else — an unknown kind, an empty id, `account:0` — is rejected
by `parseActor`, which throws rather than returning a best guess.

The table says what each identity is worth rather than pretending they
are equal: a `cli:` actor is a claim, a `client:` actor is a link. An
audit trail that overstates its own certainty is worse than one that
states its limits.

`actor` ids are installation-local, which is why `actor_label` exists: it
snapshots a human-readable name (an email, a display name) at the moment
of the event, so the record still reads after the account is gone or the
file has moved. `.ctm` and `.ctg` are portable across installations and
their `*_by` columns have always been free text; writers pass the
**label** there, and those formats do not change.

### 2.2 Actions (first cut)

`project.catdb`:

| Action | Subject | Detail |
|---|---|---|
| `segment.target_set` | segment | `{ status, origin, target_tokens }` — the state **after**; the state before is the previous event |
| `segment.confirmed` | segment | `{ tm_write: { tu_uuid, rev } \| null }` |
| `segment.locked` / `segment.unlocked` | segment | — |
| `segment.baseline` | segment | as `target_set`; §6 |
| `file.added` | file | `{ rel_path, sha256 }` |
| `project.pretranslate` | project | `{ tm_refs, counts }` — batch parent |
| `project.exported` | file | `{ sha256 }` of the DOCX produced — what exactly was delivered |
| `project.setting_changed` | project | `{ key, from, to }` — QA switches, AI opt-out, TM/glossary refs |
| `ai.requested` | segment | §4 |

`platform.sqlite`: `auth.login`, `auth.login_failed`, `auth.logout`,
`account.created`, `authorization.granted` / `authorization.revoked`
(`vendor-spec.md`'s `project_authorization`), `project.created`,
`project.deleted`, `file.downloaded`.

`portal.sqlite`: `auth.login` / `auth.login_failed` for admins,
`file.downloaded` (by client or admin), `file.delivered`. Order
transitions stay in `order_event` (decision 7), which gains `actor` and
`actor_label` columns and the same append-only triggers.

**In code** (backlog #55, `core/audit/actions.ts`): one list per
database — `PROJECT_AUDIT_ACTIONS`, `PLATFORM_AUDIT_ACTIONS`,
`PORTAL_AUDIT_ACTIONS` — because each file's `CHECK` should admit only
the actions that can happen *in that file*; `auth.login` in a
`project.catdb` is a write path that should not exist. An action in two
lists (`file.downloaded`) has one detail type. `AuditDetail` maps each
action to its detail shape; keys are snake_case because they are
stored JSON, not TypeScript. The `project.catdb` details are the table
above; the `platform.sqlite` ones are fixed in §2.5. The
`portal.sqlite` details are typed `null` until `#58` fixes them — the
subject and actor already say who and what, and `detail` is JSON
`TEXT`, so giving one a shape later is a type change, not a migration.

Snapshotting the full target after each change (not a diff) is
deliberate: a segment is a few hundred bytes of JSON, a diff format would
be a second tokens-comparison to specify and maintain, and "what did it
say at 14:02" becomes one row lookup. The editor saves at segment
boundaries (leave, confirm), never per keystroke — an event per keystroke
would be the warning-storm lesson again.

### 2.3 Batches

A bulk operation — pre-translate over 5,000 segments, a find-and-replace,
propagation — writes one parent event (`project.pretranslate`) and one
child event per segment it changes, each with `batch_id` pointing at the
parent. That makes "what did this batch touch" one indexed query, and it
is the foundation a batch undo would stand on, the way `tuv_history`
already is for the TM.

### 2.4 In `project.catdb` (backlog #56)

What the first file to carry the log settled, for `#57`/`#58` to reuse
rather than re-decide:

- **One writer, in `db/audit/events.ts`**, shared by every database:
  the table's DDL (`auditEventDdl(actions)`, the `CHECK` generated from
  that file's action list), `appendAuditEvent`, `listEvents`,
  `listBatch` and `verifyAudit`. The genesis reads the file's own
  `PRAGMA application_id`, so no caller can chain a log against the
  wrong kind of file. The next id is `max(id) + 1`, read inside the
  write's transaction — it has to be known before the row is hashed.
- **The actor travels as `AuditActor { actor, label }`**
  (`core/audit/actor.ts`): the principal, plus the display label
  snapshotted into `actor_label`. The label is required-but-nullable:
  a caller must say it has none (`system:` jobs), not forget it. The
  `.ctm`'s `updated_by`/`changed_by` receive the label (§2.1).
- **Subjects**: `segment` and `file` use the row id as decimal text;
  `project` has `subject_id` `NULL` — the file *is* the project.
- **A write that changes nothing records nothing.** `setSegmentTarget`
  compares the new target, status and origin with the stored ones and
  returns `false` without an `UPDATE` or an event when all three are
  equal. Without it, every pre-translate re-run would log one event
  per already-matched segment — thousands of rows saying nothing
  happened, the warning-storm lesson in a table that can never be
  pruned. A confirm still logs `segment.confirmed`, because the TM
  write happened even when the segment's state did not change.
- **Confirming writes two events**: `segment.target_set` (the state
  now reads `confirmed` — the snapshot rule needs it) and then
  `segment.confirmed` with the TM unit's `uuid` and the target
  variant's `rev`.
- **Pre-translate plans, then writes.** The parent's `counts` must be
  in its row before any child can point at it, and a hashed row cannot
  be amended afterwards. So the run decides every placement first,
  writes `project.pretranslate` with the final counts and the attached
  TMs' paths in priority order, then writes the children — all in one
  transaction, as before. A run that changes nothing still writes its
  parent: the run happened.
- **Export records at production.** `exportFile` returns the bytes and
  writes `project.exported` with their SHA-256; what the caller does
  with them is outside the file.
- **Not yet audited**: the settings writes (`qa_rule_setting`,
  `tm_ref`, `glossary_ref`, the untranslated allowlist) and QA
  dismissals. `project.setting_changed` exists in the vocabulary, but
  its `key` names are a design of their own; recorded as a follow-up
  rather than guessed here.

### 2.5 In `platform.sqlite` (backlog #57)

Platform schema v3 adds the same table through `auditEventDdl`, its
`CHECK` generated from `PLATFORM_AUDIT_ACTIONS`. No baseline: nothing
before v3 recorded who created an account, and §6's rule is never to
invent an author. What the second file to carry the log settled:

- **Nothing personal goes in `detail` or `subject_id`.** Both are
  inside the chain, and erasure (§5) can only touch `actor_label`. An
  email in a hashed column could never be erased without breaking the
  chain. So `account.created` is subject `account`, id the account's
  row id, detail `null`: the email is in the `account` row, which the
  erasure feature can delete. The same holds for every file that
  gains the log.
- **A failed login has no authenticated principal**, so its actor is
  `system:login` (label `NULL`), the gate that refused it. It is never
  the account the request named: that would record the attacker as
  the victim. The subject is that account when the email matched one,
  `NULL` otherwise. Detail is `{ reason: 'unknown_email' |
  'wrong_password' }`, which the log keeps but the HTTP response never
  distinguishes. The email that was tried is not recorded (see the
  first bullet).
- **Login and logout are the account's own acts**: actor and subject
  are both `account:<id>`. Each is written inside the same transaction
  as the session row it creates or deletes. A logout that finds no
  session writes nothing.
- **A project in this file is `subject_type` `project`, `subject_id`
  `<account id>/<name>`**: the two coordinates its path is built from.
  It is never the storage root, which is a capability, not a name. A
  name reused after a deletion is the same subject by design: it is
  the history of that slot.
- **`file.downloaded` is `{ file_id, name, sha256 }`**: the file's id
  and name in the file it came from, and the digest of the bytes sent.
  A download from a project also leaves `project.exported` in the
  project's own log (the document was produced), and `file.downloaded`
  here (it left, to whom). These are two facts in two files, not one
  fact recorded twice. `#58`'s portal downloads reuse the same shape.
- **Across two files, the event is written before the effect is
  visible.** A project's creation or deletion is a filesystem change
  that no SQLite transaction covers. So `recordProjectChange` appends
  the event and then makes the change *inside* the platform
  transaction: if the change throws, the event rolls back. The one
  unrecorded window left is a failed `COMMIT` after a successful
  change. A download commits `file.downloaded` before the first byte
  is sent, so a failed write means the bytes never leave.
- **The server resolves the actor once.** The session gate sets the
  request's account, and `auditActor(account)` is the one place an
  `AuditActor` is built from it: `account:<id>`, labelled with the
  email. Every route passes that to the `db` write it wraps. The
  failed-login actor is the one other constant in the file.
- **The segment-write route writes into the project's log, never
  this one** (decision 5). `PUT /api/projects/:name/segments/:id` is
  `setSegmentTarget` with the session's actor. Fastify's request
  logging carries method, URL and status, never a body. A test pins
  that: it writes a target through the route with a logger attached
  and asserts the target's text is absent from every line.
- **`authorization.granted` / `.revoked`** stay in the vocabulary
  unwritten until `#45` (`project_authorization`) exists. Whichever of
  the two lands second writes them.

## 3. The chain, and what it proves

```
chain_hash(row) = SHA-256( prev_chain_hash ‖ canonical(row) )
prev_chain_hash of the first row = SHA-256('CATA:' ‖ application_id)
canonical(row) = JSON of [id, at, actor, action, subject_type,
                          subject_id, batch_id, detail] — fixed order,
                          no whitespace, detail as stored
```

`actor_label` is deliberately **outside** the canonical form (§5).
`verifyAuditChain(rows)` in `core/audit/chain.ts` is pure: rows in,
first broken id out — provable from a test with no database, per the
headless rule.

What it proves: no row was edited, removed, or inserted between two
others **since the head hash was last seen**. What it does not prove:
that someone with the file and `sqlite3` did not rewrite the whole chain
from some point on. Anchoring the head hash outside the file (in
`platform.sqlite`, in an export, on a delivered job) is what closes that,
and is deferred until a real need names where the anchor should live.
The chain is written now because it is the part that cannot be added
retroactively; the anchor can.

### 3.1 The bytes (backlog #55)

The formula above leaves four choices open; `core/audit/chain.ts` fixes
them, and this is their record:

- **Hashes are lowercase hex**, and `‖` is string concatenation: the
  hash input is the UTF-8 encoding of `prev_chain_hash` (64 hex
  characters) followed by `canonical(row)`.
- **`application_id` is written in decimal** — the integer
  `PRAGMA application_id` returns, as `String(n)` spells it. The
  genesis therefore differs per kind of database, so a chain lifted
  from a `platform.sqlite` into a `project.catdb` fails at its first
  row.
- **`canonical(row)` is `JSON.stringify` of the eight-element array**,
  with SQL `NULL` as JSON `null`. `detail` goes in as the *string*
  stored in the column, never re-parsed: re-serialising a parsed object
  could reorder its keys, and the chain must depend only on bytes that
  are actually in the file. The writer hashes the exact string it
  stores.
- **`verifyAuditChain` reads rows in ascending `id`** and reports the
  first row whose stored `chain_hash` differs from the recomputed one,
  or whose `id` does not exceed the previous row's. An edited row is
  reported as itself; a deleted row as the row after it (whose hash was
  chained from the missing one); an inserted row as itself, or as the
  row after it if the insert was hashed correctly. **Removing rows from
  the end is invisible** — the surviving prefix is a valid chain — which
  is exactly the gap the deferred anchor closes.

## 4. AI provenance (a requirement on Epic 8)

Epic 8 is not designed yet (`ai-platform-vision.md` §3). This section
fixes what its design must record, so it cannot be built without it:

- **A suggestion is not a write.** Prefetched drafts live outside the
  segment until accepted. Acceptance is a `segment.target_set` with
  `origin` `mt_draft` / `mt_claude_polished` and the human who accepted
  it as actor; later edits are later events. "Was the MT reviewed?" is
  then answerable per segment: an accept followed by a confirm, with or
  without an edit in between.
- **`detail.provenance`** on that event: `{ engine, model, prompt_version,
  input_sha256 }` — the engine (`deepl`, `anthropic`), the exact model
  id, the version of the prompt template (a named, versioned artefact,
  never an inline string), and the digest of the assembled input. Not
  the prompt itself: it contains the TM matches and glossary and would
  copy client content into the log a second time for no gain the digest
  does not give.
- **`ai.requested`** is written when client content is sent to an
  engine, whether or not the result is accepted — that is the
  data-leaving event (decision 9), and it is what shows a per-client
  opt-out (`ai-platform-vision.md` §5.2) was honoured: a project with AI
  switched off has a `project.setting_changed` recording it and no
  `ai.requested` after it.

## 5. Personal data and retention

- **Retention: never pruned automatically.** An audit log follows its
  file: deleting a project deletes its log (and `platform.sqlite`
  records `project.deleted`). Compaction, as for the TM
  (`tm-format-spec.md` §10), is explicit and never touches
  `audit_event`. The Enterprise-tier promise in `pricing-model.md` §3
  (12-month retention, export) is met by export (§7), not a separate
  store.
- **Erasure pseudonymises, it does not delete.** A GDPR erasure request
  for a person sets their `actor_label` to `'[erased]'` in every file
  their account touched — the one UPDATE the trigger allows — and leaves
  `actor` (`account:3`) and every event intact. That is why the label is
  outside the chain: erasure must not look like tampering. Whether the
  platform keeps a tombstone `account` row mapping the id to nothing is
  for the erasure feature to decide; the log does not depend on it.
- **Audit rows are client content** where `detail` carries target
  tokens. They inherit the confidentiality of the file they sit in —
  which, per decision 5, they do automatically.
- **Application logs are not the audit trail** and must never carry
  segment text or tokens. The Fastify logger is operational, may be
  dropped or rotated, and runs outside any transaction.

## 6. Migration of existing data

`project.catdb` v5 creates `audit_event` and writes one
`segment.baseline` event per existing segment that has a target, actor
`system:migration`, with the segment's current state. The history is
then complete from the migration forward and honest about before: a
baseline says "this is what it was when recording began", never
inventing an author. The same pattern applies to `order_event` rows
that predate the `actor` column: `actor` is `system:migration`,
`actor_label` is NULL.

## 7. Reading it back

The minimum, so a log is not write-only:

- `db`: `listEvents(db, { subjectType, subjectId })`, `listBatch(db,
  batchId)`, `verifyAudit(db)` — repository calls, per the CLI/server
  rule that each route or command is one of them.
- CLI: `cat-tool history <project> <segment-id>` and
  `cat-tool audit-verify <project>`.
- An export (JSON Lines, one event per line, chain hashes included) is
  the interchange format, the way TMX is for the TM.

The editor's per-segment history panel and a PM-facing audit view are UI
work, gated behind Epic 6 like every other screen.

## 8. Open, deliberately deferred

1. **Anchoring the chain head** outside the file (§3). Needs a named
   consumer first.
2. **Audit for `.ctv`** (vendor data). `vendor-spec.md` already plans
   rate history and an `assignment_event` log; backlog `#46`/`#48` must
   give both an `actor` from their first migration and use `audit_event`
   for anything else — noted here so the vendor schema is written with
   it, not retrofitted.
3. **Whether `tuv_history` gets append-only triggers.** It is the right
   thing, but `.ctm` is a frozen, specified format (`tm-format-spec.md`)
   and triggers are part of the file; it needs a `user_version` bump and
   its own spec change, not a rider on this one.
