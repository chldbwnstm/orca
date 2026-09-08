<!-- Draft for reopening stablyai/orca#16426 (or a fresh issue if reopening is refused). Feature-request template fields. Title: -->
<!-- [Feature]: MoA deliberation ledger — durable record of multi-agent proposals, votes, and adopted/rejected outcomes -->

## Problem or use case

Orchestration can already fan work out to several agents and collect their completions, but when multiple agents deliberate toward one decision — the pattern behind #15119 (Councils) and the LLM-council composition in #10846 — the *provenance* of that decision is discarded. Today the record of "which seat proposed what, who challenged it, what was adopted, what was rejected and why" lives only in the coordinator's context window and scrollback:

- The coordinator relays every proposal and verdict by hand and keeps the tally in its own context — #15119 describes the same "play telephone / burn context / guess convergence" failure from the Discord side.
- Nothing survives the coordinator's death. Messages do not work as a ledger substrate: `resetMessages()` is `DELETE FROM messages`, heartbeats flood the table, and `worker_done` payloads are field-whitelisted at the federation boundary, so structured deliberation data cannot ride the existing mail as a durable record.
- A rejected idea leaves no trace, so when it resurfaces in a later round (or a later session asks "why didn't we do X?"), the reasoning has to be reconstructed — i.e. fabricated.

I validated this with a coordinator-side prototype (a skill driving the stock `orca orchestration` CLI) across several 3-seat deliberations (claude-fable / claude-opus / grok in separate worktrees). They converge, but every proposal and verdict passes through the coordinator twice, one seat's completions were rejected after a terminal reattach and had to be recovered by hand, and the ledger had to be maintained as a hand-edited JSON file in the coordinator's worktree — which a validator later showed had silently drifted from its own schema.

## Proposed solution

A small, additive **deliberation ledger** in the orchestration DB — the same class of client-resident control-plane state as `decision_gates`, following its exact materialization precedent:

- Two append-only tables (`moa_deliberations`, `moa_ledger_entries`) added via the established atomic `migrate()` pattern. A deliberation is named by a slug that is unique **within its Run** (surrogate id derived from `(run_id, slug)`), so two Runs can both hold a `design` deliberation. No SQL CHECK enums (widening `messages.type` to add `question` once required a full table rebuild); kinds and verdicts are validated in TypeScript.
- Content-addressed entry ids + `INSERT OR IGNORE`, so re-sent or replayed messages are idempotent no-ops; every entry id is echoed back so later verdicts can target a specific proposal.
- `authored_at` NOT NULL and normalized to UTC, `recorded_at` separate; display order `(round, authored_at, id)` — federated entries arrive in relay order, not author order.
- Ingest via an optional `payload.moa` key on the **existing** `status` message type (remote-wire-compatibility Rule 1: a new optional field on an existing frame; no new message type, which old hosts reject loudly), materialized where every arrival path already funnels: message insert, inside the savepoint that owns the carrier row. Malformed payloads never fail delivery; a storage failure rolls the message back so a valid entry cannot vanish while its message delivers.
- Explicit CLI verbs for the strict path: `orca orchestration moa-log` (typed flags or `--entries-file`, avoiding shell-quoted JSON that PowerShell mangles) and `orca orchestration moa-show` (`--json` includes `sender_handle` so a sender-asserted seat label stays auditable).
- Reset semantics: cleared by `reset --all` / `--tasks`, untouched by `--messages` — the ledger is deliberation state, not mailbox hygiene.

Deferred on purpose (follow-ups, not this change): a native deliberation/convergence primitive (#15119), returning applied launch options for seat identity verification (#10846 L1), server-side seat↔dispatch binding, cross-host ledger replication behind a negotiated capability, and any UI.

## Alternatives or additional context

- **Messages as the ledger** — rejected: `resetMessages()` deletes them, heartbeats flood the table, federated `worker_done` payloads are field-whitelisted.
- **Files in the coordinator worktree** — rejected: fails for remote or deleted worktrees; per `docs/reference/ssh-execution-boundary.md`, orchestration state is client-resident.
- **A new `messages.type`** — rejected: the CHECK enum is closed and `parseFederatedControlMessage` throws cross-host on unknown types.

A previous submission of this feature (#16427) was withdrawn by me before review to validate it end to end; the resubmission adds Run-scoped slugs, echoed entry ids, UTC-normalized authoring time, provenance in `moa-show`, atomic ingest, and a Playwright spec that drives the built CLI against the launched app.
