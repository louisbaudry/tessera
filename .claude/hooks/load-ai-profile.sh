#!/bin/bash
# SessionStart hook: loads Louis's shared Claude Code context from the
# private louisbaudry/ai_profile repo into every session of the repo that
# carries a copy of this script.
#
# Canonical copy: louisbaudry/ai_profile hooks/load-ai-profile.sh.
# Install into another repo as .claude/hooks/load-ai-profile.sh (see
# hooks/README.md). Whatever this prints on stdout becomes session context.
#
# Sources, first one that works wins:
#   1. A local clone: $AI_PROFILE_DIR, else ../ai_profile or ~/ai_profile.
#   2. The GitHub API with $AI_PROFILE_TOKEN, a fine-grained read-only token
#      scoped to louisbaudry/ai_profile (Contents: Read).
# It never fails the session: on any problem it says what is missing and
# exits 0.
set -uo pipefail

REPO="louisbaudry/ai_profile"
REF="${AI_PROFILE_REF:-main}"
FILES=(CLAUDE.md ai_profile.md)

emit() {
  printf '\n===== %s (from %s) =====\n\n%s\n' "$1" "$REPO" "$2"
}

find_local() {
  local candidates=("${AI_PROFILE_DIR:-}")
  [ -n "${CLAUDE_PROJECT_DIR:-}" ] && candidates+=("$CLAUDE_PROJECT_DIR/../ai_profile")
  candidates+=("$HOME/ai_profile")
  for dir in "${candidates[@]}"; do
    [ -n "$dir" ] && [ -f "$dir/CLAUDE.md" ] && [ -f "$dir/ai_profile.md" ] && {
      echo "$dir"
      return 0
    }
  done
  return 1
}

# Skip when the session is in ai_profile itself: its CLAUDE.md loads natively.
if [ "$(basename "${CLAUDE_PROJECT_DIR:-}")" = "ai_profile" ]; then
  exit 0
fi

echo "Shared context for working with Louis follows. Apply it in this repo;"
echo "this repo's own CLAUDE.md adds repo-specific rules on top of it."

if dir="$(find_local)"; then
  for f in "${FILES[@]}"; do
    emit "$f" "$(cat "$dir/$f")"
  done
  exit 0
fi

if [ -z "${AI_PROFILE_TOKEN:-}" ]; then
  echo
  echo "NOTE: shared context NOT loaded: no local ai_profile clone and"
  echo "AI_PROFILE_TOKEN is not set. Tell Louis once, briefly, at the start."
  exit 0
fi

for f in "${FILES[@]}"; do
  if body="$(curl -fsS --max-time 15 \
      -H "Authorization: Bearer $AI_PROFILE_TOKEN" \
      -H "Accept: application/vnd.github.raw+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "https://api.github.com/repos/$REPO/contents/$f?ref=$REF" 2>&1)"; then
    emit "$f" "$body"
  else
    echo
    echo "NOTE: could not fetch $f from $REPO: ${body//$AI_PROFILE_TOKEN/***}"
    echo "Tell Louis once, briefly, at the start."
  fi
done
exit 0
