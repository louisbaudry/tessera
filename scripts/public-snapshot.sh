#!/usr/bin/env bash
# Build the public repository's first commit from this (private) one.
#
# Why a snapshot and not "make this repo public": everything below was
# committed at some point, and history keeps it — deleting a file in a new
# commit hides nothing, and GitHub keeps old commits reachable through
# pull-request refs even after a history rewrite. So the public repository
# starts from one squashed commit of a cleaned tree, and this one stays
# private as the archive.
#
# Usage:
#   scripts/public-snapshot.sh OUT_DIR [REF]
#
# REF defaults to HEAD. OUT_DIR must not exist. The result is a fresh git
# repository with one commit on `main`, authored as whatever
# GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL say (default: your git config). Use
# your GitHub noreply address if you don't want an email in public history.
#
# The denylist check reads scripts/public-denylist.txt — real names that
# must never appear in the public tree. That file is itself excluded from
# the snapshot, because a list of names to hide is a list of the names.
set -euo pipefail

out=${1:?usage: public-snapshot.sh OUT_DIR [REF]}
ref=${2:-HEAD}
repo=$(git rev-parse --show-toplevel)
denylist="$repo/scripts/public-denylist.txt"

if [[ -e "$out" ]]; then
  echo "refusing: $out already exists" >&2
  exit 1
fi

# Never published: confidential business material, and the parked
# Tauri/FastAPI prototype (it also carries compiled .pyc files with local
# paths in them).
EXCLUDE=(
  planning/pricing-model.md
  planning/agency-validation-questions.md
  planning/conversation-context.md
  scripts/public-denylist.txt
  code
)

mkdir -p "$out"
git -C "$repo" archive "$ref" | tar -x -C "$out"
for path in "${EXCLUDE[@]}"; do
  rm -rf "${out:?}/$path"
done

# README lines that point at excluded paths.
sed -i.bak -E '/planning\/(pricing-model|conversation-context|agency-validation-questions)\.md|^code\/ /d' "$out/README.md"
rm -f "$out/README.md.bak"

# Denylist: case-insensitive, whole tree, binaries included (DOCX parts are
# zipped, so they are checked unpacked).
fail=0
if [[ -f "$denylist" ]]; then
  pattern=$(grep -vE '^\s*(#|$)' "$denylist" | paste -sd'|' -)
  if grep -rIniE "$pattern" "$out" >/tmp/public-snapshot-hits.txt 2>/dev/null; then
    echo "denylisted terms found in text files:" >&2
    cut -c1-200 /tmp/public-snapshot-hits.txt >&2
    fail=1
  fi
  while IFS= read -r -d '' docx; do
    if unzip -p "$docx" '*.xml' '*.rels' 2>/dev/null | grep -qiE "$pattern"; then
      echo "denylisted terms found inside $docx" >&2
      fail=1
    fi
  done < <(find "$out" -name '*.docx' -print0)
else
  echo "warning: $denylist missing — skipping the denylist check" >&2
fi
# Emails: only placeholder domains are allowed anywhere.
if grep -rIhoE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}' "$out" \
  --exclude=pnpm-lock.yaml |
  grep -vE '@(example\.(com|org|net)|[a-z0-9-]+\.example|users\.noreply\.github\.com|anthropic\.com)$' |
  sort -u >/tmp/public-snapshot-emails.txt && [[ -s /tmp/public-snapshot-emails.txt ]]; then
  echo "note: real-looking email addresses (review each):" >&2
  cat /tmp/public-snapshot-emails.txt >&2
fi
if [[ $fail -ne 0 ]]; then
  echo "snapshot NOT committed — fix the above first" >&2
  exit 1
fi

git -C "$out" init -q -b main
git -C "$out" add -A
git -C "$out" commit -q -m "Initial public release

Squashed from the private development repository at $(git -C "$repo" rev-parse --short "$ref")."
echo "public snapshot ready: $out ($(git -C "$out" ls-files | wc -l | tr -d ' ') files)"
