import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionTitle, SubTab } from '../lib/types'

const { getClaudeSessionTitleInfo, getCodexSessionTitleInfo } = vi.hoisted(() => ({
  getClaudeSessionTitleInfo: vi.fn<() => Promise<SessionTitle | null>>(),
  getCodexSessionTitleInfo: vi.fn<() => Promise<SessionTitle | null>>(),
}))

vi.mock('../lib/tauri/sessions', () => ({
  getClaudeSessionTitleInfo,
  getCodexSessionTitleInfo,
}))

const { useSessionTitle } = await import('./useSidebarChatTitle')

let sessionCounter = 0
const claudeTab = () =>
  ({
    id: 'tab',
    type: 'claude',
    name: 'claude',
    cwd: 'C:\\repo',
    sessionId: `session-${++sessionCounter}`,
  }) as SubTab

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

beforeEach(() => {
  vi.useFakeTimers()
  getClaudeSessionTitleInfo.mockReset()
  getCodexSessionTitleInfo.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useSessionTitle', () => {
  it('updates every consumer of a session when one of them reads a new title', async () => {
    getClaudeSessionTitleInfo.mockResolvedValue({ title: 'Automatic', userNamed: false })
    const tab = claudeTab()

    const header = renderHook(() => useSessionTitle(tab))
    await advance(0)
    await advance(60_000)
    const sidebar = renderHook(() => useSessionTitle(tab))
    await advance(0)
    expect(header.result.current?.title).toBe('Automatic')
    expect(sidebar.result.current?.title).toBe('Automatic')

    getClaudeSessionTitleInfo.mockResolvedValue({ title: 'BS-20059', userNamed: true })
    await advance(240_000)

    expect(header.result.current).toEqual({ title: 'BS-20059', userNamed: true })
    expect(sidebar.result.current).toEqual({ title: 'BS-20059', userNamed: true })
  })

  it('keeps the same title object when a refresh reads the same title', async () => {
    getClaudeSessionTitleInfo.mockResolvedValue({ title: 'Automatic', userNamed: false })
    const tab = claudeTab()
    const { result } = renderHook(() => useSessionTitle(tab))
    await advance(0)
    const first = result.current

    await advance(300_000)

    expect(getClaudeSessionTitleInfo).toHaveBeenCalledTimes(2)
    expect(result.current).toBe(first)
  })

  it('keeps looking for a title after the first retries come back empty', async () => {
    getClaudeSessionTitleInfo.mockResolvedValue(null)
    const tab = claudeTab()
    const { result } = renderHook(() => useSessionTitle(tab))
    await advance(10 * 60_000)
    expect(result.current).toBeNull()

    getClaudeSessionTitleInfo.mockResolvedValue({ title: 'Late name', userNamed: true })
    await advance(60_000)

    expect(result.current).toEqual({ title: 'Late name', userNamed: true })
  })

  it('picks up a late Codex rename with userNamed set', async () => {
    getCodexSessionTitleInfo.mockResolvedValueOnce({ title: 'Automatic', userNamed: false })
    const tab = {
      id: 'tab',
      type: 'codex',
      name: 'codex',
      cwd: 'C:\\repo',
      sessionId: `codex-${++sessionCounter}`,
    } as SubTab
    const { result } = renderHook(() => useSessionTitle(tab))
    await advance(0)
    expect(result.current).toEqual({ title: 'Automatic', userNamed: false })

    getCodexSessionTitleInfo.mockResolvedValueOnce({ title: 'BS-20059', userNamed: true })
    await advance(300_000)

    expect(result.current).toEqual({ title: 'BS-20059', userNamed: true })
  })
})
