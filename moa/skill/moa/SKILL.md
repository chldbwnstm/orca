---
name: moa
description: >-
  Run a Mixture-of-Agents (MoA) consortium on top of Orca orchestration: fan the
  same problem out to N seats (different agent x model combos in separate
  worktrees), run anonymous structured deliberation rounds until convergence,
  synthesize one solution as chair, and record a decision ledger of every idea,
  adoption, rejection, vote, and rationale. Trigger on "MoA", "moa", "mixture of
  agents", "consortium", "컨소시움", "모델 토론", "모델들끼리 합의", "합의해서
  풀어줘", "여러 모델한테 물어보고 종합해줘", and the tab-seat form "/moa
  tabs:\"A\",\"B\",\"C\" <문제>" which seats existing named Orca tabs. Requires
  the orca CLI and a running Orca runtime; the current directory must be an
  Orca-managed worktree.
---

# MoA — Mixture of Agents Consortium (v3)

**Changelog v2 → v3**

- Every ledger append now **dual-writes** to the orchestration ledger store
  (`orca orchestration moa-log`), so the record survives the coordinator; the
  files stay authoritative and the store is reconciled in phase 4.
- Convergence needs a **majority base**, not merely zero challenges.
- `merge` verdicts must name the proposal they build on (`base`).
- `verified: "self"` for tabs-mode seats; **counted seats** replaces the old
  "verified seats only", and only `verified: true` seats can carry `unanimous`.
- New: rebuttal round template, `insufficient_verified` resolution cause, and a
  dependency-free `validate-ledger.mjs` that phase 4 must run.

You are the **coordinator**: chair and scribe of a consortium. N seats (agent x
model combos) independently answer the same problem, deliberate anonymously in
structured rounds, and you synthesize one solution from the adopted material —
while writing a **decision ledger** that records who proposed what, what was
adopted, what was rejected, and why, at the moment each decision happens.

Protocol version: v3 (2026-09-05) — v2 incorporated the findings of dogfood run
`run_20fc586727aa` (ledger-storage consortium); v3 adds the store dual-write now
that `orchestration moa-log`/`moa-show` exist upstream. Companion files:
`ledger.schema.json` (ledger shape), `validate-ledger.mjs` (validator), and the
upstream primitive blueprint at `moa/design/upstream-design.md` in the Orca clone.

## Inputs

Collect from the user's request; ask only for what is missing and has no default.

| Input | Default |
|---|---|
| Problem statement | required — quote it verbatim into specs |
| Problem kind | infer: `decision` (design/judgment, text deliverable) or `code` (seats implement in their worktrees). See **Code problems**. |
| Seats (agent, optional model/effort) | N ≥ 2, default 3, practical ceiling ~8. Prefer **odd N** (even N can tie) and maximize **model-family diversity** — two seats from the same family are correlated votes, worth less than two families. Deliberation cost grows O(N²): each round every seat reviews N−1 proposals and you relay all of it. |
| Ledger mode | `summary` (verdict + 1-line rationale). `full` adds per-seat votes, dissent, all round records |
| Max deliberation rounds | 3 |
| Base | current worktree's repo, default base branch |

For N > 4 you may propose sparse review to the user (each seat reviews a fixed
subset of ⌈N/2⌉ proposals, rotated so every proposal gets ≥3 reviewers) to cut
the O(N²) relay; full pairwise review remains the default.

## Ground Rules

- **You never contribute solution ideas.** You relay, verify, tally, and
  synthesize from adopted material only. If glue text of your own is
  unavoidable in the final synthesis, mark it `chair_addition` in the ledger.
- **Anonymity during deliberation.** Seats are `seat-A`, `seat-B`, … in all
  cross-seat material. Never reveal the seat→model mapping to any seat until
  the final report. Strip `identity` fields before relaying proposals.
- **Decision-time recording.** Append to the ledger at the moment a proposal,
  verdict, or resolution is produced, and dual-write the same event to the
  store in the same step. Never reconstruct rationale afterwards — post-hoc
  reconstruction fabricates reasons.
