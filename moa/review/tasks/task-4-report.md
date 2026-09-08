# Task 4 — Skill protocol v3: store dual-write, deliberation logic, schema hardening

Review items covered: P1-3, S-1 … S-7. No git commit — all three skill files are gitignored
(`.gitignore:144 /.claude/skills/`); `moa/` is untracked. `git status` shows only `?? .debate-war/`
and `?? moa/`.

## Result

All seven items implemented and verified. `SKILL.md` is at v3, `ledger.schema.json` is hardened and
closed, `validate-ledger.mjs` is new and dependency-free, the historical dogfood ledger is
normalized and passes, and all three files are byte-identical in `C:/Users/User/.claude/skills/moa/`.

## Files

| File | Before | After |
| --- | --- | --- |
| `.claude/skills/moa/SKILL.md` | 20,064 B (v2) | 32,055 B (v3) |
| `.claude/skills/moa/ledger.schema.json` | 6,986 B | 12,113 B |
| `.claude/skills/moa/validate-ledger.mjs` | — | 15,183 B (new) |
| `moa/ledger-storage/ledger.json` | 12,373 B | 13,881 B (normalized) |

I read the final CLI contract from `src/cli/specs/orchestration-moa-specs.ts`,
`src/cli/handlers/orchestration/moa-handlers.ts` and `src/main/runtime/rpc/methods/orchestration-moa.ts`
before writing any prompt text, so the skill's commands match what tasks 1–3 actually shipped:
slug-scoped `--deliberation`, `--entries-file` only (no `--payload`), echoed
`entries: [{id, inserted}]`, and `deliberation: {id, slug}`.

## Item-by-item

### P1-3 — dual-write to the orchestration ledger store

New **"Store dual-write (the ledger of record)"** section states the split plainly: `ledger.json`
stays authoritative (it is what resume reads and what the report is built from), the store is the
durable second copy. It carries the exact command form, the full ledger→store mapping table as
specified, a concrete entry-file example (with `payload` as a JSON *string*), and the
`--seat-count` / `--task` fill-once semantics from task 2.

Dual-write is wired into every phase, not just described:

- **Phase 0** writes `moa/<slug>/store/roster.json` (one `note` entry per seat,
  `payload={type:"roster",seats:[…]}`) and logs it with `--seat-count N` — this is what creates the
  deliberation, since there is no separate create verb. The returned `deliberation.id` goes into
  ledger.json at `store.deliberation`.
- **Phase 1** dual-writes `proposals.json` and writes each returned id back as `store_entry_id`.
- **Phase 2** dual-writes `round-<r>.json` (verdicts with `subjectEntryId` resolved from those
  `store_entry_id`s, then one ranking `note` per seat).
- **Phase 3** dual-writes `resolution.json` (adopted + one outcome per rejected item).
- **Phase 4** writes `close.json`, then reconciles.

Every payload is **written to a file first** and passed as `--entries-file`; the skill says so in
three places (File Layout, the Store section, Ground Rules).

**Phase 4 reconciliation** is now step 2 of that phase: run `moa-show --deliberation <slug> --json`,
compare per-category counts against ledger.json, and record any mismatch as a `protocol_note`
naming *both* numbers — explicitly "do not quietly 'fix' either side". The report header gains the
store deliberation id.

**Graceful degradation**: an unknown-command error records `protocol_note: "store unavailable:
<error>"` once at the top level and the run continues file-only; the same for any other store
failure. Stated twice (Store section + Failure Handling) so it cannot be missed.

I also used the store in **crash recovery**: if the coordinator died between the store write and the
file write, `moa-show` tells the resuming session exactly which appends to replay, and re-running a
`moa-log` is safe because entries are content-addressed.

### S-1 — convergence rule

Rewritten as a normative two-part test over counted seats: **(a)** zero `challenge` verdicts *and*
**(b)** one proposal named as base by a strict majority. A seat "names a proposal as base" by
casting `support` on it or a `merge` whose `base` is it. The text calls out the case the old rule
got wrong: "Zero challenges but no majority base is *not* convergence — it is a scattered field",
and it routes to the rebuttal/consolidation round with the round cap still applying.

