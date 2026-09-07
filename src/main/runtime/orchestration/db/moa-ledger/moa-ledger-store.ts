import { createHash } from 'node:crypto'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

// ── MoA deliberation ledger ──
// Append-only audit rows for Mixture-of-Agents deliberations. Enums are
// validated here, not with SQL CHECKs (SQLite cannot ALTER a CHECK), and entry
// ids are content-addressed so INSERT OR IGNORE makes every ingest idempotent.
// A deliberation is addressed by a caller-chosen slug that is unique within a
// Run; its row id is a surrogate derived from (run_id, slug).
//
// Trust model: the home runtime trusts every participant in a Run, so `seat_id` is
// an attribution the sender asserts about itself, not one the runtime verified. It
// is auditable rather than authenticated — `message_id` names the message that
// carried the entry and `sender_handle` (joined from that message) names who sent
// it, so a disputed seat label can be traced back to a terminal. Server-side
// seat↔dispatch binding, which would make the label authoritative, is deferred to
// blueprint PR3.

export const MOA_ENTRY_KINDS = ['proposal', 'verdict', 'outcome', 'close', 'note'] as const
export type MoaEntryKind = (typeof MOA_ENTRY_KINDS)[number]

export const MOA_VERDICTS = ['support', 'challenge', 'merge', 'adopted', 'rejected'] as const
export type MoaVerdict = (typeof MOA_VERDICTS)[number]

export type MoaDeliberationRow = {
  id: string
  run_id: string
  slug: string
  task_id: string | null
  seat_count: number
  created_at: string
}

export type MoaLedgerEntryRow = {
  id: string
  deliberation_id: string
  round: number
  entry_kind: MoaEntryKind
  seat_id: string | null
  subject_entry_id: string | null
  verdict: MoaVerdict | null
  rationale: string | null
  payload: string
  message_id: string | null
  authored_at: string
  recorded_at: string
  recorded_seq: number
  /** Audit provenance: who sent the message that carried this entry; null when logged over RPC. */
  sender_handle: string | null
}

export type MoaEntryInput = {
  round?: number
  kind: string
  seat?: string
  subjectEntryId?: string
  verdict?: string
  rationale?: string
  payload?: string
  authoredAt?: string
}

export type MoaEntryReceipt = { id: string; inserted: boolean }

export function assertValidEntry(entry: MoaEntryInput): void {
  if (!(MOA_ENTRY_KINDS as readonly string[]).includes(entry.kind)) {
    throw new OrchestrationError(
      'invalid_argument',
      `Invalid MoA entry kind '${entry.kind}'; expected one of ${MOA_ENTRY_KINDS.join(', ')}.`
    )
  }
  if (entry.verdict !== undefined && !(MOA_VERDICTS as readonly string[]).includes(entry.verdict)) {
    throw new OrchestrationError(
      'invalid_argument',
      `Invalid MoA verdict '${entry.verdict}'; expected one of ${MOA_VERDICTS.join(', ')}.`
    )
  }
  if (entry.payload !== undefined) {
    try {
      JSON.parse(entry.payload)
    } catch {
      throw new OrchestrationError('invalid_argument', 'MoA entry payload must be valid JSON.')
    }
  }
  if (entry.round !== undefined && (!Number.isInteger(entry.round) || entry.round < 1)) {
    throw new OrchestrationError('invalid_argument', 'MoA entry round must be a positive integer.')
  }
  if (entry.authoredAt !== undefined && Number.isNaN(Date.parse(entry.authoredAt))) {
    throw new OrchestrationError(
      'invalid_argument',
      `MoA entry authoredAt '${entry.authoredAt}' is not a parseable date.`
    )
  }
}

// Why normalize: display order is a lexicographic sort on authored_at, so a '+09:00' offset would
// sort as if it were UTC. One canonical UTC ISO shape keeps the sort chronological.
function normalizeAuthoredAt(authoredAt: string | undefined): string {
  return authoredAt === undefined ? new Date().toISOString() : new Date(authoredAt).toISOString()
}