- **Requested is not proof (verified identity).** Orca may silently drop
  `--model`/`--effort` it cannot map, and never reports what it applied. Every
  seat self-reports its identity in phase 1. Verification is **per-field**:
  - `agent` and `model` must match what you requested (normalize obvious id
    variants, e.g. requested `fable` vs reported `claude-fable-5`). Both match
    → `verified: true`. Either mismatches or is missing → `verified: false`.
  - `verified: "self"` is the tabs-mode value: the seat self-reported an
    identity but you requested nothing to compare it against, so there is
    nothing to verify against. It is not a failure.
  - `effort` is recorded but **never gates verification** — CLIs generally
    cannot introspect it (both claude seats in the dogfood reported `unknown`).
    Note it in `verification_note`. Only the upstream L1 fix (#10846: runtime
    returns applied options) can close this gap.
- **Counted seats (normative).** A seat is **counted** if `verified` is `true`
  or `"self"`. Counted seats form the denominator for every majority and the
  set whose challenges block convergence. `verified: false` seats still
  deliberate and their rationale is still recorded, but they do not count.
  `unanimous` is a stronger claim: only `verified: true` seats may support it —
  never assert `unanimous` on the strength of a `"self"` seat.
- **Timeout is a checkpoint, not a death.** A `check --wait` timeout or
  `{count:0}` means keep waiting; only a genuinely exited terminal, an
  explicit failure, or the user stopping you ends a seat's turn.
- **Files are truth, messages are signals.** Structured data moves only via
  files (`moa/out/*.json` in seat worktrees + `--report-path`); never parse
  terminal scrollback, and when a completion message and a report file
  disagree about whether work finished, trust the file (see **Rejected
  completion recovery**).
- **Windows/PowerShell**: quote group addresses (`--to "@all"`); prefer typed
  flags (`--task-id`, `--report-path`) over raw `--payload` JSON. Ledger
  entries always travel as `--entries-file <path>`, never as inline JSON.

## File Layout

- Coordinator worktree: `moa/<slug>/ledger.json` (append per phase) and
  `moa/<slug>/report.md` (final). `<slug>` = short kebab-case of the problem.
- Store payloads the coordinator writes before each `moa-log`:
  `moa/<slug>/store/<phase>.json` (e.g. `roster.json`, `proposals.json`,
  `round-2.json`, `resolution.json`, `close.json`).
- Each seat writes structured output inside **its own worktree** at
  `moa/out/proposal.json`, `moa/out/round-<r>.json`, `moa/out/rebuttal-<r>.json`
  and reports the absolute path via `worker_done --report-path`.
- Inbound packets go to each seat as **files** at `moa/in/round-<r>-packet.json`
  in that seat's worktree — never inline a multi-KB packet into a CLI argument.

## Store dual-write (the ledger of record)

`moa/<slug>/ledger.json` stays authoritative — it is what you read on resume and
what the report is built from. The orchestration ledger store is the durable
second copy: it lives in the runtime DB, survives the coordinator's death, and is
what the eventual Ledger UI reads.

Open the deliberation in phase 0 (there is no separate create verb — the first
`moa-log` creates it) and append at every decision point. Always write the JSON
file first, then point the CLI at it:

```bash
orca orchestration moa-log --deliberation <slug> --entries-file moa/<slug>/store/<phase>.json --json
```

`--deliberation <slug>` is a name unique **within your Run**, not a global id.
Pass `--seat-count N` on the roster call and `--task <id>` if the deliberation
belongs to one task; both are fill-once — declaring a *different* value later is
rejected as header drift, while re-declaring the same value is fine.

Each `--entries-file` holds a JSON array of entries. Mapping from ledger.json:

| ledger.json | store entry |
|---|---|
| proposal `p-X` | `kind=proposal, round=1, seat=seat-X, rationale=<idea>, payload={key_points, confidence, report}` |
| round r verdict from A on B | `kind=verdict, round=r, seat=seat-A, subjectEntryId=<store id of p-B>, verdict, rationale, payload={merge_with, base}` |
| rankings / concessions (per seat) | `kind=note, round=r, seat, payload={type:"ranking", ranking, concede_own, derived_concession}` |
| resolution `adopted` / each `rejected[]` | `kind=outcome, verdict=adopted\|rejected, subjectEntryId, rationale, payload={votes, unanimous, sources}` |
| end of the deliberation | `kind=close, payload={resolution_forced_by, dissent, chair_additions, convergence}` |

Entry-file shape (`payload` is a JSON **string**, and `authoredAt` is optional —
omitted entries are stamped with the current UTC time):

```json
[
  { "kind": "proposal", "round": 1, "seat": "seat-A",
    "rationale": "<the idea headline>",
    "payload": "{\"key_points\":[\"…\"],\"confidence\":\"high\",\"report\":\"<abs path>\"}" }
]
```

