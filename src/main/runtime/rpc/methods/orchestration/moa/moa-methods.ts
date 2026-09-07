import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../../../core'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { OptionalString, requiredString } from '../../../schemas'
import { resolveRunScope } from '../runs/run-scope'

// MoA (Mixture of Agents) deliberation ledger methods. The ledger rows are
// append-only and content-addressed (see db/moa-ledger/moa-ledger-store.ts);
// entry kinds and verdicts are validated by the store, keeping one source of
// truth for the strict write path and the transport-tolerant payload.moa
// materializer. `deliberation` is a Run-scoped slug, not a global id.

// Why strict here and not the forgiving OptionalFiniteNumber: rounds and seat counts are
// counting numbers, and silently dropping a bad one would log the entry under round 1.
const OptionalPositiveInteger = z.number().int().positive().optional()

const MoaEntrySchema = z.object({
  round: OptionalPositiveInteger,
  kind: z.string(),
  seat: z.string().optional(),
  subjectEntryId: z.string().optional(),
  verdict: z.string().optional(),
  rationale: z.string().optional(),
  payload: z.string().optional(),
  authoredAt: z.string().optional()
})

const MoaLogParams = z.object({
  deliberation: requiredString('Missing --deliberation'),
  task: OptionalString,
  seatCount: OptionalPositiveInteger,
  entries: z.array(MoaEntrySchema).min(1, 'At least one entry is required'),
  from: OptionalString,
  run: OptionalString
})

const MoaShowParams = z.object({
  deliberation: OptionalString,
  round: OptionalPositiveInteger,
  from: OptionalString,
  run: OptionalString
})

export const ORCHESTRATION_MOA_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.moaLog',
    params: MoaLogParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime, legacyCoordinatorRunId }) => {
      const db = runtime.getOrchestrationDb()
      const run = resolveRunScope(runtime, {
        runId: params.run,
        callerTerminalHandle: params.from,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence
      })
      const result = db.logMoaEntries({
        runId: run.id,
        slug: params.deliberation,
        taskId: params.task,
        seatCount: params.seatCount,
        entries: params.entries
      })
      return {
        deliberation: result.deliberation,
        entries: result.entries,
        inserted: result.inserted,
        duplicates: result.duplicates
      }
    }
  }),

  defineMethod({
    name: 'orchestration.moaShow',
    params: MoaShowParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime, legacyCoordinatorRunId }) => {
      const db = runtime.getOrchestrationDb()
      const explicitRun = params.run ? db.getRun(params.run) : undefined
      // Why: same read posture as gateList — an explicitly named Run is inspectable, an unnamed one means the caller's own.
      const run =
        explicitRun?.legacy === 1
          ? explicitRun
          : resolveRunScope(runtime, {
              runId: params.run,
              callerTerminalHandle: params.from,
              requireCurrentConsumer: params.run === undefined,
              legacyCoordinatorRunId,
              callerEvidence: orchestrationCompatibilityEvidence
            })
      if (params.deliberation) {
        // Why look up by (run, slug) rather than filtering after: a slug used only in another Run is
        // indistinguishable from a missing one, so probing cannot map foreign Runs.
        const deliberation = db.getMoaDeliberation({ runId: run.id, slug: params.deliberation })
        if (!deliberation) {
          throw new OrchestrationError(
            'deliberation_not_found',
            `MoA deliberation not found: ${params.deliberation}`
          )
        }
        const entries = db.listMoaEntries({
          deliberationId: deliberation.id,
          round: params.round
        })
        return { runId: run.id, deliberation, entries, count: entries.length }
      }
      const deliberations = db.listMoaDeliberations({ runId: run.id })
      return { runId: run.id, deliberations, count: deliberations.length }
    }
  })
]
