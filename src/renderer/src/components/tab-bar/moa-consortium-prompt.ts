import { stripLeadingAgentTitleDecoration } from '../../../../shared/agent-title-decoration'

export type MoaSeatTerminal = {
  /** Displayed tab title (custom title wins), matched by the skill against `orca terminal list`. */
  title: string
  /** Terminal tab id, reported as `tabId` by `orca terminal list --json`; the exact fallback. */
  tabId: string
}

function seatName(title: string): string {
  // Why no quotes and no pipes: the prompt is a shell argv and PowerShell drops bare double quotes
  // on the way to a native command, so titles are separated by '|' and carry neither.
  const plain = stripLeadingAgentTitleDecoration(title)
    .replace(/[\r\n|"']+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain || 'untitled'
}

/** The `/moa tabs:` invocation the coordinator tab submits; see the moa skill's tab-seat mode. */
export function buildMoaConsortiumPrompt(args: {
  seats: readonly MoaSeatTerminal[]
  problem: string
}): string {
  const tabs = args.seats.map((seat) => seatName(seat.title)).join('|')
  const tabIds = args.seats.map((seat) => seat.tabId).join(',')
  // Why one line: the prompt travels as a shell argv; a newline would end the command on Windows shells.
  const problem = args.problem.replace(/\s*[\r\n]+\s*/g, ' ').trim()
  return `/moa tabs:${tabs} tab-ids:${tabIds} ${problem}`
}
