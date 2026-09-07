import { afterEach, describe, expect, it } from 'vitest'
import type { RpcContext } from '../../../core'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

// Why its own file: orchestration-send.test.ts is at its max-lines ceiling, and payload.moa
// ingest reporting is a self-contained slice of the send receipt.
describe('orchestration.send payload.moa ingest reporting', () => {
  const h = createOrchestrationRpcHarness()
  let ctx: RpcContext
  let activeRunId: string | undefined

  afterEach(() => {
    h.cleanup()
  })

  function setup(): void {
    ;({ ctx, activeRunId } = h.setup(true))
  }

  async function send(params: Record<string, unknown>) {
    return (await h.call(
      'orchestration.send',
      { from: 'term_coord', to: `run:${activeRunId}`, ...params },
      ctx
    )) as { moaIngest?: { inserted: number; skipped?: string } }
  }

  it('omits moaIngest for a message that carries no ledger payload', async () => {
    setup()
    // Why absent: every ordinary message would otherwise carry a MoA field it never asked for.
    expect((await send({ subject: 'hello' })).moaIngest).toBeUndefined()
  })

  it('reports what the materializer recorded', async () => {
    setup()
    const logged = await send({
      subject: 'proposal ready',
      payload: JSON.stringify({
        moa: { deliberation: 'd1', entries: [{ kind: 'proposal', seat: 'seat-A' }] }
      })
    })
    expect(logged.moaIngest).toEqual({ inserted: 1 })
  })

  it('names why a malformed ledger payload recorded nothing, without failing delivery', async () => {
    setup()
    const rejected = await send({
      subject: 'bad entry',
      payload: JSON.stringify({ moa: { deliberation: 'd1', entries: [{ kind: 'vote' }] } })
    })
    expect(rejected.moaIngest).toEqual({ inserted: 0, skipped: 'invalid_entry' })
  })
})
