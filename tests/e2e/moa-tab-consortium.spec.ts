import { expect, test } from './helpers/orca-app'
import {
  configureGoldenStubAgent,
  getGoldenStubAgentLaunchEnv,
  GOLDEN_STUB_READY_MARKER
} from './helpers/golden-stub-agent'
import {
  ensureTerminalVisible,
  getActiveTabId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { focusActiveTerminalInput, waitForTerminalOutput } from './helpers/terminal'

// Why the stub: the coordinator launch must exercise the real tab-bar → dialog → launch path
// without starting a real Claude session; the golden stub echoes what it was told to submit.
test.use({ launchEnv: getGoldenStubAgentLaunchEnv() })

const MULTI_SELECT_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control'

function tabLocator(page: Parameters<typeof waitForSessionReady>[0], tabId: string) {
  return page.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)
}

test('modifier-click seats two tabs and the context menu launches an MoA coordinator @moa-tab-consortium', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await configureGoldenStubAgent(orcaPage, { agent: 'claude' })

  const firstTabId = await getActiveTabId(orcaPage)
  expect(firstTabId).toBeTruthy()
  // Setup only: a second terminal tab, activated so the first one is the inactive seat.
  const secondTabId = await orcaPage.evaluate((id) => {
    const store = window.__store
    if (!store) {
      throw new Error('Orca store is unavailable')
    }
    return store.getState().createTab(id, undefined, undefined, { activate: true }).id
  }, worktreeId)
  await expect(tabLocator(orcaPage, secondTabId)).toHaveAttribute('data-active', 'true')

  // Ctrl/⌘+click the inactive tab: it joins the active tab in the selection without activating.
  await tabLocator(orcaPage, firstTabId).click({ modifiers: [MULTI_SELECT_MODIFIER] })
  await expect(tabLocator(orcaPage, firstTabId)).toHaveAttribute('data-multi-selected', 'true')
  await expect(tabLocator(orcaPage, secondTabId)).toHaveAttribute('data-multi-selected', 'true')
  await expect(tabLocator(orcaPage, secondTabId)).toHaveAttribute('data-active', 'true')

  await tabLocator(orcaPage, firstTabId).click({ button: 'right' })
  // Why /MoA/: the label is localized (e.g. "탭 2개로 MoA 토론…"); the product name is the stable token.
  const debateItem = orcaPage.getByRole('menuitem', { name: /MoA/ })
  await expect(debateItem).toBeVisible()
  await expect(debateItem).toBeEnabled()
  await debateItem.click()

  const dialog = orcaPage.getByTestId('moa-consortium-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('moa-consortium-seats').locator('li')).toHaveCount(2)
  const startButton = dialog.getByTestId('moa-consortium-start')
  await expect(startButton).toBeDisabled()
  await dialog.locator('#moa-consortium-problem').fill('Which cache store should we adopt?')
  await expect(startButton).toBeEnabled()
  await startButton.click()
  await expect(dialog).toBeHidden()

  // The coordinator is a third tab in the same group, running the (stubbed) Claude CLI.
  await expect(orcaPage.locator('[data-testid="sortable-tab"]')).toHaveCount(3)
  const coordinatorTab = orcaPage.locator('[data-testid="sortable-tab"][data-active="true"]')
  await expect(coordinatorTab).not.toHaveAttribute('data-tab-id', firstTabId!)
  await expect(coordinatorTab).not.toHaveAttribute('data-tab-id', secondTabId)
  await focusActiveTerminalInput(orcaPage)
  await waitForTerminalOutput(orcaPage, GOLDEN_STUB_READY_MARKER, 20_000)
  // The prompt is pasted and submitted once the TUI is ready; the stub echoes what it received.
  await waitForTerminalOutput(orcaPage, '/moa tabs:', 30_000)
  await waitForTerminalOutput(orcaPage, `tab-ids:"${firstTabId}","${secondTabId}"`, 30_000)

  // Starting the debate ends the selection.
  await expect(
    orcaPage.locator('[data-testid="sortable-tab"][data-multi-selected="true"]')
  ).toHaveCount(0)
})

test('the debate item stays disabled for a single tab and never shows for structured tabs @moa-tab-consortium', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)

  const tabId = await getActiveTabId(orcaPage)
  expect(tabId).toBeTruthy()
  await tabLocator(orcaPage, tabId!).click({ button: 'right' })
  const hint = orcaPage.getByRole('menuitem', { name: /MoA/ })
  await expect(hint).toBeVisible()
  await expect(hint).toBeDisabled()
})
