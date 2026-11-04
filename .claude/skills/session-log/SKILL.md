---
name: session-log
description: Write the end-of-session entry in Louis's private ai-work-log repo. Use before the final report of any session that pushed a commit, opened or updated a PR, or changed something outside the repo, and when a hook says the session log is missing.
---

# Session log

Source: `UNIVERSAL.md` in the shared rules, section "Session log". One
short entry per substantive session, in `louisbaudry/ai-work-log`
(private). It serves three goals: what to automate next (leverage), how
well Louis uses AI (skill), and time and tokens per outcome (cost).

## Steps

1. Attach the repo: `add_repo` with owner `louisbaudry`, repo
   `ai-work-log`, access `push`. Clone it as the tool says.
2. Pull `main`. Read `templates/session-log.md` there; if it differs from
   the format below, the repo's template wins.
3. Write one new file:
   `logs/YYYY/MM/YYYY-MM-DD-<repo>-<slug>.md`, where `<repo>` is the
   session's repo name without the owner and `<slug>` is 2-5 lowercase
   hyphenated words naming the task. If this session already wrote an
   entry, edit that file instead of adding a second.
4. Commit (message: `log: <repo> <slug>`) and push straight to `main`.
   Standing authorization: only new or this-session files under `logs/`.
   If the push is refused, pull, rebase and push once more.
5. Can't attach or push? Put the entry in the final reply under a
   "Session log" heading so Louis can file it. Say why.

## Format

```markdown
---
date: YYYY-MM-DD
agent: claude
repo: owner/name
branch: <branch>
session: <session URL or unknown>
model: unknown
duration_min: unknown
tokens: unknown
outcome: done # done | partial | abandoned | answered | blocked
links: [] # PRs, issues, notes
skills_used: []
tools_used: []
repeat: no # yes if this task has been done before by hand
---

## Asked

## Done

## Friction

## Repeat?

## Lesson
```

## Rules

- About ten lines of prose in all. A record, not a transcript: no message
  content, no pasted text, no chain of thought.
- Honest _Friction_ and _Lesson_: re-asks, corrections, blocked tools,
  waiting on Louis. "None" is allowed; padding is not.
- `unknown` for any metadata you cannot read. Never estimate duration or
  tokens.
- No health, family or money detail: one word for the topic and a link to
  where the detail lives. No names from a public repo's rules, no
  credentials, emails or phone numbers.
- Never commit to anything in `ai-work-log` except `logs/`.
