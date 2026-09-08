# Task 1 (P0) report — rebase onto upstream/main, schema v31, typecheck fix, CLI handler relocation

Branch: `feat/moa-deliberation-ledger` · Base: `upstream/main` @ `a823f97d63`
Backup of the pre-rebase branch: `backup/moa-pre-rebase-2026-09-05` (local only, never pushed).

## Result

All of steps 1–8 completed. Typecheck is green project-wide, the named test set is green,
oxlint is clean on every changed file, and `git merge-tree --write-tree upstream/main HEAD`
produces a tree with no conflicts.

## Final commits (`git log --oneline upstream/main..HEAD`)

```
db3c3cf90e test(orchestration): cover the pre-v31 to v31 MoA ledger migration path
29e8eb57a1 feat(orchestration): add MoA deliberation ledger store, ingest, and CLI
```

No merge commits. `git status` shows only the untracked `moa/` and `.debate-war/`.

## Conflicts resolved during `git rebase upstream/main`

All six conflicts landed on the first commit; the second commit replayed cleanly.

| File | Resolution |
| --- | --- |
| `src/main/runtime/orchestration/db/contract-constants.ts` | Upstream comment kept, `, v31 MoA deliberation ledger` appended; `SCHEMA_VERSION = 31`. |
| `src/main/runtime/orchestration/db/schema/migrate.ts` | Took upstream verbatim, then re-added the ledger step: keeps `applySchemaMigrationsV13ToV30`, calls `applySchemaMigrationV31MoaLedger` after it. |
| `src/main/runtime/rpc/methods/orchestration.ts` | Took upstream's barrel entirely; added the `ORCHESTRATION_MOA_METHODS` import + spread next to `...ORCHESTRATION_GATE_METHODS`. |
| `src/main/runtime/rpc/methods/orchestration-runs.test.ts` | Registry size `39 + 2 = 41`; kept upstream's `requestShow` assertion plus our two `moaLog`/`moaShow` assertions. |
| `src/cli/help.ts` | Took upstream entirely. Upstream moved the root help body out of `help.ts`, so the two MoA lines went into `src/cli/root-help-text-primary.ts` after `orchestration gate-list` (deviation noted below). |
| `src/cli/handlers/orchestration.ts` | Took upstream entirely (dropping our two `export` edits, whose helpers moved), then added the `ORCHESTRATION_MOA_HANDLERS` import + spread next to `...ORCHESTRATION_GATE_HANDLERS`. |

## Changes made on top of the conflict resolutions

Schema renumber (P0-2):
- `src/main/runtime/orchestration/db/schema/migrate-v30-moa-ledger.ts` → `migrate-v31-moa-ledger.ts`,
  exporting `applySchemaMigrationV31MoaLedger` guarded on `current < 31`.
- `SCHEMA_VERSION = 31`; upstream's v30 (`depth` columns on `dispatch_contexts` and
  `remote_dispatch_attachments`) is untouched and still runs before the ledger step.

CLI handler relocation (P0-2):
- `src/cli/handlers/orchestration-moa.ts` → `src/cli/handlers/orchestration/moa-handlers.ts`,
  still exporting `ORCHESTRATION_MOA_HANDLERS`. Imports now match `gate-handlers.ts`:
  `callOrchestrationMutation` from `./mutation-request`, `resolveCoordinatorTerminalHandle`
  from `./terminal-identity` (the old local `callMutation` name is gone from upstream).
- `src/cli/handler-group-manifest.ts`: the separate `orchestration-moa` group is removed;
  `'orchestration moa-log'` and `'orchestration moa-show'` are now keys on the single
  `orchestration` group, after `gate-list`.
- `src/cli/handlers/orchestration-moa-cli.test.ts` stayed put (mirrors
  `orchestration-gate-cli.test.ts`); it drives `main()` from `../index`, so no import
  changes were needed. `src/cli/specs/orchestration-moa-specs.ts` stayed put.

Migration test (step 4) — `moa-ledger-store.test.ts`:
- Renamed to `migrates a pre-v31 database in place`; simulates a v30 host (drops both moa
  tables, `user_version = 30`), reopens, asserts `user_version` is 31, that `logMoaEntries`
  works afterward, and that `dispatch_contexts` still has the `depth` column.