**Record the returned ids.** `moa-log --json` echoes
`entries: [{ id, inserted }, …]` in your input order, plus
`deliberation: { id, slug }`. Write the proposal ids into ledger.json as
`store_entry_id` on each proposal, and each later call's ids into the round's or
resolution's `store` block — that is how a round-r verdict resolves
`subjectEntryId` to `p-B` without re-reading `moa-show`. Store the deliberation
id at the ledger's top level as `store.deliberation`.

Entries are append-only and **content-addressed**: re-sending an identical entry
is an ignored duplicate (`inserted: false`), never a second row. A retried
`moa-log` after a dropped connection is therefore safe.

**Degrade gracefully.** If the CLI reports `moa-log` as an unknown command (an
older Orca without the verbs), record `protocol_note: "store unavailable: <error>"`
**once** at the top level and continue file-only for the rest of the run. The same
applies to any other store failure: record it and keep going. A store problem
never stops the consortium and never blocks a phase.

## Tab seats mode (`tabs:`)

When the request names existing Orca tabs — `/moa tabs:"Fably","Grokkie","Solly" <문제>`
(quotes optional, comma-separated) — the seats are those **live tab sessions**
instead of fresh worktree workers. The user watches the debate happen in their
own tabs.

Differences from the default protocol (everything else is unchanged):

1. **Resolve tabs → handles**: `orca terminal list --json` (add
   `--include-visual-layouts` only if titles are missing). When the request
   carries `tab-ids:"<id>",…` (Orca's tab-bar "Debate with MoA" action emits
   `/moa tabs:"A","B" tab-ids:"<tabId>","<tabId>" <problem>`, same order as
   `tabs:`), match each entry exactly against the `tabId` field first — that is
   authoritative. Otherwise match each requested name against terminal titles
   case-insensitively after stripping leading agent glyphs (◐ ◑ ● ○ ✦ …) and
   whitespace from both sides. A name matching zero or multiple terminals → ask
   the user to disambiguate before convening. Record in the ledger: seat label,
   tab title, terminal handle, worktree id.
2. **No worktree creation**: Phase 0 skips `--worktree new-child`. Per seat:
   `task-create` then `worker-start --task <id> --worktree "id:<that tab's worktree id>"
   --terminal <handle> --json` (the reattach path — `--worktree` explicit or it
   fails `terminal_worktree_mismatch`). Fallback: `dispatch --task <id> --to
   <handle> --inject`.
3. **Identity**: the tab already runs whatever agent the user launched — there
   is no `--model` request to verify against. Ask each seat to self-report in
   phase 1 as usual, record `requested: {agent: "<tab name>"}` plus the
   self-report, and set **`verified: "self"`** — the seat is counted, but it can
   never carry an `unanimous` claim. Family diversity notes still apply.
4. **Shared-worktree caution**: tabs may share one worktree. That is fine for
   `decision` problems (read-only); for `code` problems warn the user that
   same-worktree seats will collide on files and suggest default mode instead.
5. **Seat files**: seats in the same worktree must write to seat-scoped paths —
   `moa/out/<seat-label>/proposal.json` — so they cannot overwrite each other.
   The packet file is likewise written once per worktree, not per seat.
6. **Cleanup**: never release or close tab terminals — they are the user's
   sessions. Only the dispatches settle; tabs stay open.

## Protocol

### Phase 0 — Convene

```bash
orca orchestration run-create --objective "MoA: <slug>" --json
# per seat:
orca orchestration task-create --spec "<phase-1 spec, template below>" --task-title "moa-<slug>-seat-a-proposal" --json
orca orchestration worker-start --task <taskId> --worktree new-child --name moa-<slug>-seat-a \
  --agent <agent> [--model <id> --effort <level>] [--setup skip] --json
```

- `--setup skip` for `decision` problems (seats only read); default setup for
  `code` problems (they need the toolchain).
- The `worker-start` result may omit the handle fields; recover everything from
  `dispatch-show --task <taskId>`: dispatch id (`ctx_…`), `assignee_handle`
  (`term_…`), and the seat worktree path inside `process_incarnation`.
- Record per seat in the ledger: seat label, requested agent/model/effort,
  worktree id and path, task id, dispatch id, terminal handle,
  `verified: null`, `status: active`. One handle per seat; on
  `terminal_handle_stale` re-acquire via `orca terminal list --worktree … --json`
  and continue with the replacement only.
