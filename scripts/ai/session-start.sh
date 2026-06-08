#!/usr/bin/env bash
# Print the resume snapshot for a new Claude session: git state, the latest journal
# entry, and the open P0 tasks. Read docs/ai/RESUME.md for the full procedure.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

echo "==================== RxVision — session start ===================="
echo "Repo: $REPO"
echo
echo "## Git ----------------------------------------------------------"
echo "branch: $(git branch --show-current 2>/dev/null || echo '(none)')"
git status -s
echo "recent:"
git log --oneline -5 2>/dev/null
echo
echo "## Latest journal entry ----------------------------------------"
LAST="$(ls -1 docs/ai/journal/*.md 2>/dev/null | grep -v README | sort | tail -1 || true)"
if [ -n "$LAST" ]; then echo "($LAST)"; tail -n 40 "$LAST"; else echo "(no journal yet)"; fi
echo
echo "## Open P0 tasks (docs/todo.md) --------------------------------"
sed -n '/## P0/,/## P1/p' docs/todo.md 2>/dev/null | grep -E '^- \[( |~)\]' || echo "(none open)"
echo
echo "## Active long-running jobs ------------------------------------"
tmux list-windows -t "${RXV_SESSION:-rxvision}" 2>/dev/null | grep -E 'run-' || echo "(none)"
echo
echo "Next: read docs/ai/RESUME.md + docs/project-state.md, then continue."
echo "================================================================="
