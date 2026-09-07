import { readFile } from 'node:fs/promises'
import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import { callOrchestrationMutation } from './mutation-request'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'

// MoA (Mixture of Agents) deliberation ledger verbs. Writes are typed flags or an
// entries file — never hand-quoted JSON on the command line, which PowerShell
// mangles. The runtime store owns kind/verdict validation.

type MoaEntryPayload = {
  round?: number
  kind: string
  seat?: string
  subjectEntryId?: string
  verdict?: string
  rationale?: string
  payload?: string
  authoredAt?: string
}

async function readEntriesFile(path: string): Promise<MoaEntryPayload[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    throw new RuntimeClientError('invalid_argument', `Could not read --entries-file: ${path}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new RuntimeClientError(
      'invalid_argument',
      `--entries-file must contain a JSON array of entries: ${path}`
    )
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--entries-file must contain a non-empty JSON array of entries.'
    )
  }
  return parsed as MoaEntryPayload[]
}

function singleEntryFromFlags(flags: Map<string, string | boolean>): MoaEntryPayload {
  const entry: MoaEntryPayload = {
    kind: getRequiredStringFlag(flags, 'kind')
  }
  const round = getOptionalPositiveIntegerFlag(flags, 'round')
  if (round !== undefined) {
    entry.round = round
  }
  const seat = getOptionalStringFlag(flags, 'seat')
  if (seat !== undefined) {
    entry.seat = seat
  }
  const target = getOptionalStringFlag(flags, 'target')
  if (target !== undefined) {
    entry.subjectEntryId = target
  }
  const verdict = getOptionalStringFlag(flags, 'verdict')
  if (verdict !== undefined) {
    entry.verdict = verdict
  }
  const rationale = getOptionalStringFlag(flags, 'rationale')
  if (rationale !== undefined) {
    entry.rationale = rationale
  }
  const authoredAt = getOptionalStringFlag(flags, 'authored-at')
  if (authoredAt !== undefined) {
    entry.authoredAt = authoredAt
  }
  return entry
}

// Why the list: with an entries file present, a stray single-entry flag would be silently ignored.
const SINGLE_ENTRY_FLAGS = [
  'kind',
  'round',
  'seat',
  'target',
  'verdict',
  'rationale',
  'authored-at'
] as const

export const ORCHESTRATION_MOA_HANDLERS: Record<string, CommandHandler> = {
  'orchestration moa-log': async ({ flags, client, cwd, json }) => {
    const entriesFile = getOptionalStringFlag(flags, 'entries-file')
    const strayFlag = SINGLE_ENTRY_FLAGS.find((flag) => flags.has(flag))
    if (entriesFile && strayFlag) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Pass either --entries-file or single-entry flags, not both (saw --${strayFlag}).`
      )
    }
    const entries = entriesFile ? await readEntriesFile(entriesFile) : [singleEntryFromFlags(flags)]
    const result = await callOrchestrationMutation<{
      deliberation: { id: string; slug: string; run_id: string }
      entries: { id: string; inserted: boolean }[]
      inserted: number
      duplicates: number
    }>(client, flags, 'orchestration.moaLog', {
      deliberation: getRequiredStringFlag(flags, 'deliberation'),
      task: getOptionalStringFlag(flags, 'task'),
      seatCount: getOptionalPositiveIntegerFlag(flags, 'seat-count'),
      entries,
      run: getOptionalStringFlag(flags, 'run'),
      from: await resolveCoordinatorTerminalHandle(flags, cwd, client)
    })
    printResult(result, json, (r) => {
      const recorded = `MoA ${r.deliberation.slug} (${r.deliberation.id}): ${r.inserted} entr${r.inserted === 1 ? 'y' : 'ies'} recorded`
      const header =
        r.duplicates === 0
          ? recorded
          : `${recorded} (${r.duplicates} duplicate${r.duplicates === 1 ? '' : 's'} ignored)`
      // Why echo every id: the caller needs them to target follow-up verdicts at a specific entry.
      const lines = r.entries.map((receipt, index) => {
        const source = entries[index]
        return `${receipt.id} ${receipt.inserted ? 'new' : 'duplicate'} ${source.kind}${source.seat ? ` ${source.seat}` : ''}`
      })
      return [header, ...lines].join('\n')
    })
  },

  'orchestration moa-show': async ({ flags, client, cwd, json }) => {
    const run = getOptionalStringFlag(flags, 'run')
    // Why: named runs remain inspectable without a pane; only implicit runs resolve identity.
    const from = run ? undefined : await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await client.call<{
      runId: string
      deliberation?: { id: string; slug: string; seat_count: number }
      entries?: {
        id: string
        round: number
        entry_kind: string
        seat_id: string | null
        verdict: string | null
        rationale: string | null
      }[]
      deliberations?: {
        id: string
        slug: string
        task_id: string | null
        seat_count: number
        created_at: string
      }[]
      count: number
    }>('orchestration.moaShow', {
      deliberation: getOptionalStringFlag(flags, 'deliberation'),
      round: getOptionalPositiveIntegerFlag(flags, 'round'),
      run,
      from
    })
    printResult(result, json, (r) => {
      if (r.entries && r.deliberation) {
        if (r.entries.length === 0) {
          return `MoA ${r.deliberation.slug} (${r.deliberation.id}): no entries.`
        }
        return r.entries
          .map(
            (e) =>
              `[r${e.round}] ${e.entry_kind}${e.seat_id ? ` ${e.seat_id}` : ''}` +
              `${e.verdict ? ` ${e.verdict}` : ''}${e.rationale ? ` — ${e.rationale}` : ''} (${e.id})`
          )
          .join('\n')
      }
      if (!r.deliberations || r.deliberations.length === 0) {
        return 'No MoA deliberations found.'
      }
      return r.deliberations
        .map(
          (d) =>
            `${d.slug} (${d.id}) seats=${d.seat_count}${d.task_id ? ` task=${d.task_id}` : ''} ${d.created_at}`
        )
        .join('\n')
    })
  }
}
