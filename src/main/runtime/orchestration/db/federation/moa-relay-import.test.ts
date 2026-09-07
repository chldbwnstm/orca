import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'

// Why a dedicated file: payload.moa materializes inside insertMessage, so the relay import path
// gets the ledger for free — but only as long as it keeps routing through insertMessage.
describe('MoA ledger over the federation relay import path', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  function createFederatedDispatch() {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Federated MoA',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:11111111-1111-4111-8111-111111111111'
    })
    const task = db.createTask({ spec: 'deliberate remotely', runId: run.id })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: { worktree: 'current' },
      runtimeEpoch: 'runtime_1',
      federation: {
        environmentId: 'environment_1',
        environmentName: 'Windows',
        peerFingerprint: 'peer_1',
        protocolVersion: 1
      },
      mutationReceipt: {
        callerFingerprint: 'caller_1',
        requestId: 'request_1',
        method: 'orchestration.workerStart',
        payloadHash: 'hash_1'
      }
    })
    return { db, run, started }
  }

  function moaStatusPayload(): string {
    return JSON.stringify({
      moa: {
        deliberation: 'remote-ledger',
        seatCount: 2,
        entries: [
          {
            kind: 'proposal',
            seat: 'seat-remote',
            rationale: 'authored on the execution host',
            authoredAt: '2026-08-25T09:00:00Z'
          }
        ]
      }
    })
  }

  it('materializes payload.moa carried by an imported relay item, with message provenance', () => {
    const { db: store, run, started } = createFederatedDispatch()
    const imported = store.importFederatedRelayItem({
      dispatchId: started.dispatch.id,
      sequence: 1,
      message: {
        id: 'msg_relayed_1',
        runId: run.id,
        from: 'term_remote_worker',
        to: `run:${run.id}`,
        subject: 'proposal ready',
        body: '',
        type: 'status',
        priority: 'normal',
        payload: moaStatusPayload()
      },
      lifecycle: { kind: 'none' }
    })
    expect(imported.duplicate).toBe(false)

    const deliberation = store.getMoaDeliberation({ runId: run.id, slug: 'remote-ledger' })
    expect(deliberation?.seat_count).toBe(2)
    const entries = store.listMoaEntries({ deliberationId: deliberation?.id ?? '' })
    expect(entries).toHaveLength(1)
    expect(entries[0].seat_id).toBe('seat-remote')
    expect(entries[0].authored_at).toBe('2026-08-25T09:00:00.000Z')
    // Why provenance matters here: a relayed entry must still name the message that carried it,
    // and the sending terminal the join resolves from it.
    expect(entries[0].message_id).toBe('msg_relayed_1')
    expect(entries[0].sender_handle).toBe('term_remote_worker')
  })

  it('does not double-record when the relay replays an already-imported sequence', () => {
    const { db: store, run, started } = createFederatedDispatch()
    const item = {
      dispatchId: started.dispatch.id,
      sequence: 1,
      message: {
        id: 'msg_relayed_1',
        runId: run.id,
        from: 'term_remote_worker',
        to: `run:${run.id}`,
        subject: 'proposal ready',
        body: '',
        type: 'status' as const,
        priority: 'normal' as const,
        payload: moaStatusPayload()
      },
      lifecycle: { kind: 'none' as const }
    }
    store.importFederatedRelayItem(item)
    const replay = store.importFederatedRelayItem(item)
    expect(replay.duplicate).toBe(true)

    const deliberation = store.getMoaDeliberation({ runId: run.id, slug: 'remote-ledger' })
    expect(store.listMoaEntries({ deliberationId: deliberation?.id ?? '' })).toHaveLength(1)
  })
})
