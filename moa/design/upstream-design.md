# MoA for Orca — Upstream Primitive Blueprint

Status: draft for the future issue/PR (user decision: file the issue only after the prototype proved itself — it now has).
Sources: consortium run `run_20fc586727aa` (3 seats: claude-fable-5, claude-opus-5, grok-4.6 — all identity-verified; converged in 1 round; see `../ledger-storage/ledger.json` + `report.md`), dogfood findings of the `moa` skill v1→v2, and prior art #10846 / #15119 / #6251 / #13888.

## 1. Positioning

MoA is a **protocol layer on top of orchestration, not beside it**. Orchestration answers "how do agents talk and who owns which work" (runs/tasks/dispatches/messages); MoA answers "how do N opinions become one decision, verifiably". Everything below reuses orchestration as transport and adds only: deliberation semantics, convergence state, and a durable decision ledger.

Relationship to prior art:
- **#15119 (Council)** proposes the deliberation primitive (turn-based rounds, react protocol, convergence). MoA's protocol phase matches it; this blueprint adds the ledger/provenance half Council doesn't specify.
- **#10846 (LLM council / model inventory)** supplies the identity layer: L1 (return applied session options) is a hard dependency for real seat verification — self-report tops out at agent+model and cannot verify effort (measured in the dogfood).
- **#6251 (oracle shortcut)** and **#13888 (Rooms)** are adjacent but different: prompt-level fan-out digest (no provenance) and free-form group chat (no structure).

## 2. Evidence from the working prototype

The `moa` skill runs the full protocol today on stock orchestration CLI. What broke or strained is the case for the primitive:

| # | Observation (run_20fc586727aa) | Primitive requirement |
|---|---|---|
| 1 | `worker-start --terminal` reattach requires explicit seat `--worktree` or fails `terminal_worktree_mismatch` | round dispatch should re-attach to a dispatch, not a (worktree, terminal) pair |
| 2 | grok seat's `worker_done` rejected after reattach (pane-identity mismatch); task landed `failed` despite a valid report file; seat re-sent completions in a loop | completion identity must survive reattach; report-file-as-truth needs first-class support |
| 3 | `concede_own` self-report contradicted the seat's own ranking | protocol state (concession) should be derived server-side from structured verdicts, not self-declared |
| 4 | effort unverifiable by self-report (both claude seats: `unknown`) | #10846 L1: launch result must return applied session options |
| 5 | every proposal/verdict passes through the coordinator twice (ingest + relay); O(N²) context load at N=3 already visible | packets should move host-side (DB/files), coordinator handles verdicts only |

## 3. Adopted storage design (consortium resolution, unanimous architecture)

All three seats independently converged blind on: **DB tables as the store, messages as ingest-only transport, worktree files rejected as primary storage.**

### Authority model
- New tables in the existing orchestration SQLite DB (`userData/orchestration.db`) are **authoritative**. The ledger is client-resident control-plane state — the same class as `decision_gates` (per `docs/reference/ssh-execution-boundary.md`), which is also the materialization precedent: worker sends a typed message payload → home runtime materializes a typed row.
- Messages are **transport, never a write-ahead log**: `resetMessages()` executes `DELETE FROM messages`, so a message-based "log of record" dies on a routine mailbox reset (found independently by two seats). Rejected unanimously.

### Wire format (remote-wire-compatibility compliant)
- **Never mint a new `messages.type`**: the CHECK enum is closed and `parseFederatedControlMessage` throws `invalid_argument` cross-host on unknown types; widening it once (adding `question`) required a full table rebuild plus a SQL-text probe.
- Carry ledger events as an optional **`payload.moa` key on the existing `status` type** — Rule 1 of remote-wire-compatibility (new optional field on an existing frame), no protocol bump, old hosts ignore it.
- **Do not ride `worker_done`**: its federation payload is field-whitelisted (`taskId/dispatchId/outcome/filesModified/reportPath`); extra keys are silently dropped.
- Cross-host ledger **replication** is deferred behind a negotiated capability (`orchestration.moa-ledger.v1`); until then the home runtime owns the ledger.

