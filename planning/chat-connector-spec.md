# Chat connector — spec

**Status:** slices S1a and S1b built (backlog #378 and #381, 2026-11-11); the rest is design. Issue #152.
**Extends:** `ai-platform-vision.md`, `translation-engine-spec.md`, `audit-spec.md`,
`solo-translator-spec.md`, `tenant-spec.md`
**Decisions:** D15 and §6's O1, O2 and O5 are Louis's (2026-11-10), O6 his (2026-11-11). Every
other D is still a _proposal_ until he rules on the rest of §6. S1a and S1b build on D2 to D5 and
D11 only: they are read-only and send no document text, so they need none of the open points. How a
chat host identifies itself at sign-in (D19) is Louis's too (2026-11-11).

Louis asked on 2026-11-10 to rethink the product for a world where a translator
works from inside Claude or ChatGPT: they connect Tessera, hand over a document in
the conversation, and Tessera works behind it. He asked for research first, then
this spec.

## 0. What is being asked, in one paragraph

A translator opens their chat assistant, says "translate this contract into German
with my memory and glossary", and gets back a Word file with the formatting intact.
The assistant's own model writes the draft. Tessera does what a model cannot do by
itself: read and rebuild the file, supply what the memory and glossary already
know, check the result with rules the model cannot waive, and keep the record of
who decided what.

## 1. What the research found (2026-11-10)

Two research agents read public pages only, under the rules of
`competitive-research.md` §6. Their raw reports are not committed. A claim marked
**read here** was opened again by the session that wrote this spec; the others
rest on an agent's reading through a summarising fetch and are to be read again
before a slice depends on them. `unknown` means it could not be confirmed.

### 1.1 What the two chat hosts allow

| Question                          | Claude                                                                                                         | ChatGPT                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| How a third party plugs in        | A remote MCP server over Streamable HTTP, added by URL as a custom connector with no review (**read here**) [1] | An MCP server added as a custom server; the documentation calls the unit a plugin [3]            |
| Who can add a custom one          | Every plan, one on the free plan [2]                                                                           | Business and enterprise plans for full use; `unknown` for the others (the help page refused)     |
| An attached file reaches a tool   | Not documented. A report in the host's own tracker says a file can only be re-emitted through the model [5]     | Yes: a tool declares file parameters and receives a download URL and a file id (**read here**) [4] |
| A tool hands a file back          | Not documented; a link the person opens works                                                                  | A file reference exists; how a tool returns one is `unknown`                                    |
| Interactive UI in the conversation | MCP Apps, a stable specification (2026-01-26); inline and fullscreen; rendered on mobile [6][7]                 | The same standard, plus its own additions [8]                                                   |
| Time allowed for one tool call    | 240 seconds (**read here**) [1]                                                                                | `unknown` officially; developers report about 60 seconds                                        |
| Size of one tool result           | About 150,000 characters (**read here**) [1]                                                                   | `unknown`                                                                                       |
| Sign-in                           | OAuth 2.0 with PKCE; the client registers itself or names itself by a metadata document [9]                    | OAuth with PKCE; the same two ways to register [10]                                             |
| Features not supported            | Resource subscriptions, sampling, draft capabilities (**read here**) [1]                                       | `unknown`                                                                                       |
| Directory review                  | Read and write in separate tools, every tool annotated read-only or destructive, a privacy policy [11]         | The same kind of rules; a project with EU data residency cannot submit [12]                     |
| A write needs the person's consent | A tool not marked read-only prompts [11]                                                                       | A write asks for confirmation by default [3]                                                    |

Three consequences:

- **The file is the hard part, and it has a known answer.** Bytes cannot be trusted
  to pass through the model on either host. One competitor documents the pattern
  that works on both: the tool returns a short-lived upload link, the file travels
  outside the conversation, and the result comes back by a link (**read here**) [13].
- **"Sampling" is not available**, so a connector cannot ask the host's model to
  translate. The model translates only when it reads a tool result and writes the
  next tool call. The whole design in §3 follows from that.
- **Every bulk step must be a background job**, as it already is in the server.

### 1.2 What other translation tools ship

Competitor facts only. Twelve products with an agent interface were read [14].

- Almost all are a remote server with OAuth in front of the product's existing
  API, and most are about software strings and project management.
- Where a translate tool exists, the product's own engine translates. Two were
  found that instead hand memory, glossary and style context to the host's model:
  one hosted and read-only, one local and tied to a desktop CAT tool. The second
  sets what the model wrote to a draft status and limits a write to 40 segments
  per call (**read here**) [15].
- A formatted document translated from the conversation was found in two products,
  both by an upload link outside the conversation and both with their own engine.
- No product was found with a segment review screen inside the conversation.
- No hosted product was found that combines host-model drafting, the user's own
  memory and glossary, a formatted document round trip, rule-based QA and an audit
  trail. One vendor states that its connector's logs are not an audit trail.
- No independent account was found of a translator or an agency doing real
  document work this way. That is an absence in one sweep, not evidence of demand.

## 2. Where it sits

The connector is a fourth shell around `core` and `db`, beside the CLI, the API
server and the SPA. It changes none of them. `@cat-tool/core` stays headless and
never learns that a chat host exists.

It is not a second product and not a replacement for the grid. A tenant uses the
editor, the connector, or both on the same project, because both are the same
repository calls on the same files.

## 3. Decisions (proposed)

**D1. The host's model drafts; Tessera supplies files, memory, checks and the
record.** Tessera makes no call to a model for this path and holds no model key
for it. The division is the one §0 states. It is the opposite of what most
competitors ship, and it is the only division under which the product's existing
strengths (the roundtrip gate, the memory, the QA rules, the audit log) are what
the user is getting.

**D2. The first user is a solo translator working on their own client work.** A
solo translator is a tenant with one admin (`solo-translator-spec.md` D1), so the
connector needs no new kind of account. Staff of a larger tenant are the same
case technically; whether a tenant's clients' content may go to a chat host at
all is O1, and nothing ships to tenants with several staff before it is decided.
A vendor and anyone on a grant cannot use the connector in the first slices: what
a grantee may see is narrow by design (`GET /api/projects/:name/resources`), and
the engine is hidden from whoever does the work (`translation-engine-spec.md` D3).

**D3. The connector lives in `@cat-tool/server`, on the tenant's own host.** It
needs the session, the tenant, the storage root and the job registry, which are
all there. Each tool is one repository call with the protocol around it, the CLI
rule (`v1-spec.md` §2.4) a third time. Logic a tool needs that `db` lacks goes
into `db`. Its routes get entries in `server/src/isolation.test.ts` like any
other, and a host that is no tenant's stays the fixed 404.

**D4. A connection is a person's own sign-in, and the tenant comes from it.** The
chat host signs the person in through OAuth with PKCE on the tenant's host. The
token is stored as its hash, like a session, and resolves to one account and that
host's tenant; no tool takes a tenant, an account or a path as an argument
(`tenant-spec.md` D6). Connecting and disconnecting are platform audit events. A
tenant's SSO policy applies to this sign-in as to any other.

**D5. The actor is the person; the model is an origin.** Every write through the
connector names the account that signed in as its actor (`audit-spec.md` §2.1).
The host's model is never an actor. A draft it wrote and a person accepted has
the origin `mt_draft`, the one word for every engine, and no new origin names the
host (`translation-engine-spec.md` D41). The provenance on that event records the
engine as the chat host and the model as _unreported_: the server cannot verify
which model wrote a tool call, and a name the client claims is not a fact worth
hashing into a log. That a write arrived through the connector is recorded on the
event; how (a field in `detail`, or the session's kind) is for slice 1 to settle
against `audit-spec.md`.

**D6. Text leaves only through the gate, and the chat host is an engine.** This is
the decision that makes the design safe to build:

- The document goes to Tessera by an upload link, outside the conversation (D7).
  So the only way its text reaches the chat host is a tool result.
- A tool result that carries segment text, a memory match or a glossary rendering
  is therefore the data-leaving event. It goes through `engineFor`, fails closed
  exactly as today (no client number, no consent row: nothing is returned), and
  writes `ai.requested` before the text is sent.
- The chat host becomes a third engine choice beside `tessera` and `deepl`, with
  its own consent per client. A consent to DeepL is not a consent to this.
- Withdrawing that consent stops later batches at once, because the gate is asked
  per batch, never once per job.

What the gate cannot see is a file the person attaches to the conversation
themselves. The connector's instructions tell the model to use the upload link and
not to read an attached file; that is guidance to a model, not a control, and the
spec does not claim otherwise.

**D7. A file travels by a one-time link, never through the model.** A tool creates
an upload slot and returns a link on the tenant's host. The person opens it and
picks the file. The link is single-use and short-lived, and stored only as its
hash; every unusable link is one identical 404. The uploaded name is display
metadata and never a path (`server/src/storage.ts`). A delivered file comes back
the same way: a one-time download link, logged as a download is today. On a host
that passes attached files to a tool by URL, that is a later, second way in; it
must fetch only from that host's documented origin and treat the URL as the
webhook sender treats a typed URL (`vendor-core/webhook`).

**D8. The draft loop is batches the model pulls and pushes.**

1. Pre-translate runs first as a job, as today. Exact and context matches are
   placed from the memory and are never sent to the model.
2. A read tool returns the next batch of segments that still need a draft. Each
   carries its source with visible tags as `<tN>` markers (the marker scheme of
   `core/draft/`), its fuzzy matches above the project's threshold and the
   glossary's renderings for the terms in it. A unit's key and notes travel as
   context where the file has them.
3. The model writes drafts and sends them back in a write tool.
4. Each draft is read back by `validateDraft` or refused with a named reason;
   never repaired. The model may try again with the reason.
5. A valid draft is stored as a draft suggestion beside the segment, the store
   the built engines already use. It is not a target yet.

The batch size is a number to measure (O5), bounded by the result size limit and
by what a model keeps consistent. Text inside a batch is escaped and framed as
data, since a document can contain a sentence that reads as an instruction.

**D9. A person accepts and confirms; no tool the model can call confirms.**
Accepting a draft writes the target through `acceptDraftSuggestion`, with hidden
tags carried and status `draft`. Confirming stays a person's act in the editor,
and later in the review screen of slice 5, where the click is the person's own.
The reason is the meaning of the word: `confirmed` is what an XLIFF `final`, a
memory write and a vendor's pay rest on, and a document that says "confirm every
segment" must not be able to cause it. Whether one tool may accept a whole
project's drafts at once, behind the host's confirmation prompt, is O3.

**D10. QA and export are the existing calls.** A tool starts the QA sweep job and
returns findings by segment and rule. Dismissing a finding is a logged human
decision and is not a tool in the first slices. Export is `exportFileBytes`
behind a download link, and it reports the count of blocking findings beside the
link, as the CLI's exit status does.

**D11. What no tool does, in any slice:** approve a price, change consent, grant
or revoke access, invite or remove anyone, delete a project or a memory, edit or
retire a memory unit, change a tenant's settings. Those stay in the application.
A tool is either read-only or a write, never both, and every one is annotated so
the host prompts for a write.

**D12. Long work is a job the model polls.** Import, pre-translate, the QA sweep
and export return a job id at once and a second tool reads its state, inside the
host's time limit. Nothing new: the job registry already works this way.

**D13. Claude first, ChatGPT second.** A custom connector on Claude needs no
review and works on every plan, and its limits are documented. ChatGPT passes
files more directly but leaves its time and size limits unstated and restricts
who may add a custom server. The connector speaks the open protocol, so the
second host is a slice of adaptation, not a rewrite.

**D14. The review screen comes after the loop works.** A segment grid inside the
conversation (MCP Apps, fullscreen) is where a person would accept, edit and
confirm without leaving the chat. It is slice 5, not slice 1: the loop, the gate
and the file round trip are what is unproven, and the existing editor already
does the job meanwhile. Whether a tool can be made callable by the screen and not
by the model must be read in the specification before D9 leans on it.

**D15. A plan statement stands beside the consent.** (Louis, 2026-11-10, §6 O1.)
The gate of D6 needs two things before a chat host receives a client's text: the
client's consent to that engine, and the connected person's recorded statement
that their account on that host is on a business plan. Either missing is off.

## 4. What stays exactly as built

- The roundtrip gate, the fold rule on export and differential validation.
- `carryHiddenTags` as the only placer of hidden tags; a connector sends what the
  model placed among the visible ones, nothing more.
- A memory match applying the receiving document's formatting.
- One finding per rule per segment, named by segment and rule.
- `core/draft/` reading a reply back or refusing it.
- The actor required on every write, and no personal data in a hashed detail.
- No function taking a path from a request.

## 5. Slices

Each is one card, filed when the one before it lands. S0 is the only one that
does not need §6 decided.

| Slice | What                                                                                           | Proves                                                    |
| ----- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| S0    | A measurement, not a feature: the loop of D8 over a synthetic fixture on one host, numbers only | Batch size, time and cost per 1,000 words; whether D8 holds |
| S1a   | **Built.** A connector token and a read-only endpoint: projects, progress, QA findings as counts | D3, D4, D5, D11, the isolation entries                    |
| S1b   | **Built.** Sign-in from a chat host (OAuth with PKCE), which mints the same token; a consent page and a list of connections | D4, §6b                                                   |
| S2    | Upload link, project creation, import and pre-translate as jobs                                | D7, D12                                                   |
| S3    | The chat host as an engine with consent and the plan statement (D15); the batch tools; drafts into the suggestion store     | D6, D8                                                    |
| S4    | Accept, QA sweep, export by download link                                                      | D9, D10                                                   |
| S5    | The review screen in the conversation                                                          | D14                                                       |
| S6    | The second host                                                                                | D13                                                       |

Tests each slice owes, beyond its own: a refused consent returns no text and
writes no `ai.requested`; a batch whose text holds an instruction changes nothing
it was not asked to; a spent or foreign link is the one 404; a vendor's token
reaches no tool.

## 6. Open, for Louis

**O1. Client content and consumer chat plans.** **Decided by Louis, 2026-11-10:
consent plus a plan statement.** A client's text may reach a chat host only when
both hold:

1. the client has consented to the chat host as an engine (D6, per client), and
2. the person connected has stated, on record, that the chat account they use is
   on a business plan of that host.

The question was a real conflict. `ai-platform-vision.md` §5.1 says client content
goes only to paid or enterprise tiers, "never a consumer AI product", and the
server cannot see which plan a person's chat account is on (an inference from the
protocol: a connector is told nothing about the plan). Three positions were laid
out: never send a client's text; send it on consent alone, with a written
exception to §5.1; or this one. It was chosen because it keeps what §5.1 is for
(terms under which the content is not trained on, and a processing agreement) and
puts the one fact the server cannot check on the record as the person's own
statement, where a false one is theirs. Its cost is accepted: a translator on a
personal plan cannot honestly use the connector for client work.

What follows for the design (D15, below):

- **The statement is per person and per chat host**, never per tenant: it is a
  fact about one account. It is asked when the connection is made, shown in
  words that name what is being stated, and can be withdrawn at any time.
- **It is part of the gate and fails closed.** No statement, a withdrawn one, or
  one for another host: `engineFor` answers off, nothing is returned and no
  `ai.requested` is written. A withdrawal acts on the next batch, as a withdrawn
  consent does.
- **Making and withdrawing it are platform audit events**, with the actor, the
  tenant and the host, and nothing else.
- **It is a statement, not a check, and nothing may say otherwise.** No screen,
  document or event calls the account "verified" or the plan "confirmed".
- **A project with no client number sends nothing either.** The gate already
  fails closed there (`resolveEngine`), and this decision does not open it: a
  translator's own document with no client is a separate question, not asked.

Not decided here: the exact wording of the statement, and which of a host's plans
count as a business plan. Both are settled when S3 is specified, the second from
each host's published terms read at that time and cited.

**O2. Consent per client, or one switch per tenant.** **Settled by O1:** per
client, as for the built engines. The plan statement is the per-person half.

**O3. Accepting in bulk.** Whether a single confirmed tool call may accept every
valid draft in a project, or acceptance stays in the editor and the review screen.

**O4. Listing in a host's directory.** Publication is outward-facing, and the
hosts' rules on what a listed connector may sell are a commercial question that
does not belong in this repository.

**O5. Measure first.** Decided 2026-11-10: measure first. E-001
(`research/chat-connector/`, issue #373) ran the loop of D8 on a synthetic file
with a model driving a shell harness as a stand-in for a chat host. All 240
segments, and all 65 with tags, were valid on the first try at batch sizes 20, 40
and 80, and none of five planted instructions was obeyed. The corpus was too easy
to tell the sizes apart, nobody read the drafts for quality, and a stand-in says
nothing about a real host's speed or a person's quota. So D8's mechanism is
supported, its batch size is "80 does no harm on easy text", and the speed and
quota half of this question is still open.

E-002 (issue #375) repeated it on a harder synthetic file with the context of D8
in each batch: nested and adjacent tags, numbers, long segments, glossary
renderings, memory matches, an instruction planted inside five matches. All 320
segments were valid on the first try at batch sizes 20, 80 and 160, every glossary
rendering was followed, the product's number and punctuation rules found nothing,
and no planted instruction was obeyed. Two things to carry into D8: the context
roughly doubles what a batch sends, and a batch of 160 such segments is about a
third of a chat host's result limit. Two ceilings in a row mean synthetic text and
a stand-in have no more to say; quality, a real document and a real host are what
remain, and each needs a person.

**O6. Rust or WebAssembly.** **Decided by Louis, 2026-11-11: stay in TypeScript.** The
question was asked before the first line of S1a, with the three usual options. The work is
protocol handling and calls to existing repository functions; no profile shows the language as a
bottleneck, and a separate component could not reuse the server's session, tenant and audit code,
so those rules would have needed a second implementation. The question is asked again before a
later slice only if that slice has a kernel worth measuring.

## 6a. Decided while building S1a (backlog #378, 2026-11-11)

S1 was split in two because a chat host cannot sign in without OAuth, and OAuth is a slice of its
own. S1a builds what OAuth will mint and what it will open; S1b adds the sign-in.

**D16. Two credentials, and each opens one thing.** A **connector token** is not a session. It
is kept in its own table (`connector_token`, platform v17), the gate authenticates `/api/mcp`
with it and with nothing else, and every other route with a session and nothing else. So a token
copied out of a chat assistant's settings cannot edit a project, and a browser session cannot be
replayed at the endpoint. A token is made for the tenant its person is staff of, lives 90 days,
is stored as its hash and is shown once. It answers only while the person is still staff of that
tenant, so removing someone ends their tokens with no second write; an operator's password reset
revokes them with the sessions. A vendor gets none (D2).

**D17. What a read-only tool may say.** A tool result is what the chat host's model reads, so it
is where data leaves (D6). Text needs a consent and a plan statement that S3 builds, so S1a's
three tools return none, and they are careful with names too:

- a **project** by its name and languages: it has to be named to be asked about, and it is the
  connected person's own list;
- a **file** by its position and kind, **never its name**: an owner's file names often carry a
  client's (the same reason a grantee is not shown a memory's name);
- **QA findings as counts** by rule, with how many block delivery, **never a finding's message**:
  a message can quote the segment;
- only the token's **own tenant's** projects: a grant opens nothing here, and another tenant's
  project is answered exactly as one that does not exist.

Whether a project's name should also be withheld (it can carry a client's name too) was weighed
and left as it is: without it the tools cannot be used at all, and connecting is the person's own
act. It is cheap to revisit.

**D18. The protocol is written by hand, and checked by the official client.** The endpoint
speaks MCP revision 2025-06-18 over Streamable HTTP, answering each request with one JSON object:
no stream (a `GET` is a 405), no protocol session, tools only. That is small enough to write
directly, and the official SDK would have brought a second web framework into the build. The risk
of a hand-written protocol is being wrong in the same direction as its own tests, so
`server/src/connector.test.ts` drives it with the official TypeScript client over a real socket
(a development dependency only, `prior-art.md`). A request that names an origin must name the
server's own, as the transport requires.

**Not built in S1a, on purpose:** sign-in from a chat host (S1b); any screen (a token is made by
a request today, so only someone who can call the API can try it); reading a tool call into the
audit log (a read, like the project list, is not logged).

**The rate limit (issue #379, built).** The protocol asks a server to rate limit tool invocations.
The endpoint gets a fixed window of 60 requests a minute per connector token (`CONNECTOR_RATE_LIMIT`),
checked by the gate after the token resolves, so an invalid token is never counted and holds no
memory; a refusal is a 429 with `retry-after`. Counts are in process: one server, and a restart
resetting a window is harmless. Why only this endpoint: the one route the protocol asks for, and a
whole-API limit (login attempts, unauthenticated floods) needs its own decision and a store that
works across processes, which the server does not have. A refused request is not counted, so a
client that waits is not penalised. The figure is a guess at honest use, to be revised from real
use, not measured.

## 6b. Decided while building S1b (backlog #381, 2026-11-11)

S1b lets a chat host connect a person without a pasted token: the person adds the connector by its
address, is sent to Tessera to sign in and say yes, and the chat host holds a credential from then
on. The flow is OAuth 2.1 with PKCE, as the chat host's connector documentation requires (§7,
source 9), and nothing in it is specific to one host.

**D19. A client registers itself by request (Louis, 2026-11-11).** The question was how a chat
host identifies itself to Tessera, with three options: registration by request (RFC 7591), a
client-ID metadata document that Tessera would fetch from an address the client names, or clients
entered by hand. Louis chose registration by request: it is what the documentation describes, and
it adds **no outbound call**, where a metadata document would have made a second place the server
fetches a URL a stranger typed (the webhook sender is the first, and it took a card of its own).
An open registration endpoint is a write anyone can make, so the same slice bounds it:

- at most 30 registrations in an hour over the whole server, then a 429;
- a client nobody ever connected is deleted thirty days after it registered, with its codes;
- public clients only: no secret is issued, so none can leak, and PKCE binds a code to whoever
  asked for it;
- a client's name and addresses are a stranger's claim: the consent page shows the name as one,
  and neither is ever written to the audit log.

The cap is one bucket for everyone, so someone can use it up for an hour and stop new clients
registering. Connections that exist are untouched, and a limit per sender is issue #384.

**D20. Tessera is its own authorization server, and consent is a page of the application.** The
session lives in the browser as a bearer token, not a cookie, so the authorization endpoint
cannot know who is asking. It checks the client and its redirect address and hands the browser to
`#/connect`, where the application (signed in, or after the login screen) shows who is asking,
where the answer goes and what the connection can do, and posts the person's answer with the
session. What holds:

- **A code never goes to an address the client did not register.** A request naming an unknown
  client or another address is answered with an error and no redirect. A loopback address
  (`http` to this machine) matches on any port, as a command-line client needs (RFC 8252); every
  other address matches as an exact string.
- Only `allow: true` is consent; anything else goes back as `access_denied`.
- **Staff only**, of the tenant whose host the client registered at (D2, D14). A vendor can read
  the page and cannot connect. Under a base domain a client registered at one tenant's address is
  unknown at another's.
- The request rides in the page's fragment, which reaches no server log.

**D21. An access token is a connector token; a connection is what the person sees.** Exchanging
a code makes a **connection** (`oauth_connection`, platform v18) and its first tokens: an access
token that is a row of `connector_token` (D16), so the endpoint's gate keeps its one lookup, and a
refresh token.

- An access token lives one hour. A refresh token lives 90 days and is **rotated on every use**,
  so a connection in use goes on and an unused one lapses.
- A code and a refresh token are single-use and stored as hashes. A failed exchange spends the
  code. **A spent code or refresh token presented again ends the connection**: one of the two
  holders is not the client. The cost is that a client which loses the reply to a refresh must
  sign in again.
- Every refusal at the token endpoint is the same `invalid_grant`, whatever was wrong.
- A connection follows the membership as a hand-made token does: exchanging and refreshing answer
  only while the person is still staff of its tenant. A password reset ends every connection.
- A new sign-in from the same client replaces the person's earlier connection from it; past ten
  connections the oldest ends.
- The person lists and ends their connections under Account. `connector.connected` and
  `connector.disconnected` (with why) are logged in the tenant's slice; the hourly access tokens
  are not logged one by one.
- No scopes: the connection opens the connector's read-only tools and nothing else exists to
  grant. A later slice that adds a tool which changes something must decide whether a connection
  made before it gets that tool.

**D22. The address is configured, never read from a request.** The metadata a chat host reads
names the server's own address. Under a base domain that is the tenant's (`https://<slug>.<base
domain>`); otherwise it is `CAT_PUBLIC_ORIGIN`. The `Host` header is whatever the sender chose, so
it is never used. With neither set, sign-in is off, every route of the flow is a 404, and the
connector works with a token made by hand, as in S1a.

**Checked by the official client.** `server/src/connector-oauth.test.ts` runs the official
TypeScript client's own sign-in against a real socket: it reads the 401, finds the metadata,
registers, asks, exchanges with its own verifier and calls a tool. The same flow was driven once
in a real browser (login, consent page, redirect to a loopback listener, exchange, a tool call),
which is how the page was seen to work and how an empty reply from the disconnect route was
found; that run is not a test in the repository.

**Not built in S1b, and not verified:**

- **No real chat host has connected.** That needs a server reachable over `https` and an account
  on the host. It is the one thing left that only a deployment can show.
- A person who signs in with Microsoft or Google from the consent page's login screen loses the
  request (the browser leaves for the provider) and must start again from the chat host. A
  password sign-in keeps it.
- No rate limit on the token endpoint (issue #384). The connector's own endpoint is limited per
  token (backlog #379), which holds for a connection's hourly tokens as for a hand-made one.
- The plan statement (D15) is not asked for at sign-in: no tool returns text yet, so nothing
  needs it. S3 adds it, and must decide whether to ask at connection or at first use.
- A token made by hand (S1a) still has no screen.

## 7. Sources

Read on 2026-11-10. **read here** in §1 marks the ones this session opened itself.

1. `https://claude.com/docs/connectors/building`
2. `https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp`
3. `https://developers.openai.com/api/docs/guides/custom-mcp-server`
4. `https://developers.openai.com/plugins/reference.md`
5. `https://github.com/anthropics/claude-ai-mcp/issues/1116` (a user's report, not documentation)
6. `https://modelcontextprotocol.io/extensions/apps/overview`
7. `https://claude.com/docs/connectors/building/mcp-apps/design-guidelines.md`
8. `https://developers.openai.com/plugins/build/chatgpt-ui.md`
9. `https://claude.com/docs/connectors/building/authentication.md`
10. `https://developers.openai.com/plugins/build/auth.md`
11. `https://claude.com/docs/connectors/building/review-criteria.md`
12. `https://developers.openai.com/plugins/deploy/app-review.md`
13. `https://developers.deepl.com/docs/mcp.md`
14. The per-product pages are listed in `competitive-research.md` §3a.
15. `https://docs.supervertaler.com/trados/mcp-server/`

Ideas taken from [13] (the upload link) and [15] (context to the host's model, a
draft status for what it wrote) are kind A in `prior-art.md`: cited here, nothing
copied.
