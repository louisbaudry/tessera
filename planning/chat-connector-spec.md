# Chat connector — spec

**Status:** design only, nothing built. Issue #152.
**Extends:** `ai-platform-vision.md`, `translation-engine-spec.md`, `audit-spec.md`,
`solo-translator-spec.md`, `tenant-spec.md`
**Decisions:** every D below is a _proposal_ until Louis rules on §6. None is built on.

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
| S1    | OAuth on the tenant host; read-only tools (projects, progress, QA findings)                    | D3, D4, the isolation entries                             |
| S2    | Upload link, project creation, import and pre-translate as jobs                                | D7, D12                                                   |
| S3    | The chat host as an engine with consent; the batch tools; drafts into the suggestion store     | D6, D8                                                    |
| S4    | Accept, QA sweep, export by download link                                                      | D9, D10                                                   |
| S5    | The review screen in the conversation                                                          | D14                                                       |
| S6    | The second host                                                                                | D13                                                       |

Tests each slice owes, beyond its own: a refused consent returns no text and
writes no `ai.requested`; a batch whose text holds an instruction changes nothing
it was not asked to; a spent or foreign link is the one 404; a vendor's token
reaches no tool.

## 6. Open, for Louis

**O1. Client content and consumer chat plans.** `ai-platform-vision.md` §5.1 says
client content goes only to paid or enterprise API tiers, "never a consumer AI
product". A chat host on a personal plan is a consumer product, and the server
cannot see which plan a person is on (an inference from the protocol: the
connector receives no plan). So this path either stays outside that rule by a
stated exception, with the per-client consent of D6 as the control and the
translator answerable for their own contracts, or it is not offered for client
content at all. This is a legal and contractual call and blocks S3.

**O2. Consent per client, or one switch per tenant.** D6 proposes per client, as
for the built engines. A solo translator may find one switch simpler; it is also
the weaker promise.

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

**O6. Rust or WebAssembly.** The standing question (`CLAUDE.md`, working rhythm 6)
is asked before the first line of S1. The recommendation will be TypeScript: the
work is protocol handling and calls to existing repository functions, and the
network dominates.

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
