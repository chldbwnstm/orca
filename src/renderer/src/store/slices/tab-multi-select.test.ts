import { describe, expect, it } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import { createTabMultiSelectSlice, type TabMultiSelectSlice } from './tab-multi-select'

function makeStore() {
  return create<TabMultiSelectSlice>()((...a) =>
    createTabMultiSelectSlice(...(a as unknown as Parameters<typeof createTabMultiSelectSlice>))
  )
}

describe('tab multi-select slice', () => {
  it('seeds a fresh selection with the group active tab, then toggles', () => {
    const store = makeStore()
    store.getState().toggleTabMultiSelect({ groupId: 'g1', tabId: 'b', seedTabId: 'a' })
    expect(store.getState().multiSelectedTabIds).toEqual(['a', 'b'])
    expect(store.getState().multiSelectGroupId).toBe('g1')

    store.getState().toggleTabMultiSelect({ groupId: 'g1', tabId: 'c', seedTabId: 'a' })
    expect(store.getState().multiSelectedTabIds).toEqual(['a', 'b', 'c'])

    store.getState().toggleTabMultiSelect({ groupId: 'g1', tabId: 'b', seedTabId: 'a' })
    expect(store.getState().multiSelectedTabIds).toEqual(['a', 'c'])
  })

  it('does not double-seed when the clicked tab is the active one', () => {
    const store = makeStore()
    store.getState().toggleTabMultiSelect({ groupId: 'g1', tabId: 'a', seedTabId: 'a' })
    expect(store.getState().multiSelectedTabIds).toEqual(['a'])
  })

  it('restarts the selection when a different group is clicked', () => {
    const store = makeStore()
    store.getState().toggleTabMultiSelect({ groupId: 'g1', tabId: 'b', seedTabId: 'a' })
    store.getState().toggleTabMultiSelect({ groupId: 'g2', tabId: 'x', seedTabId: 'y' })
    expect(store.getState().multiSelectGroupId).toBe('g2')
    expect(store.getState().multiSelectedTabIds).toEqual(['y', 'x'])
  })

  it('clears the group when the last selected tab is toggled off', () => {
    const store = makeStore()
    store.getState().toggleTabMultiSelect({ groupId: 'g1', tabId: 'a', seedTabId: null })
    store.getState().toggleTabMultiSelect({ groupId: 'g1', tabId: 'a', seedTabId: null })
    expect(store.getState().multiSelectedTabIds).toEqual([])
    expect(store.getState().multiSelectGroupId).toBeNull()
  })

  it('clearTabMultiSelect is a no-op on an empty selection and otherwise resets', () => {
    const store = makeStore()
    const before = store.getState()
    store.getState().clearTabMultiSelect()
    expect(store.getState()).toBe(before)

    store.getState().toggleTabMultiSelect({ groupId: 'g1', tabId: 'a' })
    store.getState().clearTabMultiSelect()
    expect(store.getState().multiSelectedTabIds).toEqual([])
    expect(store.getState().multiSelectGroupId).toBeNull()
  })
})

// Why: compile-time proof the slice keys exist on AppState once registered.
type _Registered = AppState extends TabMultiSelectSlice ? true : never
const _registered: _Registered = true
void _registered
