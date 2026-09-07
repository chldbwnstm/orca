import React, { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { AgentIcon } from '@/lib/agent-catalog'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { getScreenSubmitShortcutLabel, isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { translate } from '@/i18n/i18n'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  DEFAULT_DISABLED_TUI_AGENTS,
  filterEnabledTuiAgents
} from '../../../../shared/tui-agent-selection'
import { buildMoaConsortiumPrompt } from './moa-consortium-prompt'
import { MOA_CONSORTIUM_MODAL, readMoaConsortiumRequest } from './moa-consortium-request'
import { MOA_MIN_SEATS } from './moa-consortium-seats'
import { getTabMultiSelectModifierLabel } from './tab-multi-select-modifier'

// Why Claude only: the `/moa` coordinator protocol is a Claude Code skill; other CLIs have no such skill to run.
const MOA_COORDINATOR_AGENT: TuiAgent = 'claude'

function seatLabel(index: number): string {
  return `seat-${String.fromCharCode(65 + (index % 26))}`
}

const MoaConsortiumDialog = React.memo(function MoaConsortiumDialog(): React.JSX.Element {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const clearTabMultiSelect = useAppStore((s) => s.clearTabMultiSelect)
  const isOpen = activeModal === MOA_CONSORTIUM_MODAL
  const request = useMemo(() => readMoaConsortiumRequest(modalData), [modalData])
  const worktreeTabs = useAppStore((s) =>
    request ? s.tabsByWorktree[request.worktreeId] : undefined
  )
  // Why resolve at render time: a seat closed while the dialog is open must disappear, not launch as a ghost.
  const seats = useMemo(
    () =>
      (request?.seatTabIds ?? []).flatMap((id) => {
        const tab = worktreeTabs?.find((candidate) => candidate.id === id)
        return tab ? [tab] : []
      }),
    [request, worktreeTabs]
  )
  const detectionTarget = useAgentDetectionTargetForWorktree(request?.worktreeId ?? null)
  const { detectedIds } = useDetectedAgents(detectionTarget)
  const disabledAgents = useAppStore(
    (s) => s.settings?.disabledTuiAgents ?? DEFAULT_DISABLED_TUI_AGENTS
  )
  // Why `?? []`: detection reports null until the worktree's host is known; treat that as "not yet".
  const coordinatorAvailable = filterEnabledTuiAgents(detectedIds ?? [], disabledAgents).includes(
    MOA_COORDINATOR_AGENT
  )

  const [problem, setProblem] = useState('')
  const [launchError, setLaunchError] = useState<string | null>(null)
  useEffect(() => {
    if (isOpen) {
      setProblem('')
      setLaunchError(null)
    }
  }, [isOpen])

  const tooFewSeats = seats.length < MOA_MIN_SEATS
  const canSubmit =
    isOpen && coordinatorAvailable && !tooFewSeats && problem.trim().length > 0 && !!request

  const handleSubmit = (): void => {
    if (!request || !canSubmit) {
      return
    }
    const prompt = buildMoaConsortiumPrompt({
      seats: seats.map((seat) => ({
        title: seat.customTitle ?? seat.title,
        tabId: seat.id
      })),
      problem
    })
    // Why submit-after-ready: the problem statement is free text and may span lines, which does
    // not survive a shell argv; launch clean, then paste and submit once the TUI is ready.
    const result = launchAgentInNewTab({
      agent: MOA_COORDINATOR_AGENT,
      worktreeId: request.worktreeId,
      groupId: request.groupId,
      prompt,
      promptDelivery: 'submit-after-ready',
      launchSource: 'tab_bar_moa_consortium'
    })
    if (!result) {
      setLaunchError(
        translate(
          'components.tab.bar.MoaConsortiumDialog.launchFailed',
          'The coordinator terminal could not be started.'
        )
      )
      return
    }
    clearTabMultiSelect()
    closeModal()
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          closeModal()
        }
      }}
    >
      <DialogContent className="sm:max-w-lg" data-testid="moa-consortium-dialog">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate('components.tab.bar.MoaConsortiumDialog.title', 'Debate with MoA')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'components.tab.bar.MoaConsortiumDialog.description',
              'Seats the selected tabs as an anonymous consortium and opens a Claude Code coordinator tab that runs the /moa skill.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">
              {translate('components.tab.bar.MoaConsortiumDialog.seats', 'Seats ({{count}})', {
                count: seats.length
              })}
            </Label>
            <ul className="flex flex-wrap gap-1.5" data-testid="moa-consortium-seats">
              {seats.map((seat, index) => (
                <li
                  key={seat.id}
                  className="flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs"
                >
                  <AgentIcon agent={seat.launchAgent ?? null} size={12} />
                  <span className="text-muted-foreground">{seatLabel(index)}</span>
                  <span className="max-w-48 truncate">{seat.customTitle ?? seat.title}</span>
                </li>
              ))}
            </ul>
            {tooFewSeats ? (
              <p className="text-xs text-muted-foreground">
                {translate(
                  'components.tab.bar.MoaConsortiumDialog.tooFewSeats',
                  'Select at least {{count}} tabs with {{modifier}}+click.',
                  {
                    count: MOA_MIN_SEATS,
                    modifier: getTabMultiSelectModifierLabel()
                  }
                )}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="moa-consortium-problem" className="text-xs">
              {translate('components.tab.bar.MoaConsortiumDialog.problem', 'Problem to debate')}
            </Label>
            <Textarea
              id="moa-consortium-problem"
              autoFocus
              rows={4}
              value={problem}
              placeholder={translate(
                'components.tab.bar.MoaConsortiumDialog.problemPlaceholder',
                'State the decision or question the seats should deliberate.'
              )}
              onChange={(event) => setProblem(event.target.value)}
              onKeyDown={(event) => {
                if (isScreenSubmitShortcut(event)) {
                  event.preventDefault()
                  handleSubmit()
                }
              }}
            />
          </div>
          {!coordinatorAvailable ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'components.tab.bar.MoaConsortiumDialog.coordinatorMissing',
                'Claude Code was not detected for this workspace; the coordinator tab needs it.'
              )}
            </p>
          ) : null}
          {launchError ? <p className="text-xs text-destructive">{launchError}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={closeModal}>
            {translate('components.tab.bar.MoaConsortiumDialog.cancel', 'Cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {translate('components.tab.bar.MoaConsortiumDialog.start', 'Start debate')}
            <span className="ml-1 text-xs opacity-70">{getScreenSubmitShortcutLabel()}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default MoaConsortiumDialog
