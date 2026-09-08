# Task 3 (P2) report — provenance exposure, ingest diagnostics, comment accuracy, CLI flag cleanup, skill-guide docs

Branch: `feat/moa-deliberation-ledger` · Commit: `cf90ee59ef`
Review items covered: P1-2(b), P2-1 follow-up, P2-4, P2-5, P2-6, P2-7, P2-8.

## Result

Every item is implemented and verified, including the optional `moaIngest` send-receipt half of
P2-4 (it turned out to be contained). Typecheck is clean project-wide, the spec'd test set passes,
oxlint is clean on all changed files, and `verify:bundled-skill-guides` passes.
`verify:skill-bundle-manifest` still fails — confirmed pre-existing, see below.

## What changed (15 files)

| File | Change |
| --- | --- |
| `db/moa-ledger/moa-ledger-store.ts` | Trust-model comment; `sender_handle` on the entry row via a LEFT JOIN; header fill-in before the drift check; expanded `recorded_seq` comment; ingest path extracted. |
| `db/moa-ledger/moa-message-ingest.ts` | **New.** `MoaIngestResult` + `ingestMoaMessagePayload` with typed skip reasons, its own attach. |
| `db/messages/message-insert.ts` | Nested `message_insert_row` savepoint around INSERT + SELECT + ingest; `insertMessageWithMoaIngest` sibling. |
| `db/attach-orchestration-db-methods.ts`, `db/orchestration-db-methods.ts` | Register the new ingest module. |
| `rpc/methods/orchestration-send-point-to-point.ts` | Optional `moaIngest` on the local send receipt. |
| `rpc/methods/orchestration-send-moa-ingest.test.ts` | **New.** Three cases for that receipt field. |
| `cli/handlers/orchestration/moa-handlers.ts`, `cli/specs/orchestration-moa-specs.ts` | `--payload` removed from the single-entry path; usage/flags/notes updated. |
| `skill-guides/orchestration.md`, `src/cli/bundled-skill-guides.ts` | New "MoA Deliberation Ledger" section + regenerated bundle. |
| 4 test files | New/updated coverage (below). |

## Item-by-item

### P1-2(b) — audit provenance in `moa-show`

`listMoaEntries` now selects through a shared `MOA_ENTRY_SELECT` that LEFT JOINs `messages` on
`message_id` and exposes `sender_handle` (`messages.from_handle`), null for RPC-logged entries.
Because the CLI text renderer only prints `entry_kind`/`seat_id`/`verdict`/`rationale`, the field
reaches `--json` and nothing else — the rendered view stays anonymized, as required.

The module header now carries the trust model explicitly: the home runtime trusts every participant
in a Run, so `seat_id` is an attribution the sender asserts about *itself* — auditable rather than
authenticated, with `message_id` naming the carrier message and `sender_handle` naming who sent it.
Server-side seat↔dispatch binding is called out as deferred to blueprint PR3.

Tests: a store test logs one entry through a status message and one through `logMoaEntries`, and
asserts `[['seat-A', 'term_seat_a'], ['seat-A', null]]`; the RPC test asserts the same pair reaches
`moaShow`'s JSON; the relay-import test now also asserts `sender_handle === 'term_remote_worker'`,
so provenance is proven to survive federation.

### P2-1 follow-up — header fill-in vs drift

This was a real bug in what I shipped in task 2, and the coordinator was right to catch it. Ingest
opens the header when a seat's status message arrives first, leaving `task_id` NULL and
`seat_count` 0 — and the drift check then rejected the coordinator's own first
`moa-log --seat-count 3`.

`fillUnsetHeaderFields` now runs before `assertNoHeaderDrift`: an unset field (`task_id IS NULL`,
`seat_count = 0`) is "not yet declared", and the first non-`undefined` declaration claims it with a
guarded `UPDATE ... WHERE task_id IS NULL` / `WHERE seat_count = 0`. Two racing declarations
therefore resolve to one winner and the loser reads as drift, rather than both being accepted.

Tests: the existing drift tests are unchanged and still pass; added one for the ingest-then-declare
fill-in path (asserting the header starts `[null, 0]`) and one proving a *second*, different
declaration after a fill-in still throws.

### P2-4 — ingest diagnostics

`ingestMoaMessagePayload` returns `{ inserted: number; skipped?: 'not_status' | 'malformed' |
'invalid_entry' | 'store_error' }`. No logging was added — the db layer has no logging precedent,
so the reason travels in the return value.

**The optional send-receipt half was doable and is done.** `orchestration.send`'s local
point-to-point path now returns an optional `moaIngest` field. Rather than change
`insertMessage`'s return type (60+ call sites), I added a sibling `insertMessageWithMoaIngest` that
returns `{ message, moaIngest }`; `insertMessage` is now a one-line delegate, so no existing caller
changed. The field is omitted when `skipped === 'not_status'` — otherwise every ordinary message
would grow a MoA field it never asked for. Additive optional response field, wire-compat rule 1.

Tests: a store test covers all four skip reasons plus the success shape; the new
`orchestration-send-moa-ingest.test.ts` covers absent / recorded / rejected on the send receipt,
including that a malformed ledger payload still delivers the message.

### P2-5 — transaction claim

`insertMessage`'s body (INSERT + SELECT + ingest) now runs inside its own
`message_insert_row` savepoint, nested inside `message_insert_batch` when a batch is in flight. The
comment was updated to say what is now true: the materialization happens *inside the savepoint that
owns its provenance row*, so a failing ingest can never leave entries without their message.

