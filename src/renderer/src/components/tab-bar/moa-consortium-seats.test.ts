import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { resolveMoaSeatTabs } from './moa-consortium-seats'

function tab(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: 'wt-1',
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

const tabsByWorktree = { 'wt-1': [tab('a'), tab('b'), tab('c')] }

describe('resolveMoaSeatTabs', () => {
  it('returns the selection in click order when the clicked tab is part of it', () => {
    const seats = resolveMoaSeatTabs(
      {
        multiSelectGroupId: 'g1',
        multiSelectedTabIds: ['c', 'a'],
        tabsByWorktree
      },
      { worktreeId: 'wt-1', groupId: 'g1', tabId: 'a' }
    )
    expect(seats.map((seat) => seat.id)).toEqual(['c', 'a'])
  })

  it('falls back to the clicked tab alone when it is outside the selection', () => {
    const seats = resolveMoaSeatTabs(
      {
        multiSelectGroupId: 'g1',
        multiSelectedTabIds: ['c', 'a'],
        tabsByWorktree
      },
      { worktreeId: 'wt-1', groupId: 'g1', tabId: 'b' }
    )
    expect(seats.map((seat) => seat.id)).toEqual(['b'])
  })

  it('ignores a selection that lives in another group', () => {
    const seats = resolveMoaSeatTabs(
      {
        multiSelectGroupId: 'g2',
        multiSelectedTabIds: ['a', 'b'],
        tabsByWorktree
      },
      { worktreeId: 'wt-1', groupId: 'g1', tabId: 'a' }
    )
    expect(seats.map((seat) => seat.id)).toEqual(['a'])
  })

  it('drops ids whose tabs have closed and tolerates a bare state', () => {
    const seats = resolveMoaSeatTabs(
      {
        multiSelectGroupId: 'g1',
        multiSelectedTabIds: ['gone', 'a'],
        tabsByWorktree
      },
      { worktreeId: 'wt-1', groupId: 'g1', tabId: 'a' }
    )
    expect(seats.map((seat) => seat.id)).toEqual(['a'])
    expect(resolveMoaSeatTabs({}, { worktreeId: 'wt-1', groupId: 'g1', tabId: 'a' })).toEqual([])
  })
})
