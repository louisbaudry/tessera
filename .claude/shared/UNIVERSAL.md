# Working with Louis (universal rules)

> Shared instructions for Claude Code in **every** repository Louis works in.
> This file is the universal rulebook, not a repo `CLAUDE.md`. Each repo's own
> `CLAUDE.md` imports it (a synced copy in `.claude/shared/`; how the sync
> works is in `SYNC.md` in the private `claude-shared` repo), then the one
> set that matches the repo, then adds only what is specific to
> that repo. Never edit the synced copies in a repo; edit them in
> `shared/` of `louisbaudry/claude-shared`:
>
> - [`CODING.md`](CODING.md): repos that ship code (apps, scripts, libraries).
> - [`NON-CODING.md`](NON-CODING.md): repos that store non-code work
>   (documents, research, content, translations, notes, data).
>
> A repo that is both (code plus a corpus) links both. This file holds only
> what is true for either kind. Who Louis is and his broader
> preferences live in `ai_profile.md` in his private `ai_profile` repo,
> loaded alongside this file when the session can reach it; this file is
> about how to work with him in a codebase.
>
> `claude-shared` is private, but this file is copied into other repos,
> some of them public. Keep it to working rules: nothing personal, no
> client names, no credentials.
>
> Precedence: a repo's own `CLAUDE.md` may narrow or extend these rules for
> that repo. It should not silently contradict them; where it does, the
> repo file wins and the conflict is worth flagging to Louis.
>
> Guidance that applies across repos belongs here, not copied into each one.
> Two copies of the same rule drift apart as soon as one is edited.

## Communication

- Least possible verbosity: answer first, then stop. No recaps, no restating the
  request, no summaries after routine edits, no explanations unless asked.
- Match the language Louis is writing in (French, English or Spanish).
- **When asking Louis a question, always propose several options and a
  recommendation.** Never ask an open-ended question on its own. Lay out
  the options and say which one you would pick and why.
  - **Ask with clickable options.** Louis often works from his phone, where
    typing is slow. Use the `AskUserQuestion` tool (2-4 tappable options,
    "Other" for free text) rather than a question in prose. Put the
    recommended option first and label it "(Recommended)". Only where the
    tool is unavailable, fall back to a text list with the same options and
    recommendation.
  - Ask one question at a time, and wait for the answer before the next.
  - **A rule alone did not hold, so a hook enforces it.** Each repo merges
    `question-gate.json` from `settings/` in `claude-shared` into its
    `.claude/settings.json` (with `require-ask-options.sh` and
    `stop-prose-question.sh` copied to `.claude/hooks/`). It blocks an
    `AskUserQuestion` call with more than one question or without the
    recommended option first, labelled "(Recommended)", and blocks (once)
    a reply that ends in a prose question. It checks the shape, not the
    quality of the options; that is still the session's job.
  - Make each question answerable without scrolling back: give what each
    option means and what it costs.
  - Routine calls inside work already directed (naming, file layout, test
    structure, which of two equivalent implementations) need no question.
    Make the call, mention it, move on.
- When uncertainty matters, say clearly what is fact, what is inference and
  what is a guess.

## Session start report

Before anything else in a session, print a compact report (one line per
item, no prose). Report only what was checked; mark anything that could
not be checked as `unknown` and say why. Never guess. Always write the
report in English, whatever language Louis writes in, so it reads the same
from one session to the next. This is the one stated exception to the
language-matching rule in Communication; everything after the report
still follows it.

- **Repo:** name, public or private, working branch, default branch.
- **Mode:** `Continuous mode` true/false (from the repo's `CLAUDE.md`;
  `false` if the line is absent), and repo kind (CODING, NON-CODING, both).
- **Cards:** count per status (Todo, In progress, Blocked, Done). Where
  the tooling cannot read the project board, give open issues by label
  instead and say the board was not readable.
- **In flight:** open PRs (draft or ready, CI state), unmerged branches,
  how far the branch is behind `main` (`git fetch origin main` first).
- **Local state:** uncommitted changes; `CLAUDE.md` and `AGENTS.md` in
  sync (where both exist); `GLOSSARY.md` present or missing.
- **Loaded:** which of `CODING.md` / `NON-CODING.md` and `ai_profile.md`
  were loaded; whether `settings/prompt-suggestions.json` is merged.
