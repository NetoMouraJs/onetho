// The ai-memory commands live with the other bindings; they are re-exported for this module's callers.
export {
  type AiMemoryCounts,
  aiMemoryCounts,
  aiMemoryInstall,
  aiMemoryStart,
  type AiMemoryStatus,
  aiMemoryStop,
} from './tauri/aiMemory'
import type { MessageKey, TFunction } from './i18n'
import type { AiMemoryStatus } from './tauri/aiMemory'

export const AI_MEMORY_DEFAULT_PORT = 49374
export const AI_MEMORY_REPO = 'https://github.com/akitaonrails/ai-memory'
export const AI_MEMORY_OWNERCODE_REPO = 'https://github.com/NetoMouraJs/ai-memory'

/**
 * The OwnerCode build of ai-memory: the one that names itself so, or, for builds made before it
 * reported a name, the one that honours the orchestrator worker contract.
 */
export function isOwnerCodeBuild(status: AiMemoryStatus | null): boolean {
  const capabilities = status?.installed ? status.capabilities : undefined
  if (!capabilities) return false
  return capabilities.build ? capabilities.build === 'ownercode' : capabilities.workerContract
}

/** The repository behind the installed build: its own, the OwnerCode fork, or upstream. */
export function aiMemoryRepoFor(status: AiMemoryStatus | null): string {
  return (
    (status?.installed ? status.capabilities.repository : null) ??
    (isOwnerCodeBuild(status) ? AI_MEMORY_OWNERCODE_REPO : AI_MEMORY_REPO)
  )
}

/** The worker features an installed build supports, in display order; empty for upstream builds. */
export function aiMemoryWorkerFlags(
  status: AiMemoryStatus | null,
): Array<'handoff' | 'reviewers' | 'sessions'> {
  const capabilities = status?.installed ? status.capabilities : undefined
  if (!capabilities) return []
  const flags: Array<'handoff' | 'reviewers' | 'sessions'> = []
  if (capabilities.workerContract) flags.push('handoff', 'reviewers')
  if (capabilities.sessionRoles && capabilities.sessionLabel) flags.push('sessions')
  return flags
}

export function offerInstall(status: AiMemoryStatus | null): boolean {
  // A server already answering is someone else's copy: installing another would split the memory.
  return Boolean(status && !status.installed && !status.running && status.supported)
}

export function canStart(status: AiMemoryStatus | null): boolean {
  return Boolean(status && status.installed && !status.running)
}

/** True when the endpoint answers and the server behind it is not the child Alethe started. */
export function portOwnedByOther(status: AiMemoryStatus | null): boolean {
  return Boolean(status?.running) && !status?.ours
}

export function normalizePort(port: number): number {
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : AI_MEMORY_DEFAULT_PORT
}

/** Rust error codes this panel can name, mapped to a real sentence for each locale. */
const AI_MEMORY_ERROR_MESSAGE_KEYS: Record<string, MessageKey> = {
  ai_memory_port_in_use: 'aiMemory.error.portInUse',
  ai_memory_unsupported_platform: 'aiMemory.error.unsupportedPlatform',
  ai_memory_binary_missing: 'aiMemory.error.binaryMissing',
}

/**
 * A sentence for a raw error code a `ai_memory_*` command rejected with, or the raw code itself when
 * it names nothing recognised — never swallowed, just not translated.
 */
export function aiMemoryErrorMessage(cause: unknown, t: TFunction): string {
  const raw = String(cause)
  for (const [code, key] of Object.entries(AI_MEMORY_ERROR_MESSAGE_KEYS)) {
    if (raw.includes(code)) return t(key)
  }
  return raw
}
