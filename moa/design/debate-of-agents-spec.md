# Debate of Agents (formerly LLM-Debate-War) — Product Spec (draft)

Status: concept settled through conversation (2026-08-25); not yet scaffolded. Public release only on the user's explicit instruction.

## One-liner

An on-demand, host-agnostic MCP server that convenes a multi-model debate over a feature or project decision and emits **one git-tracked markdown decision document** (`docs/debates/NNNN-slug.md`) — a multi-model-debated ADR — designed first and foremost to be **easy for a human or a smarter agent to supervise and grade**.

## Settled product decisions

1. **On-demand, not infrastructure.** Debating every feature is too costly; the tool is invoked only for decisions worth the cost. Cost controls: seat count, round cap, `quick` mode, and triage (below).
2. **Output is a repo file, not a database.** For repository-scoped decision docs, git-tracked `.md` is the right store (versioned, reviewable, searchable, readable by future agents). SQLite ledger is an optional sidecar. (The Orca consortium's "files rejected" verdict applied to *client-resident runtime state*; the context differs, so the conclusion flips — recorded deliberately.)
3. **Oversight is a first-class design goal** (user requirement, 2026-08-25): the document must let a human or a smarter agent supervise/grade each decision independently.

## Deliberation shape: breakdown-first

- **Phase 0 — Breakdown**: decompose the feature into discrete decision points D1…Dn (question, why it matters, option space). The breakdown itself is produced by one seat and verified by the others (cheap round).
- **Phase 1 — Triage per decision**: contested → full rounds; unanimous in round 1 → settle cheaply; requires human judgment → escalate as a question, never decide by proxy.
- **Phase 2 — Per-decision debates** (react protocol from the moa skill v2: support/challenge/merge, derived concessions, convergence = zero challenges, round cap → chair decision recorded as forced).

## Document contract (the product's core)

Top: **decision summary table** — one row per decision (result, vote split, confidence, review status) — the supervisor's 10-second view.

Each decision is an **independently gradable block**:

- Question + why it matters (1–2 lines)
- Option space with proposing seats
- **Debate summary in plain human language** — the scribe re-narrates; raw model output never appears in the top layer
- Decision (adopted, with merge sources) / rejected options (votes + reasons) / dissent (first-class)
- **Supervisor section (mandatory per decision):**
  - *Falsifiability*: "if this decision is wrong, here is how it shows up / how to test it"
  - *Invalidation conditions*: what change would reopen this decision
  - *Verdict checkboxes*: approve / reject (reason) / order re-debate — recorded in the same file; a rejection's reason becomes input to the next debate (human version of the re-surfacing rule)
- `<details>` collapsible: verbatim seat statements and verdicts — so a grader can also check the summary against its sources
- Decisions the models classify as **human-required** are emitted as structured questions, not proxy decisions

Machine layer: YAML frontmatter (or `.json` sidecar) mirroring the summary table so agent graders can parse per-decision status without reading prose.

## Architecture

- MCP server (TypeScript), stdio first; Streamable HTTP later.
- Latest-spec features: **tasks extension** (`io.modelcontextprotocol/tasks`) for long-running debates (poll `tasks/get`, feed input via `tasks/update`); **MRTR** for human tie-breaks/gates; `subscriptions/listen` later for live ledger. **Sampling is deprecated — do not use**; seats run via:
  - ① **CLI adapter** (default): spawn `claude -p` / `codex exec` / `grok` — subscription billing, no API keys, matches the dogfooded approach
  - ② **API adapter**: provider SDKs directly (per MCP deprecation guidance)
  - ③ **Orca adapter** (P3): `orca orchestration` CLI for worktree-isolated seats
- Protocol/ledger logic ported from our own moa skill v2 + moa-ledger store (our code; Orca is MIT — design reference only, no runtime fork: orchestration is coupled to terminals/panes/Electron).

### Orca harvest map (user decision 2026-08-25: reference orchestration heavily; MIT + attribution via per-file provenance comments and a NOTICE file; local clone is the reading reference)

- 🟢 **Port as-is**: `db/moa-ledger/` (our code + its 9 tests), `main/sqlite/sync-database.ts` (node:sqlite wrapper w/ statement cache), the `migrate.ts` user_version-transaction pattern, `generated-id.ts`/utc-timestamp.
- 🟡 **Port the pattern + its test scenarios, rewrite the code**: run/mailbox **FIFO delivery + ack** (crash-safe deliveries — the antidote to silent message loss), worker lifecycle state machine (`starting/ready/failed/stop_unknown/…`) with the `live/unverifiable/exited` no-synonyms verdict vocabulary, and the task→dispatch→worker_done collection loop as the debate→seat→collect skeleton.
- 🔴 **Do not take**: dispatch capabilities/pane identity (terminal-bound; child-process handles suffice), federation/relay, PTY/worker terminal resources (seats are headless `claude -p`/`codex exec` spawns), the RPC layer (MCP SDK provides transport).
- Risk split: plumbing (~40%) covered by the harvest; protocol/doc/scoring (~60%) is our novel area but already field-validated (skill v2 completed a live 3-seat consortium; the ledger design is what that consortium unanimously adopted).

## Agent scorecard layer (user requirement, 2026-08-25)

Grading exists to score **agents**, not just documents. Human verdicts on decisions convert into per-agent score events; scores accumulate per category and feed future seat selection.

- **Verdict → score mapping**: approving an adopted proposal credits its author (and supporters); rejecting it debits the author and **credits seats that challenged it**; "the rejected option B was actually better" strongly credits B's author and debits the majority that killed it; "everyone missed" debits all seats and flags the roster weak in that category. Retro-grading supported: verdicts can be recorded months later and scores update.
- **Two score tracks**: *authorship* (were your proposals right?) and *judgment* (were your votes on others' proposals right?). Judgment is tracked separately — a good juror is roster-worthy even with mediocre proposals (observed in the dogfood: fable conceded its own proposal but found the decisive flaw in opus's).
- **Categories auto-tagged at breakdown time** (each decision D1…Dn gets a category), so per-domain data accrues for free from per-decision grading.
- **Storage**: score events and aggregates live user-level (`~/.debate-of-agents/scores.db` — the SQLite sidecar's real home), spanning repos; the per-repo `.md` keeps only that debate's verdicts. Identity comes from the verified seat→model mapping; unverified seats' events are excluded (polluted data).
- **Selection loop**: `debate` consults aggregates to recommend/draft seats per category ("security: grok 9W-3L → include"), always shown with sample size.
- **Safety rails** (do not violate):
  1. Scores inform *selection only* — never vote weight; every seat keeps one equal vote (rich-get-richer kills the diversity the product exists for).
  2. Seat anonymity during debate matters *more* with scores: ratings exist only at selection time and grading time, never inside deliberation prompts.
  3. Always surface sample counts next to ratings; small-sample categories are labeled as such.

## Phases

- **P1**: stdio MCP server; tools `debate` / `debate_status` / `list_debates`; CLI seats; breakdown→triage→debate; md writer per the contract above.
- **P2**: tasks extension, MRTR human gates, frontmatter machine layer, quick mode tuning, **grade capture** (verdict checkboxes → score events).
- **P3**: Orca worktree adapter, `subscriptions/listen`, **scorecard aggregates + seat-draft recommendations**, optional MCP Apps UI.

## Carry-over invariants (from moa skill v2 / Orca dogfood — do not drop)

- Anonymous seats during debate; de-anonymize in the document.
- Per-field identity verification (agent+model gate; effort recorded only); unverified seats excluded from "unanimous".
- Decision-time recording; no post-hoc rationale reconstruction.
- Re-surfacing rule: a rejected idea returning later links to its original rejection and forces re-examination.
- Family-diversity note when seats share a model family (correlated votes).
