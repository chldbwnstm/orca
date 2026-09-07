import type { OrchestrationDb } from '../orchestration-db'
import { createMoaLedgerTablesSql } from './create-moa-ledger-tables-sql'

export function applySchemaMigrationV40MoaLedger(this: OrchestrationDb, current: number): void {
  if (current < 40) {
    // Why drop first: pre-release fork tables from the withdrawn drafts (v30/v31); never shipped.
    this.db.exec('DROP TABLE IF EXISTS moa_ledger_entries; DROP TABLE IF EXISTS moa_deliberations;')
    this.db.exec(createMoaLedgerTablesSql())
  }
}
