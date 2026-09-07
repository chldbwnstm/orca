import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'

function createDbWithRun(): { db: OrchestrationDb; runId: string } {
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'MoA ledger test run',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: 'tab_coord:leaf_coord'
  })
  return { db, runId: run.id }
}

function entriesOf(db: OrchestrationDb, runId: string, slug: string) {
  const deliberation = db.getMoaDeliberation({ runId, slug })
  return deliberation ? db.listMoaEntries({ deliberationId: deliberation.id }) : []
}

describe('moa-ledger-store', () => {
  it('creates the deliberation implicitly and records entries append-only', () => {
    const { db, runId } = createDbWithRun()
    const result = db.logMoaEntries({
      runId,
      slug: 'ledger-storage',
      seatCount: 3,
      entries: [
        { kind: 'proposal', seat: 'seat-A', rationale: 'tables as store' },
        { kind: 'proposal', seat: 'seat-B', rationale: 'messages as WAL' }
      ]
    })
    expect(result.inserted).toBe(2)
    expect(result.duplicates).toBe(0)
    expect(result.deliberation.seat_count).toBe(3)
    expect(result.deliberation.slug).toBe('ledger-storage')
    expect(result.deliberation.id).toMatch(/^moad_[0-9a-f]{32}$/)

    const entries = entriesOf(db, runId, 'ledger-storage')
    expect(entries).toHaveLength(2)
    expect(entries.every((entry) => entry.id.startsWith('moae_'))).toBe(true)
  })

  it('returns one receipt per input entry, in input order, marking duplicates', () => {
    const { db, runId } = createDbWithRun()
    const entries = [
      { kind: 'proposal', seat: 'seat-A', authoredAt: '2026-08-25T09:00:00Z' },
      { kind: 'proposal', seat: 'seat-B', authoredAt: '2026-08-25T09:01:00Z' }
    ]
    const first = db.logMoaEntries({ runId, slug: 'd1', entries })
    expect(first.entries.map((receipt) => receipt.inserted)).toEqual([true, true])

    const replay = db.logMoaEntries({ runId, slug: 'd1', entries: [entries[1], entries[0]] })
    expect(replay.entries.map((receipt) => receipt.inserted)).toEqual([false, false])
    // Why compare ids: the receipts must line up with the caller's own input order, not row order.
    expect(replay.entries[0].id).toBe(first.entries[1].id)
    expect(replay.entries[1].id).toBe(first.entries[0].id)
  })

  it('ignores duplicate entries via content-addressed ids', () => {
    const { db, runId } = createDbWithRun()
    const entry = { kind: 'verdict', round: 2, seat: 'seat-A', verdict: 'support' as const }
    const first = db.logMoaEntries({ runId, slug: 'd1', entries: [entry] })
    const second = db.logMoaEntries({ runId, slug: 'd1', entries: [entry] })
    expect(first.inserted).toBe(1)
    expect(second.inserted).toBe(0)
    expect(second.duplicates).toBe(1)
    expect(entriesOf(db, runId, 'd1')).toHaveLength(1)
  })

  it('dedupes a resend of an entry that carries no authoredAt', () => {
    const { db, runId } = createDbWithRun()
    // Why this matters: the default timestamp differs between the two calls, so hashing the
    // defaulted value instead of the raw input would mint a second row for the same entry.
    const entry = { kind: 'note', seat: 'seat-A', rationale: 'no clock on this seat' }
    db.logMoaEntries({ runId, slug: 'd1', entries: [entry] })
    const replay = db.logMoaEntries({ runId, slug: 'd1', entries: [entry] })
    expect(replay.inserted).toBe(0)
    expect(replay.duplicates).toBe(1)
    expect(entriesOf(db, runId, 'd1')).toHaveLength(1)
  })

  it('rejects invalid kinds, verdicts, payloads, rounds, and timestamps in TypeScript, not SQL', () => {
    const { db, runId } = createDbWithRun()
    const base = { runId, slug: 'd1' }
    expect(() => db.logMoaEntries({ ...base, entries: [{ kind: 'vote' }] })).toThrow(
      /Invalid MoA entry kind/
    )
    expect(() =>
      db.logMoaEntries({ ...base, entries: [{ kind: 'verdict', verdict: 'approve' }] })
    ).toThrow(/Invalid MoA verdict/)
    expect(() =>
      db.logMoaEntries({ ...base, entries: [{ kind: 'note', payload: 'not json' }] })
    ).toThrow(/payload must be valid JSON/)
    expect(() => db.logMoaEntries({ ...base, entries: [{ kind: 'note', round: 0 }] })).toThrow(
      /positive integer/
    )
    expect(() =>
      db.logMoaEntries({ ...base, entries: [{ kind: 'note', authoredAt: 'yesterday' }] })
    ).toThrow(/not a parseable date/)
    expect(entriesOf(db, runId, 'd1')).toHaveLength(0)
  })

  it('orders entries by (round, authored_at, id), not arrival order', () => {
    const { db, runId } = createDbWithRun()
    db.logMoaEntries({
      runId,
      slug: 'd1',
      entries: [
        { kind: 'verdict', round: 2, seat: 'seat-B', authoredAt: '2026-08-25T10:05:00Z' },
        { kind: 'verdict', round: 2, seat: 'seat-A', authoredAt: '2026-08-25T10:01:00Z' },
        { kind: 'proposal', round: 1, seat: 'seat-C', authoredAt: '2026-08-25T09:00:00Z' }
      ]
    })
    const entries = entriesOf(db, runId, 'd1')
    expect(entries.map((entry) => [entry.round, entry.seat_id])).toEqual([
      [1, 'seat-C'],
      [2, 'seat-A'],
      [2, 'seat-B']
    ])
  })

  it('normalizes authored_at to UTC so offset timestamps sort chronologically', () => {
    const { db, runId } = createDbWithRun()
    db.logMoaEntries({
      runId,
      slug: 'd1',
      // Why these two: 19:00+09:00 is 10:00Z, i.e. BEFORE 10:30Z, but sorts after it as raw text.
      entries: [
        { kind: 'note', seat: 'seat-Z', authoredAt: '2026-08-25T10:30:00Z' },
        { kind: 'note', seat: 'seat-A', authoredAt: '2026-08-25T19:00:00+09:00' }
      ]
    })
    const entries = entriesOf(db, runId, 'd1')
    expect(entries.map((entry) => entry.seat_id)).toEqual(['seat-A', 'seat-Z'])
    expect(entries[0].authored_at).toBe('2026-08-25T10:00:00.000Z')
  })

  it('defaults a missing authored_at to now, so late entries sort after timestamped ones', () => {
    const { db, runId } = createDbWithRun()
    db.logMoaEntries({
      runId,
      slug: 'd1',
      entries: [
        { kind: 'proposal', seat: 'seat-A', authoredAt: '2026-08-25T09:00:00Z' },
        { kind: 'proposal', seat: 'seat-B', authoredAt: '2026-08-25T09:01:00Z' }
      ]
    })
    db.logMoaEntries({ runId, slug: 'd1', entries: [{ kind: 'note', seat: 'seat-C' }] })
    const entries = entriesOf(db, runId, 'd1')
    // Why last and not first: a NULL authored_at would sort ahead of every real timestamp.
    expect(entries.map((entry) => entry.seat_id)).toEqual(['seat-A', 'seat-B', 'seat-C'])
    expect(entries[2].authored_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('materializes payload.moa from status messages with message provenance', () => {
    const { db, runId } = createDbWithRun()
    const message = db.insertMessage({
      from: 'term_seat',
      to: `run:${runId}`,
      subject: 'proposal ready',
      runId,
      payload: JSON.stringify({
        moa: {
          deliberation: 'ledger-storage',
          seatCount: 3,
          entries: [{ kind: 'proposal', seat: 'seat-A', rationale: 'tables as store' }]
        }
      })
    })
    const entries = entriesOf(db, runId, 'ledger-storage')
    expect(entries).toHaveLength(1)
    expect(entries[0].message_id).toBe(message.id)
    expect(db.getMoaDeliberation({ runId, slug: 'ledger-storage' })?.seat_count).toBe(3)
  })

  it('never materializes from non-status types and never fails message delivery on bad payloads', () => {
    const { db, runId } = createDbWithRun()
    const moaPayload = JSON.stringify({
      moa: { deliberation: 'd1', entries: [{ kind: 'note' }] }
    })
    db.insertMessage({
      from: 'term_seat',
      to: `run:${runId}`,
      subject: 'done',
      type: 'heartbeat',
      runId,
      payload: moaPayload
    })
    expect(entriesOf(db, runId, 'd1')).toHaveLength(0)

    for (const payload of ['not json', JSON.stringify({ moa: { entries: 'nope' } })]) {
      const inserted = db.insertMessage({
        from: 'term_seat',
        to: `run:${runId}`,
        subject: 'malformed moa',
        runId,
        payload
      })
      expect(inserted.id).toBeTruthy()
    }
    // Why: one invalid entry rejects the whole batch quietly — partial batches would desync ledgers across hosts.
    db.insertMessage({
      from: 'term_seat',
      to: `run:${runId}`,
      subject: 'half valid',
      runId,
      payload: JSON.stringify({
        moa: { deliberation: 'd1', entries: [{ kind: 'note' }, { kind: 'vote' }] }
      })
    })
    expect(entriesOf(db, runId, 'd1')).toHaveLength(0)
  })

  it('lets the first declaration fill in a header that ingest opened with unset fields', () => {
    const { db, runId } = createDbWithRun()
    const task = db.createTask({ spec: 'deliberate', runId })
    // Why this order: a seat's status message routinely lands before the coordinator's first
    // moa-log, opening the header with task_id NULL and seat_count 0.
    db.insertMessage({
      from: 'term_seat',
      to: `run:${runId}`,
      subject: 'seat spoke first',
      runId,
      payload: JSON.stringify({ moa: { deliberation: 'd1', entries: [{ kind: 'proposal' }] } })
    })
    const opened = db.getMoaDeliberation({ runId, slug: 'd1' })
    expect([opened?.task_id, opened?.seat_count]).toEqual([null, 0])

    const filled = db.logMoaEntries({
      runId,
      slug: 'd1',
      taskId: task.id,
      seatCount: 3,
      entries: [{ kind: 'note', round: 2 }]
    })
    expect(filled.deliberation.task_id).toBe(task.id)
    expect(filled.deliberation.seat_count).toBe(3)
  })

  it('rejects a second, different declaration once the header has been filled in', () => {
    const { db, runId } = createDbWithRun()
    db.logMoaEntries({ runId, slug: 'd1', entries: [{ kind: 'note' }] })
    db.logMoaEntries({ runId, slug: 'd1', seatCount: 3, entries: [{ kind: 'note', round: 2 }] })
    expect(() =>
      db.logMoaEntries({ runId, slug: 'd1', seatCount: 5, entries: [{ kind: 'note', round: 3 }] })
    ).toThrow(/refusing to redeclare 5/)
  })

  it('rejects a seat_count or task_id that drifts from the opened header', () => {
    const { db, runId } = createDbWithRun()
    const task = db.createTask({ spec: 'deliberate', runId })
    db.logMoaEntries({
      runId,
      slug: 'd1',
      seatCount: 3,
      taskId: task.id,
      entries: [{ kind: 'note' }]
    })
    expect(() =>
      db.logMoaEntries({ runId, slug: 'd1', seatCount: 4, entries: [{ kind: 'note', round: 2 }] })
    ).toThrow(/refusing to redeclare 4/)
    expect(() =>
      db.logMoaEntries({
        runId,
        slug: 'd1',
        taskId: 'task_other',
        entries: [{ kind: 'note', round: 2 }]
      })
    ).toThrow(/refusing to rebind it to task_other/)
    // Why re-declaring the same values is fine: replayed sends carry the header every time.
    expect(() =>
      db.logMoaEntries({
        runId,
        slug: 'd1',
        seatCount: 3,
        taskId: task.id,
        entries: [{ kind: 'note', round: 2 }]
      })
    ).not.toThrow()
  })

  it('swallows header drift on the ingest path instead of failing message delivery', () => {
    const { db, runId } = createDbWithRun()
    db.logMoaEntries({ runId, slug: 'd1', seatCount: 3, entries: [{ kind: 'note' }] })
    const message = db.insertMessage({
      from: 'term_seat',
      to: `run:${runId}`,
      subject: 'drifting seat count',
      runId,
      payload: JSON.stringify({
        moa: { deliberation: 'd1', seatCount: 5, entries: [{ kind: 'note', round: 2 }] }
      })
    })
    expect(message.id).toBeTruthy()
    expect(entriesOf(db, runId, 'd1')).toHaveLength(1)
    expect(db.getMoaDeliberation({ runId, slug: 'd1' })?.seat_count).toBe(3)
  })

  it('rolls back ledger rows from an earlier message when a later one in the batch throws', () => {
    const { db, runId } = createDbWithRun()
    const moaPayload = JSON.stringify({
      moa: { deliberation: 'd1', entries: [{ kind: 'proposal', seat: 'seat-A' }] }
    })
    expect(() =>
      db.insertMessages([
        { from: 'term_seat', to: `run:${runId}`, subject: 'first', runId, payload: moaPayload },
        // Why this throws: requireRun rejects an unknown Run, aborting the batch after the first insert.
        { from: 'term_seat', to: 'run:run_missing', subject: 'second', runId: 'run_missing' }
      ])
    ).toThrow()
    expect(entriesOf(db, runId, 'd1')).toHaveLength(0)
    expect(db.getMoaDeliberation({ runId, slug: 'd1' })).toBeUndefined()
  })

  it('is cleared by resetTasks and resetAll but survives resetMessages', () => {
    const { db, runId } = createDbWithRun()
    const log = () =>
      db.logMoaEntries({
        runId,
        slug: 'd1',
        entries: [{ kind: 'note', rationale: 'kept?' }]
      })

    log()
    db.resetMessages()
    expect(entriesOf(db, runId, 'd1')).toHaveLength(1)

    db.resetTasks()
    expect(entriesOf(db, runId, 'd1')).toHaveLength(0)
    expect(db.getMoaDeliberation({ runId, slug: 'd1' })).toBeUndefined()

    log()
    db.resetAll()
    expect(db.getMoaDeliberation({ runId, slug: 'd1' })).toBeUndefined()
  })

  it('migrates a pre-v40 database in place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-moa-migrate-'))
    const dbPath = join(dir, 'orchestration.db')
    try {
      const before = new OrchestrationDb(dbPath)
      // Why: simulate a database last written by a v39 host — ledger tables absent, version behind.
      before.db.exec('DROP TABLE moa_ledger_entries; DROP TABLE moa_deliberations;')
      before.db.pragma('user_version = 39')
      before.close()

      const after = new OrchestrationDb(dbPath)
      expect(after.db.pragma('user_version', { simple: true })).toBe(40)
      // Why: the ledger migration must stack on upstream v30, not replace it.
      expect(after.hasColumn('dispatch_contexts', 'depth')).toBe(true)
      const run = after.createRun({
        objective: 'post-migration run',
        coordinatorHandle: 'term_m',
        coordinatorPaneKey: 'tab_m:leaf_m'
      })
      const result = after.logMoaEntries({
        runId: run.id,
        slug: 'migrated',
        entries: [{ kind: 'note', rationale: 'works after upgrade' }]
      })
      expect(result.inserted).toBe(1)
      after.close()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('rebuilds ledger tables that a withdrawn pre-release draft left behind', () => {
    const { db } = createDbWithRun()
    // Why: a dogfood DB may hold the withdrawn v30 draft shape — no slug, nullable authored_at.
    db.db.exec('DROP TABLE moa_ledger_entries; DROP TABLE moa_deliberations;')
    db.db.exec(
      `CREATE TABLE moa_deliberations (id TEXT PRIMARY KEY, run_id TEXT NOT NULL);
       CREATE TABLE moa_ledger_entries (id TEXT PRIMARY KEY, deliberation_id TEXT NOT NULL);`
    )
    db.db.pragma('user_version = 39')
    db.migrate()

    expect(db.db.pragma('user_version', { simple: true })).toBe(40)
    expect(db.hasColumn('moa_deliberations', 'slug')).toBe(true)
    const run = db.createRun({
      objective: 'post-rebuild run',
      coordinatorHandle: 'term_r',
      coordinatorPaneKey: 'tab_r:leaf_r'
    })
    expect(
      db.logMoaEntries({ runId: run.id, slug: 'rebuilt', entries: [{ kind: 'note' }] }).inserted
    ).toBe(1)
  })

  it('exposes the sending terminal alongside the seat label the sender asserted', () => {
    const { db, runId } = createDbWithRun()
    db.insertMessage({
      from: 'term_seat_a',
      to: `run:${runId}`,
      subject: 'proposal ready',
      runId,
      payload: JSON.stringify({
        moa: { deliberation: 'd1', entries: [{ kind: 'proposal', seat: 'seat-A' }] }
      })
    })
    db.logMoaEntries({ runId, slug: 'd1', entries: [{ kind: 'note', seat: 'seat-A', round: 2 }] })

    const entries = entriesOf(db, runId, 'd1')
    // Why both: seat-A is asserted by the sender, term_seat_a is what the runtime saw. An
    // RPC-logged entry has no carrier message, so its sender_handle is null.
    expect(entries.map((entry) => [entry.seat_id, entry.sender_handle])).toEqual([
      ['seat-A', 'term_seat_a'],
      ['seat-A', null]
    ])
  })

  it('reports why an ingest recorded nothing', () => {
    const { db, runId } = createDbWithRun()
    const ingest = (payload: string | undefined, type?: 'status' | 'heartbeat') =>
      db.ingestMoaMessagePayload(
        db.insertMessage({
          from: 'term_seat',
          to: `run:${runId}`,
          subject: 'probe',
          type,
          runId,
          payload
        })
      )

    expect(ingest(undefined)).toEqual({ inserted: 0, skipped: 'not_status' })
    expect(
      ingest(
        JSON.stringify({ moa: { deliberation: 'd1', entries: [{ kind: 'note' }] } }),
        'heartbeat'
      )
    ).toEqual({ inserted: 0, skipped: 'not_status' })
    expect(ingest('{"moa": not json')).toEqual({ inserted: 0, skipped: 'malformed' })
    expect(ingest(JSON.stringify({ moa: { entries: 'nope' } }))).toEqual({
      inserted: 0,
      skipped: 'malformed'
    })
    expect(
      ingest(JSON.stringify({ moa: { deliberation: 'd1', entries: [{ kind: 'vote' }] } }))
    ).toEqual({ inserted: 0, skipped: 'invalid_entry' })
    expect(ingest(JSON.stringify({ moa: { deliberation: 'd1', entries: [] } }))).toEqual({
      inserted: 0,
      skipped: 'invalid_entry'
    })
  })

  it('reports a rejection when the ledger refuses the write', () => {
    const { db, runId } = createDbWithRun()
    db.logMoaEntries({ runId, slug: 'd1', seatCount: 3, entries: [{ kind: 'note' }] })
    const drifting = db.insertMessage({
      from: 'term_seat',
      to: `run:${runId}`,
      subject: 'drifting seat count',
      runId,
      payload: JSON.stringify({
        moa: { deliberation: 'd1', seatCount: 5, entries: [{ kind: 'note', round: 2 }] }
      })
    })
    // Already ingested (and swallowed) by insertMessage; re-running names the reason.
    expect(db.ingestMoaMessagePayload(drifting)).toEqual({ inserted: 0, skipped: 'rejected' })
  })

  it('records a successful ingest with no skip reason', () => {
    const { db, runId } = createDbWithRun()
    const inserted = db.insertMessageWithMoaIngest({
      from: 'term_seat',
      to: `run:${runId}`,
      subject: 'proposal ready',
      runId,
      payload: JSON.stringify({
        moa: { deliberation: 'd1', entries: [{ kind: 'proposal', seat: 'seat-A' }] }
      })
    })
    expect(inserted.moaIngest).toEqual({ inserted: 1 })
    expect(inserted.message.id).toBe(entriesOf(db, runId, 'd1')[0].message_id)
  })

  it('lets two Runs hold the same deliberation slug without mixing entries', () => {
    const { db, runId } = createDbWithRun()
    const other = db.createRun({
      objective: 'second run',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: 'tab_other:leaf_other'
    })
    const mine = db.logMoaEntries({
      runId,
      slug: 'd1',
      entries: [{ kind: 'note', seat: 'seat-mine' }]
    })
    const theirs = db.logMoaEntries({
      runId: other.id,
      slug: 'd1',
      entries: [{ kind: 'note', seat: 'seat-theirs' }]
    })
    expect(mine.deliberation.id).not.toBe(theirs.deliberation.id)
    expect(entriesOf(db, runId, 'd1').map((entry) => entry.seat_id)).toEqual(['seat-mine'])
    expect(entriesOf(db, other.id, 'd1').map((entry) => entry.seat_id)).toEqual(['seat-theirs'])
    expect(db.listMoaDeliberations({ runId })).toHaveLength(1)
  })
})

describe('moa-ledger-store review follow-ups', () => {
  it('rejects a negative or fractional seat count before storing anything', () => {
    const { db, runId } = createDbWithRun()
    for (const seatCount of [-1, 1.5]) {
      expect(() =>
        db.logMoaEntries({ runId, slug: 'd1', seatCount, entries: [{ kind: 'note' }] })
      ).toThrow(/non-negative integer/)
    }
    expect(db.getMoaDeliberation({ runId, slug: 'd1' })).toBeUndefined()
  })

  it('rolls the carrier message back when a valid ledger write fails to persist', () => {
    const { db, runId } = createDbWithRun()
    db.db.exec('DROP TABLE moa_ledger_entries')
    expect(() =>
      db.insertMessage({
        from: 'term_seat',
        to: `run:${runId}`,
        subject: 'proposal ready',
        runId,
        payload: JSON.stringify({ moa: { deliberation: 'd1', entries: [{ kind: 'note' }] } })
      })
    ).toThrow()
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 })
  })
})
