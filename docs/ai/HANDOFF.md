# HANDOFF — end-of-session procedure

Run this before you stop (or whenever you reach a natural checkpoint). The goal: the
next session — which remembers nothing — can pick up with zero loss. **Leave the repo
as the message.**

## Checklist
1. **Update `docs/project-state.md`** — make the snapshot true again: branch, what now
   works, what changed, what's still stubbed/blocked. Update the date.
2. **Update `docs/todo.md`** — tick finished items (`[x]` + date), add new ones, adjust
   priorities. The top of the list should be the obvious next thing.
3. **Append to `docs/decisions.md`** — for any non-obvious choice made this session
   (one `D-NNN` entry: what + why + alternatives rejected).
4. **Write a journal entry** — `docs/ai/journal/YYYY-MM-DD.md` using the template below.
   One file per day; append multiple sessions to the same day's file under `## HH:MM` headers.
5. **Leave the working tree clean-ish** — if a long job is running, note it in the
   journal with its `docs/ai/runs/` log path and tmux window.
6. **Do NOT commit/push** unless asked. The uncommitted diff + the docs ARE the handoff.

## Journal entry template
```markdown
## <HH:MM> — <short title>

**Did:** <what got done, with file paths>
**Decisions:** <D-NNN refs, or "none">
**State change:** <what's different now in project-state.md / todo.md>
**Verification:** <what was run/checked; note if Docker/pip/npm were unavailable>
**Blocked / waiting on Panagiotis:** <questions, approvals needed, or "nothing">
**Next step:** <the single most useful thing to do next — your gift to the next session>
```

## What "done" means here
A task is done when: the change is made, it's verified to whatever degree the
environment allows (`py_compile` / `yaml` parse / `bash -n` / unit tests if runnable),
the three state files reflect it, and a journal entry records it. Half-done work is
fine to leave — just say so explicitly in **Next step**.