- **Tools:** GitHub access and its repo scope; whether
  `set_session_title` is available.

Then continue with the request. A user message that is itself a
question or a one-line task still gets the report first.

## Naming the session

- When Louis asks for a card, issue or backlog item ("grab the next card"),
  once you know which one it is, rename the session to its number and
  title, e.g. `#42 Add glossary export`. Use the session-title tool
  (`set_session_title`) when the session has it. Where it does not, say
  the title in the first line of your reply so Louis can rename it.
- Never leave the session on a generic title such as "Next card".

## Git and pull requests

1. **Never merge without being asked**, unless the repo has
   `Continuous mode: true` (below). Push the branch, open the PR, describe what it
   does, then wait. Every merge is an individual, explicit go-ahead, even
   when the change looks obviously safe.
2. **One task, one branch, one PR.** When the work comes from an issue,
   the PR body says `Closes #NN` so the issue and its board card close on
   merge. Every PR body also carries the `Docs:` line from "Before calling
   work done".
   - **Branch names:** `<type>/<issue-number>-<short-slug>`, lowercase,
     hyphens only, e.g. `feat/42-glossary-export`. Types: `feat`, `fix`,
     `docs`, `chore`. No issue yet: `<type>/<short-slug>`. The slug names
     the task, never a random word pair. Where the session's tooling
     assigns a generic name (e.g. `claude/festive-lovelace-ab12cd`), once
     the task is known create the conventional branch from it, push that
     one instead, and open the PR from it. A branch Louis names in his
     prompt is used as given. An assigned name is kept only when the
     tooling cannot push anywhere else; then say so in the PR.
3. **Branch from `main`, merge back to `main`, promptly.** Never branch
   from another session's branch, and never let one branch pile up several
   sessions of work. Otherwise `main` quietly stops being trunk.
4. **One session at a time on one area.** Parallel sessions on the same
   files, or on a shared record file, produce conflicts neither session
   meant to cause.
5. **Check what is in flight before starting.** `git fetch origin main`
   before deciding anything is open, and look at open PRs and unmerged
   branches, not just the board. A card in Todo means nobody has _merged_
   it, not that nobody is on it. If another branch already holds the work,
   say so and ask before duplicating it.
6. **Found something broken that isn't your task?** File it as an issue
   (and a backlog entry, where the repo keeps one). Don't fix it on the
   current branch, and don't leave it as a code comment nothing tracks.
7. Commit messages say what changed and why, what was verified and what
   was not, and any security implication (e.g. "no new outbound data").
   Preserve history: don't rewrite published history.
8. **When the session stops, say whether it can be safely archived**, and
   why: everything pushed and merged with nothing in flight (safe), or
   unpushed work, an open PR, a running job or a pending question (not
   safe). In a `Continuous mode: true` repo this is the final report only,
   never a message between cards: a merge there is not a stop.

## Continuous mode (a per-repo setting)

Each repo's own `CLAUDE.md` sets one line near its top:

```
Continuous mode: true|false
```

- **`false` (the default, also when the line is absent): one card, then
  stop.** Push the branch, open the PR, describe it, report, and wait.
  Merging is an explicit go-ahead from Louis, every time.
- **`true`: card after card.** Run the repo's full gate, wait for CI,
  merge your own PR, take the next card. Louis reviews merged work after
  the fact.

In a `true` repo:

- **Merge your own PR when it is ready; don't wait to be asked.** Ready
  means CI green on the current head, no merge conflict, no open review
  thread, the `Docs:` line filled in, and nothing in it that needs Louis
  (below). Never merge a PR another session or person opened unless Louis
  asks.
- **No draft stop in a `true` repo.** Cloud sessions open PRs as drafts
  by default, and a draft cannot be merged. `Continuous mode: true` is
  Louis's standing instruction to override that default: open the PR
  ready for review when the tool allows it, otherwise take it out of
  draft (`update_pull_request` with `draft: false`) as soon as it is
  pushed. Never leave a draft for Louis to promote; he does not
  validate PRs one by one in this mode. In a `false` repo, leave the PR
  as a draft.
- **Ending a turn to wait for CI is not stopping.** A cloud session cannot
  poll or `sleep`; the CI result wakes it. So: open the PR ready,
  subscribe to it, end the turn. That wait is expected. Never end the
  turn on a PR that is already mergeable (CI green on the current head):
  merge it.
