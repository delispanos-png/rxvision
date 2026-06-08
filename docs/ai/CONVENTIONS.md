# CONVENTIONS — working agreements & guardrails

The non-negotiables for any Claude session working on RxVision. Established with
Panagiotis (the owner). Change these only with his agreement, and record the change in
`decisions.md`.

## Git
- Work on a branch, **never `main`**. Current working branch: **`quick-wins`**.
- **Never commit. Never push.** Unless Panagiotis explicitly asks, in that message.
- The uncommitted working tree + the docs are the handoff medium between sessions.

## Code changes
- **Ask before modifying application source code.** Propose the change concretely first.
- Documentation, memory, workflow artifacts (everything under `docs/`, `scripts/ai/`,
  `CLAUDE.md`, reports) may be created/edited freely.
- Match surrounding style: ruff (line-length 100), English identifiers/comments.

## Secrets
- **Never accept a secret in chat** — API tokens, keys, passwords, unseal keys.
  If offered one, decline and direct it to the server `.env` or a secret store.
- Secrets never go in the repo. `.env`, `secrets/`, `infra/docker/vault/tls/` are gitignored.
- If a secret is ever exposed in chat/logs, the action is: rotate it.

## Communication
- **Reply to Panagiotis in Greek.** Keep code, comments, and these docs in English.
- Be transparent about what was and wasn't verified (e.g. "Docker/pip/npm not available
  in this env, so I ran `py_compile` + `yaml` parse + `bash -n` instead of a live build").

## Verification expectations
- Run the strongest check the environment allows before calling something done:
  unit tests (`pytest`) and builds when runnable; otherwise `py_compile`, `yaml.safe_load`,
  `bash -n`, and isolated stdlib logic tests.
- State the limitation explicitly when a full integration test could not be run.

## Domain invariants (do not break)
- **Tenant isolation by construction** — all tenant DB access via `BaseRepository`
  (injects `tenant_id`). Keep `tests/test_invariants.py` green.
- **Money is integer cents.** **PII (AMKA) is pseudonymized before any write.**

## Maintaining the memory system
- End every session with `docs/ai/HANDOFF.md`.
- Keep `project-state.md` / `todo.md` / `decisions.md` / the journal current — they are
  the product, as much as the code is.
