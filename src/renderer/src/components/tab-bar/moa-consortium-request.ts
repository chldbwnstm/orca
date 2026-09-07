import { useAppStore } from '../../store'
import { MOA_MIN_SEATS, resolveMoaSeatTabs } from './moa-consortium-seats'

export const MOA_CONSORTIUM_MODAL = 'moa-consortium'

export type MoaConsortiumRequest = {
  worktreeId: string
  groupId: string
  /** Terminal tab ids to seat, in selection order. */
  seatTabIds: string[]
}

/** Opens the consortium dialog for the tabs a right-click on `tabId` seats; false when too few. */
export function requestMoaConsortium(target: {
  worktreeId: string
  groupId: string
  tabId: string
}): boolean {
  const state = useAppStore.getState()
  const seats = resolveMoaSeatTabs(state, target)
  if (seats.length < MOA_MIN_SEATS) {
    return false
  }
  const request: MoaConsortiumRequest = {
    worktreeId: target.worktreeId,
    groupId: target.groupId,
    seatTabIds: seats.map((seat) => seat.id)
  }
  state.openModal(MOA_CONSORTIUM_MODAL, request)
  return true
}

export function readMoaConsortiumRequest(
  modalData: Record<string, unknown>
): MoaConsortiumRequest | null {
  const { worktreeId, groupId, seatTabIds } = modalData
  if (typeof worktreeId !== 'string' || typeof groupId !== 'string' || !Array.isArray(seatTabIds)) {
    return null
  }
  return {
    worktreeId,
    groupId,
    seatTabIds: seatTabIds.filter((id): id is string => typeof id === 'string')
  }
}