// Why content-addressed: re-sent messages and replayed relays re-derive the same id, so
// duplicates die on INSERT OR IGNORE instead of needing dedup queries.
// Why the raw authoredAt and not the normalized one: an entry sent without a timestamp gets a
// fresh default every attempt, so hashing the default would turn each resend into a new row.
function moaEntryId(deliberationId: string, entry: MoaEntryInput): string {
  const canonical = JSON.stringify([
    deliberationId,
    entry.round ?? 1,
    entry.kind,
    entry.seat ?? null,
    entry.subjectEntryId ?? null,
    entry.verdict ?? null,
    entry.rationale ?? null,
    entry.payload ?? '{}',
    entry.authoredAt ?? null
  ])
  return `moae_${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`
}

// Why a surrogate key: slugs are caller-chosen ('round-1', 'ledger-storage') and two Runs may
// legitimately pick the same one, so the Run is folded into the id rather than policed after insert.
export function moaDeliberationId(runId: string, slug: string): string {
  const canonical = JSON.stringify([runId, slug])
  return `moad_${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`
}

// Why fill in rather than reject: ingest can open the header before the coordinator's first
// moa-log (a seat's status message arrives first), leaving task_id NULL and seat_count 0. An
// unset field is "not yet declared", so the first declaration claims it; the guarded WHERE makes
// two racing declarations resolve to one winner, and the loser then reads as drift.
function fillUnsetHeaderFields(
  db: OrchestrationDb['db'],
  row: MoaDeliberationRow,
  input: { taskId?: string; seatCount?: number }
): MoaDeliberationRow {
  let filled = false
  if (input.taskId !== undefined && row.task_id === null) {
    db.prepare('UPDATE moa_deliberations SET task_id = ? WHERE id = ? AND task_id IS NULL').run(
      input.taskId,
      row.id
    )
    filled = true
  }
  if (input.seatCount !== undefined && row.seat_count === 0) {
    db.prepare('UPDATE moa_deliberations SET seat_count = ? WHERE id = ? AND seat_count = 0').run(
      input.seatCount,
      row.id
    )
    filled = true
  }
  return filled
    ? (db.prepare('SELECT * FROM moa_deliberations WHERE id = ?').get(row.id) as MoaDeliberationRow)
    : row
}

// Why reject rather than ignore: once declared, the header is immutable, so a differing
// re-declaration means the caller and the ledger disagree about what this deliberation is.
function assertNoHeaderDrift(
  row: MoaDeliberationRow,
  input: { taskId?: string; seatCount?: number }
): void {
  if (input.taskId !== undefined && row.task_id !== input.taskId) {
    throw new OrchestrationError(
      'invalid_argument',
      `MoA deliberation '${row.slug}' is already bound to task ${row.task_id ?? 'none'}; refusing to rebind it to ${input.taskId}.`
    )
  }
  if (input.seatCount !== undefined && row.seat_count !== input.seatCount) {
    throw new OrchestrationError(
      'invalid_argument',
      `MoA deliberation '${row.slug}' was opened with ${row.seat_count} seats; refusing to redeclare ${input.seatCount}.`
    )
  }
}

export function openMoaDeliberation(
  this: OrchestrationDb,
  input: { runId: string; slug: string; taskId?: string; seatCount?: number }
): MoaDeliberationRow {
  if (
    input.seatCount !== undefined &&
    (!Number.isInteger(input.seatCount) || input.seatCount < 0)
  ) {
    throw new OrchestrationError(
      'invalid_argument',
      'MoA deliberation seat count must be a non-negative integer.'
    )
  }
  this.requireRun(input.runId)
  const id = moaDeliberationId(input.runId, input.slug)
  this.db
    .prepare(
      'INSERT OR IGNORE INTO moa_deliberations (id, run_id, slug, task_id, seat_count) VALUES (?, ?, ?, ?, ?)'
    )
    .run(id, input.runId, input.slug, input.taskId ?? null, input.seatCount ?? 0)
  const row = this.db
    .prepare('SELECT * FROM moa_deliberations WHERE id = ?')
    .get(id) as MoaDeliberationRow
  const header = fillUnsetHeaderFields(this.db, row, input)
  assertNoHeaderDrift(header, input)
  return header
}

