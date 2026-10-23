# Tenancy — spec

Status: decided 2026-10-23 in a scoping conversation with Louis (issue #290). The
build is slices 1 to 5 (issues #291 to #295); this file is the design they share.

Extends: `ai-platform-vision.md` §2 and §5, `v1-spec.md` §4.1a, `vendor-spec.md`
§1, `worldwide-and-compliance-spec.md` §3 and §6.

## 0. Why now

`ai-platform-vision.md` §2 (2026-08-30) decided Tessera is "built to eventually
sell to other LSPs and freelancers, proven first on one real triangle", and
said that extending to other users later is additive, not a migration. On
2026-10-23 Louis said the sale is the plan: **a tenant is a customer Language
Service Provider.** This spec writes down what additive means, so the work is
done once, in order, rather than found one route at a time.

It lifts one deferral and keeps the other. The **data model** for several LSPs
is built now. **Self-service signup, pricing and billing** stay deferred
(`ai-platform-vision.md` §5's "no generic multi-tenant signup now" still holds
for those), because they are commercial calls that are Louis's (§9, O4).

## 1. Terms

- **Tenant.** One LSP, the unit that is sold: the organisation that owns a
  storage root, a vendor roster, its clients, their engine consents, its
  webhooks and its project grants. In code `tenant`; the interface word is O6.
- **Staff.** An account that belongs to a tenant, with a role there
  (`admin`, `pm`). Today's "owner account" is a staff account.
- **Vendor.** An account with the vendor role. It belongs to **no** tenant
  (D3); it reaches one only through that tenant's roster.
- **Client.** A tenant's customer. Still a number the tenant typed, never an
  account, never checked against `portal.sqlite` (`CLAUDE.md`, backlog #130).

## 2. Where it stood (read from the code, 2026-10-23, before slice 2 landed)

- `account` has `storage_root` (`u/<96 bits hex>`) and a `role` of `owner` or
  `vendor`. The role classifies and permits nothing.
- **The owner account is the tenant, in all but name.** Every project, memory,
  glossary and the `.ctv` roster live under that account's root
  (`server/src/storage.ts`). A project is named by `(owner_id, slug)`.
- Five platform tables key on an owner account and no other tenant notion:
  `project_authorization.owner_id`, `roster_membership.owner_id`,
  `vendor_invitation.owner_id`, `client_engine_consent.owner_id`,
  `client_engine_default.owner_id`. All five are leaf tables (nothing references
  them), so `rebuildTable` can re-key them.
- One person is one owner. Two colleagues of one agency cannot share a project
  except by granting each other `assigned_translator`, a vendor scope. That is
  the gap that stops a real LSP using it.
- `portal.sqlite` has one admin and one client list (`portal-v0-spec.md` §7).
  It is a separate server and file, outside `platform.sqlite`.
- `telemetry-spec.md` and `worldwide-and-compliance-spec.md` already say
  "tenant" (a `pid`, control 1 "tenant isolation", "per-tenant files"), meaning
  the owner account. This spec gives the word its definition.

## 3. Decisions (2026-10-23)

**D1. A tenant is an LSP, one row in `platform.sqlite`.** It owns the storage
root, the roster, client numbers and consents, webhooks, project grants, AI
spend and, later, a region. Everything an owner account owns today moves to it.

**D2. Staff belong to exactly one tenant, through a membership table.**
`tenant_membership` is a table, not a column on `account`, so that "one person
in two tenants" is a relaxed constraint later and not a migration. v1 keeps
`UNIQUE (account_id)`: one email, one tenant (O1). A consultant who works for
two LSPs has two accounts.

**D3. A vendor is not tenant staff.** A freelancer who translates for two LSPs
has one account and one roster entry in each tenant (`roster_membership`,
re-keyed to the tenant). Nothing of one tenant's work is visible through the
other: grants, assignments, payables and the vendor record (#123) are per
tenant already, because each `.ctv` is. A tenant never sees a vendor's other
tenants.

**D4. The storage root belongs to the tenant and is minted once.** The existing
owner's `u/…` root becomes their tenant's root, so **no file moves**. Slice 1
(#291) makes that the rule for every tenant: it takes its founding admin's
account root, copied once, because until slice 2 moves the readers every file is
still under that directory. Whether a tenant created after slice 2 mints its own
root is slice 2's call. The root is never chosen by a caller and no path comes
from a request (`CLAUDE.md`, _The API server_), unchanged.

**D5. Two staff roles, and a table says what each may do.** `admin`: everything,
including staff, engine consent, webhooks and settings. `pm`: projects,
memories, glossaries, roster, assignments, payables. The table is one pure
function in `core/auth` (`tenantRoleAllows(role, action)`), the shape of
`scopeAllows`, so a route asks and never re-encodes. The last admin cannot be
removed. A reviewer role is the next addition and is a migration, as a project
scope is.

*Built (slice 3, #293):* `TENANT_ACTIONS` are `work`, `staff`, `consent` and `webhooks`; a pm has only
`work`. A staff link is its own table, `staff_invitation`, with the tenant and role fixed at invitation, and
the last admin cannot be removed or demoted (two triggers under the repository's check). Removing staff ends
their sessions; the account stays, tenantless.

**D6. The tenant comes from the session, never from the request.** A route
resolves it from the authenticated account's membership. The one place a
request names a tenant is a grantee opening a project in someone else's tenant
(`?tenant=<id>`; it was `?owner=<account id>` before slice 2, #292), and that opens only
through a grant; no grant is the same 404 as a missing project. A path built afterwards
uses the opened tenant, never the session's. An account with no tenant (a vendor) is not
refused on a read: it is shown what its empty storage root always showed it, an empty list
or the 404 of a missing object, and is refused (403) only where it would create something.

**D7. Tenants are provisioned by the operator.** `create-tenant` on the command
line, beside `create-account`. There is no signup route, no trial, no plan.
Decided against building signup first: it needs email, payment and abuse
decisions that are not ours to guess (O4), and everything isolation needs
works without it.

**D8. Per-tenant files stay.** Translation content stays in per-tenant SQLite
files, not a shared multi-tenant RDBMS. `worldwide-and-compliance-spec.md` §3
already argues it: a tenant is one folder, so moving it to another region, or
deleting it, is a copy or a removal. `storage-architecture.md`'s open RDBMS
question should not take that away without weighing it.

**D9. The audit actor stays a person; the tenant is what the event is about.**
An event is attributed to an account as now (`actor` required, an AI engine is
an `origin`). New actions, each a frozen literal widened with `rebuildTable`:
`tenant.created` and `tenant.renamed` (slice 1, built), then `tenant.member_added`,
`tenant.member_removed` and `tenant.role_changed` (slice 3). No event carries a
name or an address: a detail is hashed. Whether the platform log also carries a `tenant_id` is
O3.

**D10. Telemetry names a tenant by `pid`.** `HMAC(telemetry_key, "tenant:<id>")`,
as `telemetry-spec.md` §6.3 does for `account:<id>` today. AI cost is per tenant
and never per person.

**D11. TypeScript throughout; no Rust/Wasm.** Asked 2026-10-23 as
`CLAUDE.md`'s rhythm requires, with the options of a Wasm isolation kernel and
a Wasm plugin sandbox. Louis chose to stay in TypeScript. The work is data and
access rules, with no hot kernel and nothing a benchmark has pointed at; the
existing vitest suites and `inject` tests cover all of it. A plugin sandbox for
LSP extensions is a different product question and would be its own card.

**D12. The first tenant is a company the owner already runs, and the operator
is a separate legal entity (decided 2026-10-23, Louis).** The first customer is
a real LSP that is the owner's own business, so every choice here is proven on
one before another is sold to. Louis intends a separate company to run Tessera
as a service; the first tenant is then a customer of it like any later one. That
is a legal and commercial matter for Louis and his advisers, not settled here;
the design only has to hold whichever way it goes, and it does, because the
operator is never a tenant (§7). Three consequences. The one existing install is
not a throwaway: its owner account becomes the first tenant's first `admin`, its
root becomes that tenant's root, and the portal it already runs becomes that
tenant's portal (§9 O2). **The tenant's name is data, never repo content**: this
repo is public and `NOTICE` keeps any company name out of it, so the name is
typed when the tenant is provisioned or renamed, lives in `tenant.name` in the
operator's file, and appears in no fixture, test, doc, issue or commit. Tests
use invented names. And **the first tenant needs the same paperwork as any
other** (§7, O4), because nothing in the data model treats it as special.

## 4. Data model

```sql
-- platform.sqlite v8, slice 1 (#291, built).
CREATE TABLE tenant (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL CHECK (length(trim(name)) > 0),  -- the LSP's display name
  storage_root TEXT NOT NULL UNIQUE,         -- the founding admin's account root, D4
  created_at   TEXT NOT NULL
);

CREATE TABLE tenant_membership (
  tenant_id  INTEGER NOT NULL REFERENCES tenant(id),
  account_id INTEGER NOT NULL REFERENCES account(id),
  role       TEXT    NOT NULL CHECK (role IN ('admin', 'pm')),  -- frozen literal
  added_at   TEXT    NOT NULL,
  PRIMARY KEY (tenant_id, account_id),
  UNIQUE (account_id)                        -- v1: one tenant per person (O1)
) WITHOUT ROWID;

-- D3 in the schema, not in a route: a vendor is never tenant staff.
CREATE TRIGGER tenant_membership_staff_only BEFORE INSERT ON tenant_membership
WHEN COALESCE((SELECT role FROM account WHERE id = NEW.account_id), 'owner') <> 'owner'
BEGIN SELECT RAISE(ABORT, 'a vendor is never tenant staff'); END;
```

Slice 2 (#292, built; platform schema v9) re-keys the five owner tables: each is
replaced by a table keyed on `tenant_id REFERENCES tenant(id)`, its rows copied through
`tenant_membership` (`rekeyTable`: `rebuildTable` cannot do it, because it copies the old
columns by name and the old column is the point). A row naming an owner that has no tenant
fails the migration and rolls it back, discarding nothing. `project_authorization`'s
`CHECK (account_id <> owner_id)` and `roster_membership`'s are replaced by triggers
(`project_authorization_not_staff`, `roster_membership_not_staff`): staff of a tenant already
have its projects and are not on its roster. `vendor_invitation` also records `invited_by`
(backfilled from the old `owner_id`, which was that one person), because the tenant is not a
person and the vendor account an acceptance creates is still attributed to the staff member
who vouched for it. A project is named by `(tenant_id, slug)` in `ProjectRef`, and in a log as
`t<tenant id>/<slug>`: events written earlier keep `<owner account id>/<slug>`, and the prefix
is what stops the two being mistaken.

`account.storage_root` stays, `NOT NULL UNIQUE`, and is never read for staff
once slice 2 lands. Dropping it needs a table rebuild that `account` cannot take
(other tables reference it, and `rebuildTable` refuses that until the runner
can turn foreign keys off before `BEGIN`), so it is a documented leftover, not a
second source of truth: the one path builder reads the tenant's root.

The roster file keeps its name and place (`<root>/vendors.ctv`), now one per
tenant. Its rows are keyed by vendor account id and do not change.

## 5. Migration of the existing install

Additive, in one platform migration (slice 1), on every existing file:

1. For each `account` with role `owner`: insert a `tenant` whose `storage_root`
   is that account's, named `Tenant <id>` (no personal address is used as a
   name); insert an `admin` membership. The operator then gives the first
   tenant its real name with `rename-tenant` (D12), an audited write, so no
   name is ever in a migration or in the repo. The migration writes **no audit
   event**: nothing recorded who made these and an author is never invented
   (`audit-spec.md` §6).
2. Nothing else changes in slice 1. Existing sessions, grants and files work
   as before because no reader looks at the new tables.
3. From then on `createAccount` founds a tenant for every `owner` account it
   makes, in the same transaction, so no owner is ever without one and slice 2's
   backfill has nothing to miss. This replaces the `bringTenantLevel` mender this
   section first proposed: a roster entry spans two files and needs mending, but
   a tenant and its admin are rows in one file written together.

Slice 2 then switches the readers in one release. A rollback of slice 2 is the
backup the runner already takes before a migration.

## 6. Isolation invariants (tests first)

Each is a hard invariant in the sense of `CODING.md`: a test exists and has been
seen to fail before the code that satisfies it.

1. **No cross-tenant read or write.** A session of tenant A, on every route,
   against tenant B's project, memory, glossary, reference file, job, roster,
   assignment, payable, webhook, consent and download, gets the response a
   missing object gets (404, identical body). One test walks the routes the app
   registers, so a route added later without an entry fails it (slice 4, #294).
2. **A path is built from the tenant's minted root and a validated slug.** No
   function takes a path from a request; a tenant id in a request selects a row,
   never a directory.
3. **A grant opens one project and nothing else.** A vendor with a grant in
   tenant A reads nothing of tenant A beyond it, and nothing at all of B.
4. **A tenant's last admin cannot be removed or demoted.**
5. **An invitation attaches an account only to the tenant that issued it.**
   Every unusable link is one identical 404, as today.
6. **A tenant's client numbers are its own.** The same client id in two tenants
   is two clients; consent and a default engine never cross.
7. **Deleting or exporting a tenant touches one root and one set of rows.**
   (Offboarding is not built in these slices; this is the property it needs.)

## 7. What is not tenant-scoped

- **Vendor accounts** (D3), which sit across tenants through rosters.
- **The operator.** Whoever runs the installation sees `platform.sqlite` and
  the ops stack (`telemetry-spec.md` §10); a tenant sees neither. There is no
  operator account in the product yet and none is added here: the operator is
  the command line and the server's own file system.
  The operator is not a tenant and has no membership in one. If a separate
  company runs the service (D12), it is expected to act as processor of each
  tenant's client data, with the tenant as controller, and each tenant signs
  a data processing agreement with it, the first tenant included. That
  reading is Louis's to confirm with counsel; it is recorded here because it
  is why the first tenant gets no shortcut in the data model.
- **The portal** (slice 5, #295) is the one surface that is not yet per tenant.
  It has its own server, database, single admin and client list, so a second
  LSP would share all of them. §9 O2 says how.

## 8. Slices

| Slice | Issue | What                                                                 | Size |
| ----- | ----- | -------------------------------------------------------------------- | ---- |
| 1     | #291  | `tenant`, `tenant_membership`, backfill, `createTenant`, `create-tenant`, `rename-tenant` | M |
| 2     | #292  | Key ownership on the tenant: paths, grants, roster, invitations, consent (built) | L |
| 3     | #293  | Staff roles, `tenantRoleAllows`, staff invitations (built; its screen is #300) | M    |
| 4     | #294  | Isolation matrix across every route; tenant-scoped audit view        | M    |
| 5     | #295  | A portal per tenant (needs O2)                                       | L    |

Order: 1, then 2; 3 and 4 follow 2 and are independent; 5 waits on O2. One
session on one slice at a time: slices 1 and 2 both change `platform/schema.ts`,
and migration numbers are checked against `main` just before merge.

## 9. Open for Louis

Each has a recommendation; none blocks slices 1 to 3.

- **O1. Can one person be staff in two tenants?** Recommended: no in v1, one
  email and one tenant. A consultant for two LSPs is two accounts. The table
  shape makes yes a later relaxation, not a migration.
- **O2. One portal file per tenant, or a `tenant_id` across the portal's
  tables?** Recommended: a file per tenant. The portal holds uploaded client
  files, so it follows the same placement and deletion rule as D8. Cost: the
  portal server opens a database by tenant, and a tenant's admin is created per
  file. Blocks slice 5 only. With D12 the existing portal file simply becomes
  the first tenant's, with no data move, which favours a file per tenant: the
  column option would have to back-fill every portal table for that tenant.
- **O3. Does the platform `audit_event` carry a nullable `tenant_id`, inside the
  hash?** Recommended: yes (operator events have none). It lets a tenant's admin
  read their own slice and lets an operator export one tenant's slice on
  offboarding. It changes the hash input, which `audit-spec.md` must record, and
  is why it is a decision and not a default. Blocks the audit half of slice 4.
- **O4. Self-service signup, plans and billing.** Not now. A commercial and
  legal call (price, trial, who is the data controller, the DPA a tenant signs),
  and `ai-platform-vision.md` §5 deferred the paperwork until a client needs it.
  The first LSP is a company the owner already runs (D12), provisioned by hand;
  its agreement with the operating entity is still a document to write.
- **O5. The region unit.** `worldwide-and-compliance-spec.md` §3.1 leaves it
  open. Recommended: the tenant, with a `region` column added when a second
  region exists, not before.
- **O7. A subdomain per tenant (#298).** Louis, 2026-10-23: a domain for the platform and a
  subdomain per LSP. It fits: it is the usual pattern, it gives each tenant its own browser
  origin (a token is kept per origin, so a login on one is not on another), and D8 makes the
  tenant the region unit, so a subdomain can later point at a region. Conditions: the host is
  a hint, never the authority (the session still names the tenant, D6; a mismatch is refused);
  the slug is a public name and is not `tenant.name`; one wildcard certificate so customer
  names stay out of Certificate Transparency logs. **Decided (Louis, 2026-10-23): a vendor
  signs in on each tenant's subdomain**, not on a neutral host. So the host check applies to
  every session: a vendor session is valid on tenant T's host only if the account is on T's
  roster, and the vendor routes that today span every roster (`/api/vendor/feed`,
  `/capacity`, `/payments`) answer for the host's tenant only, so one LSP's page never shows
  another LSP's work. The cost is accepted for simplicity: a freelancer on three rosters has
  three logins and no combined feed or payment record. A neutral host remains possible later
  and would not change the host check.
- **O6. What the interface calls it.** Recommended: "organisation" in the UI,
  `tenant` in code; the glossary records the code word. Louis may prefer
  "workspace".

## 10. What this teaches the existing specs

Slice 2 landed 2026-10-23. `CLAUDE.md`'s invariants that said "owner account" (the `.ctv` is
one per tenant, a consent is the tenant's, a path is built from the tenant's root) now say
tenant, and `vendor-spec.md` carries a note at the top that its "owner" is the tenant and
its `?owner=` is `?tenant=`. They were true in the same words with that one noun changed,
which is why this was a re-keying and not a redesign.
