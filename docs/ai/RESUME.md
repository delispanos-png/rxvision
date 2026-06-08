# RESUME — start-of-session procedure

Run this every time a new Claude session begins. ~2 minutes. The goal: rebuild full
context from the repository before touching anything.

## 1. Orient (read, in this order)
1. `CLAUDE.md` (repo root) — auto-loaded; the bootstrap.
2. `docs/ai/README.md` — the map of this system.
3. `docs/project-state.md` — where we are now (branch, what works, what's stubbed).
4. `docs/todo.md` — the task board; find the highest-priority open item.
5. The **latest** entry in `docs/ai/journal/` — what the previous session did + any
   "next step" it left.
6. `docs/ai/CONVENTIONS.md` — the working agreements (skim; they rarely change).

Shortcut: run `bash scripts/ai/session-start.sh` to print git state + the latest
journal entry + open P0 tasks in one shot.

## 2. Check the ground truth
```bash
git branch --show-current        # expected: quick-wins (current working branch)
git status -s                    # uncommitted work from a prior session
git log --oneline -8
tmux ls 2>/dev/null              # any live session?
tmux list-windows -t rxvision 2>/dev/null | grep run-   # any long job still running?
```
If a `run-*` window exists, a long task may be in progress — inspect it
(`tmux attach -t rxvision`) and its log under `docs/ai/runs/` before starting new work.

## 3. Reconcile
- If `git status` shows uncommitted changes, they are intentional (we **don't commit
  without being asked**). Cross-check them against the latest journal entry so you know
  what they are before building on top.
- If the journal's "Next step" is still valid, that's your starting point.

## 4. Confirm the guardrails (always in force)
- **No commit, no push** unless Panagiotis explicitly asks.
- **Ask before any application source-code change.** Docs/memory/workflow artifacts
  are fine to create/edit freely.
- **Never accept secrets in chat** (API tokens, keys, passwords). They go only in the
  server `.env` / a secret store.
- **Reply in Greek** (Panagiotis's preference); keep code, comments and these docs in English.
- Work on a branch, never `main`.

## 5. Start working
Pick the top open task from `docs/todo.md`, do it inside the tmux session
(`bash scripts/ai/rxvision-tmux.sh`), and when you stop, follow `docs/ai/HANDOFF.md`.
