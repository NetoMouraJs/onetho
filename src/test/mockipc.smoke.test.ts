import { invoke } from '@tauri-apps/api/core'
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * Viability check for the official Tauri v2 renderer mocking pattern.
 * @see https://v2.tauri.app/develop/tests/mocking/
 * See docs/TESTING.md and `playwright/shell-mockipc.spec.ts` for Playwright injection notes.
 */
describe('mockIPC smoke (Tauri v2)', () => {
  afterEach(() => {
    clearMocks()
  })

  it('mockWindows satisfies getCurrentWindow() used at module load', () => {
    mockWindows('main')
    expect(getCurrentWindow().label).toBe('main')
  })

  it('mockIPC stubs invoke for bootstrap commands', async () => {
    mockWindows('main')
    mockIPC((cmd) => {
      if (cmd === 'list_profiles') {
        return { active_profile_id: 'default', profiles: [] }
      }
      if (cmd === 'load_projects') {
        return null
      }
      return null
    })
    await expect(invoke('list_profiles')).resolves.toMatchObject({
      active_profile_id: 'default',
    })
    await expect(invoke('load_projects')).resolves.toBeNull()
  })
})