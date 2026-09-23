# Worldwide deployment and compliance by design

Status: **direction decided, nothing built.** Written 2026-09-23, from a
session with the owner that started as "how do we deploy this" and
became "who is this deployed _for_". Reasoning is kept on the record, not
just the conclusions, so that none of it is re-litigated per feature.

## 0. Why this exists

The product is meant to be used worldwide. The owner's example: a
**purchaser in the USA** orders a job that a **translator in Kuala
Lumpur** translates. Two questions follow, and they turn out to be the
same question seen twice:

1. How does the app stay fast for someone a continent away from the
   server?
2. What can we honestly promise a client about where their data is and
   who sees it?

The owner also decided that the second question is a **selling point**,
built into the product from the first line of code rather than added as
paperwork later (§6). That reverses part of a recorded decision; §6.1
says which part and why.

None of this changes `@cat-tool/core`, the DOCX filter, the `.ctm`
format, or the roundtrip gate. It decides where things run and what
they are allowed to see.

---

## 1. The one physical constraint: distance

A round trip Kuala Lumpur → US server → Kuala Lumpur costs about a
quarter of a second whatever the server's size. Only moving the server,
or the work, closer changes it. So the question is never "how do we make
it fast everywhere" but "**who needs speed, for what**":

| | Purchaser (portal) | Translator (editor) |
|---|---|---|
| Server round trips | A few per order | Thousands per job |
| Notices 250 ms? | No | Yes — every segment |

**Rule: the work goes close to the translator; the purchaser can be
anywhere.** Moves A–C below apply that rule, cheapest first.

---

## 2. Move A — the translator works in the browser on a job package

