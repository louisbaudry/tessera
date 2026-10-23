---
name: glossary
description: How to keep a repo's GLOSSARY.md. Use before naming anything that stands for a domain concept (type, table, status, flag, command, heading, UI label), when one concept has two names or one name two meanings, when Louis uses a term with a specific meaning, or when a repo has no GLOSSARY.md yet.
---

# Glossary

Source: `UNIVERSAL.md` in the shared rules, sections "Glossary" and
"Adding or changing a term". Every repo has a `GLOSSARY.md` at its root.

## Format

Markdown table, alphabetical, one row per term: _Term_, _Definition_ (one
sentence), _Avoid_ (aliases and near-misses). Add _Source_ where the term
is not ours. Keep it Prettier-clean. Domain words, statuses, identifiers
and anything a new reader would guess wrong go in; general vocabulary,
local variable names and names of clients or people do not.

## Using it

Read it before naming anything (code, docs, UI text, PR titles) and use its
terms exactly. If a term is missing or two collide, follow the steps below;
never pick silently. A change that adds or redefines a term updates the
glossary in the same PR.

## Adding a term

1. **Search first:** `GLOSSARY.md`, then grep the repo for the term and its
   aliases. Reuse an existing row; never add a second for one concept.
2. **Take the definition from evidence** (code, specs, issues, Louis's
   words). Never invent one. If unconfirmed, write the best reading, mark
   the row `unconfirmed`, and say so in the PR.
3. **Write the row:** term singular and lower case unless a proper noun
   (identifiers in backticks); definition says what it is, not how it is
   used, without using the term itself; _Avoid_ lists aliases actually
   found; _Source_ only for spec, standard or issue terms.
4. **Insert alphabetically.**
5. **Align what you touch:** replace an _Avoid_ alias in files this change
   already edits; elsewhere file an issue (mechanical renames get their own
   PR).
6. **Say so in the PR:** the `Docs:` line names the glossary and the terms.

## Two terms, one concept

Keep the one used most in code, docs and user-facing text; put the other in
_Avoid_. If it is close, or the term is user-facing, ask Louis with options
and a recommendation.

## Changing a term

- Rename: new name takes the row, old name moves to _Avoid_.
- Meaning change: a design decision; record the reasoning where the repo
  keeps decisions, and ask Louis first if other terms depend on it.
- Retire: delete the row; if another term replaces it, the old name goes in
  that term's _Avoid_.

## No glossary yet

The session start report says so. Before the task, create `GLOSSARY.md` in
its own small PR: seed it from what code, specs and docs already say
(usually 10 to 30 rows), mark unconfirmed terms `unconfirmed`, and ask
nothing. Louis reviews the draft.

## Special cases

Language: write each term in the language the repo uses for it; code
identifiers stay English. Public repos: no client, person or private-repo
term. Translation repos: this is the repo's working vocabulary, not the
client termbase.
