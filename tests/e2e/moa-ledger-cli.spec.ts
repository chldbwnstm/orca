import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { RuntimeClient } from '../../src/cli/runtime-client'
import { runBuiltOrcaCli } from './helpers/completed-worker-retirement-fixture'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

type CliEnvelope<T> = { ok: boolean; result: T; error?: { code: string; message: string } }

type LedgerEntry = {
  id: string
  round: number
  entry_kind: string
  seat_id: string | null
  subject_entry_id: string | null
  verdict: string | null
  sender_handle: string | null
}

// Why an E2E here: the unit suites cover the store and RPC in isolation; this proves the built
// CLI, the runtime RPC boundary, message ingest, and the read path agree end to end.
test('moa-log and moa-show keep one deliberation across the built CLI, runtime, and mail ingest @moa-ledger', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  await waitForActivePanePtyId(orcaPage)

  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const client = new RuntimeClient(userDataDir, 30_000, null, null)
  const pane = await waitForActivePaneHookDescriptor(orcaPage)
  // Why poll: the PTY binding lands in the renderer a beat before the runtime registers the terminal.
  let coordinator = ''
  await expect
    .poll(
      async () => {
        try {
          const resolved = await client.call<{ terminal: { handle: string } }>(
            'terminal.resolvePane',
            { paneKey: pane.paneKey }
          )
          coordinator = resolved.result.terminal.handle
          return coordinator
        } catch {
          return null
        }
      },
      { timeout: 30_000, message: 'runtime never registered the coordinator terminal' }
    )
    .not.toBeNull()
  const created = await client.call<{ run: { id: string } }>('orchestration.runCreate', {
    objective: 'MoA ledger end-to-end',
    from: coordinator
  })
  const runId = created.result.run.id

  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-moa-ledger-e2e-'))
  const proposalsFile = path.join(dir, 'proposals.json')
  writeFileSync(
    proposalsFile,
    JSON.stringify([
      {
        kind: 'proposal',
        round: 1,
        seat: 'seat-A',
        rationale: 'tables as store',
        authoredAt: '2026-09-07T10:00:00Z'
      },
      {
        kind: 'proposal',
        round: 1,
        seat: 'seat-B',
        rationale: 'messages as WAL',
        authoredAt: '2026-09-07T10:01:00Z'
      }
    ])
  )
  const cli = <T>(args: string[]): CliEnvelope<T> =>
    runBuiltOrcaCli([...args, '--from', coordinator, '--json'], {
      userDataDir,
      cwd: process.cwd()
    }) as CliEnvelope<T>

  try {
    const logArgs = [
      'orchestration',
      'moa-log',
      '--deliberation',
      'ledger-storage',
      '--seat-count',
      '2',
      '--entries-file',
      proposalsFile
    ]
    const logged = cli<{
      deliberation: { id: string; slug: string; run_id: string; seat_count: number }
      entries: { id: string; inserted: boolean }[]
      inserted: number
      duplicates: number
    }>(logArgs)
    expect(logged.ok).toBe(true)
    expect(logged.result.deliberation).toMatchObject({
      slug: 'ledger-storage',
      run_id: runId,
      seat_count: 2
    })
    expect(logged.result.inserted).toBe(2)
    expect(logged.result.entries.map((entry) => entry.inserted)).toEqual([true, true])
    const proposalA = logged.result.entries[0].id

    // Content-addressed: the same file again records nothing new.
    const replay = cli<{ inserted: number; duplicates: number }>(logArgs)
    expect(replay.result).toMatchObject({ inserted: 0, duplicates: 2 })

    // A status message carrying payload.moa materializes with message provenance.
    const sent = cli<{ moaIngest?: { inserted: number; skipped?: string } }>([
      'orchestration',
      'send',
      '--to',
      `run:${runId}`,
      '--subject',
      'round 2 verdict',
      '--type',
      'status',
      '--payload',
      JSON.stringify({
        moa: {
          deliberation: 'ledger-storage',
          entries: [
            {
              kind: 'verdict',
              round: 2,
              seat: 'seat-B',
              subjectEntryId: proposalA,
              verdict: 'support',
              rationale: 'holds up',
              authoredAt: '2026-09-07T10:05:00Z'
            }
          ]
        }
      })
    ])
    expect(sent.ok).toBe(true)
    expect(sent.result.moaIngest).toEqual({ inserted: 1 })

    const shown = cli<{ deliberation: { slug: string }; entries: LedgerEntry[]; count: number }>([
      'orchestration',
      'moa-show',
      '--deliberation',
      'ledger-storage'
    ])
    expect(shown.result.count).toBe(3)
    expect(
      shown.result.entries.map((entry) => [entry.round, entry.entry_kind, entry.seat_id])
    ).toEqual([
      [1, 'proposal', 'seat-A'],
      [1, 'proposal', 'seat-B'],
      [2, 'verdict', 'seat-B']
    ])
    const verdict = shown.result.entries[2]
    expect(verdict.subject_entry_id).toBe(proposalA)
    expect(verdict.verdict).toBe('support')
    // Audit provenance: the CLI-logged rows carry no sender, the mailed one names its terminal.
    expect(shown.result.entries.slice(0, 2).map((entry) => entry.sender_handle)).toEqual([
      null,
      null
    ])
    expect(verdict.sender_handle).toBe(coordinator)

    const catalog = cli<{ deliberations: { slug: string; seat_count: number }[] }>([
      'orchestration',
      'moa-show'
    ])
    expect(catalog.result.deliberations).toEqual([
      expect.objectContaining({ slug: 'ledger-storage', seat_count: 2 })
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
