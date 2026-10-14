# Translation engine — spec (draft)

Status: **draft, nothing built.** Written 2026-10-12 from Louis's request:
Tessera gets its own automated translation, built on an analysis of the
client's translation memory plus Claude, invisible to the client and the
translator, "something similar to what is proposed by ModernMT". It is
**Epic 8** (Ring 0.5, `ai-platform-vision.md` §3), tracked in issue #228.
Eight decisions (D1 to D8) were taken by Louis on 2026-10-12 and ten more
(D9 to D18, §9) on 2026-10-13, each in answer to a question with options and
a recommendation. Two points stay open (§9). Reasoning is kept on the record, not just the conclusions.

**A word on naming.** "Provider" is taken: a _Language Provider_ is the
translation business and its vendors (Epic 9). This spec calls the thing an
**engine** (`GLOSSARY.md`: _draft engine_), which is also
the word `audit-spec.md` §4 already uses for `deepl` and `anthropic`.

## 0. What is being asked, in one paragraph

For a segment with no usable TM match, Tessera finds the client's most
similar translated sentences and their glossary terms, puts them in a
prompt, and asks Claude for a draft in the client's own wording. Nothing is
trained: the "analysis of the client's TM" is retrieval, done per segment, so
a unit added to the memory today informs the next draft immediately. The
translator sees an ordinary suggestion. The client sees nothing. A project
manager can instead choose DeepL for a client or a project. A client's
content leaves for an engine only if that client has opted in.

## 1. Where it sits

`ai-platform-vision.md` §3 (Ring 0.5) planned two engines with two jobs: a
dedicated MT engine (provisionally DeepL) for a fast first draft, and Claude
for context-aware polish and for semantic QA. This spec changes the first
half and leaves the second:

- The first-pass draft can now come from **Claude with the client's TM in the
  prompt** (this engine) **or from DeepL**, and the Project Manager chooses
  (D2, D8). §3's sentence "provisional pick for the MT engine: DeepL" is
  therefore no longer the whole story; the vision doc points here.
- **Semantic QA** (Claude reading a translation against its source) is
  untouched and is a separate surface, a separate card, and not this epic's
  first slice.
- The matching order does not move: **TM first, engine as fallback.** An
  exact TM hit still wins outright (`v1-spec.md` §6.1), and a fuzzy match at
  or above the project's threshold is placed as before (`v1-spec.md` §6.1a).
  The engine drafts a segment those left empty, and a segment whose best
  match was a fuzzy one is drafted _with that match in the prompt_ (§3).

## 2. Decisions

D1 to D8 are Louis's, 2026-10-12; D9 to D18 are in §9.

**D1. Adaptation by retrieval only.** No per-client model, no fine-tuning, no
offline client profile. The alternatives were weighed: a per-client trained
model is what ModernMT sells, but it needs GPUs, retraining and a quality bar
that is hard to reach against Claude with good context; an offline profile
(terminology, tone, recurring patterns computed once per client) is a
possible later layer, and D17 keeps it as a deferred option rather than a
decision. What makes retrieval-only adequate is that the machinery already
exists: `retrieveFuzzy` (FS-2 scorer behind an FTS5 shortlist,
`v1-spec.md` §6.1a), `retrievePair`, and the glossary lookup. This epic
adds a prompt and an engine seam, not a second matcher.