### Schema invariants
- **Strict append-only**: outcomes are new rows referencing proposal rows; nothing is ever UPDATEd — audit log by construction. No mutable `status/current_round` header (a crash mid-round-close would leave it disagreeing with its entries); round-close is itself an append-only event row.
- **Deliberations are Run-scoped**: the caller names a deliberation by a `slug` unique *within a Run* (`UNIQUE(run_id, slug)`), and the primary key is a surrogate `moad_<sha256(run_id, slug)[:32]>`. Two Runs may each hold a `round-1` deliberation without colliding, and a slug that exists only in another Run reads as "not found" rather than "belongs to another Run" — the error text itself must not confirm a foreign Run's contents.
- The deliberation header is **immutable**: re-declaring a different `seat_count`/`task_id` on an open deliberation is an `invalid_argument`, not a silent overwrite. The transport-tolerant ingest path swallows that rejection (records nothing) so a drifting payload never fails message delivery.
- **Content-addressed entry ids** + `INSERT OR IGNORE` → idempotent ingest (duplicate/re-sent messages are no-ops; directly fixes observation #2's re-send loop). The id hashes the **raw** `authoredAt` the caller supplied (`null` when absent), never the defaulted timestamp — otherwise a resend of a clock-less entry would mint a new row every time.
- `authored_at` vs `recorded_at` split; display order is `(round, authored_at, id)`. `authored_at` is **NOT NULL** and always stored as a canonical UTC ISO string (`toISOString()`): a missing one defaults to now, and a `+09:00` input is normalized, so the lexicographic index sort is chronological and a late clock-less entry sorts last instead of first (a NULL would sort ahead of every real timestamp).
- Any local sequence is a pagination cursor only — federated entries arrive in relay order, not author order (an `AUTOINCREMENT` global order would misname the first voter; also the naive sketch was invalid SQLite — TEXT PK + AUTOINCREMENT). `recorded_seq` is therefore **not a column**: it is the SQLite `rowid`, exposed by the read query as `rowid AS recorded_seq`.
- Anonymized `seat_id` (never terminal handles/pane keys — handles are recyclable and de-anonymize seats); `message_id` provenance link to the originating message row. Provenance holds across the federation relay too: relayed items land through the same `insertMessage`, so a remote entry still names the message that carried it.
- **No SQL CHECK enums** on kind/verdict: SQLite cannot ALTER a CHECK; validate in TypeScript. `round` and `seatCount` are validated as strict positive integers at the RPC boundary rather than coerced, so a malformed round cannot be silently filed under round 1.
- Reset semantics: ledger cleared by `resetAll`/`resetTasks`, untouched by `resetMessages`.

### DDL (PR 1, as implemented at schema v31)

```sql
CREATE TABLE IF NOT EXISTS moa_deliberations (
  id           TEXT PRIMARY KEY,          -- surrogate: moad_<sha256(run_id, slug)[:32]>
  run_id       TEXT NOT NULL,
  slug         TEXT NOT NULL,             -- caller-chosen name, unique within the Run
  task_id      TEXT,
  seat_count   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, slug)
);                                        -- immutable header; state lives in entries

CREATE INDEX IF NOT EXISTS idx_moa_deliberations_run ON moa_deliberations(run_id);

CREATE TABLE IF NOT EXISTS moa_ledger_entries (
  id               TEXT PRIMARY KEY,      -- content-addressed (idempotent ingest)
  deliberation_id  TEXT NOT NULL,         -- the surrogate id, never the slug
  round            INTEGER NOT NULL DEFAULT 1,
  entry_kind       TEXT NOT NULL,         -- proposal|verdict|outcome|close|note (TS-validated)
  seat_id          TEXT,                  -- anonymized seat label
  subject_entry_id TEXT,                  -- verdict/outcome -> targeted proposal entry
  verdict          TEXT,                  -- support|challenge|merge / adopted|rejected (TS-validated)
  rationale        TEXT,
  payload          TEXT NOT NULL DEFAULT '{}',
  message_id       TEXT,                  -- provenance link to messages row
  authored_at      TEXT NOT NULL,         -- seat-side authoring time, canonical UTC ISO; defaults to now
  recorded_at      TEXT NOT NULL DEFAULT (datetime('now'))
);                                        -- recorded_seq is the rowid, exposed by the read query only

CREATE INDEX IF NOT EXISTS idx_moa_entries_display
  ON moa_ledger_entries(deliberation_id, round, authored_at, id);
```

Applied via the established atomic `migrate()` pattern (one schema-version bump, `CREATE TABLE IF NOT EXISTS` in a dedicated create-sql module, store module attached via `attach-orchestration-db-methods.ts`). The v31 migration drops both tables before creating them: the withdrawn v30 draft of this PR shipped nowhere, so a local dogfood DB is rebuilt rather than migrated column by column.

### Surface (PR 1, as implemented)

- **Store**: `openMoaDeliberation({ runId, slug, taskId?, seatCount? })`; `logMoaEntries({ runId, slug, entries, ... })` returning `{ deliberation, entries: { id, inserted }[], inserted, duplicates }`; `getMoaDeliberation({ runId, slug } | { id })`; `listMoaDeliberations({ runId })`; `listMoaEntries({ deliberationId, round? })`.
- **RPC**: `orchestration.moaLog` / `orchestration.moaShow`. `deliberation` is the slug on the wire; responses carry both `deliberation.id` and `deliberation.slug`. Not-found is `OrchestrationError('deliberation_not_found')`, so `--json` callers branch on a stable code rather than message text.
- **CLI**: `orca orchestration moa-log` prints a summary line plus one `<entry_id> new|duplicate <kind> [seat]` line per entry, so a coordinator can aim a later verdict at a specific entry without a second round trip.

## 4. Phased PR plan (small-first per CONTRIBUTING.md)

- **PR 1 — ledger store**: schema bump + two tables + store module + read/write CLI (`orca orchestration moa-log`, `moa-show --json`). Ingest path: materialize `payload.moa` on `status` messages, decision_gates-style. No UI, no federation. This is "the established unit of change in this DB".
- **PR 2 — seat truth (#10846 L1)**: surface `appliedSessionOptions` in `terminal.createAgentSession` result + CLI warning when a requested option was dropped. Independently valuable; unblocks real verification.
- **PR 3 — protocol conveniences**: round dispatch that re-attaches by dispatch id (fixes observations #1/#2), server-derived concession/convergence state, `moa-status` for coordinators.
- **PR 4 — UI + federation**: Ledger panel reading via a new RPC (old clients never call it); replication behind `orchestration.moa-ledger.v1`.

Each PR needs: linked issue (file the MoA issue referencing #10846/#15119 right before PR 1), AI disclosure, cross-platform/SSH notes, tests per repo rules (GitCapabilityCache-style host scoping doesn't apply; wire-compat contract tests do).

## 5. Open questions

- ~~Does a deliberation belong to a run or to a task?~~ **Resolved in PR 1: run-scoped.** The slug is unique per Run and `task_id` stays an optional header field, so per-seat tasks still attach without becoming the identity.
- Seat anonymity vs. UI: the Ledger panel de-anonymizes after close — where is the seat→identity map stored? (Prototype: coordinator-side; primitive likely needs it in the header payload, sealed until close.)
- Sparse review for N > 4: protocol-level or coordinator policy?
- Should `payload.moa` events be signed/hashed for tamper-evidence, or is append-only + provenance enough for v1? (Consortium assumption: no legal-grade immutability needed in PR 1.)
