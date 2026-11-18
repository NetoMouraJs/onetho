import { expect, test } from '@playwright/test'

/**
 * Playwright + stub manual de `__TAURI_INTERNALS__` (equivalente funcional a
 * `@tauri-apps/api/mocks` no Vitest). A documentação oficial do Tauri v2 recomenda
 * Vitest + mockIPC para isso; WebdriverIO browser mode para E2E no Chrome com invoke mock.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const invoke = (cmd: string, _args?: Record<string, unknown>) => {
      switch (cmd) {
        case 'list_profiles':
          return Promise.resolve({ active_profile_id: 'default', profiles: [] })
        case 'load_projects':
          return Promise.resolve(null)
        case 'record_app_event':
        case 'record_frontend_error':
          return Promise.resolve(null)
        default:
          return Promise.resolve(null)
      }
    }
    ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke,
      transformCallback: (cb: unknown) => cb,
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { windowLabel: 'main', label: 'main' },
      },
    }
  })
})

test('dev shell mounts #root with injected Tauri mocks', async ({ page }) => {
  await page.goto('/')
  const root = page.locator('#root')
  await expect(root).toBeVisible()
  await expect
    .poll(async () => root.evaluate((el) => el.childElementCount), { timeout: 20_000 })
    .toBeGreaterThan(0)
})