**D2. Two engines, the PM chooses.** The Tessera engine (Claude with the
client's TM in the prompt) and DeepL are both engines behind one seam
(`DraftEngine`, §5). Neither is the default of the product: the choice is a
setting (D8). This keeps §3's "swappable, not a deep architectural
commitment" true, and gives the PM a cheap first pass when a client has no
memory worth retrieving.

**D3. Looks like any other suggestion.** In the editor, an engine draft is
presented as a suggestion with no engine name and no machine-draft marker;
no client-facing surface (portal, quote, deliverable) mentions it. The
**origin is still stored** (`mt_draft`, §4) and the audit provenance is still
written (D4, `audit-spec.md` §4), because pay and the audit trail need it and
because dropping it would make the opt-out unprovable. Two consequences are
recorded here so nobody discovers them later:

1. This is the opposite of the marker the universal rule asks for ("marked
   as AI-assisted where the repo supports it"). Louis chose it, so it stands;
   it means a translator cannot tell a machine draft from a TM suggestion by
   looking. The engine therefore gives no percentage and no tier, the same
   rule a semantic match has (`semantic-matching-spec.md` §4), so a draft
   is never read as a match score.
2. The disclosure to clients that `ai-platform-vision.md` §5.3 asks for
   ("a line in the service agreement naming AI-assisted tools") is the only
   place a client learns of it, which makes that line and D4 the whole of
   the client's protection. D11 accepts that, on one condition.

**D4. Per-client opt-in, off by default, logged.** A client's memory and
glossary are sent to Claude only after that client has been switched on, by
the owner on the client's behalf, and the change is logged. A segment of an
opted-out client gets no engine draft and no `ai.requested` event. This
**reverses `ai-platform-vision.md` §5.2** ("AI processing is opt-in per
project or per client, _default on_, one click off") for this engine,
because the text sent here is the client's own translated history, a bigger
disclosure than a source sentence alone. The consent gate is checked
**on the server at the moment of the call**, never in the SPA and not once
per job: a client switched off while a job runs must stop the job's later
segments (D15). §5 of the vision doc's
other rules stand: paid/enterprise API tiers only, never a consumer product.

**D5. Batch at pre-translate, plus an editor prefetch.** A pre-translate run
asks the engine for every segment the TM left empty, as a server job
(`jobs.ts`, "bulk work is a job, never a request"). Separately the editor
asks ahead of where the translator is working, so an edited, added or missed
segment still has a suggestion and the vision doc's "never a blocking wait"
holds. Both fill the same place. **Where that place is** needs care, because
`audit-spec.md` §4 says "a suggestion is not a write: prefetched drafts live
outside the segment until accepted." So the engine's output is held in a
per-project suggestion store, not written into `segment.target`; accepting
one is the write (`setSegmentTarget`, hidden tags carried, actor the accepting
human, origin `mt_draft`). This differs from a placed fuzzy match, which
pre-translate writes as a `draft` (`v1-spec.md` §6.1a, 3), and is the one
place this spec departs from the fuzzy path; D10 confirms it.

**D6. Stay in TypeScript.** The standing question (`CLAUDE.md`, working
rhythm 6) was asked: stay in TypeScript, a Rust/Wasm kernel for one hot path,
or a Wasm component. Decision: **stay in TypeScript.** The work is TM
retrieval (already FTS5 plus the FS-2 scorer in TS), prompt assembly and a
network call to Claude, and the call dominates latency. No profile or
`pnpm bench:tm` run has shown the language to be a bottleneck; every
slowdown found so far was a query shape or a missing index. The trigger to
reopen is a benchmark, not a feeling: if semantic (embedding) retrieval over
very large client memories (`semantic-matching-spec.md`) becomes the hot
path, that one pure kernel could sit behind the same `core` function
signature. Nothing is built for it now.

**D7. Quality bar: a held-out TM benchmark against DeepL.** The engine is not
turned on for a real client on a feeling. For a client with an opted-in
memory, a sample of its human-translated units is held out, each is drafted
with the memory _excluding that unit_ (and its duplicates), and the draft is
scored against the human target (chrF and TER, plus an edit-distance measure
of what a translator would have to change). Three arms: the Tessera engine,
DeepL, and Claude without any TM context, so the benefit of the retrieval is
measured and not assumed. It follows the protocol already binding on
`semantic-matching-spec.md` §6: **a hypothesis is committed before the run
that tests it, every run gets a results file with the commit, corpus digest,
model and parameters, failures included, and no client text lands in the
repo**; a private memory contributes numbers only, under opaque ids. The
harness lives under `research/translation-engine/` (opened in slice 0)
(§7), and its journal and hypotheses files are append-only.

**D8. The engine is a client default, overridable per project.** A client
has an engine setting (`off`, `tessera`, `deepl`), `off` by default and the
same row as its opt-in (D4). A project inherits it; the PM can set the
project to another value, but **cannot override a client's `off`** for an
engine that sends client content: the project override picks among what the
client allows. The choice is logged (`project.setting_changed`,
`audit-spec.md` §2.2). "Client" here is the number the owner typed on the
project (`portal_client_setting`, backlog #130), not a lookup in
`portal.sqlite`; the per-client setting lives in `platform.sqlite` (D9).

## 3. How a draft is made

For one segment, the Tessera engine does this, in this order, in `core`
functions that take their inputs as arguments (headless, no I/O):

1. **Gate.** The caller has already established that the client allows the
   engine (D4, D8). `core` does not read the setting; `db` does and refuses
   before anything is assembled.
2. **Retrieve.** The segment's best fuzzy matches from the project's attached
   memories in priority order (`retrieveFuzzy`, `v1-spec.md` §6.1a), a
   bounded number of them, below the pre-translate threshold included: a 62%
   match is poor as a placed target and excellent as a prompt example. Exact
   and ICE matches never reach the engine; they are placed.
3. **Terms.** The glossary terms found in the source (`findRendering`,
   `smart-glossary-spec.md`), with the preferred rendering of each.
4. **Context.** The neighbouring source segments of the same file, and
   nothing else from the document.
5. **Assemble.** A named, versioned prompt template (`prompt_version`,
   `audit-spec.md` §4: never an inline string), with the source's inline tags
   replaced by placeholders and mapped back afterwards. Hidden tags are never
   in the prompt and never the engine's to place: the result goes through
   `setSegmentTarget` like any write, and `carryHiddenTags` supplies them
   (`CLAUDE.md`, invariants). A target whose placeholders do not map back to
   the source's visible tags is a rejected draft, not a stored one.
6. **Call and validate.** One call per segment (batching several segments
   per call is a later optimisation, not a decision), then `parseTokens` and
   the tag rules before the suggestion is stored. A draft that fails
   validation is dropped and the failure counted; it is never repaired
   silently.
7. **Record.** `ai.requested` when client content is sent, and, on
   acceptance, `segment.target_set` with
   `detail.provenance = { engine, model, prompt_version, input_sha256 }`
   (`audit-spec.md` §4). The prompt itself is not logged.

**Prompt caching.** A batch run sends the same instructions, glossary subset
and example format for every segment of a client, which is what prompt
caching is for. Whether it pays is a measurement, not an assumption, and
belongs in the D7 results.

**A client's text in a prompt is data, not instructions.** A translated unit
in a memory is third-party text. The template marks the retrieved units as
reference material, and a draft that obeys an instruction embedded in a unit
instead of translating the source is exactly what the validation in step 6
and the benchmark's adversarial cases look for (§6).

## 4. What it writes

- **`origin`:** `mt_draft` for a Tessera-engine draft and for a DeepL draft
  alike (`v1-spec.md` §4.3: a deliberately open string, so no schema
  change). The engine, model and prompt version are in the provenance, not in
  the origin, so an engine can change without a migration. The vision doc's
  `mt_claude_polished` is reserved for the Claude-polish-of-a-DeepL-draft
  path, which this epic does not build.
- **`status`:** an accepted draft is `draft`, never `translated` or
  `confirmed`; a person confirms it, as with a placed fuzzy match.
- **Pay and analysis.** An engine draft is not a TM tier. `analyseTierWords`
  and the vendor payable (`vendor-spec.md`, #49b/#51b) price a segment by its
  frozen match tier; a segment drafted by an engine and then edited is, for
  analysis, a segment with no TM match, exactly as today. Nothing here
  changes a rate. What a vendor is owed for post-editing a hidden draft is a
  commercial question and is D16: no change.
- **Memory.** A confirmed target written back to a memory carries its `origin`
  as it does today; an engine draft is not a human translation, so the TM
  write-back rules (`tm-format-spec.md`) decide whether a confirmed
  post-edited draft is stored. This spec adds no new write.

## 5. Where it lives

- **`@cat-tool/core`** (headless): `core/draft/` holds the pure parts: the
  `DraftEngine` interface (`draft(request) → Promise<DraftResult>`, the
  request being plain data), prompt assembly from retrieved matches, terms
  and context, the placeholder map for inline tags, and response validation.
  Nothing in it imports a network client, `better-sqlite3`, or a clock.
- **`@cat-tool/db`:** the per-project suggestion store, the client engine
  setting and the project override, and the consent gate, all through the
  shared migration runner. Audit actions `ai.requested` and the
  `project.setting_changed` for the engine are new members of the closed
  list, a migration that widens the `CHECK` with `rebuildTable` (the snapshot
  invariant in `CLAUDE.md`).
- **`@cat-tool/server`:** the Anthropic and DeepL adapters (the I/O-bearing
  implementations, the `SmtpNotificationService` pattern), the pre-translate
  job (`db/src/jobs/ops.ts`), and the prefetch route. Credentials are read
  from the environment, never a file in the repo. The Anthropic call is an
  **outbound data flow carrying client content**: it is behind D4 and goes
  through one function, so a new outbound call cannot skip the gate.
- **`@cat-tool/web`:** the suggestion in the match panel and the setting in
  the client and project screens. No logic that needs a DOM to prove.
- **CLI:** `pretranslate` gains the same engine step as one repository call,
  not a second implementation; a CLI run without a gate-allowed client does
  nothing and says why.

## 6. Tests

All offline: no key, no network, a fake `DraftEngine` that returns scripted
drafts.

- The consent gate: an opted-out client yields no engine call and no
  `ai.requested`, in the job and in the prefetch; switching a client off
  mid-job stops the remaining segments; a project cannot override a
  client's `off`. Written before the code that enforces it (invariant tier).
- Prompt assembly is deterministic: the same inputs produce the same
  `input_sha256`; hidden tags never appear in a prompt; a retrieved unit
  containing an instruction is wrapped as reference material.
- Placeholder round trip: a draft that drops, duplicates or invents a tag is
  rejected; one that maps back goes through `setSegmentTarget` with hidden
  tags carried.
- No client route returns the origin or the engine (a test per field, the
  `clientFile` pattern), since D3 hides it from the client; and no response
  names the engine to a translator.
- The suggestion store is not a write: no `segment.target_set` until
  acceptance; acceptance names the accepting human as actor.
- The audit chain still verifies after a batch run (`audit-verify`).
- The golden transcript (`pnpm test:golden`) gains a line only if the CLI's
  output changes, and that diff is read, not regenerated.
- Prompt changes get a small fixed set of golden cases read by a human
  (`CODING.md`, LLM output): the model is not unit-tested, the code that
  enforces rules on its answer is.

## 7. Phasing

Each slice ships on its own and is gated; none starts before the one above
it is merged (`CLAUDE.md`, one session on one area). Issue-level cards are
filed when a slice is next, not before.

| Slice | What | Done when |
| ----- | ---- | --------- |
| 0 | Decisions and spikes: the two open points of §9 closed (the language pairs, the agreement wording); a spike drafts 50 segments from a synthetic memory and records latency and token counts. | The decisions are written here; the spike's result is a results note, failures included. |
| 1 | The client engine setting (`off`/`tessera`/`deepl`), the project override, the consent gate, the audit actions. No engine yet. | A client defaults to `off`; the gate refuses and logs nothing sent; the override cannot widen the client's choice. |
| 2 | `core/draft/`: the interface, prompt template v1, retrieval wiring, placeholders, validation, with a fake engine. | Fixture segments produce valid, tag-safe suggestions through the fake engine; hidden tags carried. |
| 3 | The Anthropic adapter, the suggestion store, the pre-translate job and the CLI step, provenance and `ai.requested`. | A batch over a fixture project stores suggestions only for allowed clients; the audit chain verifies. |
| 4 | The editor: suggestion in the match panel, accept, prefetch ahead of the cursor. | A translator accepts a draft from the keyboard with no blocking wait; the accept is the audited write. |
| 5 | `research/translation-engine/` and the D7 benchmark harness: hypotheses first, three arms, a results file per run. | A results file compares the three arms on a synthetic corpus; a private-memory run yields numbers only. |
| 6 | The DeepL adapter behind the same seam, so the PM's choice (D2) is real. | The same fixture project drafts through either engine; the setting picks. |

Slice 0's spike is recorded in `research/translation-engine/` (experiment
E-001, hypotheses H1 to H4, written before any run); the folder is the one
D7's benchmark will use.

Slice 5 can run alongside slice 3 on a separate area; it touches
`research/`, not the pipeline. The benchmark gates **turning the engine on
for a real client**, not building it.

## 8. What stays exactly as built

TM first, then the engine. Exact and ICE matches are placed and never sent
anywhere. The roundtrip gate, the byte-identical skeleton and the export fold
rule are untouched: an engine draft is tokens, and tokens are what
`setSegmentTarget` already receives. `@cat-tool/core` stays headless; the
network lives in the server. A TM match still applies the receiving
document's formatting. A semantic match never gets a percentage, and neither
does a draft.

## 9. Settled on 2026-10-13, and what is still open

The ten points left open on 2026-10-12 were put to Louis one at a time on
2026-10-13, each with options and a recommendation. He took the
recommendation every time (D9 to D18). Two things stay open, and both are
Louis's, not code's.

**D9. A client's setting lives in `platform.sqlite`.** A small per-owner
table keyed by the client number the owner types on the project (backlog
#130), since it holds settings and not translation content. The CAT server
still never reads `portal.sqlite`. A wrong client number matches nothing, so
the engine stays off: the safe failure. Its changes go to that file's audit
log (`project.setting_changed` in the project, a platform-side action here).

**D10. D5 stands: engine output is a suggestion, not a write.** It sits in a
per-project suggestion store and becomes a write only when a translator
accepts it, with that translator as the actor (`audit-spec.md` §4). This is
the one place the engine departs from a placed fuzzy match, and it is
confirmed. The alternative made the PM who ran a batch the actor of text a
translator never saw.

**D11. The service-agreement line is enough, once checked.** D3 plus the
agreement line of `ai-platform-vision.md` §5.3 is accepted as the client's
disclosure, on one condition: before the first opted-in client, the
agreement's wording is confirmed to name AI-assisted tools. That check is
Louis's, not a build task, and is a stop-and-ask before slice 3 turns the
engine on for a real client.

**D12. Cost: a per-job token ceiling now, a monthly client cap later.**
Slice 3 ships with a ceiling on each pre-translate job: it stops, reports,
and the PM can resume. A per-client monthly cap waits until real spend per
client is seen. Until it exists, many small jobs can still add up; that is
accepted. Tokens per job are logged either way.

**D13. The model tier is decided by the D7 benchmark.** The model id is a
setting recorded in every draft's provenance. The benchmark's first arm is
the mid tier; the cheaper and the top tier are extra arms. Slice 3 uses a
placeholder default until the results are in. No separate model for prefetch
is assumed: two models would give one segment two behaviours depending on
when it was fetched.

**D14. First languages: EN to ES and EN to VI.** Louis, 2026-10-13: the
business mostly translates English into Spanish and English into
Vietnamese. These two pairs are the first benchmark and the first pilot;
the earlier wording ("the Romance and Germanic pairs of
`ai-platform-vision.md` §3") is superseded for this engine. Three
consequences, each a fact about this repo or an open check, not a guess:

- **Vietnamese is not where DeepL was assumed strongest.** The vision doc's
  case for DeepL rested on Romance and Germanic pairs. Whether DeepL
  translates into Vietnamese at all, and how well, is **unverified** and is
  the first thing slice 5's setup checks. If it does not, the EN to VI
  benchmark has no DeepL arm, and the comparison is the Tessera engine
  against Claude without TM context.
- **Vietnamese tokenises into more tokens than Spanish for the same
  meaning** (diacritics and syllable-per-word spelling; inference, to be
  measured). The spike therefore tests H1 per pair, not once.
- **No Vietnamese rule is needed for EN to VI as such:** the source is
  English and nothing in this engine segments or counts target words.
  `core/segment/rules.ts` does carry a first-pass `vi` (and `ko`) rule set,
  an initial abbreviation list marked "further curation will come as real
  jobs reveal patterns" (backlog #13a, whose description of `rulesFor('vi')`
  throwing is out of date; corrected 2026-10-14). So a Vietnamese source
  imports today, but its sentence boundaries are not yet earned from real
  failures, and a VI to EN pair would inherit that. It is out of scope for
  now for that reason, not because it is blocked. A Vietnamese text is not
  in `UNSPACED_LANGUAGES` (`core/model/words.ts`), but its words are
  syllables separated by spaces, so a word count of Vietnamese is a
  syllable count.

CJK and Thai stay out of the first benchmark (no word counter,
`v1-spec.md` §3.6).

**D15. Opt-out mid-project purges unaccepted suggestions and keeps accepted
targets.** At the moment a client is switched off, every unaccepted
suggestion for that client is deleted (it holds text derived from its
memory), accepted targets stay (they are the translator's work), the job's
remaining segments stop, and both the purge and the stop are logged. A
translator loses unaccepted look-ahead drafts mid-session; that is accepted.

**D16. Post-editing is paid by match tier, as today.** An engine draft is not
a TM tier, so the segment is priced as no match and nothing is built. A
post-editing rate tier is a possible later decision once the benchmark and a
pilot show how much translators edit drafts; it would be a rate row (never an
edit), would touch the frozen analysis, and needs Louis's commercial terms.

**D17. No offline client profile for now.** Terminology, tone and recurring
patterns computed once per client stay a deferred option on top of D1. If
the D7 benchmark shows retrieval alone leaves a gap a profile would fix, a
card is opened then; nothing is built before.

**D18. No redaction of personal data now.** A memory may contain names and
addresses and the engine sends what retrieval returns. Redaction on
translation text is unreliable and can break a match, so it is not built.
The protection is the per-client opt-in (D4), enterprise API terms with no
training on inputs (`ai-platform-vision.md` §5.1), and the compliance work
already planned (`worldwide-and-compliance-spec.md` §6, `ai-platform-vision.md`
§5.4). A client who requires more than that, and a regulated sector in
particular, reopens this.

### Still open

1. **The agreement wording** (D11), a check on Louis's side before the first
   opted-in client.
2. **An API key for the spike**, supplied as an environment secret by Louis
   (never pasted into a chat or a file). Without it E-001 cannot run
   (`research/translation-engine/`).