- **A merge is not the end of the task.** The next action after the merge
  is the next card, in the same run, with no closing summary and no
  archive report (Git rule 8). One line for the merged PR, then:
  1. `git fetch origin main`, then restart the session's designated
     branch from it (`git checkout -B <branch> origin/main`). The merged
     PR is finished and never takes new commits.
  2. Pick the next card (below), rename the session to it, claim it
     (`in-progress`), and start.
- **Picking the next card is a routine call, not a question.** Use the
  order the repo's `CLAUDE.md` gives. Where it gives none: the top Todo
  card on the board with no `in-progress` label, no open PR or unmerged
  branch on it, no overlap with the files of an open PR and no epic
  another session holds. Where the board cannot be read, use open issues
  by label and say so in the PR. A draft PR that the repo marks as for
  Louis's review is not a card to pick up.
- **The only stops:** a case under "When to stop and ask Louis", or no
  eligible card left (then give the final report, archive line included).
  A CI failure, a review comment, an unclear card or a finished PR is
  work, an issue or the next card, never a reason to stop.
- Questions that don't require Louis become issues, not stops.

The setting changes only whether work pauses between cards. The cases
below stop a session in both modes, and only the repo's own file, never
this one, sets it.

### When to stop and ask Louis

With `Continuous mode: true`, work runs card after card without
interruption. Only one thing stops it:
something that **requires** human intervention. When that happens, always
stop and ask Louis; never guess past it, never work around it. Those cases
are:

- **Credentials and consent.** OAuth authorizations, app installs, API
  keys and secrets, 2FA or CAPTCHA, account creation, payments.
- **A decision only Louis can make that is costly to reverse.** Business
  intent the spec doesn't cover, a client preference, a legal or
  commercial call. A cheap, reversible choice is not a stop: make it,
  record it in the PR and move on.
- **Anything irreversible that leaves the repo.** Sending email,
  publishing, touching production data, deleting what can't be restored,
  unless that repo's `CLAUDE.md` grants standing authorization for that
  exact kind of action.
- **A check that can't be run from the session** and that the work
  depends on: a real client sample, a blocked host, a device, a judgement
  of tone or look.

Everything else (a CI failure, a review comment, an ambiguity with a
sensible default, a bug found in passing) is handled without asking: fix
it, or file it as an issue and continue.

## Where work is tracked

Most repos split this the same way, and the split only works if it is
kept:

- **Status lives in one place: the issues and the project board.** What is
  open, in flight, next or blocked. Never write an item's status into
  markdown (a checkbox, a "still to come" paragraph); move the card.
- **The record lives in the repo's files** (backlog, specs, `CLAUDE.md`):
  what shipped, why it is built that way, what it taught. When the work
  lands, update the record in the same PR: rewrite the backlog entry as
  the record, or, where the repo keeps its write-ups elsewhere (its
  `CLAUDE.md` or a `docs/` file), write it there and leave the backlog
  entry as a pointer to it. Either way, one copy of the reasoning.
- The code is the final word. If the board, a backlog entry and the code
  disagree, check the code, then fix whichever is wrong.

## Working across repositories

- A session works in one repository. If the work needs something from
  another of Louis's repositories (an issue, a PR, a new term, an
  identifier it does not yet mint, a convention) or would change what
  that repository says or exposes, stop before touching it and ask,
  with options and a recommendation: what the other repo would need,
  what happens if nothing is done there, and whether the dependency
  should exist at all.
- Reading another repo to copy a term or cite a decision needs no
  question. Each repo's own `CLAUDE.md` says what may be copied, and
  in which direction.
- Nothing from a private repo enters a public one: no name, no research
  subject, no "needed for X". A request filed in a public repo is
  written in that repo's own terms, as if the private one did not
  exist.
- Record the dependency in the repo that depends on it, so the next
  session finds it.

## Shared ontology