`v1-spec.md` §2 and §7 plan an SPA that calls the API for everything.
From far away, the calls the translator _waits on_ — next segment's TM
matches, QA on confirm — are the ones that hurt. Autosave (backlog #31)
does not, because nobody waits on it.

**Decision:** when a translator opens a job, the server sends a **job
package**: the segments, with their TM matches already computed (what
`pretranslate` already does), and the project's QA settings. Segmenting,
tag handling and QA then run **in the browser**, at local speed. Only
rare, explicit actions (concordance search) go back to the server.

**Confirmed segments go into an outbox** that syncs in the background
and survives a dropped connection, keeping #31's "a crash costs seconds"
true on hotel wifi.

Why this is feasible: `core` is headless by rule (CLAUDE.md), and its
only runtime dependency is `fflate`, which runs in browsers. Two
`node:crypto` uses exist (checked 2026-09-23):

- `core/tm/normalize.ts` — SHA-256 segment hashing. Needs a browser
  path (Web Crypto's `subtle.digest`, which is async) before hashing can
  run client-side. Small, contained, but the async signature is a real
  design point, not a find-and-replace.
- `core/auth/credentials.ts` — passwords and sessions. Stays server-side.

What it costs:

- **Two copies for a moment** (browser ahead of server until the outbox
  drains). Safe while **one person edits a file at a time**, which is
  how the vendor assignment model hands out work (`vendor-spec.md`:
  accepting a job resolves to exactly one acceptance). A reviewer role
  is still open there (§3); if it lands, reviewing while the translator
  works is the first simultaneous-editing case, and gets designed
  deliberately then.
- **More logic in the browser** — covered by the same headless tests
  that already prove it.

It also serves §5: the translator receives **only the matches for their
job, never the client's memory**. Minimisation falls out of the
performance design rather than being bolted on.

**When:** decide before Epic 6 (#28–#35) is built. It shapes the
editor's data flow, and retrofitting it after is a rewrite.

---

## 3. Move B — regional servers

**Decision:** data lives in **regions** (e.g. Frankfurt, Singapore,
Virginia), each running the same container from the same
infrastructure-as-code blueprint. Start with **one** region; add one
when a contract requires it or when slowness is _measured_.

Why this is cheap here and expensive almost everywhere else: data is
already partitioned by file. Each account is one folder
(`server/src/storage.ts`: `u/<hex>/projects/*.catdb`), so moving a
client means copying a folder, not untangling a shared database. The
only global state is `platform.sqlite` (accounts, sessions) — small and
read once per login, so it can live in one home region.

**This is an argument in `storage-architecture.md`'s open RDBMS
question:** per-tenant SQLite files are what make regional placement a
copy. A shared multi-region RDBMS is the expensive global architecture
this design avoids. Whatever that document decides for Vendor's
multi-writer data, it should not take away per-tenant files for
translation content without weighing this.

Moves A and B **reinforce each other**: without A, a project would have
to sit near its translator for speed, even if the client's contract
says otherwise. With A, speed is solved in the browser, so the region
can be chosen for the **client's legal and contractual needs alone**.

Routing: start with **regional addresses** (`eu.…`, `us.…`). A single
address with a routing front door can come later without moving data.

### 3.1 Open: what is placed in a region — account or project

Not decided. Leaning **per client account**.

| | Per client account | Per project |
|---|---|---|
| Matches contracts ("our data stays in X") | Directly | Must be checked per project |
| TMs next to projects | Always | A client's TM may be in another region |
| Fits today's code | Already one folder per account | Needs region per project + lookup |
| Client needing two regions | Two accounts | One account |
| Moving a client | Everything at once (can be GBs) | Small moves |
| Placing data wrongly by mistake | Hard | Easy, per project |
| Proving it in an audit | One server per client | A report over every project |

Who carries the complexity: per account, the rare multinational client
(two logins); per project, the operator, on every project, forever.
Per account can later become per project by splitting an account; the
reverse is much harder. §5 also weakens the question: storage location
is one of four things a client asks, not the whole promise.

### 3.2 Open: a TM shared across regions

An agency master TM serving projects in several regions has no clean
answer yet. Move A makes it rarer (matching happens once, at job
preparation), but not legal: a client's translations must not reach a
region they did not agree to. Per-account placement (§3.1) avoids it for
client TMs; it remains for an agency's own cross-client memory.

---

## 4. Move C — CDN for static files only, EU-owned, later

**Decision:**

- When a CDN is added, it carries **the app's static files only**
  (HTML, JS, CSS, icons) — never an API response, never client content.
  The browser talks to the client's regional server **directly**.
- **EU-owned provider** (e.g. Bunny.net) over a US-owned one, for
  consistency with §5.2. It still sees visitors' IP addresses (personal
  data), so it goes on the subprocessor list (§6.2, control 10).
- **Not before launch.** Add it when distant users say the app is slow
  to _open_. Slow _working_ is Move A's problem, not the CDN's.

Rejected: whole-site proxying through the CDN. Simpler, and it adds
attack protection, but every client document would then transit the
CDN's machines in plain text in every city it serves from — making the
CDN a subprocessor of client content and undoing §3 and §5. The
regional servers take on their own basic protection (firewall, rate
limits) instead.

---

## 5. What "data stays in X" means in 2026

The phrase hides four questions, and clients' lawyers ask all four:

1. **Where is it stored?** (the disk)
2. **Who can see it?** (people, anywhere)
3. **Which government can compel it?** (the provider's owner, not the
   disk's location)
4. **Where does it travel?** (backups, logs, emails, AI and MT services)

Three facts shape the product's answer. This is orientation for
product design, **not legal advice**: contract wording gets a lawyer's
review before it is sold.

### 5.1 Remote access is a transfer

Under GDPR, access from outside the EU is a transfer even if the file
never moves. A worldwide translator network therefore **cannot**
promise "the data never leaves the EU" — reading it abroad is the
service. It can promise transfers done properly: a data-protection
contract with each translator (standard contractual clauses), and
**minimisation** — which Move A delivers (the job package, never the
memory).

### 5.2 The provider's owner matters as much as the region

The US CLOUD Act (2018) reaches data held by US-owned providers wherever
it is stored. Data on a US hyperscaler's Frankfurt region is in
Frankfurt, and still in reach. "Sovereign cloud" offerings are the
2025–2026 response. **EU-owned hosting** (Hetzner, OVH, Scaleway,
IONOS) is therefore part of the promise, not a price choice.

### 5.3 Some regimes exclude the model itself

- **EU (GDPR):** permits transfers with safeguards. "Keep it in the EU"
  is usually a client's contractual demand, stricter than the law.
- **US:** no general localisation law, but sector rules. **ITAR**
  (defence technical data) limits access to US persons: a translator in
  Kuala Lumpur is excluded by the rule itself, whatever the software
  does. **HIPAA** has no certification; it is a Business Associate
  Agreement per client plus safeguards.
- **Malaysia (PDPA, amended 2024)**, and strict localisation regimes
  (China, Russia) exist and are out of scope until a client needs them.

The product's answer to a regime it cannot meet is to **refuse cleanly**
— a restricted job only reaches eligible translators (control 11) — not
to claim compliance.

### 5.4 The promise the software should be able to enforce

> Your files and memories are **stored** in [region] with an
> **EU-owned** provider. Translators see **only the job assigned to
> them**, under a data-protection contract. Nothing goes to an AI
> service without your say-so. Here is every service that touches your
> data.

Every clause maps to a mechanism: region per account (§3), the job
package (§2), the per-client AI switch (`ai-platform-vision.md` §5 item 2),
and the subprocessor list (control 10).

---

## 6. Compliance: design now, certify later

**Decision (owner, 2026-09-23):** every privacy and security control is
built into the architecture from now on. **Certification** — SOC 2,
ISO 27001, signed HIPAA BAAs — happens when a paying client needs it.

The reasoning: controls are cheap before real data exists and expensive
after (audit history cannot be recovered retroactively; encrypting files
clients already hold is a migration). Audits are expensive at any time.
Target sectors, all four: **healthcare/pharma, legal/patents,
corporate/tech/marketing, public sector.**

### 6.1 What this changes on the record

- **Reverses** `ai-platform-vision.md` §5 item 4 ("GDPR paperwork …
  deferred until it's needed … building the compliance machinery before
  there's a client who needs it is effort spent on the wrong thing").
  The **machinery** is now built by design. The **paperwork** (a DPA or
  BAA per client) is still produced when a client needs it.
- **Keeps** `pricing-model.md` §3: SOC 2 Type II stays Enterprise-gated,
  about 18 months post-launch, because the ~€30,000 audit preparation is
  not recoverable at early-stage pricing. Designing the controls now
  makes that audit cheaper when it comes; it does not bring it forward.
- **Promotes** `tm-format-spec.md` §10's "encryption at rest is not in
  v1" to a first-priority control (§6.3, item 3).

### 6.2 Common controls

Frameworks mostly ask for the same controls under different names (GDPR
Art. 32, HIPAA Security Rule, SOC 2, ISO 27001). Each is built once and
mapped to each framework. Status as of 2026-09-23, checked in code:

| # | Control | Status |
|---|---|---|
| 1 | Tenant isolation | **Built** — per-account storage root, no path from a request (`server/src/storage.ts`) |
| 2 | Credential storage | **Built** — scrypt passwords, hashed session tokens (`core/auth/credentials.ts`) |
| 3 | Access control (who opens which project) | Planned — issue #84, `project_authorization` |
| 4 | Audit log | **Missing** |
| 5 | Encryption at rest | Reserved — SQLCipher option, `tm-format-spec.md` §10 |
| 6 | Encryption in transit (HTTPS) | Not deployed — backlog #36 |
| 7 | Deletion and retention, backups included | **Missing** — only logout deletes anything today |
| 8 | Data region per client | Direction set — §3 |
| 9 | Translators see only their job | Direction set — §2 |
| 10 | AI/MT switch per client + subprocessor list | Switch decided (`ai-platform-vision.md` §5 item 2), neither built |
| 11 | Restricted jobs (EU-persons-only, US-persons-only) | **Not yet considered** — belongs in vendor eligibility (Epic 9) |
| 12 | Two-factor login | **Missing** |
| 13 | Backups with tested restores | Partial — backup before migrations/bulk ops only |
| 14 | Export and portability | Partial — TMX export for memories |
| 15 | Incident response (detect, 72 h notification, record) | **Missing** — mostly process, not software |

### 6.3 Order: expensive-to-retrofit first

1. **Audit log.** History not recorded cannot be recovered. Build it as
   an **append-only log enforced by the schema** (`BEFORE UPDATE`/
   `BEFORE DELETE` triggers that abort) — the pattern `term_decision`
   already uses (`db/glossary/schema.ts`), so not even an administrator
   can quietly rewrite it. Auditors look for exactly that property.
2. **Access control** — issue #84; every later screen depends on it.
3. **Encryption at rest** — decided before launch, it costs almost
   nothing; after, it is a migration of every file clients hold.
4. **Deletion and retention** — touches every file type (`.catdb`,
   `.ctm`, `.ctg`, `.ctv`, backups); designed before those multiply.

Everything else follows normal feature order: adding it later does not
cost more than adding it now.

None of these has a backlog entry or issue yet. Creating them (one per
control, per CLAUDE.md's working rhythm) is the next step, and each
needs its own spec section before code.

---

## 7. Open risks

- **TM size at scale.** `tm-format-spec.md` §11 estimates the format
  holds to ~2M units; nothing has measured it. The real `.sdltm` files
  seen so far are tiny (largest 2,866 units, §8a.3); a mid-size agency
  master TM can reach 1–10M. Exact lookups (hash index) and concordance
  (FTS5) should scale; **fuzzy matching** (a v1 cut, `v1-spec.md` §4.3)
  is the risk, along with import, backup and cross-region copy times.
  Move A softens it: matching runs at job preparation, not per
  keystroke. A synthetic benchmark (100k/1M/5M units) was queued as a
  separate task on 2026-09-23; synthetic numbers still need confirming
  against a real large TM.
- **Region unit** (§3.1) and **cross-region TMs** (§3.2).
- **Legal review** of the §5.4 promise before it appears in a contract.
- **Interaction with `storage-architecture.md`** (§3): per-tenant files
  are load-bearing for regional placement.
