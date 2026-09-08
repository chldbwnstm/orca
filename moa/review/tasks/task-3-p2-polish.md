# Task 3 — P2: provenance exposure, ingest diagnostics, comment accuracy, CLI flag cleanup, skill-guide docs

Read `moa/review/tasks/common.md` first. Review items: P1-2(b), P2-4, P2-5, P2-6, P2-7, P2-8 (sections 3, 4). Tasks 1 and 2 must be complete.

## Changes

### P1-2(b) — audit provenance in moa-show
- `listMoaEntries` (or a dedicated read used by `moaShow`) LEFT JOINs `messages` on `message_id` and exposes `sender_handle` (`messages.from_handle`, null for RPC-logged entries). Include it in the `--json` output only; the text renderer keeps seat labels only (the coordinator already knows the seat→identity map; the text view stays anonymized).
- Add a short trust-model comment at the top of `moa-ledger-store.ts`: the home runtime trusts Run participants; seat attribution is asserted by the sender and auditable via `message_id`/`sender_handle`; server-side seat↔dispatch binding is deferred (blueprint PR3).

### P2-1 follow-up — header fill-in vs drift (coordinator finding on task 2)
- `assertNoHeaderDrift` currently rejects `--seat-count 3` when the header was created with the default `seat_count = 0` (and `--task` when `task_id` is NULL). Ingest can create the header before the coordinator's first `moa-log` (a seat's status message arrives first), which would then fail. Treat an unset header field (`task_id IS NULL`, `seat_count = 0`) as "not yet declared": the first non-undefined declaration fills it in with a guarded `UPDATE ... WHERE task_id IS NULL` / `WHERE seat_count = 0`; only a conflicting non-empty value is drift. Keep the existing drift tests; add one for the fill-in path and one proving a second, different declaration still fails.

### P2-4 — ingest diagnostics
- `ingestMoaMessagePayload` returns `{ inserted: number; skipped?: 'not_status' | 'malformed' | 'invalid_entry' | 'store_error' }` instead of a bare number (no logging in the db layer — there is no precedent). `insertMessage` keeps ignoring the value.
- If the LOCAL `orchestration.send` path can surface it in its result as an optional `moaIngest` field with a small, contained change (read the return of the local `insertMessage` call), do it and add a test; if the routing makes that invasive, skip it and say so in the report. Wire-compat: a new optional response field is Rule 1 (safe).

### P2-5 — transaction claim
- Wrap the body of `insertMessage` (INSERT + SELECT + ingest) in its own SAVEPOINT (distinct name from `message_insert_batch`; nested savepoints are fine) so the comment "in the same transaction scope as its provenance row" is true; keep the comment accurate.

### P2-6 — rowid cursor
- Comment on `recorded_seq`: rowid of a non-INTEGER-PRIMARY-KEY table can be renumbered by VACUUM; Orca does not VACUUM today; if it ever does, promote to a real column. One or two lines.

### P2-7 — CLI `--payload`
- Remove `--payload` from the single-entry flag set of `moa-log` (it contradicts the file's own PowerShell note); payloads travel via `--entries-file`. Update spec `usage`/`allowedFlags`/notes and the CLI test if it referenced it.

### P2-8 — skill guide
- Add a "MoA deliberation ledger" subsection to `skill-guides/orchestration.md` right after the gates block, in the same terse style: the two verbs with usage lines, the kinds/verdicts enums, "append-only + content-addressed (resends are ignored duplicates)", "prefer --entries-file", and that `moa-show --json` returns entries ordered `(round, authored_at, id)`.
- Regenerate the bundled copy: find the write-mode script in `package.json` (`generate:bundled-skill-guides` or the `--write` flag of `config/scripts/generate-bundled-skill-guides.mjs`), run it, then `pnpm run verify:bundled-skill-guides` must pass. Run `pnpm run verify:skill-bundle-manifest` too; if it fails identically on a clean upstream checkout state (pre-existing staleness), report that rather than "fixing" unrelated files.

## Verify
- `pnpm typecheck:tsc:node`, `pnpm typecheck:tsc:cli` → zero errors.
- `npx vitest run --config config/vitest.config.ts src/main/runtime/orchestration/db/moa-ledger src/main/runtime/orchestration/db/messages src/main/runtime/rpc/methods/orchestration-moa.test.ts src/cli/handlers/orchestration-moa-cli.test.ts src/cli/specs/orchestration.test.ts src/cli/registry-parity.test.ts src/cli/vocabulary-policy.test.ts` plus any send-RPC test file you touched.
- `npx oxlint` on changed files.
- Commit(s). Do not push.
- Report to `moa/review/tasks/task-3-report.md`, then `worker_done`.