Facts, findings, claims, assessments, sources, evidence and people are
modelled the same way in every repo, by the public
[`louisbaudry/epistemic-ontology`](https://github.com/louisbaudry/epistemic-ontology).

- **Read it only when the work records or changes such things** (a data
  model, a vocabulary, an export, a note that states findings). Start with
  `specs/SPEC-001-core-assertion.md`. Don't load it at session start.
- A repo that adopts it keeps a short **profile** of the subset it uses, in
  its own docs. A profile narrows or adds terms; it never gives a core
  identifier another meaning.
- Copy terms and cite spec numbers; don't fetch the repo at run time.
- A need the ontology doesn't meet goes to Louis first, with options, per
  "Working across repositories". It is rewritten in neutral terms before
  it is filed there: that repo is public and shared, so no repo's case,
  subject or client appears in it.

## Before calling work done

- **Say what was verified and what was not.** Where something could not be
  checked from this session (no network to a host, no real sample), say so
  plainly. "Looks fine" is not reviewable.
- **Docs gate: no PR without it.** After the last code or content change and
  before the push that opens the PR (and again before any later push that
  changes behavior), walk this list against the diff and update what it
  touches, in the same PR:
  1. The repo's backlog or record: rewrite the entry for this work as
     the record (see "Where work is tracked").
  2. Specs and `docs/` pages that describe what changed, and
     `GLOSSARY.md` for any term the change adds or redefines.
  3. `README` and any setup or usage text the change makes wrong.
  4. `CLAUDE.md` (and `AGENTS.md`, kept in sync): commands, conventions,
     invariants, decisions.
  5. `INFRASTRUCTURE.md` where the change is an infrastructure change
     (rule in `CODING.md`).
  6. Other markdown the change makes stale: grep the repo for the old
     name, flag, path or behavior.

  The PR body carries one line, either "Docs: updated, <files>" or
  "Docs: no change, <why>". A bare "no change" does not pass: say what
  was checked. A PR without this line is not ready, and in a
  `Continuous mode: true` repo it is not merged. A draft opened early may
  say "Docs: pending", but never omit the line, and "pending" is replaced
  before the PR is marked ready.

  A rule alone did not hold, so each repo also merges the `docs-gate.json`
  hook from `settings/` in `claude-shared` into its `.claude/settings.json`
  (with `require-docs-line.sh` copied to `.claude/hooks/`). It blocks a PR
  tool call whose body has no valid `Docs:` line. It checks the line, not
  whether the docs were really updated; that is still the session's job
  and the reviewer's check.

- The kind-specific checks are in `CODING.md` or `NON-CODING.md`.

## Glossary

Every repo has a `GLOSSARY.md` at its root. Terms drift between sessions
(the same thing under two names, one name for two things); the glossary
is where each is fixed once.

- **Format:** a Markdown table, alphabetical, one row per term: _Term_,
  _Definition_ (one sentence), _Avoid_ (aliases and near-misses not to
  use). Add _Source_ (spec, issue, standard) where the term is not ours.
- **What goes in:** the repo's domain words, statuses, identifiers and
  anything a new reader would guess wrong. Not general vocabulary.
- **Use it:** read it before naming anything (code, docs, UI text, PR
  titles) and use its terms exactly. Where two terms collide, or a term
  is missing, follow "Adding or changing a term" below; don't pick
  silently.
- **Keep it current:** a change that adds or redefines a term updates the
  glossary in the same PR (docs gate).
- **No glossary yet:** the session start report says so (Local state).
  Before the task, create `GLOSSARY.md` in its own small PR, not mixed
  into the task's PR. Seed it from what the code, specs and docs already
  say (the repo's domain words, statuses and identifiers; usually 10 to 30
  rows), mark unconfirmed terms `unconfirmed`, and ask nothing: Louis
  reviews the draft.
- **Translation repos:** this is the repo's own working vocabulary, not
  the client termbase. Client glossaries stay in their own files and
  follow `NON-CODING.md` (originals are never edited).
- **Public repos:** the public-repo rules apply to it too: no client,
  person or private-repo term.
- **Per repo, not synced:** the rule is copied everywhere, the content
  never is.

### Adding or changing a term

**When to add one** (any of these):

- You are about to name something new that stands for a domain concept
  (a type, table, status, flag, command, heading, UI label).
- One concept appears under two names, or one name under two concepts.
- Louis uses a word with a specific meaning that is not written down.
- A reader would have to ask "what does X mean here?".

Not for general vocabulary, local variable names, or anything that names
a client or person (see public-repo rules).

**How to add one:**

1. **Search first.** Look in `GLOSSARY.md` and grep the repo for the term
   and its likely aliases. If it exists, reuse it; never add a second row
   for the same concept.
2. **Take the definition from evidence:** the code, specs, issues, or
   Louis's own words. Never invent one. If you cannot confirm it, write
   your best reading, mark the row `unconfirmed`, and say so in the PR.
3. **Write the row:**
   - _Term_: singular, lower case unless it is a proper noun; an
     identifier that appears in code goes in backticks.
   - _Definition_: one sentence saying what it is, not how it is used.
     Don't use the term itself or an undefined term in it.
   - _Avoid_: the aliases and near-misses actually found in the repo or
     in Louis's wording.
   - _Source_: only for a term taken from a spec, standard or issue.
4. **Insert it alphabetically** and keep the table Prettier-clean.
5. **Align what you touch.** If an _Avoid_ alias appears in files this
   change already edits, replace it in the same change. Elsewhere, don't
   sweep: file an issue, since mechanical renames go in their own PR.
6. **Say so in the PR:** the `Docs:` line names the glossary and the
   terms, e.g. "Docs: updated, GLOSSARY.md (added X; changed Y)".

**Two terms for one concept:** keep the one already used most in the
code, docs and user-facing text, and put the other in its _Avoid_ cell.
If it is close, or the term is user-facing, ask Louis with options and a
recommendation (see Communication); don't pick silently.

**Changing a term:**

- _Rename:_ the new name takes the row; the old name moves to _Avoid_.
- _Meaning change:_ this is a design decision. Record the reasoning where
  the repo keeps decisions (see "Design decisions go on the record"), and
  ask Louis first if other terms depend on it.
- _Retire:_ delete the row. If another term replaces it, the old name goes
  in that term's _Avoid_ cell.

**Language:** write each term in the language the repo uses for it. Code
identifiers stay in English. Add a column for another language only where
the repo already works in several.

## Design decisions go on the record

- Write a decision (a data model, a file-format detail, a scope change, a
  method) into the repo's docs before or alongside the change, never after.
  Keep the reasoning, not just the conclusion.
- Inspect what exists before proposing large changes. Prefer maintainable
  solutions over clever ones, and don't replace a working system just
  because another approach is fashionable.

## AI output is a proposal, not a fact

- Never invent source data: URLs, dates, authors, titles, quotes,
  statistics. Unknown means omit it or mark it as a placeholder.
- A model's output (an extraction, a classification, a translation, a
  verdict) never silently becomes evidence or a published finding. It is
  marked as AI-assisted where the repo supports it, and a human decides.

