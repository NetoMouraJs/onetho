import { describe, expect, it } from 'vitest'

import {
  AI_MEMORY_OWNERCODE_REPO,
  AI_MEMORY_REPO,
  aiMemoryErrorMessage,
  aiMemoryRepoFor,
  type AiMemoryStatus,
  aiMemoryWorkerFlags,
  canStart,
  isOwnerCodeBuild,
  normalizePort,
  offerInstall,
  portOwnedByOther,
} from './aiMemory'
import type { TFunction } from './i18n'
import type { AiMemoryCapabilities } from './tauri/aiMemory'

const NO_CAPABILITIES: AiMemoryCapabilities = {
  workerContract: false,
  sessionRoles: false,
  sessionLabel: false,
  build: null,
  repository: null,
}

/** What the OwnerCode build reported before it named itself. */
const WORKER_CAPABILITIES: AiMemoryCapabilities = {
  ...NO_CAPABILITIES,
  workerContract: true,
  sessionRoles: true,
  sessionLabel: true,
}

function status(patch: Partial<AiMemoryStatus> = {}): AiMemoryStatus {
  return {
    installed: false,
    running: false,
    command: 'ai-memory',
    endpoint: '127.0.0.1:49374',
    version: null,
    managed: false,
    supported: true,
    ours: false,
    capabilities: NO_CAPABILITIES,
    ...patch,
  }
}

describe('which ai-memory build is installed', () => {
  it('names an upstream build and links upstream', () => {
    const upstream = status({ installed: true })
    expect(isOwnerCodeBuild(upstream)).toBe(false)
    expect(aiMemoryWorkerFlags(upstream)).toEqual([])
    expect(aiMemoryRepoFor(upstream)).toBe(AI_MEMORY_REPO)
  })

  it('takes a build with the worker contract as OwnerCode until it names itself', () => {
    const fork = status({ installed: true, capabilities: WORKER_CAPABILITIES })
    expect(isOwnerCodeBuild(fork)).toBe(true)
    expect(aiMemoryWorkerFlags(fork)).toEqual(['handoff', 'reviewers', 'sessions'])
    expect(aiMemoryRepoFor(fork)).toBe(AI_MEMORY_OWNERCODE_REPO)
  })

  it('trusts the name and repository a build reports', () => {
    const named = status({
      installed: true,
      capabilities: {
        ...WORKER_CAPABILITIES,
        build: 'other',
        repository: 'https://github.com/someone/ai-memory',
      },
    })
    expect(isOwnerCodeBuild(named)).toBe(false)
    expect(aiMemoryRepoFor(named)).toBe('https://github.com/someone/ai-memory')
  })

  it('reads nothing from a binary that is not installed', () => {
    expect(isOwnerCodeBuild(status({ capabilities: WORKER_CAPABILITIES }))).toBe(false)
  })
})

describe('whether the panel offers to install', () => {
  it('offers when nothing is installed and upstream builds for this machine', () => {
    expect(offerInstall(status())).toBe(true)
  })

  it('does not offer on a machine upstream publishes no build for', () => {
    // Windows on ARM. Saying so beats a button that downloads a 404.
    expect(offerInstall(status({ supported: false }))).toBe(false)
  })

  it('does not offer when a binary is already there', () => {
    expect(offerInstall(status({ installed: true }))).toBe(false)
  })

  it('does not offer while another server answers on the port', () => {
    // An external copy without a binary on PATH; a second install would split the memory.
    expect(offerInstall(status({ running: true }))).toBe(false)
  })

  it('offers nothing while the status is unknown, and names no build', () => {
    expect(isOwnerCodeBuild(null)).toBe(false)
    expect(aiMemoryWorkerFlags(null)).toEqual([])
    expect(offerInstall(null)).toBe(false)
  })
})

describe('whether starting is offered', () => {
  it('needs a binary', () => {
    expect(canStart(status())).toBe(false)
    expect(canStart(status({ installed: true }))).toBe(true)
  })

  it('is not offered while something already answers on the endpoint', () => {
    expect(canStart(status({ installed: true, running: true }))).toBe(false)
  })
})

describe('who owns the endpoint', () => {
  it('names a server Alethe did not start', () => {
    // Most likely the person's own instance: a reason to leave it alone, not to fight for the bind.
    expect(portOwnedByOther(status({ installed: true, running: true, ours: false }))).toBe(true)
  })

  it('says nothing when the running server is ours', () => {
    expect(portOwnedByOther(status({ installed: true, running: true, ours: true }))).toBe(false)
  })

  it('says nothing when nothing is running', () => {
    expect(portOwnedByOther(status({ installed: true, ours: false }))).toBe(false)
  })
})

describe('the port a person can type', () => {
  it('keeps a usable port and falls back to the default otherwise', () => {
    expect(normalizePort(50000)).toBe(50000)
    expect(normalizePort(0)).toBe(49374)
    expect(normalizePort(70000)).toBe(49374)
    expect(normalizePort(Number.NaN)).toBe(49374)
  })
})

describe('turning a raw error code into a sentence', () => {
  // Echoes the key back rather than a real translation: the mapping under test is code -> key,
  // not key -> copy, which the locale files already guard at build time.
  const t: TFunction = ((key: string) => key) as TFunction

  it('names the port already being in use', () => {
    expect(aiMemoryErrorMessage('ai_memory_port_in_use', t)).toBe('aiMemory.error.portInUse')
  })

  it('names an unsupported platform', () => {
    expect(aiMemoryErrorMessage('ai_memory_unsupported_platform', t)).toBe(
      'aiMemory.error.unsupportedPlatform',
    )
  })

  it('names a binary that went missing after extraction', () => {
    expect(aiMemoryErrorMessage('ai_memory_binary_missing', t)).toBe('aiMemory.error.binaryMissing')
  })

  it('falls back to the raw cause for anything unmapped, rather than swallowing it', () => {
    expect(aiMemoryErrorMessage('some_future_code', t)).toBe('some_future_code')
    expect(aiMemoryErrorMessage(new Error('boom'), t)).toBe('Error: boom')
  })
})
