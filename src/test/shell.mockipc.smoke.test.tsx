import { render, screen, waitFor } from '@testing-library/react'
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { OnboardingModal } from '../components/modals/OnboardingModal'
import { useProjectsStore } from '../stores/projectsStore'

/** Renderer smoke: mounts onboarding UI with a mocked Tauri backend. */
describe('shell smoke with mockIPC', () => {
  beforeEach(() => {
    mockWindows('main')
    mockIPC((cmd) => {
      switch (cmd) {
        case 'list_profiles':
          return { active_profile_id: 'default', profiles: [] }
        case 'load_projects':
          return null
        case 'find_cli_launcher':
        case 'agent_cli_version':
        case 'cloud_sync_status':
        case 'cloud_sync_device_start':
        case 'cloud_sync_device_finish':
        case 'cloud_sync_pull':
        case 'cloud_sync_push':
        case 'open_in_browser':
        case 'record_app_event':
        case 'record_frontend_error':
          return null
        default:
          return null
      }
    })

    useProjectsStore.setState({
      ...useProjectsStore.getState(),
      hydrated: true,
      preferences: {
        ...useProjectsStore.getState().preferences,
        onboardingDone: false,
        displayName: '',
        language: 'en',
      },
    })
  })

  afterEach(() => {
    clearMocks()
  })

  it('renders Quick setup onboarding shell', async () => {
    render(<OnboardingModal />)
    await waitFor(() => {
      expect(screen.getByText(/quick setup/i)).toBeInTheDocument()
      expect(screen.getByPlaceholderText(/your name/i)).toBeInTheDocument()
    })
  })
})