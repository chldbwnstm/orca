import { stripLeadingAgentTitleDecoration } from '../../../../shared/agent-title-decoration'

export type MoaSeatTerminal = {
  /** Displayed tab title (custom title wins), matched by the skill against `orca terminal list`. */
  title: string
  /** Terminal tab id, reported as `tabId` by `orca terminal list --json`; the exact fallback. */
  tabId: string
}

function quoteSeatName(title: string): string {
  // Why strip the glyph: the tab bar hides the agent's leading decoration, so the user reads
  // and the skill matches the undecorated title; quotes become apostrophes to keep the list parseable.
  const plain = stripLeadingAgentTitleDecoration(title)
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, "'")
    .trim()
  return `"${plain || 'untitled'}"`
}

/** The `/moa tabs:` invocation the coordinator tab submits; see the moa skill's tab-seat mode. */
export function buildMoaConsortiumPrompt(args: {
  seats: readonly MoaSeatTerminal[]
  problem: string
}): string {
  const tabs = args.seats.map((seat) => quoteSeatName(seat.title)).join(',')
  const tabIds = args.seats.map((seat) => `"${seat.tabId}"`).join(',')
  return `/moa tabs:${tabs} tab-ids:${tabIds} ${args.problem.trim()}`
}
