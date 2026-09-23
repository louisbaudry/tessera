# Agent instructions

This project's actual instructions for coding agents live in
[`CLAUDE.md`](CLAUDE.md) — conventions, the working rhythm, non-negotiable
invariants, and gotchas that have already cost time once. Read that file,
not this one.

This file exists only because some tools look for `AGENTS.md` specifically
and would otherwise miss the real instructions. It is deliberately a
pointer, not a second copy: two files carrying the same guidance drift
apart the moment one of them is updated and the other isn't — exactly the
mistake `CLAUDE.md`'s own "frozen, cross-package fact" rule exists to
prevent, applied to documentation instead of code.

If you are about to add project-specific guidance for an agent, add it to
`CLAUDE.md` and leave this file as it is.
