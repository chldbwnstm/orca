<!-- Draft PR body. Title: feat(orchestration): MoA deliberation ledger — durable record of multi-agent proposals, votes, and outcomes -->
<!-- Replace #ISSUE with the reopened/new issue number before posting. -->

## ELI5

When several agents deliberate toward one decision (a council / mixture-of-agents review), the record of who proposed what, who challenged it, and why the final answer won currently lives only in the coordinator's context window — and dies with it. This PR gives orchestration a small append-only "deliberation ledger" in the existing orchestration DB, so that record survives, deduplicates itself, and can be read back later, plus two CLI verbs to write and read it.

## What Changed

- **Schema v40**: two append-only tables, `moa_deliberations` and `moa_ledger_entries`, created through the established atomic `migrate()` pattern (`create-moa-ledger-tables-sql.ts`, `migrate-v40-moa-ledger.ts`).
  - A deliberation is addressed by a **slug unique within its Run**; its row id is a surrogate `moad_<sha256(run_id, slug)>`, so two Runs may both hold a `design` deliberation and a slug used only in another Run reads as not found (no probing of foreign Runs).
  - No SQL CHECK enums — entry kinds (`proposal|verdict|outcome|close|note`) and verdicts (`support|challenge|merge|adopted|rejected`) are validated in TypeScript. SQLite cannot alter a CHECK later; widening `messages.type` once required a full table rebuild.
  - Content-addressed entry ids + `INSERT OR IGNORE`: re-sent or replayed entries are idempotent no-ops. The hash uses the raw input, so an entry sent without a timestamp still dedupes after the store stamps one.
  - `authored_at` is NOT NULL, normalized to UTC ISO; display order is `(round, authored_at, id)` — federated entries arrive in relay order, not author order. `rowid` is exposed only as a local pagination cursor.
- **Store** (`db/moa-ledger/moa-ledger-store.ts`, attached like every other store module): `logMoaEntries` (strict, transactional, returns `{ id, inserted }` per entry in input order), `openMoaDeliberation` (header fields `task_id` / `seat_count` may be declared once and are then immutable), `getMoaDeliberation`, `listMoaDeliberations`, `listMoaEntries` (LEFT JOINs the carrier message so `sender_handle` is available for audit).
- **Ingest** (`db/moa-ledger/moa-message-ingest.ts`): an optional `payload.moa` key on the **existing** `status` message type materializes rows inside the message insert — the single funnel every arrival path (send, federation relay import, injected mail) already passes through — inside the savepoint that owns the provenance row. Malformed payloads never fail delivery (the insert reports a typed skip reason); a storage failure rolls the carrier message back. The local `send` receipt carries the result as an optional `moaIngest` field.
- **RPC**: `orchestration.moaLog` / `orchestration.moaShow` (`rpc/methods/orchestration/moa/moa-methods.ts`), Run-scoped exactly like gates; strict positive-integer schemas for `round` / `seatCount`.
- **CLI**: `orca orchestration moa-log` (typed flags for one entry, or `--entries-file` for a round — structured payloads travel only there, since shell-quoted JSON is what PowerShell mangles; every entry id is echoed back for later `--target` use) and `orca orchestration moa-show`. Keys live in the existing `orchestration` handler group; the verbs are documented in the orchestration skill guide's messaging-and-gates reference (bundle regenerated).
- **Reset semantics**: ledger cleared by `reset --all` / `--tasks`, deliberately untouched by `--messages` — it is deliberation state, not mailbox hygiene.

