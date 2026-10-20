import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUiStore } from '../stores/uiStore'
import {
  getCachedCodexUsage,
  receiveCodexSessionUsage,
  resetCodexUsageSources,
} from './codexUsageCache'
import type { CodexUsage } from './tauri'
import { clearAllTtlCaches } from './ttlCache'
import { setUsageAccess } from './usageAccess'

const { getCodexUsage } = vi.hoisted(() => ({ getCodexUsage: vi.fn() }))
vi.mock('./tauri', () => ({ getCodexUsage }))

const window = (used: number, minutes: number) => ({
  used_percent: used,
  window_minutes: minutes,
  resets_at_ms: 0,
})

const usage = (used: number, credits = 0): CodexUsage => ({
  primary: window(used, 300),
  secondary: window(10, 10_080),
  plan: 'plus',
  rate_limited: false,
  reset_credits: credits,
  reset_credit_items: [],
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-19T20:00:00Z'))
  clearAllTtlCaches()
  resetCodexUsageSources()
  setUsageAccess({ codex: true })
  getCodexUsage.mockReset()
  useUiStore.setState({ codexUsage: null, codexUsageSource: null })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Codex usage sources', () => {
  it('shows a pushed session reading and serves it without calling the API', async () => {
    receiveCodexSessionUsage({ usage: usage(36), at_ms: Date.now() })

    expect(useUiStore.getState().codexUsage?.primary.used_percent).toBe(36)
    expect(useUiStore.getState().codexUsageSource).toEqual({ kind: 'session', at: Date.now() })
    expect((await getCachedCodexUsage()).primary.used_percent).toBe(36)
    expect(getCodexUsage).not.toHaveBeenCalled()
  })

  it('asks the API on a forced read, even with a recent session reading', async () => {
    receiveCodexSessionUsage({ usage: usage(36), at_ms: Date.now() })
    getCodexUsage.mockResolvedValueOnce(usage(40))

    expect((await getCachedCodexUsage(true)).primary.used_percent).toBe(40)
    expect(useUiStore.getState().codexUsageSource).toEqual({ kind: 'api', at: Date.now() })
  })

  it('goes back to the API once the session reading is old', async () => {
    receiveCodexSessionUsage({ usage: usage(36), at_ms: Date.now() })
    vi.advanceTimersByTime(10 * 60_000)
    getCodexUsage.mockResolvedValueOnce(usage(41))

    expect((await getCachedCodexUsage()).primary.used_percent).toBe(41)
  })

  it('ignores a session reading older than what the API or an earlier push said', async () => {
    getCodexUsage.mockResolvedValueOnce(usage(40))
    await getCachedCodexUsage(true)
    useUiStore.setState({ codexUsage: usage(40) })

    receiveCodexSessionUsage({ usage: usage(30), at_ms: Date.now() - 1_000 })
    expect(useUiStore.getState().codexUsage?.primary.used_percent).toBe(40)

    vi.advanceTimersByTime(2_000)
    receiveCodexSessionUsage({ usage: usage(45), at_ms: Date.now() })
    receiveCodexSessionUsage({ usage: usage(44), at_ms: Date.now() - 500 })
    expect(useUiStore.getState().codexUsage?.primary.used_percent).toBe(45)
  })

  it('keeps the reset credits only the API reports', async () => {
    getCodexUsage.mockResolvedValueOnce(usage(40, 2))
    await getCachedCodexUsage(true)
    vi.advanceTimersByTime(1_000)

    receiveCodexSessionUsage({ usage: usage(45), at_ms: Date.now() })

    expect(useUiStore.getState().codexUsage?.reset_credits).toBe(2)
  })

  it('shows nothing pushed while Codex usage reading is off', () => {
    setUsageAccess({ codex: false })

    receiveCodexSessionUsage({ usage: usage(36), at_ms: Date.now() })

    expect(useUiStore.getState().codexUsage).toBeNull()
  })
})
