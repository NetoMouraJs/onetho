import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'
import { loadClaudePlan } from './claudePlan'
import { DEFAULT_PREFERENCES } from './types'

beforeEach(() => {
  useProjectsStore.setState({
    preferences: {
      ...DEFAULT_PREFERENCES,
      usageAccess: { ...DEFAULT_PREFERENCES.usageAccess, claude: true },
    },
  })
  useUiStore.setState({ claudePlanLabel: null })
  invoke.mockReset()
})

describe('loadClaudePlan', () => {
  it('stores a known plan label from the backend', async () => {
    invoke.mockResolvedValueOnce('pro')
    await loadClaudePlan()
    expect(invoke).toHaveBeenCalledWith('get_claude_plan')
    expect(useUiStore.getState().claudePlanLabel).toBe('pro')
  })

  it('clears the label when the plan is unknown', async () => {
    invoke.mockResolvedValueOnce(null)
    await loadClaudePlan()
    expect(useUiStore.getState().claudePlanLabel).toBeNull()
  })

  it('keeps a known label without reading the credentials again', async () => {
    useUiStore.setState({ claudePlanLabel: 'max · 5x' })
    await loadClaudePlan()
    expect(invoke).not.toHaveBeenCalled()
    expect(useUiStore.getState().claudePlanLabel).toBe('max · 5x')
  })

  it('reads the credentials again when asked to refresh', async () => {
    useUiStore.setState({ claudePlanLabel: 'pro' })
    invoke.mockResolvedValueOnce('max · 20x')
    await loadClaudePlan(true)
    expect(useUiStore.getState().claudePlanLabel).toBe('max · 20x')
  })

  it('clears the label when Claude usage access is off', async () => {
    useProjectsStore.setState({
      preferences: {
        ...DEFAULT_PREFERENCES,
        usageAccess: { ...DEFAULT_PREFERENCES.usageAccess, claude: false },
      },
    })
    useUiStore.setState({ claudePlanLabel: 'pro' })
    await loadClaudePlan(true)
    expect(invoke).not.toHaveBeenCalled()
    expect(useUiStore.getState().claudePlanLabel).toBeNull()
  })

  it('clears the label when credentials cannot be read', async () => {
    invoke.mockRejectedValueOnce(new Error('invoke failed'))
    await loadClaudePlan()
    expect(useUiStore.getState().claudePlanLabel).toBeNull()
  })

  it('keeps the newest lookup when an older one finishes last', async () => {
    let failOlder!: (error: Error) => void
    let resolveNewer!: (label: string) => void
    invoke
      .mockReturnValueOnce(new Promise((_, reject) => (failOlder = reject)))
      .mockReturnValueOnce(new Promise((resolve) => (resolveNewer = resolve)))
    const older = loadClaudePlan()
    const newer = loadClaudePlan(true)
    resolveNewer('max · 20x')
    await newer
    failOlder(new Error('credentials being rewritten'))
    await older
    expect(useUiStore.getState().claudePlanLabel).toBe('max · 20x')
  })

  it('ignores a lookup that finishes after usage access was turned off', async () => {
    let resolveLookup!: (label: string) => void
    invoke.mockReturnValueOnce(new Promise((resolve) => (resolveLookup = resolve)))
    const lookup = loadClaudePlan()
    useProjectsStore.setState({
      preferences: {
        ...DEFAULT_PREFERENCES,
        usageAccess: { ...DEFAULT_PREFERENCES.usageAccess, claude: false },
      },
    })
    await loadClaudePlan()
    resolveLookup('pro')
    await lookup
    expect(useUiStore.getState().claudePlanLabel).toBeNull()
  })
})