- A failed `worker-start` → record `"status": "seat_failed"` with the error,
  continue if ≥ 2 seats remain, otherwise abort and tell the user.
- If seat families overlap (e.g. two claude seats), record a `family_note` in
  the ledger: agreement between same-family seats is correlated evidence.

**Open the deliberation in the store.** Once the roster is known, write
`moa/<slug>/store/roster.json` — one `note` entry per seat — and log it. This is
what creates the deliberation:

```json
[
  { "kind": "note", "round": 1, "seat": "seat-A",
    "rationale": "roster",
    "payload": "{\"type\":\"roster\",\"seats\":[{\"seat\":\"seat-A\",\"requested\":{\"agent\":\"claude\",\"model\":\"opus\"},\"worktree\":\"…\"}]}" }
]
```

```bash
orca orchestration moa-log --deliberation <slug> --seat-count <N> --entries-file moa/<slug>/store/roster.json --json
```

Record the returned `deliberation.id` in ledger.json under `store.deliberation`.

### Phase 1 — Independent proposals (blind)

Seats work in separate worktrees and must not see each other. Phase-1 spec
template (fill `<>`; keep the JSON contract verbatim):

```text
You are one anonymous seat in a Mixture-of-Agents consortium. Work alone; do
not attempt to discover or contact other seats.

PROBLEM
<problem statement, verbatim>
<for code problems add: implement your solution in this worktree; for decision
problems add: you may inspect the codebase read-only; do NOT modify source files>

DELIVERABLE
Write moa/out/proposal.json in this worktree (create dirs) with exactly:
{
  "identity": { "agent": "<the CLI you are actually running in>",
                "model": "<the model id you are actually running as, from your
                           own runtime knowledge (e.g. /status, startup banner);
                           'unknown' if you cannot tell>",
                "effort": "<active reasoning effort or 'unknown'>" },
  "idea": "<one-sentence headline of your approach>",
  "proposal": "<full solution: design, code sketch or diff summary, tradeoffs>",
  "confidence": "<low|medium|high>",
  "assumptions": ["<assumption>", ...]
}
Then report completion exactly as your orchestration preamble instructs:
worker_done with --outcome succeeded and --report-path <absolute path to
moa/out/proposal.json>.
```

Collect:

```bash
orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 540000 --json
orca orchestration check --ack <deliveryId> --wait --types worker_done,escalation,question --timeout-ms 540000 --json
```

- Answer `question` messages via `orca orchestration reply --id <msgId> --body …`;
  process and ack every batch; heartbeats in a batch are progress signals, not
  actions. Repeat until every live seat reported.
- On each `worker_done`: read the report file, apply per-field verification,
  and append the proposal to the ledger **with the seat label, not the model**,
  including an `id` (`p-A`, `p-B`, …), the idea, distilled `key_points`, and
  the report path.
- Once all proposals are in, dual-write them: `moa/<slug>/store/proposals.json`
  (one `proposal` entry per seat, in seat order) → `moa-log`. Write each
  returned entry id back into ledger.json as that proposal's `store_entry_id`;
  every later `subjectEntryId` comes from here.
- **Do not `worker-release` any seat between phases.**

### Phase 2 — Deliberation rounds (react protocol)

Build the anonymized packet — every proposal labeled by seat, `identity`
stripped — and write it to `moa/in/round-<r>-packet.json` in **each seat's
worktree**. Then per seat:

```bash
orca orchestration task-create --spec "<round spec>" --task-title "moa-<slug>-seat-a-round-<r>" --json
orca orchestration worker-start --task <roundTaskId> --worktree "id:<seat worktree id>" --terminal <seat handle> --json
# fallback if --terminal is rejected by an older CLI:
orca orchestration dispatch --task <roundTaskId> --to <seat handle> --inject --json
```