Out of scope, on purpose: a deliberation/convergence state machine (#15119), applied-launch-option reporting for seat identity (#10846 L1), server-side seat↔dispatch binding (seat labels are sender-asserted and auditable via `message_id` / `sender_handle`), cross-host replication, UI.

## Why

Multi-agent deliberation is already being requested from several directions (#15119 Councils, #10846 LLM-council composition), and both need the half this PR provides: a durable, queryable decision record. The messages table cannot be that record (`resetMessages()` is `DELETE FROM messages`; federated `worker_done` payloads are field-whitelisted), and coordinator-side files fail for remote/deleted worktrees — per `docs/reference/ssh-execution-boundary.md`, orchestration state is client-resident. `decision_gates` is the exact materialization precedent this follows.

The design was validated with a coordinator-side prototype (a skill over the stock orchestration CLI) across several 3-seat deliberations before this code was written; the failure modes it surfaced (double relay through the coordinator, hand-edited ledger drifting from its schema, rejected completions after reattach) are what the ledger fixes first.

This resubmits #16427, which I withdrew to validate end to end. Compared with that draft it adds Run-scoped slugs, echoed entry ids, UTC-normalized `authored_at`, provenance in `moa-show`, atomic ingest with a typed receipt, and addresses the three review comments left on it (every single-entry flag now conflicts with `--entries-file`; `seat_count` must be a non-negative integer; a persistence failure rolls the carrier message back instead of being swallowed).

## Linked Issue

Fixes #ISSUE

## Visual Proof

N/A — no UI change; the surface is the orchestration DB, two RPC methods, and two CLI verbs. Example session (Windows, PowerShell):

```text
orca orchestration moa-log --deliberation ledger-storage --seat-count 3 --entries-file moa/store/proposals.json --json
orca orchestration moa-log --deliberation ledger-storage --kind verdict --round 2 --seat seat-B --target <entry_id> --verdict support --rationale "holds up"
orca orchestration moa-show --deliberation ledger-storage --json
```

## Testing

- Unit: `moa-ledger-store.test.ts` (implicit open, content-addressed duplicates, TypeScript-side validation, `(round, authored_at, id)` ordering incl. omitted and offset timestamps, ingest skip reasons, reset scopes, pre-v40 migration in place, rebuild of the withdrawn draft tables, slug reuse across Runs, header fill-once/drift, storage-failure rollback), `moa-relay-import.test.ts` (federation relay import materializes with `message_id` / `sender_handle`), `moa-methods.test.ts` (Run scoping, `consumer_fenced`, not-found code, receipts), `send-moa-ingest.test.ts` (receipt field), `orchestration-moa-cli.test.ts` (flags, entries file, per-entry output, flag conflicts), plus the registry-count and CLI parity suites.
- End to end: `tests/e2e/moa-ledger-cli.spec.ts` launches the built app, creates a Run through the runtime RPC, and drives the built CLI: `moa-log --entries-file`, a replay that records nothing, a `status` message carrying `payload.moa` whose receipt reports `moaIngest`, and `moa-show` returning all three entries in author order with `subject_entry_id` and `sender_handle` provenance.
- Gates run locally: `pnpm typecheck` (node, cli, e2e), targeted `vitest`, `oxlint`, `oxfmt --check`, `verify:bundled-skill-guides`, max-lines ratchet.
- Platforms: Windows 11 (PowerShell + Git Bash) for everything above. The change is DB/RPC/CLI only — no path, shortcut, or shell-specific behavior beyond the existing CLI flag parsing; the `--entries-file` design exists specifically so PowerShell users never quote JSON on the command line. SSH/remote: federation relay import goes through the same `insertMessage` funnel (covered by the relay test); cross-host ledger replication is explicitly deferred behind a future negotiated capability, so old hosts see only an ignored optional payload field (wire-compat Rule 1).

- [x] I manually tested these changes locally
- [x] Automated tests added/updated, or explained why not below

## AI Disclosure

Written with Claude Code (Claude Fable 5.1, with Claude Opus 5 as a coding worker under Orca orchestration) driven by me; every change was reviewed by me and verified with the test gates listed above.

## Review

Agent code-review summary (checked explicitly):

- Cross-platform: DB/RPC/CLI only; no filesystem paths beyond `--entries-file` (read with `node:fs`), no shortcuts; PowerShell quoting is the reason for `--entries-file` and the absence of a `--payload` flag on the single-entry form.
- SSH / remote / local: ingest is host-agnostic (message insert funnel; relay import tested); the ledger stays client-resident per the execution-boundary doc; new optional response fields only (`moaIngest`, entry receipts).
- Agents / integrations: no agent-specific code; seat labels are opaque strings.
- Performance: content-addressed ids avoid dedup queries; one index on `(deliberation_id, round, authored_at, id)`; ingest short-circuits unless the payload contains `"moa"`.
- Security: participants in a Run can write ledger rows for that Run (same trust as sending mail there); seat attribution is sender-asserted and auditable via `message_id` / `sender_handle`; foreign Runs are not probeable through `moaShow`; no new IPC surface beyond two Run-scoped RPC methods.
- Backwards compatibility: additive schema version (v40) with `CREATE TABLE IF NOT EXISTS` and a drop-and-recreate of the never-shipped fork draft tables; no wire opcode changes.

## Agent skill upstream boundary

- [x] Not applicable, or this change follows `docs/reference/agent-skill-sharing-upstream-boundary.md` and copies or mechanically translates no upstream skill-installer source, tests, fixtures, registry entries, path tables, comments, or documentation.

## Notes

Known pre-existing failures on a clean checkout, unrelated to this PR: `verify:skill-bundle-manifest` staleness and three Windows-environment-specific unit tests (`orchestration-mutation-recovery` ×3 style socket/env cases).

## Checklist

- [x] This PR is small and focused
- [x] I explained what changed and why (including ELI5)
- [x] Before/after screenshots or videos attached for UI changes, or `N/A` with reason
- [x] Self-reviewed for correctness, security, and performance
- [x] Cross-platform, SSH/remote, and path/shortcut impact considered (or N/A)
- [x] `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass (or CI will cover; local preferred)

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01EkSz1GwJTks9XiX8DsauAg
