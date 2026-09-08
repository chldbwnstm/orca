# Common instructions for every MoA fix task (read first)

- Repo: `C:/Users/User/orca/projects/Orca MOA` (fork of stablyai/orca). Branch: `feat/moa-deliberation-ledger`. Work in THIS worktree; do not create worktrees.
- The review that drives these tasks: `moa/review/2026-09-05-project-review.md`. Item ids (P0-1, P1-5, S-2, ...) refer to it.
- Project rules: `AGENTS.md` at the repo root applies (concise "why not how" comments only, never disable max-lines, no vague file names like helpers/utils, cross-platform + SSH + folder-workspace considerations, remote wire compatibility, `.ts` over `.d.ts`).

## Toolchain (important on this machine)

- System Node is 22; the repo needs Node 24 (`node:sqlite`). Prefix PATH with the portable Node 24 before ANY pnpm/npx/vitest/tsc call:
  - Git Bash: `export PATH="C:/Users/User/AppData/Local/Temp/claude/C--Users-User-orca-projects-Orca-MOA/50687781-033f-4c63-a2bd-cea5f0075267/scratchpad/node-v24.19.0-win-x64:$PATH"`
  - PowerShell: `$env:PATH = "C:\Users\User\AppData\Local\Temp\claude\C--Users-User-orca-projects-Orca-MOA\50687781-033f-4c63-a2bd-cea5f0075267\scratchpad\node-v24.19.0-win-x64;" + $env:PATH`
  - Confirm with `node --version` → v24.19.0.
- Since the rebase (task 1) `package.json` pins `pnpm@12.0.0`; the system `pnpm` shim is 10 and cannot read the new lockfile. Use the pnpm 12 wrapper set up in task 1, or bypass pnpm: `npx tsc --noEmit -p config/tsconfig.node.json --composite false`, `npx vitest run --config config/vitest.config.ts ...`, `npx oxlint ...`. `node_modules` is already reinstalled for pnpm 12.
- Verification commands:
  - `pnpm typecheck:tsc:node` and `pnpm typecheck:tsc:cli` (must print zero errors)
  - `npx vitest run --config config/vitest.config.ts <test files>`
  - `npx oxlint <changed files>`
- Known pre-existing failures on clean main (do not try to fix, just mention if you hit them): 3 Windows env-specific tests, and `verify:skill-bundle-manifest` staleness.

## Git

- Commit your work on the branch with clear conventional messages (`feat(orchestration): ...`, `fix(cli): ...`). Keep the working tree clean at the end (`git status` shows only the untracked `moa/` and `.debate-war/`).
- NEVER push, never open issues or PRs, never touch `origin`/`upstream` remotes except `git fetch`.
- Never run `orca orchestration reset`.

## Reporting

- Write a report to `moa/review/tasks/task-<N>-report.md`: what changed (file list), exact verification commands with pass/fail summaries, deviations from the plan and why, anything left undone.
- Then send `worker_done` exactly as your orchestration preamble instructs, with `--outcome succeeded|failed`, `--files-modified`, and `--report-path <absolute path to the report>`.
- If a decision is genuinely ambiguous and blocks you, use `orca orchestration ask` rather than guessing.
