# MoA — Mixture of Agents for Orca

Let agents from different vendors, each running in its own Orca tab, debate one
problem and converge on an answer with a durable record of who proposed what,
who challenged it, and why the result won.

## Quick start on another machine (macOS / Linux / Windows)

```bash
git clone https://github.com/chldbwnstm/orca.git orca-moa
cd orca-moa
git checkout feat/moa-tab-consortium      # ledger + tab-bar UI + e2e, on top of upstream/main
corepack enable                            # Node 24 + pnpm 12 (package.json pins both)
pnpm install
sh moa/skill/install.sh                    # Windows: powershell -ExecutionPolicy Bypass -File moa/skill/install.ps1
pnpm dev                                   # opens a separate "Orca: feat/moa-tab-consortium" instance
```

Then, in that instance: Settings → Experimental → enable orchestration; add your
project; open one tab per agent (Claude, Codex, Grok, …); ⌘/Ctrl+click two or more
tabs; right-click → "Debate with N tabs (MoA)…"; type the problem; Start. A Claude
Code coordinator tab opens and runs `/moa tabs:… tab-ids:… <problem>`; the seats
deliberate in their own tabs and the coordinator writes `moa/<slug>/report.md`.

Without the fork build (plain Orca), the same debate runs by typing the `/moa tabs:"A","B" <problem>`
command in any Claude Code tab once the skill is installed — the ledger then stays file-only.

Branches: `feat/moa-deliberation-ledger` is the upstream PR candidate (DB ledger,
RPC, CLI verbs, e2e); `feat/moa-tab-consortium` stacks the fork-only UI on it.

| Path | What it is |
|---|---|
| `skill/moa/` | The `/moa` coordinator skill (SKILL.md v3, ledger schema, validator); `skill/install.*` copies it to `~/.claude/skills/moa` |
| `design/upstream-design.md` | Blueprint for the upstream primitive: adopted storage design, DDL, phased PR plan, open questions |
| `design/debate-of-agents-spec.md` | Spec of the companion MCP server (separate repo) that runs debates without Orca |
| `ledger-storage/ledger.json` | Machine ledger of consortium `run_20fc586727aa` (3 seats, converged in 1 round) |
| `ledger-storage/report.md` | Human-readable consortium report for the same run |
| `review/2026-09-05-project-review.md` | External-style project review: P0 typecheck + upstream v30 collision, P1 store/skill logic, fixes with reasons |
| `review/tasks/` | Task specs and reports of the fix cycle that followed the review |
| `review/pr/` | Draft issue and PR bodies for the upstream submission |

Strategy (settled): dogfood the skill → gather evidence → file the issue
(referencing #10846/#15119) right before PR 1. Do not open the issue earlier.

Seat worktrees from past runs live under `C:/Users/User/orca/workspaces/Orca MOA/`
(`moa-ledger-seat-a/b/c`) — kept until the user approves removal.
