# Rules for coding repos

> Applies to repos that ship code. Read after [`UNIVERSAL.md`](UNIVERSAL.md),
> which holds the rules common to every repo (communication, git and PRs,
> tracking, public-repo safety). A repo's own `CLAUDE.md` may narrow these.

## Before calling work done

- Run the repo's full set of checks (format, lint, typecheck, build,
  tests, whatever it defines) and report the result honestly.
- **If a check fails, the change is presumed wrong, not the check.** Don't
  regenerate expected outputs, loosen an assertion, or skip a test to get
  to green. A golden or snapshot diff is something to read and explain,
  not something to overwrite.
- Where a repo has no automated tests, say exactly what you ran by hand
  and what you saw; "works locally" is not reviewable.
- A test that has never been seen to fail proves nothing. When adding one,
  check that it fails when the thing it tests is broken.
- In any script that pipes a check's output (`cmd | tee log`), use
  `set -o pipefail`. Otherwise the pipe hides the command's exit code.

## Tests

Agents write most of the code, so tests are the independent check. The
policy is tiered by risk, not blanket TDD.

1. **Test first (red, then green) for:**
   - **Bug fixes.** Write a test that reproduces the bug and watch it fail,
     then fix. The fix PR carries that test.
   - **Hard invariants** of the repo: a rule that must never break
     (a spending or length cap, an access rule, a no-leak guarantee, an
     idempotency guarantee). Each one gets a test before the code that
     enforces it, and the repo's `CLAUDE.md` lists them.
2. **Test with the code, same PR, any order,** for everything else that
   has logic. A PR that adds logic with no test says why in its body.
3. **No test needed** for copy, styling, markdown and one-off data edits.
4. **Never weaken a test to get green:** see "Before calling work done".
   Changing an existing test is fine when the behavior was meant to
   change; the PR says so and why.
5. **The PR says what was tested and what could not be.** CI running the
   suite is a required check before any merge; a repo with code and no CI
   suite files a card for it.
6. **Shape of a good agent-era test:**
   - Runs offline: no API keys, no network, no shared database.
   - Asserts behavior and contracts, not implementation details.
   - For SQL and row-level security, run the migrations on a scratch
     Postgres and assert as each role (anonymous, owner, end user).
7. **LLM output:** don't test the model. Test the code that enforces rules
   on its answer (validators, filters, parsers). Prompt changes get a
   small fixed set of golden cases, read by a human when they differ.

## Code comments

- **Document the public surface.** Every public module, class and function
  gets a doc comment in the language's native format (YARD, JSDoc,
  docstring, rustdoc), so the repo's docs can be generated from it:
  what it does, its parameters, what it returns, what it raises.
- **Inline comments say why, not what.** Explain a constraint, a trade-off
  or a surprise. Don't narrate code that already reads clearly.
- Change behavior, change the comment in the same commit. A stale comment
  is worse than none.
- Match the repo's existing comment density and format; this rule fills
  gaps, it doesn't trigger a rewrite of a documented codebase.

### One-time sync (pending)

A repo records that it has applied this rule by adding the line
`Code comments rule synced: YYYY-MM-DD` to its own `CLAUDE.md`. In a
session on a coding repo whose `CLAUDE.md` lacks that line, before the
task: check the repo's `CLAUDE.md` (and `AGENTS.md` if present) against
"Code comments" above, add or adjust only what is missing or contradicts
it, and add the line. Do this in its own small PR, not mixed into the
task's PR. Never edit another repo from a session; each repo does its own
on its next session. Louis removes this subsection once the repos are
synced.

## Parallel sessions on one repo

Several sessions may work on the same repo at once if they do not collide.

- **Claim before starting.** Assign the issue to yourself, or add an
  `in-progress` label, and skip any card that already has one. "Todo" does
  not mean free. Two sessions taking "the next card" at once is the commonest
  failure.
- **One area per session.** Split cards by module or file set, not just by
  order. Don't start a card that overlaps files an open PR already touches;
  say so and ask.
- **Re-gate after syncing `main`.** Before merging, merge current `main`
  into the branch and re-run the full checks on the result. A clean git merge
  can still break behaviour; only the checks show it. Never merge on a CI
  result that predates the latest `main`.
- **Shared record files conflict by design** (backlog, changelog, `CLAUDE.md`).
  Keep entries small and in separate sections; whoever merges second resolves
  the conflict by keeping both sides, never by dropping the other session's
  entry.
