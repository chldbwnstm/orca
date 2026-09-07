import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ORCHESTRATION_MOA_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'moa-log'],
    summary: 'Append entries to a MoA deliberation ledger',
    usage:
      'orca orchestration moa-log --deliberation <slug> (--kind <kind> [--round <n>] [--seat <label>] [--target <entry_id>] [--verdict <verdict>] [--rationale <text>] [--authored-at <iso>] | --entries-file <path>) [--task <task_id>] [--seat-count <n>] [--run <run_id>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'deliberation',
      'kind',
      'round',
      'seat',
      'target',
      'verdict',
      'rationale',
      'authored-at',
      'entries-file',
      'task',
      'seat-count',
      'run',
      'from',
      'retry-request'
    ],
    notes: [
      'A deliberation is named by a slug that is unique within your Run; two Runs may reuse the same slug.',
      'Entries are append-only and content-addressed: resending the same entry is an ignored duplicate, never a second row. Each entry id is echoed back so later verdicts can target it.',
      'Kinds: proposal, verdict, outcome, close, note. Verdicts: support, challenge, merge, adopted, rejected.',
      'Structured entry payloads travel via --entries-file only; there is no --payload flag, because shell-quoted JSON is what PowerShell mangles.',
      'Prefer --entries-file for batches too; one file carries the whole round.'
    ]
  },
  {
    path: ['orchestration', 'moa-show'],
    summary: 'Show MoA deliberations or one ledger',
    usage:
      'orca orchestration moa-show [--deliberation <slug>] [--round <n>] [--run <run_id>] [--from <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'deliberation', 'round', 'run', 'from'],
    notes: [
      '--run inspects a named Run without binding; otherwise deliberations are scoped to the caller.',
      'Entries are ordered (round, authored_at, id) — author order, not arrival order. An entry sent without --authored-at is stamped with the current UTC time.'
    ]
  }
]
