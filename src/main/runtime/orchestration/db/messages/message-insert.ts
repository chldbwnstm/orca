import type { MessageType, MessagePriority, MessageDeliveryContract, MessageRow } from '../../types'
import { LEGACY_RUN_ID } from '../contract-constants'
import { generateId } from '../generated-id'
import type { MoaIngestResult } from '../moa-ledger/moa-message-ingest'
import { exposeMessageTimestamps } from '../utc-timestamp'
import type { OrchestrationDb } from '../orchestration-db'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'

// ── Messages ──

const MESSAGE_INSERT_SAVEPOINT = 'message_insert_batch'
// Why a second, nested savepoint: the batch one only covers whole messages, so a row and the
// ledger entries derived from it need their own scope for the comment below to be true.
const MESSAGE_ROW_SAVEPOINT = 'message_insert_row'
const WORKER_DONE_MESSAGE_SAVEPOINT = 'worker_done_message_commit'

export type MessageInsert = {
  id?: string
  from: string
  to: string
  subject: string
  body?: string
  type?: MessageType
  priority?: MessagePriority
  threadId?: string
  payload?: string
  senderPaneKey?: string
  runId?: string
  deliveryContract?: MessageDeliveryContract
}

export function insertMessage(this: OrchestrationDb, msg: MessageInsert): MessageRow {
  return this.insertMessageWithMoaIngest(msg).message
}

/** Same insert, but hands back what the payload.moa materializer did; see `insertMessage`. */
export function insertMessageWithMoaIngest(
  this: OrchestrationDb,
  msg: MessageInsert
): { message: MessageRow; moaIngest: MoaIngestResult } {
  const runId = msg.runId ?? LEGACY_RUN_ID
  const deliveryContract = msg.deliveryContract ?? 'current_delivery'
  this.requireRun(runId)
  const id = msg.id ?? generateId('msg')
  this.db.exec(`SAVEPOINT ${MESSAGE_ROW_SAVEPOINT}`)
  try {
    const stmt = this.db.prepare(`
      INSERT INTO messages (
        id, run_id, delivery_contract, from_handle, to_handle, subject, body,
        type, priority, thread_id, payload, sender_pane_key
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      id,
      runId,
      deliveryContract,
      msg.from,
      msg.to,
      msg.subject,
      msg.body ?? '',
      msg.type ?? 'status',
      msg.priority ?? 'normal',
      msg.threadId ?? null,
      msg.payload ?? null,
      msg.senderPaneKey ?? null
    )
    const row = exposeMessageTimestamps(
      this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow
    )
    // Why here and not in the send RPC: every arrival path (send, federation relay
    // import, injected system mail) funnels through this insert, so payload.moa on a
    // status message materializes exactly once, inside the savepoint that owns its
    // provenance row — a failing ingest can never leave entries without their message.
    const moaIngest = this.ingestMoaMessagePayload(row)
    this.db.exec(`RELEASE ${MESSAGE_ROW_SAVEPOINT}`)
    return { message: row, moaIngest }
  } catch (error) {
    this.db.exec(`ROLLBACK TO ${MESSAGE_ROW_SAVEPOINT}`)
    this.db.exec(`RELEASE ${MESSAGE_ROW_SAVEPOINT}`)
    throw error
  }
}

export function insertMessages(this: OrchestrationDb, messages: MessageInsert[]): MessageRow[] {
  this.db.exec(`SAVEPOINT ${MESSAGE_INSERT_SAVEPOINT}`)
  try {
    const inserted = messages.map((message) => this.insertMessage(message))
    this.db.exec(`RELEASE ${MESSAGE_INSERT_SAVEPOINT}`)
    return inserted
  } catch (error) {
    this.db.exec(`ROLLBACK TO ${MESSAGE_INSERT_SAVEPOINT}`)
    this.db.exec(`RELEASE ${MESSAGE_INSERT_SAVEPOINT}`)
    throw error
  }
}

export function commitWorkerDoneMessageMutation<T>(this: OrchestrationDb, mutation: () => T): T {
  return runLifecycleWriteTransaction(this.db, WORKER_DONE_MESSAGE_SAVEPOINT, mutation)
}

export type MessageInsertMethods = {
  insertMessage: typeof insertMessage
  insertMessageWithMoaIngest: typeof insertMessageWithMoaIngest
  insertMessages: typeof insertMessages
  commitWorkerDoneMessageMutation: typeof commitWorkerDoneMessageMutation
}

export function attachMessageInsert(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    insertMessage,
    insertMessageWithMoaIngest,
    insertMessages,
    commitWorkerDoneMessageMutation
  })
}
