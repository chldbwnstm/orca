import type { StateCreator } from 'zustand'
import type { AppState } from '../types'

/** Ephemeral Ctrl/Cmd+click selection of terminal tabs inside one tab group, for bulk
 *  actions such as seating an MoA consortium. Renderer-only; never persisted or synced. */
export type TabMultiSelectSlice = {
  multiSelectGroupId: string | null
  /** Terminal tab ids in click order; empty when nothing is selected. */
  multiSelectedTabIds: string[]
  toggleTabMultiSelect: (args: {
    groupId: string
    tabId: string
    /** The group's active tab, folded in when a fresh selection starts elsewhere. */
    seedTabId?: string | null
  }) => void
  clearTabMultiSelect: () => void
}

export const createTabMultiSelectSlice: StateCreator<AppState, [], [], TabMultiSelectSlice> = (
  set,
  get
) => ({
  multiSelectGroupId: null,
  multiSelectedTabIds: [],

  toggleTabMultiSelect: ({ groupId, tabId, seedTabId }) => {
    const state = get()
    let ids = state.multiSelectGroupId === groupId ? state.multiSelectedTabIds : []
    // Why seed with the active tab: the first modifier-click reads as "this one and the one
    // I'm on", the way browser tab strips behave; without it the user has to click twice.
    if (ids.length === 0 && seedTabId && seedTabId !== tabId) {
      ids = [seedTabId]
    }
    ids = ids.includes(tabId) ? ids.filter((id) => id !== tabId) : [...ids, tabId]
    set({
      multiSelectGroupId: ids.length > 0 ? groupId : null,
      multiSelectedTabIds: ids
    })
  },

  clearTabMultiSelect: () => {
    if (get().multiSelectedTabIds.length === 0) {
      return
    }
    set({ multiSelectGroupId: null, multiSelectedTabIds: [] })
  }
})
