#!/usr/bin/env bash
# Run a long command in a dedicated, detached tmux window with a timestamped log,
# so it survives SSH disconnects and the full output is recoverable afterwards.
#
# Usage:  scripts/ai/run-task.sh <label> -- <command...>
# Example: scripts/ai/run-task.sh smoke   -- make smoke
#          scripts/ai/run-task.sh build   -- docker compose build
#
# The window stays open after the command finishes (so you can read the tail and
# the recorded exit code); close it with `exit` once you're done.
set -euo pipefail

SESSION="${RXV_SESSION:-rxvision}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS="$REPO/docs/ai/runs"
mkdir -p "$RUNS"

LABEL="${1:-task}"; shift || true
[ "${1:-}" = "--" ] && shift || true
[ "$#" -gt 0 ] || { echo "usage: $0 <label> -- <command...>"; exit 1; }

TS="$(date +%Y%m%d-%H%M%S)"
LOG="$RUNS/${TS}-${LABEL}.log"
CMD="$*"
WIN="run-${LABEL}"

tmux has-session -t "$SESSION" 2>/dev/null \
  || tmux new-session -d -s "$SESSION" -c "$REPO" -n claude

# bash -c: mirror all output to the log via process substitution, run the command,
# record its real exit code, then drop to an interactive shell so the window persists.
tmux new-window -t "$SESSION" -n "$WIN" -c "$REPO" \
  bash -c "exec > >(tee -a '$LOG') 2>&1; echo \"\$ $CMD\"; $CMD; echo \"--- exit \$? @ \$(date -Is) ---\"; exec bash"

echo "started:  $CMD"
echo "  window: $SESSION:$WIN"
echo "  log:    $LOG"
echo "watch  -> tmux attach -t $SESSION   (or)   tail -f '$LOG'"