### S-2 — `merge` verdicts carry `base`

The round-spec JSON contract now includes `"base": "seat-X"`, with an explicit instruction that it
is REQUIRED on every `merge`, names what the merged result is built on, may be the target / one of
`merge_with` / the seat's own, and is omitted on `support` and `challenge`. Phase 3 base selection
now reads "**merge-as-base means `base === target`**". Schema and validator match.

### S-3 — schema hardening + validator

`ledger.schema.json`: `additionalProperties: false` on seat, proposal, round, verdict, rebuttal,
defence, challenge, resolution, adopted, rejected-item and dissent objects. The `identity`
definition stays **open** so `effort` and future runtime fields survive. Added `base` (with the
seat pattern), `store_entry_id` on proposals/verdicts/adopted/rejected, `store` blocks at top level
/ round / resolution, `insufficient_verified` in `resolution_forced_by`, `verified: "self"`,
`base_tally`, `kind: deliberation|rebuttal`, `rebuttals[]`, `amended_in_round`, and a top-level
`protocol` enum.

`validate-ledger.mjs`: plain Node, no imports beyond `node:fs`/`node:process`, so it runs mid-run in
any worktree with no install step. It checks required keys, enums, closed objects, the
`^seat-[A-Z]$` pattern (on seat labels *and* on vote-map keys), types, and array/map shapes, and
prints one line per problem with a JSON path. Exit 0 = clean, 1 = problems, 2 = usage.
Phase 4 step 3 runs it and **stops to fix the ledger** on failure — this replaced the old "validate
with a JSON parse at minimum", which is gone from the file.

**Historical ledger normalization.** Before: 2 problems.

```
moa/ledger-storage/ledger.json: 2 problems
  $.debates[0].rounds[0].verdicts_seat_B: unexpected key (this object does not allow extra properties)
  $.debates[0].rounds[0].verdicts_seat_C: unexpected key (this object does not allow extra properties)
```

I merged the two stray arrays into the round's `verdicts` array ordered by casting seat (A, B, C;
stable within a seat) and deleted the stray keys. After: `ok (protocol v2, 3 seats)`. I verified the
merge was **lossless** by diffing against a backup: verdict count 6→6, identical multiset, and the
rest of the round, the top level, the proposals and the resolution all byte-equal as parsed JSON.

Example failure output on a deliberately broken copy (typo'd key, bad seat label, bad verdict enum,
dropped required key, bad `resolution_forced_by`):

```
ledger-broken.json: 5 problems
  $.seats[0].seat: expected a seat label matching /^seat-[A-Z]$/, got "seatA"
  $.debates[0].rounds[0].verdicts_seat_D: unexpected key (this object does not allow extra properties)
  $.debates[0].rounds[0].verdicts[0].verdict: expected one of 'support', 'challenge', 'merge', got "approve"
  $.debates[0].resolution.rejected[0]: missing required key 'unanimous'
  $.debates[0].resolution.resolution_forced_by: expected one of 'round_cap', 'seat_attrition', 'tie', 'insufficient_verified', null, got "vibes"
```

### S-4 — tabs mode counts

