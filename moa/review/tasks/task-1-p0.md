# Task 1 — P0: rebase onto upstream/main, renumber schema to v31, fix typecheck, relocate CLI handlers

Read `moa/review/tasks/common.md` first. Review items: P0-1, P0-2 (sections 2 of the review).

## Background (verified facts)

- `upstream/main` (stablyai/orca, already fetched) is ~1,114 commits ahead of local `main` and already uses `SCHEMA_VERSION = 30` (adds `depth` columns to `dispatch_contexts` and `remote_dispatch_attachments`). It renamed `db/schema/migrate-v13-v29.ts` → `migrate-v13-v30.ts`.
- Upstream split `src/cli/handlers/orchestration.ts` into `src/cli/handlers/orchestration/*.ts` modules (`gate-handlers.ts`, `mutation-request.ts` exporting `callOrchestrationMutation`, `terminal-identity.ts` exporting `resolveCoordinatorTerminalHandle`, ...). The handler-group manifest has ONE `orchestration` group whose `keys` list every verb.
- `git merge-tree --write-tree upstream/main HEAD` currently conflicts in: `src/cli/handlers/orchestration.ts`, `src/cli/help.ts`, `src/main/runtime/orchestration/db/contract-constants.ts`, `src/main/runtime/orchestration/db/schema/migrate.ts`, `src/main/runtime/rpc/methods/orchestration-runs.test.ts`, `src/main/runtime/rpc/methods/orchestration.ts`.
- `pnpm typecheck:tsc:node` fails on the branch with 8× TS2339 in `moa-ledger-store.ts` `ingestMoaMessagePayload`: `as { moa?: typeof moa }` captures the flow-narrowed `null` type, so `moa` becomes `never`.

## Steps

1. Safety + sync (local only):
   - `git branch backup/moa-pre-rebase-2026-09-05 HEAD`
   - `git fetch upstream`
   - `git branch -f main upstream/main` (main is not checked out; confirm `git branch --show-current` prints `feat/moa-deliberation-ledger` first).
2. `git rebase upstream/main` (non-interactive). Resolve conflicts keeping upstream content and re-adding the MoA registrations:
   - `contract-constants.ts`: `SCHEMA_VERSION = 31`; append `, v31 MoA deliberation ledger` to the version comment after upstream's v30 text.
   - `db/schema/migrate.ts`: keep upstream's `applySchemaMigrationsV13ToV30` import; rename our file to `migrate-v31-moa-ledger.ts` exporting `applySchemaMigrationV31MoaLedger` (guard `current < 31`) and call it after V13ToV30.
   - `rpc/methods/orchestration.ts`: keep upstream; add the `ORCHESTRATION_MOA_METHODS` import and spread next to `...ORCHESTRATION_GATE_METHODS`.
   - `rpc/methods/orchestration-runs.test.ts`: registry size becomes upstream's 39 + 2 = 41; keep the two `has('orchestration.moaLog'/'moaShow')` assertions.
   - `src/cli/help.ts`: keep upstream; add the two `moa-log` / `moa-show` lines after `gate-list`.
   - `src/cli/handlers/orchestration.ts`: take upstream's version entirely (drop our two `export` edits — those helpers moved).
   - If `git rebase` stops on the second commit (migration test), resolve the same way.
3. Relocate the CLI handler to upstream's structure:
   - Move `src/cli/handlers/orchestration-moa.ts` → `src/cli/handlers/orchestration/moa-handlers.ts`; export `ORCHESTRATION_MOA_HANDLERS`; import `callOrchestrationMutation` from `./mutation-request` and `resolveCoordinatorTerminalHandle` from `./terminal-identity` (read their exact signatures first; `gate-handlers.ts` is the model). Spread it into `ORCHESTRATION_HANDLERS` in `src/cli/handlers/orchestration.ts` next to `...ORCHESTRATION_GATE_HANDLERS`.
   - Remove the separate `orchestration-moa` handler group from `src/cli/handler-group-manifest.ts`; add `'orchestration moa-log'` and `'orchestration moa-show'` to the single `orchestration` group's `keys` (after `gate-list`).
   - Keep `src/cli/handlers/orchestration-moa-cli.test.ts` where it is (matches `orchestration-gate-cli.test.ts`), fix imports. Keep `src/cli/specs/orchestration-moa-specs.ts` (mirrors `orchestration-worker-specs.ts`).
4. Migration test (`moa-ledger-store.test.ts`): rename to "migrates a pre-v31 database in place"; simulate a v30 host (drop the two moa tables, `user_version = 30`), reopen, expect `user_version` 31, `logMoaEntries` works, AND assert `dispatch_contexts` still has the `depth` column (proves upstream's v30 was not skipped).
5. P0-1 fix in `moa-ledger-store.ts`:
   ```ts
   type MoaMessagePayload = { deliberation?: unknown; taskId?: unknown; seatCount?: unknown; entries?: unknown }
   let moa: MoaMessagePayload | null = null
   const parsed = JSON.parse(message.payload) as { moa?: MoaMessagePayload | null }
   ```
6. Verify (all must pass; paste summaries in the report):
   - `pnpm typecheck:tsc:node`, `pnpm typecheck:tsc:cli` → zero errors (whole project, not just MoA files).
   - `npx vitest run --config config/vitest.config.ts src/main/runtime/orchestration/db/moa-ledger src/main/runtime/rpc/methods/orchestration-moa.test.ts src/cli/handlers/orchestration-moa-cli.test.ts src/main/runtime/rpc/methods/orchestration-runs.test.ts src/cli/registry-parity.test.ts src/cli/vocabulary-policy.test.ts src/cli/handler-group-manifest.test.ts src/cli/index.test.ts src/cli/specs/orchestration.test.ts src/main/runtime/orchestration/db/schema`
   - `npx oxlint` on every changed file.
   - `git merge-tree --write-tree upstream/main HEAD` prints a tree id and NO `CONFLICT` lines.
   - `git log --oneline upstream/main..HEAD` shows only MoA commits (no merge commits); `git status` clean.
7. Commits: the two rebased originals (v31 folded in during conflict resolution is fine) plus follow-up commits for the relocation and the typecheck fix. Do not push.
8. Report to `moa/review/tasks/task-1-report.md` (conflicts resolved, final commit list, verification results), then `worker_done`.
