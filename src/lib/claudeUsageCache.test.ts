import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUiStore } from '../stores/uiStore'
import {
  claudeUsageNextRequestAt,
  claudeUsageRetryAt,
  getCachedClaudeUsage,
  loadClaudeUsage,
  receiveClaudeSessionUsage,
  resetClaudeUsageCooldown,
  resetClaudeUsageSources,
} from './claudeUsageCache'
import type { ClaudeUsage } from './tauri'
import { clearAllTtlCaches } from './ttlCache'
import { setUsageAccess } from './usageAccess'

const { getClaudeUsage } = vi.hoisted(() => ({ getClaudeUsage: vi.fn() }))
vi.mock('./tauri', () => ({ getClaudeUsage }))

const reading: ClaudeUsage = {
  five_hour: { utilization: 34, resets_at: '2026-09-29T20:00:00Z' },
  seven_day: { utilization: 46, resets_at: '2026-10-01T09:00:00Z' },
  seven_day_opus: { utilization: 0, resets_at: '' },
  model_limits: [],
}

const RATE_LIMITED = 'API returned 429 Too Many Requests'
const GAP_MS = 30_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-19T20:00:00Z'))
  clearAllTtlCaches()
  resetClaudeUsageCooldown()
  resetClaudeUsageSources()
  setUsageAccess({ claude: true })
  getClaudeUsage.mockReset()
  useUiStore.setState({
    claudeUsage: null,
    claudeUsageError: null,
    claudeUsageRetryAt: null,
    claudeUsageLoading: false,
    claudeUsageSource: null,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

// The usage API rate limits readily; that is not the same as having no token (#244).
describe('loadClaudeUsage', () => {
  it('keeps the last reading when a refresh is refused', async () => {
    getClaudeUsage.mockResolvedValueOnce(reading)
    await loadClaudeUsage()
    vi.advanceTimersByTime(GAP_MS)

    getClaudeUsage.mockRejectedValueOnce(RATE_LIMITED)
    expect(await loadClaudeUsage(true)).toBeNull()

    expect(useUiStore.getState().claudeUsage).toEqual(reading)
    expect(useUiStore.getState().claudeUsageError).toBe('rate_limited')
  })

  it('says there is no token only when there is none', async () => {
    getClaudeUsage.mockResolvedValueOnce(reading)
    await loadClaudeUsage()
    vi.advanceTimersByTime(GAP_MS)

    getClaudeUsage.mockRejectedValueOnce('no_token')
    await loadClaudeUsage(true)

    expect(useUiStore.getState().claudeUsage).toBeNull()
    expect(useUiStore.getState().claudeUsageError).toBe('no_token')
  })

  it('reports other HTTP failures as unavailable, without a cooldown', async () => {
    getClaudeUsage.mockRejectedValueOnce('API returned 500 Internal Server Error')
    await loadClaudeUsage(true)
    expect(useUiStore.getState().claudeUsageError).toBe('unavailable')
    expect(claudeUsageRetryAt()).toBeNull()
    vi.advanceTimersByTime(GAP_MS)

    getClaudeUsage.mockResolvedValueOnce(reading)
    expect(await loadClaudeUsage(true)).toEqual(reading)
    expect(useUiStore.getState().claudeUsageError).toBeNull()
  })

  it('never brings back a reading from the cache after a refresh failed', async () => {
    getClaudeUsage.mockResolvedValueOnce(reading)
    await loadClaudeUsage()
    vi.advanceTimersByTime(GAP_MS)
    getClaudeUsage.mockRejectedValueOnce('no_token')
    await loadClaudeUsage(true)
    vi.advanceTimersByTime(GAP_MS)

    // The regular poll comes around again within the cache window.
    getClaudeUsage.mockRejectedValueOnce('no_token')
    await loadClaudeUsage()

    expect(getClaudeUsage).toHaveBeenCalledTimes(3)
    expect(useUiStore.getState().claudeUsage).toBeNull()
    expect(useUiStore.getState().claudeUsageError).toBe('no_token')
  })
})

describe('loading state', () => {
  it('says a read is on its way until the last caller gets its answer', async () => {
    let answer: (value: ClaudeUsage) => void = () => undefined
    getClaudeUsage.mockReturnValueOnce(new Promise<ClaudeUsage>((resolve) => (answer = resolve)))

    const first = loadClaudeUsage(true)
    const second = loadClaudeUsage()
    expect(useUiStore.getState().claudeUsageLoading).toBe(true)

    answer(reading)
    await Promise.all([first, second])
    expect(useUiStore.getState().claudeUsageLoading).toBe(false)
    expect(getClaudeUsage).toHaveBeenCalledTimes(1)
  })
})

describe('request throttle', () => {
  it('serves a forced refresh inside the minimum gap from the cache', async () => {
    getClaudeUsage.mockResolvedValue(reading)
    await loadClaudeUsage(true)
    vi.advanceTimersByTime(GAP_MS - 1)

    expect(await loadClaudeUsage(true)).toEqual(reading)
    expect(getClaudeUsage).toHaveBeenCalledTimes(1)
    expect(claudeUsageNextRequestAt()).toBe(Date.now() + 1)

    vi.advanceTimersByTime(1)
    await loadClaudeUsage(true)
    expect(getClaudeUsage).toHaveBeenCalledTimes(2)
  })

  it('holds a read back inside the gap after a failure without changing what is shown', async () => {
    getClaudeUsage.mockRejectedValueOnce('API returned 500 Internal Server Error')
    await loadClaudeUsage(true)

    await loadClaudeUsage()

    expect(getClaudeUsage).toHaveBeenCalledTimes(1)
    expect(useUiStore.getState().claudeUsageError).toBe('unavailable')
  })

  it('sends no request during the cooldown, not even a forced refresh', async () => {
    getClaudeUsage.mockRejectedValueOnce(RATE_LIMITED)
    await loadClaudeUsage(true)

    await loadClaudeUsage(true)
    await loadClaudeUsage()

    expect(getClaudeUsage).toHaveBeenCalledTimes(1)
    expect(useUiStore.getState().claudeUsageError).toBe('rate_limited')
    expect(useUiStore.getState().claudeUsageRetryAt).toBe(Date.now() + 60_000)
    expect(claudeUsageNextRequestAt()).toBe(Date.now() + 60_000)
  })

  it('recovers on the first refresh after the cooldown', async () => {
    getClaudeUsage.mockRejectedValueOnce(RATE_LIMITED)
    await loadClaudeUsage(true)

    vi.advanceTimersByTime(60_000)
    getClaudeUsage.mockResolvedValueOnce(reading)
    expect(await loadClaudeUsage(true)).toEqual(reading)

    expect(useUiStore.getState().claudeUsageError).toBeNull()
    expect(useUiStore.getState().claudeUsageRetryAt).toBeNull()
  })

  it('waits as long as Retry-After says when that is longer than the backoff', async () => {
    getClaudeUsage.mockRejectedValueOnce(`${RATE_LIMITED}; retry-after=120`)
    await loadClaudeUsage(true)

    expect(claudeUsageRetryAt()).toBe(Date.now() + 120_000)
  })

  // What the usage API actually sends with its 429.
  it('still backs off when Retry-After is 0', async () => {
    getClaudeUsage.mockRejectedValueOnce(`${RATE_LIMITED}; retry-after=0`)
    await loadClaudeUsage(true)

    await loadClaudeUsage(true)

    expect(claudeUsageRetryAt()).toBe(Date.now() + 60_000)
    expect(getClaudeUsage).toHaveBeenCalledTimes(1)
  })

  it('doubles the wait while the API keeps refusing, and resets after a success', async () => {
    getClaudeUsage.mockRejectedValueOnce(RATE_LIMITED)
    await loadClaudeUsage(true)
    vi.advanceTimersByTime(60_000)

    getClaudeUsage.mockRejectedValueOnce(RATE_LIMITED)
    await loadClaudeUsage(true)
    expect(claudeUsageRetryAt()).toBe(Date.now() + 120_000)
    vi.advanceTimersByTime(120_000)

    getClaudeUsage.mockResolvedValueOnce(reading)
    await loadClaudeUsage(true)
    vi.advanceTimersByTime(GAP_MS)
    getClaudeUsage.mockRejectedValueOnce(RATE_LIMITED)
    await loadClaudeUsage(true)
    expect(claudeUsageRetryAt()).toBe(Date.now() + 60_000)
  })

  it('keeps the cooldown across a restart', async () => {
    getClaudeUsage.mockRejectedValueOnce(RATE_LIMITED)
    await loadClaudeUsage(true)
    const retryAt = claudeUsageRetryAt()

    vi.resetModules()
    const reloaded = await import('./claudeUsageCache')
    await reloaded.loadClaudeUsage(true)

    expect(reloaded.claudeUsageRetryAt()).toBe(retryAt)
    expect(getClaudeUsage).toHaveBeenCalledTimes(1)
  })
})

describe('Claude usage from the status line', () => {
  const pushed = (fiveHour: number): ClaudeUsage => ({
    five_hour: { utilization: fiveHour, resets_at: '2026-10-19T23:50:00+00:00' },
    seven_day: { utilization: 50, resets_at: '2026-10-22T09:00:00+00:00' },
    seven_day_opus: { utilization: 0, resets_at: '' },
    model_limits: [],
  })

  it('shows a pushed reading and serves it without calling the API', async () => {
    useUiStore.setState({ claudeUsageError: 'rate_limited' })
    receiveClaudeSessionUsage({ usage: pushed(61), at_ms: Date.now() })

    expect(useUiStore.getState().claudeUsage?.five_hour.utilization).toBe(61)
    expect(useUiStore.getState().claudeUsageError).toBeNull()
    expect(useUiStore.getState().claudeUsageSource).toEqual({ kind: 'session', at: Date.now() })
    expect((await getCachedClaudeUsage()).five_hour.utilization).toBe(61)
    expect(getClaudeUsage).not.toHaveBeenCalled()
  })

  it('keeps the Opus and model limits only the API reports', async () => {
    getClaudeUsage.mockResolvedValueOnce({
      ...reading,
      seven_day_opus: { utilization: 12, resets_at: '2026-10-22T09:00:00Z' },
      model_limits: [{ model: 'Fable', utilization: 7, resets_at: '2026-10-22T09:00:00Z' }],
    })
    await loadClaudeUsage(true)
    vi.advanceTimersByTime(1_000)

    receiveClaudeSessionUsage({ usage: pushed(61), at_ms: Date.now() })

    const shown = useUiStore.getState().claudeUsage
    expect(shown?.five_hour.utilization).toBe(61)
    expect(shown?.seven_day_opus.utilization).toBe(12)
    expect(shown?.model_limits?.[0]?.model).toBe('Fable')
  })

  it('falls back to the pushed reading when a forced read is refused', async () => {
    receiveClaudeSessionUsage({ usage: pushed(61), at_ms: Date.now() })
    getClaudeUsage.mockRejectedValueOnce(RATE_LIMITED)

    expect((await loadClaudeUsage(true))?.five_hour.utilization).toBe(61)
    expect(useUiStore.getState().claudeUsageError).toBeNull()
    expect(useUiStore.getState().claudeUsageSource?.kind).toBe('session')
  })

  it('ignores a reading older than what the API or an earlier push said', async () => {
    getClaudeUsage.mockResolvedValueOnce(reading)
    await loadClaudeUsage(true)

    receiveClaudeSessionUsage({ usage: pushed(20), at_ms: Date.now() - 1_000 })
    expect(useUiStore.getState().claudeUsage?.five_hour.utilization).toBe(34)

    vi.advanceTimersByTime(2_000)
    receiveClaudeSessionUsage({ usage: pushed(61), at_ms: Date.now() })
    receiveClaudeSessionUsage({ usage: pushed(60), at_ms: Date.now() - 500 })
    expect(useUiStore.getState().claudeUsage?.five_hour.utilization).toBe(61)
  })

  it('goes back to the API once the pushed reading is old', async () => {
    receiveClaudeSessionUsage({ usage: pushed(61), at_ms: Date.now() })
    vi.advanceTimersByTime(5 * 60_000)
    getClaudeUsage.mockResolvedValueOnce(reading)

    expect((await getCachedClaudeUsage()).five_hour.utilization).toBe(34)
    expect(useUiStore.getState().claudeUsageSource).toEqual({ kind: 'api', at: Date.now() })
  })

  it('shows nothing pushed while Claude usage reading is off', () => {
    setUsageAccess({ claude: false })

    receiveClaudeSessionUsage({ usage: pushed(61), at_ms: Date.now() })

    expect(useUiStore.getState().claudeUsage).toBeNull()
  })
})