`verified: "self"` introduced and defined in Ground Rules as "self-reported with nothing requested
to compare against — not a failure". A new normative **Counted seats** bullet defines counted =
`true` or `"self"`, makes it the denominator for every majority and the set whose challenges block
convergence, and keeps `unanimous` restricted to `verified: true` ("never assert `unanimous` on the
strength of a `"self"` seat"). Tabs mode item 3 now sets `verified: "self"` instead of `null`.

Every v2 "verified seats only" site is updated: Ground Rules, Phase 2 convergence, Phase 3 tally
and base selection, and the resolution's `unanimous` field. `grep` for the old phrasing returns only
the changelog line that describes the change.

### S-5 — degenerate rosters

Phase 3 opens with a **Degenerate roster** bullet: fewer than 2 counted seats at Phase 3 → the chair
decides from recorded material and records `resolution_forced_by: "insufficient_verified"`, and the
report must say so plainly — "a single-seat 'consensus' must never be presented as one". Mirrored in
Failure Handling and in the schema enum.

### S-6 — rebuttal round template

Full spec template added inline in Phase 2, dispatched like a normal round. JSON contract:
`defence: {action: defend|amend|concede, amended_proposal, rationale}` for the challenged seat and
`challenges: [{target, action: confirm|withdraw, rationale}]` for challengers, plus `ranking` and
`concede_own` so convergence can be re-evaluated. File: `moa/out/rebuttal-<r>.json`. Ingest rules
are stated (a `withdraw` retires the challenge, an `amend` is recorded without overwriting the
original, a `concede` removes the proposal from base contention), and the schema has matching
`rebuttals[]` / `amended_in_round` fields.

### S-7 — single source of truth

Closing section: the Orca clone copy is the source, `~/.claude/skills/moa/` is a deployed copy that
must never be edited directly, with the exact PowerShell (`Copy-Item … -Force`) and POSIX (`cp`)
one-liners.

## Verification

| Check | Result |
| --- | --- |
| `node .claude/skills/moa/validate-ledger.mjs moa/ledger-storage/ledger.json` | **PASS** — `ok (protocol v2, 3 seats)` |
| Same, before normalization | fails with exactly the 2 stray-key problems (shown above) |
| Deliberately broken copy | **exit 1**, 5 problems (shown above) |
| v3 ledger missing `base` on merges | **exit 1**, 5 × `required on a 'merge' verdict under protocol v3` |
| Full v3-shaped ledger (protocol v3, `base`, `store`, `store_entry_id`, `verified:"self"`, `insufficient_verified`, `base_tally`, `kind`) | **PASS** — proves the v3 rules are satisfiable, not just strict |
| Non-JSON input / no argument | exit 1 with a parse message / exit 2 with usage |
| Normalization losslessness | verdict multiset identical; round remainder, top level, proposals and resolution all equal |
| SKILL.md consistency grep | no stale "verified seats only", no "(v2)", no "JSON parse at minimum" |
| `diff` project copy vs `C:/Users/User/.claude/skills/moa/` | **identical** for all three files |
| Deployed copy smoke test | `node C:/Users/User/.claude/skills/moa/validate-ledger.mjs …` → ok |

## Deviations from the plan

1. **`base` is required-on-merge only under `protocol: "v3"`.** The task asks both that `base` be
   required on `merge` verdicts *and* that the validator pass on the normalized historical ledger —
   but all five of that ledger's merge verdicts predate the field, and its seats never reported a
   base. Inventing one would be exactly the post-hoc reconstruction the skill forbids. I added a
   top-level `protocol` enum (absent = `v2`): v3 ledgers get the strict check, v2-era ledgers stay
   valid as historical records. SKILL.md tells the coordinator to set `"protocol": "v3"` and explains
   why the gate exists. Both requirements hold, and I verified the v3 gate fires (5 failures) and is
   satisfiable (full v3 ledger passes).
2. **The historical ledger was reformatted**, not only edited. Rewriting it through
   `json.dumps(indent=2)` expanded the hand-written compact one-line objects, so the diff is larger
   than the logical change (12,373 → 13,881 B). The parsed content is provably unchanged apart from
   the intended merge; a backup of the original is at
   `<scratchpad>/ledger-before.json` if the original formatting is wanted back.
3. **The validator is a hand-written checker, not a JSON Schema engine.** "Dependency-free" rules out
   `ajv`, and writing a general draft-07 evaluator would be far more code than the rules it needs to
   enforce. `ledger.schema.json` remains the readable specification; the validator enforces the
   subset that actually catches mistakes. This is stated in the file's header comment so the two are
   not mistaken for one artifact.
4. **A few schema fields were added beyond the listed set** — `base_tally`, `kind`, `rebuttals[]`,
   `amended_in_round`, `tab`, `protocol_note` at top level. Each exists because S-1/S-6/P1-3 tell the
   coordinator to record something the v2 schema had nowhere to put, and closed objects
   (`additionalProperties: false`) mean an unlisted field is now a hard error rather than a silent
   extra.