export function logMoaEntries(
  this: OrchestrationDb,
  input: {
    runId: string
    slug: string
    taskId?: string
    seatCount?: number
    entries: MoaEntryInput[]
    messageId?: string
  }
): {
  deliberation: MoaDeliberationRow
  entries: MoaEntryReceipt[]
  inserted: number
  duplicates: number
} {
  for (const entry of input.entries) {
    assertValidEntry(entry)
  }
  this.db.exec('SAVEPOINT moa_log_entries')
  try {
    const deliberation = this.openMoaDeliberation({
      runId: input.runId,
      slug: input.slug,
      taskId: input.taskId,
      seatCount: input.seatCount
    })
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO moa_ledger_entries (
        id, deliberation_id, round, entry_kind, seat_id, subject_entry_id,
        verdict, rationale, payload, message_id, authored_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const receipts: MoaEntryReceipt[] = []
    let inserted = 0
    for (const entry of input.entries) {
      const id = moaEntryId(deliberation.id, entry)
      const result = stmt.run(
        id,
        deliberation.id,
        entry.round ?? 1,
        entry.kind,
        entry.seat ?? null,
        entry.subjectEntryId ?? null,
        entry.verdict ?? null,
        entry.rationale ?? null,
        entry.payload ?? '{}',
        input.messageId ?? null,
        normalizeAuthoredAt(entry.authoredAt)
      )
      const changed = Number(result.changes) > 0
      receipts.push({ id, inserted: changed })
      inserted += changed ? 1 : 0
    }
    this.db.exec('RELEASE moa_log_entries')
    return {
      deliberation,
      entries: receipts,
      inserted,
      duplicates: input.entries.length - inserted
    }
  } catch (error) {
    this.db.exec('ROLLBACK TO moa_log_entries')
    this.db.exec('RELEASE moa_log_entries')
    throw error
  }
}

export function getMoaDeliberation(
  this: OrchestrationDb,
  filter: { runId: string; slug: string } | { id: string }
): MoaDeliberationRow | undefined {
  const id = 'id' in filter ? filter.id : moaDeliberationId(filter.runId, filter.slug)
  return this.db.prepare('SELECT * FROM moa_deliberations WHERE id = ?').get(id) as
    | MoaDeliberationRow
    | undefined
}

export function listMoaDeliberations(
  this: OrchestrationDb,
  filter: { runId: string }
): MoaDeliberationRow[] {
  return this.db
    .prepare('SELECT * FROM moa_deliberations WHERE run_id = ? ORDER BY created_at, slug')
    .all(filter.runId) as MoaDeliberationRow[]
}

// Why (round, authored_at, id) and not insertion order: federated entries land in
// relay-arrival order, so rowid would misreport who spoke first.
//
// Why recorded_seq is only a cursor: this table has a TEXT primary key, so its rowid is not an
// alias of the PK and VACUUM is free to renumber it. Orca never VACUUMs today; if it ever does,
// promote recorded_seq to a real column rather than letting a cursor silently shift.
//
// The LEFT JOIN is the audit half of the trust model: seat_id is asserted by the sender, and
// sender_handle is the terminal the runtime actually saw it arrive from (NULL over RPC).
const MOA_ENTRY_SELECT = `SELECT e.*, e.rowid AS recorded_seq, m.from_handle AS sender_handle
  FROM moa_ledger_entries e
  LEFT JOIN messages m ON m.id = e.message_id`

export function listMoaEntries(
  this: OrchestrationDb,
  filter: { deliberationId: string; round?: number }
): MoaLedgerEntryRow[] {
  if (filter.round !== undefined) {
    return this.db
      .prepare(
        `${MOA_ENTRY_SELECT}
         WHERE e.deliberation_id = ? AND e.round = ?
         ORDER BY e.round, e.authored_at, e.id`
      )
      .all(filter.deliberationId, filter.round) as MoaLedgerEntryRow[]
  }
  return this.db
    .prepare(
      `${MOA_ENTRY_SELECT}
       WHERE e.deliberation_id = ?
       ORDER BY e.round, e.authored_at, e.id`
    )
    .all(filter.deliberationId) as MoaLedgerEntryRow[]
}

export type MoaLedgerStoreMethods = {
  openMoaDeliberation: typeof openMoaDeliberation
  logMoaEntries: typeof logMoaEntries
  getMoaDeliberation: typeof getMoaDeliberation
  listMoaDeliberations: typeof listMoaDeliberations
  listMoaEntries: typeof listMoaEntries
}

export function attachMoaLedgerStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    openMoaDeliberation,
    logMoaEntries,
    getMoaDeliberation,
    listMoaDeliberations,
    listMoaEntries
  })
}
