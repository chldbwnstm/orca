# Task 2 (P1) report — run-scoped deliberations, entry ids, authored_at, validation

Branch: `feat/moa-deliberation-ledger` · Commit: `3c644e3593`
Review items covered: P1-1, P1-4, P1-5, P2-1, P2-2, P2-3, P2-9, D-1, D-2.

## Result

Every change in the task is implemented and verified. Typecheck is clean project-wide,
the spec'd test set passes, and oxlint reports nothing on the changed files. Nothing is
left undone.

## What changed (10 files)

| File | Change |
| --- | --- |
| `db/schema/create-moa-ledger-tables-sql.ts` | `moa_deliberations` gains `slug TEXT NOT NULL` + `UNIQUE(run_id, slug)`; `id` is now a surrogate. `moa_ledger_entries.authored_at` becomes `NOT NULL`. Header comment restated for the new invariants. |
| `db/schema/migrate-v31-moa-ledger.ts` | Drops both tables before creating them, with the required why-comment ("pre-release fork tables from the withdrawn v30 draft; never shipped"). |
| `db/moa-ledger/moa-ledger-store.ts` | Surrogate ids, slug-addressed API, entry receipts, authored_at defaulting + UTC normalization, header-drift rejection. |
| `db/moa-ledger/moa-ledger-store.test.ts` | Rewritten for the slug API plus 8 new cases. |
| `db/federation/moa-relay-import.test.ts` | **New.** Relay import materializes `payload.moa` with `message_id` provenance, and a replayed sequence does not double-record. |
| `rpc/methods/orchestration-moa.ts` | Strict positive-integer schemas, slug passthrough, entry receipts in the response, `deliberation_not_found`. |
| `rpc/methods/orchestration-moa.test.ts` | Receipt/id assertions, integer rejection, `consumer_fenced`, not-found code, same-slug-two-Runs isolation. |
| `cli/handlers/orchestration/moa-handlers.ts` | Per-entry output lines; slug shown alongside the surrogate id. |
| `cli/handlers/orchestration-moa-cli.test.ts` | `--entries-file` now asserts entry *content*; new test for the per-entry output. |
| `cli/specs/orchestration-moa-specs.ts` | `--deliberation <slug>` in usage; notes cover Run-scoped slugs, echoed entry ids, and the authored_at default. |
| `moa/design/upstream-design.md` (untracked) | DDL + invariants + a new "Surface" section updated to the implemented shape. |

## Item-by-item

### P1-5 — deliberations scoped to their Run

`moa_deliberations.id` is now `moad_<sha256(JSON([run_id, slug]))[:32]>` with `slug TEXT NOT NULL`
and `UNIQUE(run_id, slug)`. Entries still key on the surrogate id, so nothing downstream had to
learn about slugs.

Store API: `openMoaDeliberation({ runId, slug, taskId?, seatCount? })`,
`logMoaEntries({ runId, slug, ... })`, `getMoaDeliberation({ runId, slug } | { id })` (the union
covers the "by id where needed" case), `listMoaEntries({ deliberationId })` unchanged.

The "belongs to another Run" throw is gone. `moaShow` resolves `(run.id, slug)` directly, so a slug
that exists only in another Run is simply absent — the non-probing behavior now falls out of the
lookup instead of needing a post-hoc `run_id` comparison, and its test still passes.

### P1-4 — return entry ids

`logMoaEntries` returns `entries: { id, inserted }[]` in **input** order alongside the existing
counts; the RPC passes it through. CLI text output prints the summary line then one
`<id> new|duplicate <kind> [seat]` line per entry. A test sends the same two entries back in
reversed order and asserts the receipts line up with the caller's array, not with row order.

### P1-1 — authored_at never NULL, normalized to UTC

`authored_at TEXT NOT NULL`. The store fills `entry.authoredAt ?? new Date().toISOString()` and
normalizes any provided value through `new Date(...).toISOString()`. An unparseable `authoredAt`
throws `OrchestrationError('invalid_argument', ...)` on the strict path (and is swallowed on the
ingest path, like every other validation failure).

The content-addressed id still hashes `entry.authoredAt ?? null` — the **raw** input — with a
why-comment saying so. A dedicated test resends a clock-less entry and asserts it stays a duplicate;
hashing the defaulted value would mint a row per send.

Two ordering tests, both of which fail on the pre-change code:
- a clock-less entry logged after two timestamped ones sorts **last** (a NULL sorted first);
- `2026-08-25T19:00:00+09:00` sorts **before** `2026-08-25T10:30:00Z`, and is stored as
  `2026-08-25T10:00:00.000Z`.

### P2-1 — seatCount/taskId drift

`openMoaDeliberation` rejects a non-`undefined` `seatCount`/`taskId` that differs from the stored
header with `OrchestrationError('invalid_argument', ...)`. Re-declaring the *same* values is
explicitly still fine (replayed sends carry the header every time) and is asserted. The ingest path
keeps returning 0 and the message still lands — also asserted, including that the stored
`seat_count` is unchanged.

### P2-2 — RPC integer validation

