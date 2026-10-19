import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUiStore } from '../stores/uiStore'
import { claudeUsageRetryAt, loadClaudeUsage, resetClaudeUsageCooldown } from './claudeUsageCache'
import type { ClaudeUsage } from './tauri'
import { clearAllTtlCaches } from './ttlCache'

const { getClaudeUsage } = vi.hoisted(() => ({ getClaudeUsage: vi.fn() }))
vi.mock('./tauri', () => ({ getClaudeUsage }))

const reading: ClaudeUsage = {
  five_hour: { utilization: 34, resets_at: '2026-09-29T20:00:00Z' },
  seven_day: { utilization: 46, resets_at: '2026-10-01T09:00:00Z' },
  seven_day_opus: { utilization: 0, resets_at: '' },
  model_limits: [],
}

const RATE_LIMITED = 'API returned 429 Too Many Requests'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-19T20:00:00Z'))
  clearAllTtlCaches()
  resetClaudeUsageCooldown()
  getClaudeUsage.mockReset()
  useUiStore.setState({ claudeUsage: null, claudeUsageError: null, claudeUsageRetryAt: null })
})

afterEach(() => {
  vi.useRealTimers()
})

// The usage API rate limits readily; that is not the same as having no token (#244).
describe('loadClaudeUsage', () => {
  it('keeps the last reading when a refresh is refused', async () => {
    getClaudeUsage.mockResolvedValueOnce(reading)
    await loadClaudeUsage()

    getClaudeUsage.mockRejectedValueOnce(RATE_LIMITED)
    expect(await loadClaudeUsage(true)).toBeNull()

    expect(useUiStore.getState().claudeUsage).toEqual(reading)
    expect(useUiStore.getState().claudeUsageError).toBe('rate_limited')
  })

  it('says there is no token only when there is none', async () => {
    getClaudeUsage.mockResolvedValueOnce(reading)
    await loadClaudeUsage()

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

    getClaudeUsage.mockResolvedValueOnce(reading)
    expect(await loadClaudeUsage(true)).toEqual(reading)
    expect(useUiStore.getState().claudeUsageError).toBeNull()
  })

  it('never brings back a reading from the cache after a refresh failed', async () => {
    getClaudeUsage.mockResolvedValueOnce(reading)
    await loadClaudeUsage()
    getClaudeUsage.mockRejectedValueOnce('no_token')
    await loadClaudeUsage(true)

    // The regular poll comes around again within the cache window.
    getClaudeUsage.mockRejectedValueOnce('no_token')
    await loadClaudeUsage()

    expect(getClaudeUsage).toHaveBeenCalledTimes(3)
    expect(useUiStore.getState().claudeUsage).toBeNull()
    expect(useUiStore.getState().claudeUsageError).toBe('no_token')
  })
})

describe('rate limit cooldown', () => {
  it('sends no request during the cooldown, not even a forced refresh', async () => {
    getClaudeUsage.mockRejectedValueOnce(RATE_LIMITED)
    await loadClaudeUsage(true)

    await loadClaudeUsage(true)
    await loadClaudeUsage()

    expect(getClaudeUsage).toHaveBeenCalledTimes(1)
    expect(useUiStore.getState().claudeUsageError).toBe('rate_limited')
    expect(useUiStore.getState().claudeUsageRetryAt).toBe(Date.now() + 60_000)
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

  it('waits as long as Retry-After says', async () => {
    getClaudeUsage.mockRejectedValueOnce(`${RATE_LIMITED}; retry-after=120`)
    await loadClaudeUsage(true)

    expect(claudeUsageRetryAt()).toBe(Date.now() + 120_000)
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
    getClaudeUsage.mockRejectedValueOnce(RATE_LIMITED)
    await loadClaudeUsage(true)
    expect(claudeUsageRetryAt()).toBe(Date.now() + 60_000)
  })
})
