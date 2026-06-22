# Coding Agent Instructions

## Two folders (do not assume they're the same)
- **Code project** — `C:\Users\lty\Downloads\PersonalAI`
  All code, tests, builds, installs, git. Use as working directory for any command.
- **Project memory (Obsidian vault)** — `C:\Users\lty\Downloads\PC_SYNC\Projects\Jarvis Personal AI`
  Markdown state files only. Update these here, never in the code project.

The vault is project memory, not a general note vault. Do not read personal,
journal, school, or unrelated notes unless explicitly asked. Do not operate
outside these two folders unless explicitly asked.

## Context budget

Use the least context needed. Don't scan the whole project or vault by default,
don't open files just because they exist, and stop inspecting once you've found
the relevant area. Prefer targeted reads over broad searches.

## Before coding (non-trivial changes)

1. Read from the vault if present: `PROJECT_MAP.md` (navigation index),
   `HANDOFF.md` (current state), `TODO.md` (active tasks).
2. Use `PROJECT_MAP.md` first to decide which code areas matter, then inspect
   only those files. If the task names an exact file, just open that + neighbors.

When an error names a file/route/component/endpoint/model/table/feature, use
`PROJECT_MAP.md` to locate the area before searching. Don't inspect unrelated
folders once it points you somewhere.

## Read only when the task needs it (vault)

- `BUGS.md` — debugging, regressions, known bugs
- `DECISIONS.md` — architecture, deps, auth, DB, API, model, deployment, storage
- `CHANGELOG.md` — recent implementation history
- `docs/setup.md` — install, local setup, env, dependencies
- `docs/api.md` — API routes, request/response formats, backend integration
- `docs/deployment.md` — hosting, cloud, CI/CD, build, production

## Coding

Make the smallest safe change that solves the task; fix root causes, not symptoms.
If no code change is needed, say so. Don't touch unrelated files, add deps, or do
large rewrites unless asked. Never expose keys, tokens, secrets, cookies, or
`.env` values. (Other good practices are assumed — only deviations need stating.)

## Testing

Run the most relevant targeted check from the code project. If you can't run it,
say why. Never claim something is tested unless it was actually run.

## Project-memory Markdown rules

Allowed files (vault only): `HANDOFF.md`, `PROJECT_MAP.md`, `TODO.md`, `BUGS.md`,
`DECISIONS.md`, `CHANGELOG.md`, `docs/setup.md`, `docs/api.md`, `docs/deployment.md`.
Before creating any other `.md`, explain why these aren't enough. Keep updates
short and factual; don't duplicate info across files or paste large code blocks.

Limits: `HANDOFF.md` <120 lines · `PROJECT_MAP.md` <200 lines · `TODO.md` active
tasks only · `BUGS.md` active/recently-fixed only · `DECISIONS.md` long-term
decisions only · `CHANGELOG.md` append-only, grouped by date.

## After coding — update memory only if state actually changed

- `CHANGELOG.md` (when code changed) — what changed, files, tests run, untested parts
- `HANDOFF.md` — when current working state changed (state, broken/unfinished, next step)
- `TODO.md` — tasks completed or real new tasks found
- `BUGS.md` — bug fixed, new bug, or repro changed
- `DECISIONS.md` — an important long-term decision was made
- `PROJECT_MAP.md` — important files/folders added, removed, renamed, or repurposed

Don't create memory files just to satisfy this.

## End every response with

Changed files · What was fixed/added · Tests run · Markdown files updated · Next step
## Always commit and push after finishing work 