`MoaEntrySchema.round`, `MoaShowParams.round` and `MoaLogParams.seatCount` now use
`z.number().int().positive().optional()`. I did **not** reuse `OptionalPositiveInt` from
`rpc/schemas.ts`: it is deliberately forgiving (it coerces a bad value to `undefined` and accepts 0
and non-integers), which is the exact behavior the review flagged — a dropped round silently files
the entry under round 1. A test rejects `round: 1.5` and `seatCount: 0`.

### P2-3 — error type

`moaShow` not-found now throws `OrchestrationError('deliberation_not_found', ...)`. There is no code
union in `orchestration-error.ts` (`code` is a bare `string`), so I followed the established
`<thing>_not_found` convention already used by `run_not_found`, `task_not_found`,
`dispatch_not_found`, `question_not_found`. The message text is unchanged, so the existing
`/not found/` assertion still holds; the test additionally asserts the code.

### P2-9 — extra tests

- **Federation relay import** — new `db/federation/moa-relay-import.test.ts`. Builds a real
  federated dispatch via `createStartingWorkerDispatch({ federation: ... })` (the
  `orchestration-reset-db.test.ts` pattern), imports a relay item carrying `payload.moa`, and
  asserts the entry, the normalized `authored_at`, and `message_id === 'msg_relayed_1'`. A second
  case replays the same sequence and asserts one row.
- **`insertMessages` batch rollback** — a batch whose second message names an unknown Run throws,
  and the ledger rows from the first message are gone (both the entry and the deliberation header).
- **`moaLog` with a foreign `run`** — from the bound coordinator, rejects with `consumer_fenced`.
- **`--entries-file` content** — the CLI test now asserts the exact parsed entries (kind, seat,
  rationale, round, verdict, authoredAt), not just `toHaveLength(2)`.

### D-1 / D-2 — design doc

`moa/design/upstream-design.md`: the DDL sketch is replaced with the implemented v31 DDL, the
invariants list gains Run-scoping, header immutability, the raw-input hashing rule, the
authored_at NOT NULL + UTC rule, `recorded_seq`-is-the-rowid (it was drawn as a column), federated
provenance, and the strict-integer boundary. Added a "Surface (PR 1, as implemented)" section for
the store/RPC/CLI shapes, and marked the run-vs-task open question resolved.

## Verification

Toolchain per task 1's note: Node 24.19.0 + pnpm 12 through the scratchpad wrapper.

| Command | Result |
| --- | --- |
| `pnpm typecheck:tsc:node` | **PASS** — zero errors (whole project) |
| `pnpm typecheck:tsc:cli` | **PASS** — zero errors (whole project) |
| `npx vitest run --config config/vitest.config.ts` over the 7 spec'd paths | **PASS** — 5 files, 49 tests |
| Same plus `registry-parity`, `vocabulary-policy`, `handler-group-manifest`, `cli/index`, `specs/orchestration` | **PASS** — 10 files, 100 tests |
| `npx oxlint` on all 10 changed files | **PASS** — exit 0, no diagnostics |
| `git status --short` | only `?? .debate-war/` and `?? moa/` |

Broad regression sweep — `npx vitest run --config config/vitest.config.ts src/main/runtime/orchestration src/cli`:
**178 files passed, 3 failed (1634 tests passed, 5 failed)**. The three failing files are the known
Windows env-specific ones flagged in `common.md`, and I confirmed it: stashing this task's changes
and re-running the identical command produces the same three files and the same five failures
(`src/cli/orchestration-mutation-recovery.test.ts` ×3, `src/cli/handlers/orchestration-gate-cli.test.ts` ×1,
`src/cli/runtime/client-recovery.test.ts` ×1 — the last an `EACCES` binding a unix socket under
`%TEMP%`).

One extra file, `db/dispatch-row-writer-boundary.test.ts`, failed on a single broad run at 68s. It
is a whole-`src`-tree scanning test and it timed out under parallel load; it passes standalone and
passed on a repeat of the same broad run. My changes add no `INSERT INTO dispatch_contexts` /
`remote_dispatch_attachments`, which is all that test looks for.

## Deviations from the plan

1. **`OptionalPositiveInt` was not reused** (P2-2) — see the item above; the existing helper coerces
   instead of rejecting, so it cannot satisfy "test one rejection". A local
   `OptionalPositiveInteger = z.number().int().positive().optional()` is defined in
   `orchestration-moa.ts` with a why-comment. The task's own wording allowed either.
2. **The "withdrawn draft rebuild" test is in-memory, not file-backed.** I first wrote it against a
   real DB file like the neighbouring migration test; it passed every assertion but the trailing
   `rmSync` failed with Windows `EPERM` (still true with `maxRetries`/`retryDelay`). Calling
   `db.migrate()` directly on an `:memory:` DB whose tables were rewritten to the draft shape tests
   the same thing without a file handle. The existing file-backed `migrates a pre-v31 database in
   place` test is untouched and still passes.
3. **`cli/specs/orchestration-moa-specs.ts` was also updated** (not named in the task). The usage
   string said `--deliberation <id>`, which is now wrong — it is a slug, and its uniqueness scope is
   the thing a caller most needs to know.