- **State outside git is shared too:** database migrations (check the next
  number against `main` just before merging), lockfiles and generated files
  (regenerate with the repo's tooling, don't hand-merge), a shared dev
  database, ports, deploys. Run migrations and deploys only from the session
  that owns that area, and never against shared or production data from a
  session that doesn't.

## Infrastructure register

The infrastructure of every code repo is recorded in one file,
`INFRASTRUCTURE.md`, at the root of the private `louisbaudry/claude-shared`
repo. Read the repo's section before changing how it is hosted, built or
deployed.

- **What counts as an infrastructure change:** hosting provider, server,
  region or OS; containers, Compose files, Dockerfile base image, runtime
  or language major version; reverse proxy or TLS; database engine,
  version, host or Supabase project; storage buckets; backups; CI or CD
  workflows and the deploy mechanism; container or package registry;
  scheduled jobs; domains and DNS; external service providers; where
  secrets live; environments. Creating, moving, archiving or retiring a
  repo that has any of these counts too.
- **When:** in the same session as the change, before calling the work
  done. The repo's PR carries one line, either "Infrastructure: updated,
  with the link to the claude-shared PR" or "Infrastructure: no change".
- **How:** open a separate, small draft PR in `claude-shared` on its own
  branch that edits only that repo's section (plus its row in the
  overview table and its "Last full survey" note if that was refreshed).
  Louis authorizes this one cross-repo edit as a standing rule, limited
  to `INFRASTRUCTURE.md`; it is the exception to "Working across
  repositories" in `UNIVERSAL.md`. Never merge that PR unasked, since
  `claude-shared` is not in continuous mode. A session that cannot reach
  `claude-shared` says so in its PR and gives Louis the exact text to add.
- **What to write:** standard terms (VPS, reverse proxy, Docker Compose,
  CI, CD, container registry, scheduled job), using the fields already in
  the file. State what the repo's files say; mark anything not confirmed
  as unconfirmed.
- **Never in the register:** credentials of any kind, including default
  passwords, connection strings with a password and key values. Name
  where a secret lives, not what it is. The file stays at the root of
  `claude-shared`, never in `shared/`, because the sync copies `shared/`
  into other repos, some of them public.

## Design

- **Define a shared fact once and import it everywhere.** Two copies of a
  constant, schema or regex can drift apart without anyone noticing.
- A test fixture that encodes a belief about someone else's format proves
  only that belief. Check it against a real sample before trusting the
  tests built on it.
- Keep a change to what the task needs. Refactors, renames and dependency
  bumps that the task doesn't require go in their own issue and PR.

## Security and data

- No credentials, tokens or secrets in code, fixtures, logs or commit
  messages, in public or private repos. Read them from the environment.
- Say in the commit message whether the change adds outbound data flows,
  new dependencies or new permissions ("none" is an answer).
- Fixtures use synthetic data. Real client or personal data never goes in
  a fixture, even trimmed (see the public-repo rules in `UNIVERSAL.md`).

## Supabase permissions

Permission rules are read from the session repo's own `.claude/settings.json`,
not from this repo, so each repo that uses Supabase copies a snippet from
[`settings/`](https://github.com/louisbaudry/claude-shared/tree/main/settings):

- **Default (every Supabase repo):** merge `supabase-read.json`. Read-only
  tools no longer prompt. `execute_sql`, migrations, edge-function deploys
  and every branch or project action still prompt.
- **Select, insert and update without prompts (recommended for dev):** merge
  `supabase-write.json` instead, copy `block-sql-destructive.sh` to
  `.claude/hooks/`, and put the repo's Supabase project ref on one line in
  `.claude/supabase-project-ref` (or let `supabase link` write
  `supabase/.temp/project-ref`). The hook auto-approves `execute_sql` only
  when its `project_id` equals that declared ref and blocks delete, drop,
  truncate, alter, create, grant, revoke and copy. Any other project, or no
  declared ref, falls back to the normal prompt. The ref goes in the
  consuming repo only if that repo is private.
- `execute_sql` is deliberately not in the `allow` list: a permission rule
  matches the tool name only, so it cannot tell one project or one statement
  from another. The hook can, which is why write access goes through it.
  The hook is a keyword check, not a security boundary; real enforcement is
  database privileges. Never put a project ref or key in a snippet here:
  this repo is public.

## AI output in code

- Generated code is a proposal: read it, run it, and be able to explain it
  before it goes in a PR.
- Never invent APIs, flags, package names or versions. Check the docs or
  the installed source; say so when you could not.
