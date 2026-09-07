import type { TerminalTab } from '../../../../shared/terminal-tab-types'

/** Fewer than this and there is nobody to deliberate with. */
export const MOA_MIN_SEATS = 2

type MoaSeatState = {
  multiSelectGroupId?: string | null
  multiSelectedTabIds?: string[]
  tabsByWorktree?: Record<string, TerminalTab[]>
}

/**
 * The terminal tabs a right-click on `tabId` would seat: the live multi-selection when it
 * contains this tab, otherwise this tab alone. Closed tabs drop out; order is click order.
 */
export function resolveMoaSeatTabs(
  state: MoaSeatState,
  target: { worktreeId: string; groupId: string; tabId: string }
): TerminalTab[] {
  const tabs = state.tabsByWorktree?.[target.worktreeId] ?? []
  const selected = state.multiSelectedTabIds ?? []
  const ids =
    state.multiSelectGroupId === target.groupId && selected.includes(target.tabId)
      ? selected
      : [target.tabId]
  return ids.flatMap((id) => {
    const tab = tabs.find((candidate) => candidate.id === id)
    return tab ? [tab] : []
  })
}
