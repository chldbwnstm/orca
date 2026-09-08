# Task 4 — Skill protocol v3: dual-write to the store, fix deliberation logic, harden the schema

Read `moa/review/tasks/common.md` first. Review items: P1-3, S-1 … S-7 (section 5). Tasks 1–3 must be complete so the CLI verbs and response shapes are final — read `src/cli/specs/orchestration-moa-specs.ts`, `src/cli/handlers/orchestration/moa-handlers.ts`, and `src/main/runtime/rpc/methods/orchestration-moa.ts` for the exact contract before writing prompt text.

Files: `.claude/skills/moa/SKILL.md`, `.claude/skills/moa/ledger.schema.json` (both gitignored, in this worktree). No git commit for these. At the end copy both (plus the new validator) to `C:/Users/User/.claude/skills/moa/` and confirm the copies are byte-identical (`diff`).

## Changes to SKILL.md (bump header to v3, add a 3–6 line changelog under the title)

### P1-3 — dual-write to the orchestration ledger store
- Phase 0: after `run-create`, open the deliberation by logging the roster as the first entries (`kind: note`, payload `{ type: "roster", seats: [...] }`) with `--seat-count N` — the deliberation is created implicitly by the first `moa-log`.
- Every ledger append (proposal ingest, each round's verdicts/rankings/concessions, resolution, close) ALSO runs `orca orchestration moa-log --deliberation <slug> --entries-file moa/<slug>/store/<phase>.json --json` using this mapping (write the JSON file first, never inline JSON on the command line):

  | ledger.json | store entry |
  |---|---|
  | proposal `p-X` | `kind=proposal, round=1, seat=seat-X, rationale=<idea>, payload={key_points, confidence, report}` |
  | round r verdict from A on B | `kind=verdict, round=r, seat=seat-A, subjectEntryId=<store id of p-B>, verdict, rationale, payload={merge_with, base}` |
  | rankings / concessions (per seat) | `kind=note, round=r, seat, payload={type:"ranking", ranking, concede_own, derived_concession}` |
  | resolution.adopted / rejected[] | `kind=outcome, verdict=adopted|rejected, subjectEntryId, rationale, payload={votes, unanimous, sources}` |
  | end | `kind=close, payload={resolution_forced_by, dissent, chair_additions, convergence}` |

- Record the returned store entry ids in ledger.json (`store_entry_id` on proposals; `store` block per round/resolution) so later `subjectEntryId` values resolve without re-reading `moa-show`.
- Phase 4: run `orca orchestration moa-show --deliberation <slug> --json`, reconcile counts against ledger.json, and write any mismatch as a `protocol_note`. Include the store deliberation id in the report header.
- Degrade gracefully: if the CLI reports `moa-log` as an unknown command (older Orca), record `protocol_note: "store unavailable: <error>"` once and continue file-only. Never let a store failure stop the consortium.

### S-1 — convergence rule
- Converged iff (a) zero `challenge` verdicts among counted seats AND (b) one proposal holds a strict majority of counted seats as base (`support`, or `merge` whose `base` names it). Zero challenges without a majority base → run the rebuttal/consolidation round (round cap still applies).

### S-2 — merge verdict carries `base`
- Round JSON contract: `{ "target", "verdict", "rationale", "merge_with": [], "base": "seat-X" }` where `base` is required when `verdict` is `merge` (which proposal the merge is built on). Update the round spec template, the tally rules ("merge-as-base" now means `base === target`), and the schema.

### S-3 — schema hardening + validator
- `ledger.schema.json`: `additionalProperties: false` on seat, proposal, round, verdict, resolution, rejected-item and dissent objects (keep the `identity` definition open to `effort`). Add `base` to verdict; add `store_entry_id`/`store` fields; add `insufficient_verified` to `resolution_forced_by`; allow `verified: "self"`.
- Add `.claude/skills/moa/validate-ledger.mjs`: dependency-free Node script (`node validate-ledger.mjs <ledger.json>`) that checks required keys, enums, `additionalProperties` for the objects above, and the `^seat-[A-Z]$` pattern; exits 1 with a list of paths on failure. Phase 4 must run it and stop to fix the ledger on failure (this replaces "validate with a JSON parse at minimum").
- Normalize the historical dogfood ledger `moa/ledger-storage/ledger.json`: merge the stray `verdicts_seat_B` / `verdicts_seat_C` arrays into the round's `verdicts` array (keep order A, B, C), then confirm the validator passes on it. Mention in the report.

### S-4 — tabs mode counts
- Introduce `verified: "self"` for tabs-mode seats (self-reported identity, nothing requested to compare against). Counted seats = `verified: true` or `"self"`; only `true` seats may support an `unanimous` claim. Fix every place that says "verified seats only".

### S-5 — degenerate rosters
- If fewer than 2 counted seats remain at Phase 3, the chair decides and records `resolution_forced_by: "insufficient_verified"`.

### S-6 — rebuttal round template
- Add a rebuttal spec template (like the phase-1/round templates) with a JSON contract: challenged seat → `{ "action": "defend|amend|concede", "amended_proposal": "...", "rationale": "..." }`; challengers → `{ "target", "action": "confirm|withdraw", "rationale" }`. Files: `moa/out/rebuttal-<r>.json`.

### S-7 — single source of truth
- Note at the end of SKILL.md: the project copy in the Orca clone is the source; sync with one copy command (give the exact Windows and POSIX forms) to `~/.claude/skills/moa/`.

## Verify
- `node .claude/skills/moa/validate-ledger.mjs moa/ledger-storage/ledger.json` passes after normalization (and fails on a deliberately broken copy — show one example in the report).
- Re-read SKILL.md end-to-end for internal consistency (every "verified seats only" updated; tally rules use `base`; phase 4 checklist includes moa-log reconciliation and the validator).
- Copy to `C:/Users/User/.claude/skills/moa/` and `diff` all three files.
- Report to `moa/review/tasks/task-4-report.md`, then `worker_done`.
