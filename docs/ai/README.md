# RxVision — AI Tech Lead Operating System

This directory is the **persistent working environment** for the AI Technical Lead.
Its purpose: any future Claude session can resume work with full context, work
survives SSH disconnects, and all project knowledge lives in the repository.

> If you are a Claude session starting up: go to **[RESUME.md](RESUME.md)** now.

## The model: three layers

**1. Living state — the data (update as you work):**
| File | Answers | Cadence |
|---|---|---|
| [`../project-state.md`](../project-state.md) | *Where are we right now?* | every session |
| [`../todo.md`](../todo.md) | *What's next?* (the task board) | every session |
| [`../decisions.md`](../decisions.md) | *Why did we do it this way?* (ADR log) | when a non-obvious choice is made |
| [`journal/`](journal/) | *What happened, when?* (chronological log) | one entry per session |

**2. Operating manual — the process (read, rarely change):**
| File | Purpose |
|---|---|
| [`RESUME.md`](RESUME.md) | Exact start-of-session procedure |
| [`HANDOFF.md`](HANDOFF.md) | Exact end-of-session procedure + journal template |
| [`TMUX.md`](TMUX.md) | tmux session/window design (disconnect survival) |
| [`LONG-RUNNING-TASKS.md`](LONG-RUNNING-TASKS.md) | Running long jobs without losing progress |
| [`CONVENTIONS.md`](CONVENTIONS.md) | Working agreements & guardrails (git, secrets, language) |

**3. Automation — the tools (`scripts/ai/`):**
| Script | Does |
|---|---|
| `scripts/ai/rxvision-tmux.sh` | Create/attach the standard tmux session |
| `scripts/ai/session-start.sh` | Print the resume snapshot (git + journal + P0 tasks) |
| `scripts/ai/run-task.sh` | Run a long command detached, with a timestamped log |

Plus the repo root **[`../../CLAUDE.md`](../../CLAUDE.md)** — the bootstrap that every
session auto-loads — and the five analysis reports in the repo root
(`architecture-review.md`, `technology-stack.md`, `technical-debt.md`,
`security-review.md`, `quick-wins.md`).

## The loop

```
  start ──▶ RESUME.md ──▶ pick a task (todo.md) ──▶ work in tmux
    ▲                                                   │
    │                                                   ▼
  HANDOFF.md ◀── update state + journal ◀── finish / disconnect
```

## Design principles

- **Repo is the single source of truth.** No knowledge lives only in a chat window or
  in one session's head — if it matters, it's a file here.
- **Plain Markdown + small shell scripts.** No databases, no services to keep alive.
  Greppable, diff-able, survives anything.
- **Idempotent & append-only where it counts.** The journal and decisions log only
  grow; state and tasks are edited in place.
- **Lean over bureaucratic.** Every file earns its place; if a ritual stops being
  useful, delete it and note why in `decisions.md`.
