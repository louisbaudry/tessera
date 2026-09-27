#!/bin/bash
# SessionStart hook: loads Louis's shared Claude Code context into every
# session of the repo that carries a copy of this script. Whatever it prints
# on stdout becomes session context.
#
# Canonical copy: louisbaudry/claude-shared hooks/load-shared-context.sh.
# Install into another repo as .claude/hooks/load-shared-context.sh (see
# hooks/README.md).
#
#   CLAUDE.md      public louisbaudry/claude-shared: the working rules.
#                  Local clone ($CLAUDE_SHARED_DIR, ../claude-shared,
#                  ~/claude-shared), else fetched anonymously from GitHub.
#   ai_profile.md  private louisbaudry/ai_profile: who Louis is. Optional.
#                  Local clone ($AI_PROFILE_DIR, ../ai_profile, ~/ai_profile),
#                  else the GitHub API, which succeeds in a cloud session only
#                  when ai_profile is one of the session's repos (the cloud
#                  proxy substitutes the session's own GitHub credentials), or
#                  locally with $AI_PROFILE_TOKEN.
#
# It never fails the session: on any problem it says what is missing and
# exits 0.
set -uo pipefail

REF="${CLAUDE_SHARED_REF:-main}"

emit() {
  printf '\n===== %s (from %s) =====\n\n%s\n' "$1" "$2" "$3"
}

find_local() { # <file> <dir>...
  local file="$1" dir
  shift
  for dir in "$@"; do
    [ -n "$dir" ] && [ -f "$dir/$file" ] && {
      echo "$dir/$file"
      return 0
    }
  done
  return 1
}

fetch() { # <owner/repo> <file> [token]
  local auth=()
  [ -n "${3:-}" ] && auth=(-H "Authorization: Bearer $3")
  curl -fsS --max-time 15 ${auth[@]+"${auth[@]}"} \
    -H "Accept: application/vnd.github.raw+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/$1/contents/$2?ref=$REF" 2>&1
}

parent="${CLAUDE_PROJECT_DIR:+$CLAUDE_PROJECT_DIR/..}"

echo "Shared context for working with Louis follows. Apply it in this repo;"
echo "this repo's own CLAUDE.md adds repo-specific rules on top of it."

# The rules. Required: say so loudly if they are missing.
if f="$(find_local CLAUDE.md "${CLAUDE_SHARED_DIR:-}" "${parent:+$parent/claude-shared}" "$HOME/claude-shared")"; then
  emit CLAUDE.md louisbaudry/claude-shared "$(cat "$f")"
elif body="$(fetch louisbaudry/claude-shared CLAUDE.md)"; then
  emit CLAUDE.md louisbaudry/claude-shared "$body"
else
  echo
  echo "NOTE: shared rules NOT loaded: could not fetch CLAUDE.md from"
  echo "louisbaudry/claude-shared ($body). Tell Louis once, briefly, at the start."
fi

# The profile. Optional: one quiet line if unavailable.
if f="$(find_local ai_profile.md "${AI_PROFILE_DIR:-}" "${parent:+$parent/ai_profile}" "$HOME/ai_profile")"; then
  emit ai_profile.md louisbaudry/ai_profile "$(cat "$f")"
elif body="$(fetch louisbaudry/ai_profile ai_profile.md "${AI_PROFILE_TOKEN:-}")"; then
  emit ai_profile.md louisbaudry/ai_profile "$body"
else
  echo
  echo "(ai_profile.md not available in this session. That is expected unless"
  echo "louisbaudry/ai_profile was selected as a session repo; no need to mention it.)"
fi
exit 0
