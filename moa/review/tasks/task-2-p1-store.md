# Task 2 — P1: store/RPC/CLI logic fixes (run-scoped deliberations, entry ids, authored_at, validation)

Read `moa/review/tasks/common.md` first. Review items: P1-1, P1-4, P1-5, P2-1, P2-2, P2-3, P2-9, D-1, D-2 (sections 3, 4, 6). Task 1 must be complete (branch rebased, v31, typecheck clean).

Nothing of this schema has shipped anywhere (PR withdrawn), so the v31 DDL and migration may be rewritten freely. The v31 migration must `DROP TABLE IF EXISTS moa_ledger_entries; DROP TABLE IF EXISTS moa_deliberations;` before creating, with a one-line why-comment ("pre-release fork tables from the withdrawn v30 draft; never shipped"), so a local dogfood DB gets the new shape.

## Changes

### P1-5 — deliberations scoped to their Run
Recommended design (matches the blueprint's "content-addressed id" claim, minimal ripple):
- `moa_deliberations`: `id TEXT PRIMARY KEY` becomes a surrogate `moad_<sha256(run_id, slug)[:32]>`; add `slug TEXT NOT NULL`; `UNIQUE(run_id, slug)`. Entries keep `deliberation_id` = surrogate id.
- Store API: `openMoaDeliberation({ runId, slug, ... })`, `getMoaDeliberation({ runId, slug })` (and by id where needed), `listMoaEntries({ deliberationId })` unchanged. `logMoaEntries` takes `slug` (rename from `deliberationId`) and returns the row (which carries both `id` and `slug`).
- RPC `moaLog`/`moaShow` and CLI `--deliberation <slug>` keep their user-facing shape; responses include `deliberation.id` and `deliberation.slug`.
- The "belongs to another Run" error path disappears; `moaShow` for a slug that exists only in another Run is simply "not found" (keep the non-probing behavior + its test).
- Test: the same slug in two Runs succeeds and yields two different deliberation ids; entries never mix.

### P1-4 — return entry ids
- `logMoaEntries` returns `entries: { id: string; inserted: boolean }[]` in input order, plus the existing counts. RPC passes it through. CLI text output prints one line per entry: `<id> new|duplicate <kind> [seat]`.

### P1-1 — authored_at never NULL, normalized to UTC
- Store fills `authoredAt ?? <UTC now ISO>` at insert (reuse `db/utc-timestamp.ts` conventions). Column becomes `authored_at TEXT NOT NULL`.
- Provided `authoredAt` must parse as a date; strict path rejects with `OrchestrationError('invalid_argument', ...)`; it is stored normalized to UTC ISO (`toISOString()`), so `+09:00` and `Z` inputs sort correctly.
- IMPORTANT for idempotency: the content-addressed id must hash the RAW input (`entry.authoredAt ?? null`), not the defaulted timestamp, so a resend of an entry without authoredAt still dedupes. Add a why-comment.
- Test: an entry logged later without `authoredAt` sorts AFTER earlier entries that carried timestamps (this test must fail on the current code).

### P2-1 — seatCount/taskId drift
- In `openMoaDeliberation`, when the row already exists and the input supplies a non-undefined `seatCount`/`taskId` that differs → `OrchestrationError('invalid_argument', ...)`. The ingest path (`ingestMoaMessagePayload`) keeps swallowing it (returns 0). Test both.

### P2-2 — RPC integer validation
- `MoaEntrySchema.round`, `MoaShowParams.round`, `MoaLogParams.seatCount`: positive integers (`z.number().int().positive().optional()` or an existing helper in `rpc/schemas.ts` if one exists). Test one rejection.

### P2-3 — error type
- `moaShow` not-found: use `OrchestrationError` with an existing code (check the code union in `orchestration-error.ts`; prefer a not-found style code if present, else `invalid_argument`), so `--json` callers get a stable `code`. Keep the message text matching the existing test regex or update the test.

### P2-9 — extra tests
- federation relay import path materializes `payload.moa` (follow existing `federation-relay-import` test patterns; provenance `message_id` must be set).
- `insertMessages` batch: when a later message in the batch throws, ledger rows from an earlier message in the same batch are rolled back.
- `moaLog` with `run: <foreign run id>` from the bound coordinator → `consumer_fenced` (RPC harness).
- CLI `--entries-file` test asserts the two entries' content, not just length.

### D-1 / D-2 — design doc
- Update `moa/design/upstream-design.md` DDL sketch + invariants to the implemented shape (surrogate id + slug, `recorded_seq` = rowid alias, authored_at NOT NULL + UTC). This file is untracked; just edit it.

## Verify
- `pnpm typecheck:tsc:node`, `pnpm typecheck:tsc:cli` → zero errors.
- `npx vitest run --config config/vitest.config.ts src/main/runtime/orchestration/db/moa-ledger src/main/runtime/rpc/methods/orchestration-moa.test.ts src/cli/handlers/orchestration-moa-cli.test.ts src/main/runtime/rpc/methods/orchestration-runs.test.ts src/main/runtime/orchestration/db/messages src/main/runtime/orchestration/db/federation src/main/runtime/orchestration/db/schema`
- `npx oxlint` on changed files.
- Commit (e.g. `feat(orchestration): scope MoA deliberations to their Run, return entry ids, normalize authored_at`). Do not push.
- Report to `moa/review/tasks/task-2-report.md`, then `worker_done`.
