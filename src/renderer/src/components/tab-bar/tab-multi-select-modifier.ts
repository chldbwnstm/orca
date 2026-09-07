import { getShortcutPlatform } from '@/lib/shortcut-platform'

type ModifierEvent = {
  button?: number
  ctrlKey: boolean
  metaKey: boolean
  shiftKey?: boolean
}

/** A primary-button press with the platform's multi-select modifier (⌘ on Mac, Ctrl elsewhere). */
export function isTabMultiSelectClick(event: ModifierEvent): boolean {
  if (event.button !== undefined && event.button !== 0) {
    return false
  }
  // Why the cross-modifier is rejected: Ctrl+click on Mac is the context-menu gesture, and
  // ⌘/Win+click on the other platforms belongs to the OS.
  return getShortcutPlatform() === 'darwin'
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey
}

export function getTabMultiSelectModifierLabel(): string {
  return getShortcutPlatform() === 'darwin' ? '⌘' : 'Ctrl'
}
