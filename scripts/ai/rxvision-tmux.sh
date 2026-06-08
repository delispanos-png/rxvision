#!/usr/bin/env bash
# Standard RxVision tmux session for the AI Tech Lead.
# Idempotent: creates the session + windows if missing, otherwise just attaches.
#
# WHY: run everything — including the Claude Code CLI itself — inside this tmux
# session so all work survives SSH disconnects. Detach with `Ctrl-b d`; reconnect
# later and `tmux attach -t rxvision` to find everything exactly as you left it.
set -euo pipefail

SESSION="${RXV_SESSION:-rxvision}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session '$SESSION' already exists — attaching."
else
  echo "creating tmux session '$SESSION' at $REPO"
  # 0: claude  — the Claude Code CLI (the AI Tech Lead) runs here
  tmux new-session -d -s "$SESSION" -c "$REPO" -n claude
  tmux send-keys -t "$SESSION:claude" \
    "echo '[0:claude] run the Claude Code CLI here  ->  claude'" C-m

  # 1: stack   — docker compose / the running app
  tmux new-window -t "$SESSION" -c "$REPO" -n stack
  tmux send-keys -t "$SESSION:stack" \
    "echo '[1:stack] app stack  ->  docker compose up --build   |   make up'" C-m

  # 2: shell   — git + general shell
  tmux new-window -t "$SESSION" -c "$REPO" -n shell
  tmux send-keys -t "$SESSION:shell" "git status -s; git log --oneline -5" C-m

  # 3: tasks   — long-running jobs (see scripts/ai/run-task.sh)
  tmux new-window -t "$SESSION" -c "$REPO" -n tasks
  tmux send-keys -t "$SESSION:tasks" \
    "echo '[3:tasks] long jobs  ->  scripts/ai/run-task.sh <label> -- <cmd>'" C-m

  # 4: logs    — tail logs
  tmux new-window -t "$SESSION" -c "$REPO" -n logs
  tmux send-keys -t "$SESSION:logs" \
    "echo '[4:logs] tail logs  ->  make logs svc=api   |   tail -f docs/ai/runs/*.log'" C-m

  tmux select-window -t "$SESSION:claude"
fi

# Attach from outside tmux, or switch if already inside a tmux client.
if [ -n "${TMUX:-}" ]; then
  tmux switch-client -t "$SESSION"
else
  tmux attach-session -t "$SESSION"
fi
