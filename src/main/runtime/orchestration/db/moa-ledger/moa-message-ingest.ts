import type { MessageRow } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'
import { OrchestrationError } from '../../orchestration-error'
import { assertValidEntry, type MoaEntryInput } from './moa-ledger-store'

// The transport half of the MoA ledger: `payload.moa` riding an existing `status` message.
// Kept out of the store so the strict write path (orchestration.moaLog) and this tolerant
// one cannot drift apart on validation — both call `assertValidEntry`.

type MoaMessagePayload = {
  deliberation?: unknown
  taskId?: unknown
  seatCount?: unknown
  entries?: unknown
}

/** Why a reason and not a bare count: 0 alone cannot tell "no ledger here" from "we dropped it". */
export type MoaIngestResult = {
  inserted: number
  skipped?: 'not_status' | 'malformed' | 'invalid_entry' | 'rejected'
}

// Transport-tolerant materializer: a status message may carry payload.moa from a
// newer or foreign client. Malformed payloads must never fail message delivery,
// so this validates quietly and records nothing on shape errors; the explicit
// orchestration.moaLog RPC is the strict path. The reason travels in the return
// value rather than a log line — the db layer has no logging precedent.
export function ingestMoaMessagePayload(
  this: OrchestrationDb,
  message: MessageRow
): MoaIngestResult {
  if (message.type !== 'status' || !message.payload || !message.payload.includes('"moa"')) {
    return { inserted: 0, skipped: 'not_status' }
  }
  let moa: MoaMessagePayload | null = null
  try {
    const parsed = JSON.parse(message.payload) as { moa?: MoaMessagePayload | null }
    moa = parsed?.moa ?? null
  } catch {
    return { inserted: 0, skipped: 'malformed' }
  }
  if (!moa || typeof moa.deliberation !== 'string' || !Array.isArray(moa.entries)) {
    return { inserted: 0, skipped: 'malformed' }
  }
  const entries: MoaEntryInput[] = []
  for (const raw of moa.entries) {
    const entry = raw as MoaEntryInput
    try {
      assertValidEntry(entry)
    } catch {
      return { inserted: 0, skipped: 'invalid_entry' }
    }
    entries.push(entry)
  }
  if (entries.length === 0) {
    return { inserted: 0, skipped: 'invalid_entry' }
  }
  try {
    const result = this.logMoaEntries({
      runId: message.run_id,
      slug: moa.deliberation,
      taskId: typeof moa.taskId === 'string' ? moa.taskId : undefined,
      seatCount: typeof moa.seatCount === 'number' ? moa.seatCount : undefined,
      entries,
      messageId: message.id
    })
    return { inserted: result.inserted }
  } catch (error) {
    // Why rethrow anything else: a storage failure must take the carrier message down with it
    // (the insert savepoint), or a valid entry would vanish while its message still delivers.
    if (error instanceof OrchestrationError) {
      return { inserted: 0, skipped: 'rejected' }
    }
    throw error
  }
}

export type MoaMessageIngestMethods = {
  ingestMoaMessagePayload: typeof ingestMoaMessagePayload
}

export function attachMoaMessageIngest(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    ingestMoaMessagePayload
  })
}
