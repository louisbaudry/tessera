#!/usr/bin/env bash
# SessionStart hook.
#
# Reinforces the "Model and speed check" rule in shared/UNIVERSAL.md. A hook
# cannot ask Louis anything and cannot switch the model, so it only injects
# a reminder into the session context at startup (and on resume or clear).
# The session itself asks, once the first request is known.
cat <<'MSG'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Model and speed check (UNIVERSAL.md): after the session start report and once the first request is known, ask one AskUserQuestion recommending the model and speed for that task (recommended option first, labelled \"(Recommended)\"), then wait for the answer before doing any work. You cannot switch the model yourself: Louis uses /model and /fast. If the current model is already the recommended one, say so in one line and continue."}}
MSG
exit 0
