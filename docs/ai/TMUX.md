# TMUX — session design (disconnect survival)

**The rule:** everything runs inside one tmux session named `rxvision` — including the
Claude Code CLI itself. tmux keeps processes alive on the server when your SSH link
drops; you reconnect and reattach to find everything exactly as it was.

## Start / attach
```bash
bash scripts/ai/rxvision-tmux.sh      # creates the session if missing, else attaches
```
Idempotent — safe to run any time.

## Window layout
| # | Name | Purpose |
|---|---|---|
| 0 | `claude` | The Claude Code CLI (the AI Tech Lead) runs here |
| 1 | `stack`  | `docker compose up --build` / `make up` — the running app |
| 2 | `shell`  | git + general shell |
| 3 | `tasks`  | long-running jobs (via `scripts/ai/run-task.sh`) |
| 4 | `logs`   | `make logs` / `tail -f docs/ai/runs/*.log` |

Long jobs each get their own `run-<label>` window (created by `run-task.sh`).

## Essential keys (prefix = `Ctrl-b`)
| Keys | Action |
|---|---|
| `Ctrl-b d` | **Detach** (leaves everything running) — safe before you close the laptop/SSH |
| `Ctrl-b 0..4` | Jump to window N |
| `Ctrl-b n` / `p` | Next / previous window |
| `Ctrl-b w` | Pick a window from a list |
| `Ctrl-b [` | Scroll mode (arrows/PgUp; `q` to exit) |
| `Ctrl-b ,` | Rename current window |

## The disconnect-survival workflow
1. SSH into the server.
2. `bash scripts/ai/rxvision-tmux.sh` → attach.
3. In window `0:claude`, run `claude` and work.
4. SSH drops / you close the terminal → **nothing is lost**; the session keeps running.
5. Reconnect later: `ssh ...` then `tmux attach -t rxvision` (or run the script again).

## Recovery cheatsheet
```bash
tmux ls                       # list sessions
tmux attach -t rxvision       # reattach
tmux kill-window -t rxvision:run-smoke   # close a finished job window
tmux kill-session -t rxvision # nuke everything (last resort)
```

> If tmux isn't installed on the server: `sudo apt-get install -y tmux`.
> One session is enough — do not spawn many; reuse `rxvision`.

## "Can I close the terminal and keep my place?"

Three independent layers — know which one you mean:

**1. Project state & progress (always survives, forever).**
Everything we decide/build is written to the repo (`docs/project-state.md`,
`docs/todo.md`, `docs/decisions.md`, `docs/ai/journal/`, plus the git diff). Any future
session — even a brand-new one with zero chat memory — resumes the *work* via
`docs/ai/RESUME.md`. This needs no tmux, no live process. To see progress: read the
latest journal entry, `docs/todo.md`, and `git status`/`git diff`.

**2. The exact conversation (survives if you do one of these):**
- **Best:** run `claude` INSIDE tmux, and when you leave, **detach** (`Ctrl-b d`) —
  do NOT exit claude. Reconnect later → `tmux attach -t rxvision` → you're in the same
  chat, same scrollback, mid-thread.
- **If the process did end** (you exited, or claude wasn't in tmux): restart it and
  recover history with `claude --continue` (most recent conversation here) or
  `claude --resume` (pick from a list). Claude Code stores session transcripts on disk.

**3. Long-running commands (survive via tmux, independent of the chat).**
A job started with `scripts/ai/run-task.sh` runs in its own tmux window and keeps going
after you disconnect; its log is in `docs/ai/runs/`.

### Important: does Claude keep *working* while you're away?
No — not on its own. Claude acts per turn: when it finishes answering it idles. What
keeps running while you're disconnected is (a) any background **command** you launched
(layer 3) and (b) a scheduled/autonomous loop if one was explicitly set up. The chat and
the project state are preserved so you resume seamlessly — but Claude won't autonomously
keep developing unless you've started a long task or asked for a scheduled loop.

### The reliable recipe
```bash
ssh <server>
bash scripts/ai/rxvision-tmux.sh   # attach the rxvision session
# window 0:claude →  claude          (start or it's already running)
# … work …
# leaving?  Ctrl-b d  (detach — everything stays alive)
# coming back?  ssh <server>  →  tmux attach -t rxvision
```
