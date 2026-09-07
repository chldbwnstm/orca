// @vitest-environment happy-dom

import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

const launchMock = vi.hoisted(() => ({
  launchAgentInNewTab: vi.fn(() => ({
    tabId: 'coordinator',
    startupPlan: {},
    pasteDraftAfterLaunch: true
  }))
}))
const detection = vi.hoisted(() => ({
  detectedIds: ['claude', 'codex'] as string[] | null
}))

vi.mock('@/lib/launch-agent-in-new-tab', () => launchMock)
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({ detectedIds: detection.detectedIds })
}))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  useAgentDetectionTargetForWorktree: () => 'local'
}))
vi.mock('@/lib/agent-catalog', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  AgentIcon: () => null
}))

import MoaConsortiumDialog from './MoaConsortiumDialog'

const initialState = useAppStore.getInitialState()

function tab(id: string, title: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: 'wt-1',
    title,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function openDialog(seatTabIds: string[]): void {
  useAppStore.setState(
    {
      ...initialState,
      tabsByWorktree: { 'wt-1': [tab('t1', '◐ Fably'), tab('t2', 'Grokkie')] },
      multiSelectGroupId: 'g1',
      multiSelectedTabIds: seatTabIds,
      activeModal: 'moa-consortium',
      modalData: { worktreeId: 'wt-1', groupId: 'g1', seatTabIds }
    },
    true
  )
}

beforeEach(() => {
  launchMock.launchAgentInNewTab.mockClear()
  detection.detectedIds = ['claude', 'codex']
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('MoaConsortiumDialog', () => {
  it('lists the seats and launches a Claude coordinator with the /moa tabs prompt', () => {
    openDialog(['t1', 't2'])
    render(<MoaConsortiumDialog />)

    const seats = screen.getByTestId('moa-consortium-seats')
    expect(seats.textContent).toContain('seat-A')
    expect(seats.textContent).toContain('Fably')
    expect(seats.textContent).toContain('seat-B')
    expect(seats.textContent).toContain('Grokkie')

    const start = screen.getByRole('button', { name: /Start debate/ })
    expect(start).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('Problem to debate'), {
      target: { value: 'Which cache store should we adopt?' }
    })
    expect(start).toHaveProperty('disabled', false)
    act(() => start.click())

    expect(launchMock.launchAgentInNewTab).toHaveBeenCalledWith({
      agent: 'claude',
      worktreeId: 'wt-1',
      groupId: 'g1',
      prompt: '/moa tabs:"Fably","Grokkie" tab-ids:"t1","t2" Which cache store should we adopt?',
      promptDelivery: 'submit-after-ready',
      launchSource: 'tab_bar_moa_consortium'
    })
    expect(useAppStore.getState().activeModal).toBe('none')
    expect(useAppStore.getState().multiSelectedTabIds).toEqual([])
  })

  it('submits with the screen submit shortcut from the problem field', () => {
    openDialog(['t1', 't2'])
    render(<MoaConsortiumDialog />)

    const problem = screen.getByLabelText('Problem to debate')
    fireEvent.change(problem, { target: { value: 'Retry policy?' } })
    fireEvent.keyDown(problem, { key: 'Enter', ctrlKey: true })

    expect(launchMock.launchAgentInNewTab).toHaveBeenCalledTimes(1)
  })

  it('blocks the launch when Claude Code is not detected for the workspace', () => {
    detection.detectedIds = ['codex']
    openDialog(['t1', 't2'])
    render(<MoaConsortiumDialog />)

    fireEvent.change(screen.getByLabelText('Problem to debate'), {
      target: { value: 'x' }
    })
    expect(screen.getByRole('button', { name: /Start debate/ })).toHaveProperty('disabled', true)
    expect(screen.getByText(/Claude Code was not detected/)).toBeTruthy()
  })

  it('drops closed seats and refuses to start with fewer than two', () => {
    openDialog(['t1', 'closed'])
    render(<MoaConsortiumDialog />)

    expect(screen.getByTestId('moa-consortium-seats').textContent).not.toContain('closed')
    expect(screen.getByText(/Select at least 2 tabs/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Problem to debate'), {
      target: { value: 'x' }
    })
    expect(screen.getByRole('button', { name: /Start debate/ })).toHaveProperty('disabled', true)
    expect(launchMock.launchAgentInNewTab).not.toHaveBeenCalled()
  })

  it('keeps the dialog open and reports when the coordinator cannot start', () => {
    launchMock.launchAgentInNewTab.mockReturnValueOnce(null as never)
    openDialog(['t1', 't2'])
    render(<MoaConsortiumDialog />)

    fireEvent.change(screen.getByLabelText('Problem to debate'), {
      target: { value: 'x' }
    })
    act(() => screen.getByRole('button', { name: /Start debate/ }).click())

    expect(screen.getByText(/could not be started/)).toBeTruthy()
    expect(useAppStore.getState().activeModal).toBe('moa-consortium')
  })
})
