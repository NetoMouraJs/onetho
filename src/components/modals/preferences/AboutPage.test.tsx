import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BRAND_AUTHOR,
  BRAND_AUTHOR_GITHUB,
  BRAND_IDENTIFIER,
  BRAND_REPOSITORY_URL,
} from '../../../lib/brand'
import { fetchAletheReleases } from '../../../lib/releases'
import { openInBrowser } from '../../../lib/tauri/filesystem'
import { EMPTY_PROJECTS_FILE } from '../../../lib/types'
import { useProjectsStore } from '../../../stores/projectsStore'
import { AboutPage } from './AboutPage'

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(async () => '1.7.0'),
  getTauriVersion: vi.fn(async () => '2.8.0'),
}))

vi.mock('../../../lib/tauri/filesystem', () => ({
  openInBrowser: vi.fn(async () => {}),
  openDataFolder: vi.fn(async () => {}),
  openLogsFolder: vi.fn(async () => {}),
}))

vi.mock('../../../lib/backup', () => ({
  exportProfileState: vi.fn(async () => ({ skipped: [], embeddedImages: 0, imageLinksKept: [] })),
  announceBackup: vi.fn(),
}))

vi.mock('../../../lib/dialog', () => ({
  saveFile: vi.fn(async () => 'C:/backups/alethe.zip'),
}))

vi.mock('../../../lib/updater', () => ({
  checkForUpdate: vi.fn(async () => null),
  installPendingUpdate: vi.fn(async () => {}),
  installRelease: vi.fn(() => new Promise<void>(() => {})),
}))

vi.mock('../../../lib/releases', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/releases')>()),
  fetchAletheReleases: vi.fn(async () => [
    { version: '1.7.0', publishedAt: '2026-09-20T12:00:00Z', installable: true },
    { version: '1.6.0', publishedAt: '2026-08-17T12:00:00Z', installable: true },
    { version: '1.2.3', publishedAt: '2026-07-01T12:00:00Z', installable: false },
  ]),
}))

describe('AboutPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
  })

  it('introduces the fork author with a link to their GitHub profile', async () => {
    render(<AboutPage />)
    expect(screen.getByText(BRAND_AUTHOR)).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(await screen.findByText(`${BRAND_IDENTIFIER} · Tauri 2.8.0`)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'GitHub' }))
    expect(openInBrowser).toHaveBeenCalledWith(`https://github.com/${BRAND_AUTHOR_GITHUB}`)
  })

  it('opens the contribution pages on GitHub', () => {
    render(<AboutPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Open a pull request' }))
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }))
    expect(openInBrowser).toHaveBeenCalledWith(`${BRAND_REPOSITORY_URL}/compare`)
    expect(openInBrowser).toHaveBeenCalledWith(
      `${BRAND_REPOSITORY_URL}/issues/new?template=bug_report.yml`,
    )
  })

  // The older-version installer downloads upstream Alethe builds, so the fork keeps it off.
  it('does not offer to install older upstream releases', () => {
    render(<AboutPage />)
    expect(screen.queryByRole('button', { name: 'Show older versions' })).not.toBeInTheDocument()
    expect(fetchAletheReleases).not.toHaveBeenCalled()
  })
})