P0-1 typecheck fix — `moa-ledger-store.ts`:
- Added a named `MoaMessagePayload` type and used it for both `moa` and the `JSON.parse`
  cast, so the parse result is no longer typed from the flow-narrowed `null` (which made
  every field `never` and produced 8× TS2339).

## Verification

Toolchain note: after the rebase, `package.json` pins `pnpm@12.0.0` (upstream bumped it from
10.24.0), and upstream's `pnpm-lock.yaml` is now a multi-document pnpm-12 lockfile that
pnpm 10 refuses to read. `node_modules` was reinstalled with `pnpm install --frozen-lockfile`
under pnpm 12 + Node 24.19.0. All commands below ran with Node 24 and pnpm 12.

| Command | Result |
| --- | --- |
| `pnpm typecheck:tsc:node` | **PASS** — zero errors (whole project) |
| `pnpm typecheck:tsc:cli` | **PASS** — zero errors (whole project) |
| `npx vitest run --config config/vitest.config.ts <the 10 spec'd paths>` | **PASS** — 9 files, 86 tests |
| Same set with `src/main/runtime/orchestration/db` widened to the whole dir | **PASS** — 28 files, 250 tests |
| `npx oxlint <all 23 changed files>` | **PASS** — exit 0, no diagnostics (verified oxlint is actually reporting by probing it with a `debugger` statement, which it flagged) |
| `git merge-tree --write-tree upstream/main HEAD` | **PASS** — printed `cc7f0c1bb49b3817afc58af74e7a7e752b678ba9`, no `CONFLICT` lines |
| `git log --oneline --merges upstream/main..HEAD` | empty — no merge commits |
| `git status --short` | only `?? .debate-war/` and `?? moa/` |

`src/main/runtime/orchestration/db/schema` contains no `*.test.ts`, so that path in the
spec'd vitest invocation contributes no files; the schema migration is covered by the
`moa-ledger-store.test.ts` case above and by the 20 files under `.../db`.

One transient failure was seen and did not reproduce: on the first combined run (executed in
the same shell command as `tsc`), a whole-tree source-scanning ratchet test failed at
`collectSourceFiles(srcRoot)`. Re-running the identical vitest command twice, and running
that file's directory alone, passed every time — it raced the concurrent `tsc` process over
the source tree, not the MoA changes.

## Deviations from the plan

1. **Help text lives elsewhere now.** Step 2 said to add the `moa-log` / `moa-show` lines to
   `src/cli/help.ts`. Upstream moved the root help body into `root-help-text-primary.ts` /
   `root-help-text-secondary.ts`, so `help.ts` was taken from upstream unchanged and the two
   lines went into `src/cli/root-help-text-primary.ts` after `orchestration gate-list`.
2. **Relocation and the P0-1 fix are folded into the first commit, not follow-ups.** Step 7
   allowed folding the v31 renumber; I extended that to the handler relocation and the
   `MoaMessagePayload` fix because both are conflict-resolution consequences of the rebase —
   a separate "fix what the previous commit in this same branch just broke" commit would be
   noise in a two-commit branch. Both commit messages were reworded to say v31 and to
   describe the new handler location.
3. **`node_modules` was reinstalled and pnpm 12 activated.** Not in the plan, but the rebase
   made it mandatory: the pre-rebase tree was ~1,114 commits behind, and typechecking against
   the stale tree produced dozens of unrelated errors (missing `@anthropic-ai/claude-agent-sdk`,
   an older `zod`). The system `pnpm` shim ships with Node 22's corepack, which cannot launch
   pnpm 12 (it looks for `bin/pnpm.cjs`; pnpm 12 ships `bin/pnpm.mjs` plus a native binary), so
   pnpm 12 is invoked through a one-line wrapper in the session scratchpad. Anyone picking this
   worktree up needs Node 24 + pnpm 12, not pnpm 10.

## Left undone

Nothing from this task. Review items beyond P0-1 / P0-2 (the P1 and S items) are out of scope
here and untouched.
