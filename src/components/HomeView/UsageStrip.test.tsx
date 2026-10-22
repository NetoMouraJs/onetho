import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_PREFERENCES } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import type { ClaudeUsage } from '../../lib/tauri'
import { UsageStrip } from './UsageStrip'

vi.mock('../../lib/i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('./ActivityGraph', () => ({ ActivityGraph: () => null }))
vi.mock('../../lib/claudeUsageCache', () => ({
  loadClaudeUsage: vi.fn(async () => null),
  claudeUsageNextRequestAt: () => 0,
}))
vi.mock('../../lib/codexUsageCache', () => ({
  traceCachedCodexUsage: vi.fn(async () => null),
}))
vi.mock('../../lib/kimiUsageCache', () => ({
  getCachedKimiUsage: vi.fn(async () => null),
}))
vi.mock('../../lib/antigravityUsageCache', () => ({
  getCachedAntigravityUsage: vi.fn(async () => null),
}))

const claudeReading: ClaudeUsage = {
  five_hour: { utilization: 12, resets_at: '2026-10-20T12:00:00Z' },
  seven_day: { utilization: 30, resets_at: '2026-10-27T12:00:00Z' },
  seven_day_opus: { utilization: 5, resets_at: '2026-10-27T12:00:00Z' },
}

beforeEach(() => {
  useProjectsStore.setState({
    preferences: {
      ...DEFAULT_PREFERENCES,
      usageShowClaude: true,
      usageShowCodex: false,
      usageShowAntigravity: false,
      usageShowKimi: false,
      usageAccess: { ...DEFAULT_PREFERENCES.usageAccess, claude: true },
    },
  })
  useUiStore.setState({
    claudeUsage: claudeReading,
    claudeUsageError: null,
    claudePlanLabel: null,
  })
})

describe('Claude usage card plan label', () => {
  it('shows the account plan when OAuth metadata provides one', () => {
    useUiStore.setState({ claudePlanLabel: 'pro' })
    render(<UsageStrip showActivity={false} />)
    expect(screen.getByText('pro')).toBeInTheDocument()
  })

  it('shows no plan label when the plan is unknown', () => {
    render(<UsageStrip showActivity={false} />)
    expect(screen.queryByText('max · 5x')).not.toBeInTheDocument()
    expect(screen.queryByText('pro')).not.toBeInTheDocument()
  })
})
