# LONG-RUNNING TASKS — running jobs without losing progress

For anything that takes minutes (builds, `make smoke`, ingestion backfills, test
suites, migrations): never run it in the foreground of an SSH shell that might drop.

## The one command
```bash
scripts/ai/run-task.sh <label> -- <command...>
# examples:
scripts/ai/run-task.sh smoke -- make smoke
scripts/ai/run-task.sh build -- docker compose -f docker-compose.prod.yml build
```
It:
- runs the command in a **dedicated detached tmux window** (`run-<label>`) — survives disconnects,
- mirrors all output to a **timestamped log** at `docs/ai/runs/<ts>-<label>.log`,
- records the **real exit code** (`--- exit N @ <time> ---`) at the end,
- keeps the window open afterwards so you can read the tail.

## Monitor
```bash
tail -f docs/ai/runs/*.log              # live output
tmux attach -t rxvision                 # then jump to the run-<label> window
tmux list-windows -t rxvision | grep run-   # what's still running
```

## When it finishes
- Read the exit line in the log. Non-zero → investigate; the full output is in the log.
- Close the window: `tmux kill-window -t rxvision:run-<label>` (or type `exit` in it).
- Record the outcome in the journal (with the log path if it failed).

## Run logs are local, not committed
`docs/ai/runs/` has its own `.gitignore` so logs never enter git. They are scratch
output for the current/next session, not project knowledge — distil anything important
into the journal or `project-state.md`.

## For the Claude session itself (harness notes)
- Prefer the harness's own background execution (`run_in_background`) for long commands
  you launch directly — you'll be re-invoked when they finish, so don't poll in a tight loop.
- Use `run-task.sh` when the job should outlive the session entirely (a human will check
  it later) or when Panagiotis will watch it in tmux.
- If you must wait on external state the harness can't track, schedule a sensible wakeup
  rather than busy-waiting.