## Prompt suggestions

Louis wants the greyed-out prompt suggestions (Tab to accept) in every repo.
A rule here cannot switch a client setting, so each repo merges this key
(kept as `settings/prompt-suggestions.json` in `claude-shared`) into its own
`.claude/settings.json`:

```json
{
  "promptSuggestionEnabled": true
}
```

For his local client, the same key can go in `~/.claude/settings.json` once,
which covers every repo without copying.

## Fetching web sources

- If x.com refuses the direct fetch (HTTP 402), use a third-party mirror, such as api.fxtwitter.com.

## Public repositories

Before pushing, check whether the repo is public. If it is, everything
pushed is readable by anyone: code, fixtures, docs, commit messages,
branch names, and PR and issue text.

- **No personal data and no client data, ever, in any form.** That means
  no real names, email addresses, phone numbers or postal addresses. It
  also means no client names, client documents, translation memories,
  glossaries or text taken from them. No credentials, tokens or internal
  hostnames either. Nothing that would let a reader identify a client or a
  person behind a pseudonym. This covers test fixtures and "just a
  snippet" in an example or a log too.
- When unsure whether something identifies someone, leave it out and ask.
- Deleting a file in a later commit does not unpublish it: history keeps
  it. So the check happens before the push, not after.

Private repos still never get credentials or secrets committed.

## Keeping CLAUDE.md and AGENTS.md in sync

- In any repo that has both `CLAUDE.md` and `AGENTS.md`, they must always
  say the same thing. Whenever you edit one, make the equivalent edit to
  the other in the same commit.
- Before calling work done, check that the two still match. A mismatch is
  a bug: fix it, or say which file is right if you cannot tell.
- A repo that has only one of them is fine; don't create the other unless
  Louis asks.

## Maintaining this file

This file lives in `louisbaudry/claude-shared` (`shared/UNIVERSAL.md`). Update it there when a rule
turns out to apply everywhere, and move repo-specific detail back into
that repo's own `CLAUDE.md`. Propose changes; don't edit it silently from
another repo's session.
