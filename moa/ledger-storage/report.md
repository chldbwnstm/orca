# MoA Consortium Report — ledger-storage

**Run**: `run_20fc586727aa` · 2026-08-25 · 3 seats · converged in 1 deliberation round (zero challenges)

## Problem

How should the MoA deliberation ledger be persisted in Orca: (A) new orchestration DB tables, (B) per-run files in the coordinator worktree, (C) orchestration message payloads — under remote wire compatibility, SSH execution, crash recovery, future UI exposure, and small-first-PR constraints?

## Adopted Solution (merge of p-C base + p-B details + p-A invariant)

**Store**: new tables in the existing orchestration SQLite DB (`userData/orchestration.db`), added via the established atomic `migrate()` pattern. The ledger is client-resident control-plane state — the same class as `decision_gates`, which is the exact materialization precedent (worker sends typed message payload → home runtime materializes a typed row).

**Transport/ingest**: existing orchestration messages only, as an optional `payload.moa` key on the **existing** `status` type.
- Never mint a new `messages.type`: the CHECK enum is closed and `parseFederatedControlMessage` throws `invalid_argument` cross-host on unknown types (verified in code).
- Don't ride `worker_done`: its federation payload is field-whitelisted (`taskId/dispatchId/outcome/filesModified/reportPath`) — extra keys are silently dropped (verified in code).

**Authority**: ledger tables are authoritative; messages are transport, **not** a write-ahead log — `resetMessages()` executes `DELETE FROM messages`, so a message-based "log of record" is destroyed by a routine mailbox reset (found independently by two seats).

**Schema invariants**:
- Strict append-only: outcomes are new rows referencing proposal rows; nothing is ever UPDATEd — audit log by construction (replaces a mutable header `status/current_round`, which a crash mid-round-close can leave inconsistent).
- Content-addressed entry ids + `INSERT OR IGNORE` for idempotent ingest.
- `authored_at` vs `recorded_at` split; display order is `(round, authored_at, id)`; any local sequence is a pagination cursor only — federated entries arrive in relay order, not author order.
- Anonymized `seat_id` (never terminal handles/pane keys); `message_id` provenance link to the originating message row.
- No SQL CHECK enums on kind/verdict — validate in TypeScript (SQLite cannot ALTER a CHECK; widening `messages.type` once required a full table rebuild).

**Scope/rollout**: first PR = one schema-version bump + store module + CLI verbs (the established unit of change in this DB). Cross-host ledger replication deferred behind a negotiated capability (e.g. `orchestration.moa-ledger.v1`). Reset semantics: cleared by `resetAll`/`resetTasks`, untouched by `resetMessages`.

## Consortium Record (debate 1)

| Seat | Identity (requested → verified) | Idea (phase 1, blind) |
|---|---|---|
| seat-A | claude/fable/high → **claude-fable-5** ✓ (effort unverifiable) | Append-only ledger tables in orchestration DB; C as transport only; reject B |
| seat-B | claude/opus/high → **claude-opus-5** ✓ (effort unverifiable) | Tables as rebuildable projection; **messages table as durable WAL**; reject B |
| seat-C | grok → **grok-4.6** ✓ | Tables authoritative (schema v30); messages as ingest only, decision_gates precedent; reject B |

Family note: seat-A and seat-B share the claude family — their agreement is correlated evidence; seat-C (grok) agreeing independently is the stronger signal.

### Adopted

- **Base: p-C** (votes: A support, B merge-as-base) — correct authority model, decision_gates precedent, correct reset semantics.
- **From p-B**: closed-enum/no-new-type rule, `payload.moa` on `status`, whitelist finding, content-addressed idempotent ingest, authored/recorded split.
- **From p-A**: strict append-only invariant (praised by B as the round's best framing), anonymized seat ids, message provenance.

### Rejected (with votes)

| Rejected idea | Why | Votes | Unanimous |
|---|---|---|---|
| p-B: messages as durable WAL / tables as projection | `resetMessages()` = `DELETE FROM messages` destroys the "log"; heartbeat flood; retention unsolved | A reject · B concede · C reject | ✓ |
| p-A: AUTOINCREMENT global order | Relay-arrival ≠ author order in federation (wrong "first voter" in UI); schema as written is invalid SQLite (TEXT PK + AUTOINCREMENT) | A concede · B reject · C reject | ✓ |
| SQL CHECK enums on kind/verdict | Closed-enum rebuild hazard; SQLite can't ALTER CHECK → validate in TS | A reject · B reject · C reject | ✓ |
| Option B: files as primary store | Fails with remote/deleted coordinator worktree; ledger is client-resident control-plane state | A reject · B reject · C reject (all blind, phase 1) | ✓ |

### Dissent

- **seat-C** ranked p-B first (B > C > A) against the consensus base p-C, weighting B's code-verified federation constraints as decisive.

### Rankings & concessions

- seat-A: C > B > A, **conceded own**
- seat-B: C > B > A, did not concede (protocol ambiguity: ranked another first while `concede_own=false`)
- seat-C: B > C > A, did not concede

Chair additions: none — synthesis assembled entirely from seat material.

## Dogfood Findings (protocol/tooling friction observed this run)

1. **`worker-start --terminal` reattach needs an explicit `--worktree` of the seat's worktree** — defaulting to `current` fails with `terminal_worktree_mismatch`. → fix the skill's Phase-2 template.
2. **grok seat completions were rejected after reattach** ("Rejected worker_done", pane-identity mismatch) — its round-2 task landed `failed` despite valid output, and the seat kept re-sending `worker_done`. Coordinator recovered via manual `task-update`. Evidence for #10846-style "requested is not proof" *and* for a real dispatch-attach primitive.
3. **`concede_own` semantics are ambiguous** relative to rankings — define: ranking another proposal first ⇒ implicit concession, or make concede a derived field.
4. **Effort is unverifiable by self-report** — both claude seats reported `effort: unknown`; only #10846's L1 (runtime returns applied options) can close this.
5. Coordinator context load was fine at N=3/one round, but every proposal and verdict passed through the coordinator twice (ingest + relay) — the O(N²) packet relay is where a native primitive would pay off first.

## Roster (requested vs verified)

All 3 seats verified on agent+model; effort unverified on both claude seats; no model was requested for grok (reported grok-4.6).
