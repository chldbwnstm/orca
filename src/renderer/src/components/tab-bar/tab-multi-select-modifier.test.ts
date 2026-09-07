import { afterEach, describe, expect, it, vi } from 'vitest'

const platform = vi.hoisted(() => ({ value: 'win32' as NodeJS.Platform }))

vi.mock('@/lib/shortcut-platform', () => ({
  getShortcutPlatform: () => platform.value
}))

import { getTabMultiSelectModifierLabel, isTabMultiSelectClick } from './tab-multi-select-modifier'

afterEach(() => {
  platform.value = 'win32'
})

describe('isTabMultiSelectClick', () => {
  it('uses Ctrl on Windows and Linux', () => {
    expect(isTabMultiSelectClick({ button: 0, ctrlKey: true, metaKey: false })).toBe(true)
    expect(isTabMultiSelectClick({ button: 0, ctrlKey: false, metaKey: true })).toBe(false)
    platform.value = 'linux'
    expect(isTabMultiSelectClick({ button: 0, ctrlKey: true, metaKey: false })).toBe(true)
  })

  it('uses ⌘ on Mac and leaves Ctrl+click to the context menu', () => {
    platform.value = 'darwin'
    expect(isTabMultiSelectClick({ button: 0, ctrlKey: false, metaKey: true })).toBe(true)
    expect(isTabMultiSelectClick({ button: 0, ctrlKey: true, metaKey: false })).toBe(false)
    expect(getTabMultiSelectModifierLabel()).toBe('⌘')
  })

  it('ignores non-primary buttons and plain clicks', () => {
    expect(isTabMultiSelectClick({ button: 1, ctrlKey: true, metaKey: false })).toBe(false)
    expect(isTabMultiSelectClick({ button: 0, ctrlKey: false, metaKey: false })).toBe(false)
    expect(getTabMultiSelectModifierLabel()).toBe('Ctrl')
  })
})
