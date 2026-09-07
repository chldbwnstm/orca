import { useCallback } from 'react'
import { useAppStore } from '../../store'
import { isTabMultiSelectClick } from './tab-multi-select-modifier'

/** Modifier-click selection for one tab: reads its selected state and consumes the gesture. */
export function useTabMultiSelect(args: {
  groupId: string
  tabId: string
  enabled: boolean
  /** The group's active tab, folded into a fresh selection (see the slice). */
  seedTabId: string | null
}): {
  isMultiSelected: boolean
  /** True when the press was a multi-select click and must neither activate nor start a drag. */
  interceptPointerDown: (event: React.PointerEvent) => boolean
  clearTabMultiSelect: () => void
} {
  const { groupId, tabId, enabled, seedTabId } = args
  const isMultiSelected = useAppStore(
    (state) =>
      enabled && state.multiSelectGroupId === groupId && state.multiSelectedTabIds.includes(tabId)
  )
  const toggleTabMultiSelect = useAppStore((state) => state.toggleTabMultiSelect)
  const clearTabMultiSelect = useAppStore((state) => state.clearTabMultiSelect)

  const interceptPointerDown = useCallback(
    (event: React.PointerEvent): boolean => {
      if (!enabled || !isTabMultiSelectClick(event)) {
        return false
      }
      event.preventDefault()
      event.stopPropagation()
      toggleTabMultiSelect({ groupId, tabId, seedTabId })
      return true
    },
    [enabled, groupId, tabId, seedTabId, toggleTabMultiSelect]
  )

  return { isMultiSelected, interceptPointerDown, clearTabMultiSelect }
}