Honest note on coverage: I did not add a test that observes a rollback from *this* savepoint,
because there is no reachable path that produces one — `ingestMoaMessagePayload` catches every
store error and returns `store_error`. The savepoint is defence for future callers and makes the
comment accurate; the observable batch-level guarantee is already covered by task 2's
`insertMessages` rollback test.

### P2-6 — rowid cursor

The `recorded_seq` comment now states the actual hazard: this table has a TEXT primary key, so its
rowid is not a PK alias and `VACUUM` is free to renumber it; Orca never VACUUMs today; if it ever
does, promote `recorded_seq` to a real column rather than letting a cursor silently shift.

### P2-7 — CLI `--payload`

Removed from `singleEntryFromFlags`, from the spec `usage` string, and from `allowedFlags`. The
notes now say outright that structured payloads travel via `--entries-file` only, *because*
shell-quoted JSON is what PowerShell mangles — the contradiction the review flagged. `payload` is
still a valid key inside an `--entries-file` entry.

Test: a new CLI case passes `--payload` and asserts exit code 1 with no `orchestration.moaLog` call.

### P2-8 — skill guide

Added a `## MoA Deliberation Ledger` section to `skill-guides/orchestration.md`, placed immediately
after the "Gates And Legacy Inspection" section and before "Full Handoffs". I used a sibling `##`
heading rather than a `###` subsection because every heading in that file is `##`, and MoA is
neither a gate nor legacy inspection. It covers the two verbs with usage lines, the kinds/verdicts
enums, Run-scoped slugs, append-only + content-addressed (resends are ignored duplicates), the
echoed entry ids, "prefer `--entries-file`", and that `moa-show --json` returns entries ordered
`(round, authored_at, id)`.

`pnpm run generate:bundled-skill-guides` regenerated `src/cli/bundled-skill-guides.ts`, and
`pnpm run verify:bundled-skill-guides` passes.

**`verify:skill-bundle-manifest` fails, and it is pre-existing.** It reports
`resources/skills/current-manifest.json`, `snapshot-registry.json` and `release-mapping.json` as
stale. I verified this two ways: (a) stashing all of this task's changes and re-running it produces
the identical three files and message, and (b) extracting a clean `upstream/main` tree with
`git archive` into a scratch directory and running that tree's own copy of the script produces the
identical output. Per the task instruction I did not touch those unrelated generated files.

## Verification

Toolchain per task 1's note: Node 24.19.0 + pnpm 12 through the scratchpad wrapper.

| Command | Result |
| --- | --- |
| `pnpm typecheck:tsc:node` | **PASS** — zero errors (whole project) |
| `pnpm typecheck:tsc:cli` | **PASS** — zero errors (whole project) |
| `npx vitest run` over the spec'd paths + `orchestration-send.test.ts` + the new send test + `db/federation` | **PASS** — 9 files, 99 tests |
| `npx oxlint` on all changed `.ts` files | **PASS** — exit 0 |
| `pnpm run verify:bundled-skill-guides` | **PASS** |
| `pnpm run verify:skill-bundle-manifest` | **FAIL — pre-existing**, identical on a clean `upstream/main` checkout (evidence above) |
| `git status --short` | only `?? .debate-war/` and `?? moa/` |

Broad regression sweep — `npx vitest run --config config/vitest.config.ts src/main/runtime/orchestration src/cli`:
**1641 tests passed, 6 failed.** Five are the known Windows env-specific failures documented in
`common.md` and re-confirmed against a stashed baseline in the task 2 report
(`orchestration-mutation-recovery` ×3, `orchestration-gate-cli` ×1, `client-recovery` ×1). The
sixth is `db/dispatch-row-writer-boundary.test.ts`, the same whole-`src`-tree scanning test that
flaked in tasks 1 and 2: it timed out at 47s under parallel load and passes standalone in 0.8s. I
also grepped every file I changed for `INSERT ... INTO dispatch_contexts|remote_dispatch_attachments`
— the only thing that test looks for — and there are no matches.

## Deviations from the plan

1. **Two `max-lines` splits were forced.** After the changes, `moa-ledger-store.ts` hit 333 code
   lines (max 300) and `orchestration-send.test.ts` hit 822 (max 800); both were clean at HEAD, so
   I introduced both. Per AGENTS.md I split rather than disabling or bumping the rule:
   - The ingest path moved to `db/moa-ledger/moa-message-ingest.ts` with its own attach, registered
     alongside the store. This is a genuine seam — transport-tolerant materialization vs. the store
     — and both paths still share one `assertValidEntry` (now exported), so the strict and tolerant
     validators cannot drift.
   - The send-receipt test moved to `orchestration-send-moa-ingest.test.ts`, matching the existing
     `orchestration-send-invalid-type.test.ts` / `orchestration-send-dispatch-authority.test.ts`
     pattern.
2. **`insertMessage`'s return type was not changed** (P2-4 said "read the return of the local
   insertMessage call"). It has 60+ call sites; a sibling `insertMessageWithMoaIngest` gets the same
   result with zero call-site churn, and `insertMessage` delegates to it.
3. **The MoA guide section is a `##` sibling, not a `###` subsection** — see P2-8 above.
4. **No test for the new single-message savepoint** — no reachable failure path exists; explained
   under P2-5 rather than left silent.
