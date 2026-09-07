import { afterEach, describe, expect, it } from 'vitest'
import type { RpcContext } from '../../../core'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type { OrchestrationDb } from '../../../../orchestration/db'

describe('orchestration MoA RPC methods', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext

  function setup(): void {
    ;({ db, ctx } = h.setup(true))
  }

  afterEach(() => {
    h.cleanup()
  })

  async function call(name: string, params: Record<string, unknown>) {
    return h.call(name, params, ctx)
  }

  describe('orchestration.moaLog', () => {
    it('records entries in the caller run and reports duplicates', async () => {
      setup()
      const entries = [
        { kind: 'proposal', seat: 'seat-A', rationale: 'tables as store' },
        { kind: 'verdict', round: 2, seat: 'seat-B', verdict: 'support' }
      ]
      const first = (await call('orchestration.moaLog', {
        deliberation: 'ledger-storage',
        seatCount: 3,
        entries
      })) as {
        deliberation: { id: string; slug: string; seat_count: number }
        entries: { id: string; inserted: boolean }[]
        inserted: number
      }
      expect(first.deliberation.slug).toBe('ledger-storage')
      expect(first.deliberation.id).toMatch(/^moad_[0-9a-f]{32}$/)
      expect(first.deliberation.seat_count).toBe(3)
      expect(first.inserted).toBe(2)
      expect(first.entries.map((receipt) => receipt.inserted)).toEqual([true, true])

      const replay = (await call('orchestration.moaLog', {
        deliberation: 'ledger-storage',
        entries
      })) as {
        entries: { id: string; inserted: boolean }[]
        inserted: number
        duplicates: number
      }
      expect(replay.inserted).toBe(0)
      expect(replay.duplicates).toBe(2)
      expect(replay.entries.map((receipt) => receipt.inserted)).toEqual([false, false])
      // Why: the ids must be stable across sends so a caller can target an earlier entry.
      expect(replay.entries.map((receipt) => receipt.id)).toEqual(
        first.entries.map((receipt) => receipt.id)
      )
    })

    it('surfaces store validation errors for invalid kinds', async () => {
      setup()
      await expect(
        call('orchestration.moaLog', {
          deliberation: 'd1',
          entries: [{ kind: 'vote' }]
        })
      ).rejects.toThrow(/Invalid MoA entry kind/)
    })

    it('rejects a non-integer round at the schema boundary', async () => {
      setup()
      // Why reject rather than coerce: a dropped round would silently file the entry under round 1.
      await expect(
        call('orchestration.moaLog', {
          deliberation: 'd1',
          entries: [{ kind: 'note', round: 1.5 }]
        })
      ).rejects.toThrow()
      await expect(
        call('orchestration.moaLog', {
          deliberation: 'd1',
          seatCount: 0,
          entries: [{ kind: 'note' }]
        })
      ).rejects.toThrow()
    })

    it('fences a bound coordinator that names another Run', async () => {
      setup()
      const foreign = db.createRun({
        objective: 'foreign run',
        coordinatorHandle: 'term_foreign',
        coordinatorPaneKey: 'tab_foreign:leaf_foreign'
      })
      await expect(
        call('orchestration.moaLog', {
          deliberation: 'd1',
          run: foreign.id,
          entries: [{ kind: 'note' }]
        })
      ).rejects.toThrowError(expect.objectContaining({ code: 'consumer_fenced' }))
    })
  })

  describe('orchestration.moaShow', () => {
    it('lists deliberations without --deliberation and entries with it', async () => {
      setup()
      await call('orchestration.moaLog', {
        deliberation: 'd1',
        entries: [
          { kind: 'proposal', round: 1, seat: 'seat-A' },
          { kind: 'verdict', round: 2, seat: 'seat-B', verdict: 'merge' }
        ]
      })

      const catalog = (await call('orchestration.moaShow', {})) as {
        deliberations: { id: string; slug: string }[]
        count: number
      }
      expect(catalog.count).toBe(1)
      expect(catalog.deliberations[0].slug).toBe('d1')

      const full = (await call('orchestration.moaShow', { deliberation: 'd1' })) as {
        entries: { entry_kind: string; round: number }[]
      }
      expect(full.entries).toHaveLength(2)

      const roundTwo = (await call('orchestration.moaShow', {
        deliberation: 'd1',
        round: 2
      })) as { entries: { entry_kind: string }[] }
      expect(roundTwo.entries).toHaveLength(1)
      expect(roundTwo.entries[0].entry_kind).toBe('verdict')
    })

    it('carries sender_handle provenance into the JSON entries', async () => {
      setup()
      db.insertMessage({
        from: 'term_seat_a',
        to: `run:${db.getCurrentRunForPane(h.coordinatorPaneKey)?.id}`,
        subject: 'proposal ready',
        payload: JSON.stringify({
          moa: { deliberation: 'd1', entries: [{ kind: 'proposal', seat: 'seat-A' }] }
        })
      })
      await call('orchestration.moaLog', {
        deliberation: 'd1',
        entries: [{ kind: 'note', seat: 'seat-A', round: 2 }]
      })

      const shown = (await call('orchestration.moaShow', { deliberation: 'd1' })) as {
        entries: { seat_id: string | null; sender_handle: string | null }[]
      }
      // Why exposed here and not in the text view: --json is the audit surface; the rendered
      // list stays anonymized because the coordinator already holds the seat->identity map.
      expect(shown.entries.map((entry) => entry.sender_handle)).toEqual(['term_seat_a', null])
    })

    it('hides deliberations that belong to another run', async () => {
      setup()
      const foreign = db.createRun({
        objective: 'foreign run',
        coordinatorHandle: 'term_foreign',
        coordinatorPaneKey: 'tab_foreign:leaf_foreign'
      })
      db.logMoaEntries({
        runId: foreign.id,
        slug: 'foreign-deliberation',
        entries: [{ kind: 'note' }]
      })
      // Why: the caller's implicit run must not see (or even confirm the existence of) the foreign ledger.
      const rejected = call('orchestration.moaShow', { deliberation: 'foreign-deliberation' })
      await expect(rejected).rejects.toThrow(/not found/)
      // Why the code and not just the text: --json callers branch on it, so it is part of the contract.
      await expect(rejected).rejects.toThrowError(
        expect.objectContaining({ code: 'deliberation_not_found' })
      )
    })

    it('shows the caller its own deliberation under a slug another run also uses', async () => {
      setup()
      const foreign = db.createRun({
        objective: 'foreign run',
        coordinatorHandle: 'term_foreign',
        coordinatorPaneKey: 'tab_foreign:leaf_foreign'
      })
      db.logMoaEntries({ runId: foreign.id, slug: 'shared', entries: [{ kind: 'note' }] })
      await call('orchestration.moaLog', {
        deliberation: 'shared',
        entries: [{ kind: 'proposal', seat: 'seat-mine' }]
      })

      const shown = (await call('orchestration.moaShow', { deliberation: 'shared' })) as {
        deliberation: { id: string }
        entries: { seat_id: string | null }[]
      }
      expect(shown.entries.map((entry) => entry.seat_id)).toEqual(['seat-mine'])
      expect(shown.deliberation.id).not.toBe(
        db.getMoaDeliberation({ runId: foreign.id, slug: 'shared' })?.id
      )
    })
  })
})