- `--worktree` must name the **seat's** worktree explicitly: with `--terminal`
  alone it defaults to `current` (the coordinator's) and fails with
  `terminal_worktree_mismatch`.

Round spec (personalize only the seat's own label):

```text
MoA deliberation, round <r>. You are seat-<X> in the consortium. The anonymized
proposals of all seats (including your own) are in moa/in/round-<r>-packet.json
in this worktree. Read it first. You may re-inspect the codebase read-only to
verify factual claims other seats make; do NOT modify source files.

For EACH other seat's proposal give a verdict:
  "support"   - adopt as-is (1-2 sentences why)
  "challenge" - flawed; give the concrete failure scenario
  "merge"     - good in part; say which part, what to combine it with, and
                which proposal the combination is BUILT ON ("base")
Also rank ALL proposals (including your own) best-first. Ranking any other
proposal above your own MEANS you concede your own as the base; set
"concede_own" accordingly and consistently with your ranking.

Write moa/out/round-<r>.json in this worktree with exactly:
{ "verdicts": [ { "target": "seat-X", "verdict": "support|challenge|merge",
                  "rationale": "...", "merge_with": ["seat-Y"],
                  "base": "seat-X" } ],
  "ranking": ["seat-?", ...],
  "concede_own": true|false }
"base" is REQUIRED on every "merge" verdict and names the proposal the merged
result is built on (it may be the target, one of merge_with, or your own).
Omit "base" on "support" and "challenge".
Then report completion as your preamble instructs: worker_done with
--outcome succeeded and --report-path <absolute path to moa/out/round-<r>.json>.
```

Collect exactly as in phase 1. Record every verdict in the ledger at ingest
(`full` mode: verbatim; `summary`: verdict + first sentence of rationale),
plus per-seat rankings and concessions. Then dual-write the round:
`moa/<slug>/store/round-<r>.json` holds the `verdict` entries (each with
`subjectEntryId` = the target proposal's `store_entry_id`) followed by one
`note` ranking entry per seat → `moa-log`. Record the returned ids in the
round's `store` block.

**Concede semantics (normative)**: `concede_own` is self-reported, but the
**derived** value governs tallying: a seat that ranks another proposal
strictly above its own has conceded its proposal as base, regardless of the
flag. Record both; on a discrepancy add a `protocol_note` and use the derived
value.

**Convergence (normative)**: the debate has converged iff **both** hold over the
counted seats:

- **(a) no challenges** — zero `challenge` verdicts cast by counted seats, and
- **(b) a majority base** — one proposal is named as base by a strict majority
  of counted seats. A seat names a proposal as base when it casts `support` on
  it, or casts a `merge` whose `base` is that proposal.

Zero challenges but no majority base is *not* convergence — it is a scattered
field, and it goes to the rebuttal/consolidation round like any other
non-converged state. Hitting the round cap → you decide as chair and the ledger
records `"resolution_forced_by": "round_cap"`.

**Rebuttal / consolidation round.** Scope it to what is unresolved: challenged
proposals get defended, and a scattered field gets consolidated. Dispatch it
exactly like a normal round (new `task-create` + `worker-start --terminal`), with
this spec:

```text
MoA rebuttal, round <r>. You are seat-<X>. Read moa/in/round-<r>-packet.json in
this worktree: it lists the challenges raised against each proposal and the
current base tally.

If YOUR proposal was challenged, answer every challenge against it.
If YOU challenged another proposal, revisit each of your challenges after
reading its defence.

Write moa/out/rebuttal-<r>.json in this worktree with exactly:
{ "defence": { "action": "defend|amend|concede",
               "amended_proposal": "<full text if action is amend, else \"\">",
               "rationale": "..." },
  "challenges": [ { "target": "seat-Y", "action": "confirm|withdraw",
                    "rationale": "..." } ],
  "ranking": ["seat-?", ...],
  "concede_own": true|false }
Include "defence" only if your own proposal was challenged; otherwise omit it.
Include one "challenges" item per challenge you cast in the previous round.
Then report completion as your preamble instructs: worker_done with
--outcome succeeded and --report-path <absolute path to moa/out/rebuttal-<r>.json>.
```

Ingest a rebuttal like a round: a `withdraw` retires that challenge, a `confirm`
keeps it, an `amend` replaces the proposal text (record the amendment, never
overwrite the original), a `concede` removes that proposal from base contention.
Then re-evaluate convergence with the same two-part rule.

**Re-surfacing rule**: if a round-r proposal substantially restates an
already-rejected one, do not silently dedupe. Link it to the original
rejection entry (`"resurfaces": "<proposal id>"`) and require an explicit
re-examination verdict — the earlier rejection rationale may no longer hold.

### Rejected completion recovery (observed with grok seats)

Some agents' completion signals are rejected after a `--terminal` reattach:
the message arrives with a "Rejected worker_done" subject (pane-identity
mismatch), the round task lands `failed`, and the seat may re-send the same
`worker_done` repeatedly. Procedure:

1. The report file is the deliverable — if it exists and parses, **ingest it
   normally**; the rejection affects tracking, not content.
2. Recover the task record: `orca orchestration task-update --id <taskId>
   --status completed --result '{"note":"coordinator recovery: <what happened>"}' --json`.
3. Ack duplicate re-sends as they arrive; do not reply to them.
4. Record the incident in the ledger (`protocol_note`) — it is evidence for
   the upstream primitive.

### Phase 3 — Synthesis (chair)

Tally over **counted** seats (`verified: true` or `"self"`).

- **Degenerate roster**: if fewer than 2 counted seats remain when you reach
  this phase, there is no consortium left to tally. Decide as chair from the
  recorded material, record `"resolution_forced_by": "insufficient_verified"`
  with the reasoning, and say so plainly in the report — a single-seat
  "consensus" must never be presented as one.
- **Base selection**: the proposal named as base by a strict majority of counted
  seats — `support` on it, or a `merge` whose `base` names it (**merge-as-base
  means `base === target`**). Aggregate rankings (Borda-style: first place =
  N−1 points, and so on) as the tie-break input. On a residual tie, you cast the
  deciding vote from the recorded rationales — record
  `"resolution_forced_by": "tie"` and your reasoning.
- **Merges**: fold in the parts other proposals were credited for in `merge`
  verdicts, each with its source proposal id.
- **Component rejections**: when only part of a proposal was rejected, record
  it as its own rejected item with a compound id (`"p-B:messages-as-WAL"`) —
  votes and rationale attach to the component, not the whole proposal.
- Write the final solution using only adopted material; mark unavoidable glue
  as `chair_addition`.
- Append the resolution to the ledger: adopted `{sources, type: single|merge,
  base, rationale}`, every rejected item `{proposal, votes per seat,
  rationale, unanimous (verified: true seats only)}`, and `dissent` for any
  seat whose ranking disagreed with the outcome — dissent is first-class, not
  noise.
- Dual-write it: `moa/<slug>/store/resolution.json` (one `outcome` entry for the
  adoption plus one per rejected item, each `subjectEntryId` pointing at the
  proposal's `store_entry_id`) → `moa-log`, and record the ids under
  `resolution.store`.

### Phase 4 — Report and cleanup

**Close and reconcile the store first**, so the report can state the truth about
the record:

1. Write `moa/<slug>/store/close.json` — a single `close` entry whose payload
   carries `resolution_forced_by`, `dissent`, `chair_additions`, `convergence` —
   and `moa-log` it.
2. `orca orchestration moa-show --deliberation <slug> --json` and reconcile
   against ledger.json: one store entry per proposal, per verdict, per ranking
   note, per adopted/rejected outcome, plus the close. Any mismatch (count,
   missing entry, unexpected extra) goes into the ledger as a `protocol_note`
   naming both numbers — do not quietly "fix" either side.
3. `node <skill dir>/validate-ledger.mjs moa/<slug>/ledger.json`. **If it exits
   non-zero, stop and fix the ledger** before writing the report; a ledger that
   fails its own schema is not a record.

Write `moa/<slug>/report.md` with this structure (normative):

1. Header: run id, **store deliberation id**, date, seat count, rounds to
   convergence.
2. Problem (verbatim).
3. **Adopted solution** — the synthesized answer, with source attribution
   (base + merged parts) inline.
4. **Consortium record**: roster table (seat | requested → verified identity |
   counted? | blind idea), family note; adopted list; **rejected table** (idea |
   why | votes | unanimous); dissent; rankings & concessions; chair additions.
5. Protocol/tooling findings observed this run (feeds the upstream case),
   including any store reconciliation mismatch.
6. Roster requested-vs-verified summary.

Then:

- Show the user the solution and the report path.
- Release **every dispatch of every round**, not just phase 1 — each
  `worker-start` created its own: `orca orchestration worker-release
  --dispatch <id> --json` for each (recover forgotten ids via
  `dispatch-show --task <roundTaskId>`).
- **Keep seat worktrees.** For `code` problems they hold the candidate
  implementations — the adopted seat's worktree is the winner to merge from.
  Ask the user before removing losing worktrees.

## Code problems

When seats implement code (problem kind `code`):

- Phase-1 spec tells seats to implement in their worktree and summarize the
  diff in `proposal`; verdicts in phase 2 may cite actual diffs (the packet
  includes each proposal's diff summary; reviewers may read the other
  worktrees read-only if paths are provided).
- The adopted solution names a **winning worktree**; if the resolution merges
  parts from several seats, dispatch one final integration task to the winning
  seat's terminal with the adopted resolution as spec — integration is seat
  work, not chair work.
- Never merge/commit anything to the user's branches without their approval;
  the report states what is ready to merge and from where.

## Crash recovery / resume

The ledger is the recovery point. If the coordinator session dies mid-run, a
new session resumes with:

1. Read `moa/<slug>/ledger.json` — it holds run id, store deliberation id,
   per-seat task/dispatch/terminal ids, and the last recorded phase.
2. Rebind: `orca orchestration run-use --run <runId> --json`.
3. Reconcile: `task-list` for task statuses; `dispatch-show --task <id>` per
   in-flight task; `orca terminal list --worktree <seat worktree> --json` to
   re-acquire stale handles. Also `orca orchestration moa-show --deliberation
   <slug> --json` — if the store is ahead of ledger.json (the crash landed
   between the store write and the file write), the store entries tell you
   exactly which appends to replay into the file.
4. Read any `moa/out/*.json` newer than the ledger's last entries and ingest
   them (files are truth), then continue the protocol from the first
   incomplete phase. Never restart phase 1 for seats whose proposals are
   already in the ledger. Re-running a `moa-log` is safe: identical entries
   are ignored duplicates.

## Ledger

Schema reference: `ledger.schema.json` next to this file — it reflects the
dogfooded shape (per-seat task/dispatch/terminal, verification_note, key_points,
rounds with rankings/concessions, component rejections, dissent, protocol_note)
plus the v3 additions (`base` on merge verdicts, `store_entry_id`/`store`,
`verified: "self"`, `insufficient_verified`). Objects are closed
(`additionalProperties: false`), so a typo'd key is an error rather than silent
data loss.

Keep appending at decision time, and **validate before finishing**:

```bash
node <skill dir>/validate-ledger.mjs moa/<slug>/ledger.json
```

It is dependency-free (plain Node, no install) and prints one line per problem
with a JSON path. Exit 0 means the ledger is well-formed; anything else must be
fixed before the report is written.

Set `"protocol": "v3"` at the top of a ledger written under this version. The
validator enforces the v3-only rules (`base` required on every `merge` verdict)
only when that field says `v3`, so v2-era ledgers stay valid as historical
records rather than being retro-fitted with data their seats never reported.

## Failure Handling

- Seat launch fails → `seat_failed`, continue with ≥ 2 seats, else abort.
- Seat silent past 2 full wait cycles with no terminal activity → check
  `orca orchestration worker-show --dispatch <id> --json`; only a genuinely
  exited terminal is dead. Record `seat_failed`, continue.
- A dropped seat's phase-1 proposal stays in the debate (others still vote on
  it); it just cannot vote or defend.
- Attrition below 2 counted seats by phase 3 → `insufficient_verified` (above).
- Store call fails → one `protocol_note`, continue file-only. Never abort.
- Never call `orca orchestration reset` during a MoA run.

## Known limitations (by design of the MVP — the upstream primitive closes these)

- Coordinator context carries every proposal and verdict twice (ingest +
  relay): O(N²) growth; the packet-as-file rule mitigates, not solves.
- Convergence and tallying are coordinator judgment, not a state machine — the
  store records the decisions, it does not compute them.
- Identity verification tops out at self-report; `effort` is unverifiable.
- Seat attribution in the store is asserted by the sender, not authenticated:
  `sender_handle` in `moa-show --json` makes it auditable, but server-side
  seat↔dispatch binding is still upstream work.
- The store holds the record but no UI reads it yet; the full design (tables,
  `payload.moa` ingest, Ledger panel, federation) is in
  `moa/design/upstream-design.md`.

## Source of truth for this skill

The copy in the Orca clone — `<orca-clone>/.claude/skills/moa/` — is the source.
`~/.claude/skills/moa/` is a deployed copy; never edit it directly. After
changing SKILL.md, ledger.schema.json, or validate-ledger.mjs, sync with one
command:

```powershell
# Windows (PowerShell)
Copy-Item "<orca-clone>\.claude\skills\moa\*" "$env:USERPROFILE\.claude\skills\moa\" -Force
```

```bash
# macOS / Linux
cp <orca-clone>/.claude/skills/moa/* ~/.claude/skills/moa/
```
