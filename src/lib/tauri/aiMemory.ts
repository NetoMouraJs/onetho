import { invoke } from '@tauri-apps/api/core'

export type AiMemoryStatus = {
  installed: boolean
  /** Something answers on the loopback endpoint — not necessarily a server Alethe started. */
  running: boolean
  command: string
  endpoint: string
  version: string | null
  /** The binary is the copy Alethe installed, not one found on PATH. */
  managed: boolean
  /** Upstream publishes a build for this machine. False on Windows ARM64. */
  supported: boolean
  /** The server behind `endpoint`, if any, is the child process Alethe itself started. */
  ours: boolean
  /** What the build reports in `ai-memory capabilities --json`; all off when it has no such command. */
  capabilities: AiMemoryCapabilities
}

export type AiMemoryCapabilities = {
  /** Workers keep the user's handoff, and reviewer/QA workers start without recall. */
  workerContract: boolean
  /** Captured worker sessions carry their role. */
  sessionRoles: boolean
  /** Captured worker sessions carry the job label. */
  sessionLabel: boolean
  /** The build's own name, e.g. `ownercode`. */
  build: string | null
  /** Where the build comes from (a GitHub address). */
  repository: string | null
}

export async function aiMemoryDetect(command?: string): Promise<AiMemoryStatus> {
  return invoke<AiMemoryStatus>('ai_memory_detect', { command })
}

// The backend selects HTTP for ai-memory 2.x and the stdio bridge for 3.x.
export async function aiMemoryMcpConfigPath(repo: string): Promise<string> {
  return invoke<string>('ai_memory_mcp_config_path', { repo })
}

/**
 * Prepares ai-memory for a Codex/OpenCode terminal in `repo` and returns its launch arguments.
 * Leaves a global ai-memory setup alone and clears the in-repo entries earlier versions wrote.
 */
export async function aiMemoryTerminalSetup(
  repo: string,
  agent: 'codex' | 'opencode',
  enabled: boolean,
): Promise<string[]> {
  return invoke<string[]>('ai_memory_terminal_setup', { repo, agent, enabled })
}

export type AiMemoryCounts = { sessions: number; observations: number; pages: number }

export async function aiMemoryInstall(): Promise<string> {
  return invoke<string>('ai_memory_install')
}

export async function aiMemoryStart(port?: number): Promise<void> {
  await invoke('ai_memory_start', { port })
}

export async function aiMemoryStop(): Promise<void> {
  await invoke('ai_memory_stop')
}

/**
 * `null` means ai-memory could not be asked — the server is unreachable, `status` exited non-zero —
 * which is not the same thing as a store that has nothing in it yet. Callers must tell the two apart
 * rather than falling back to zeros for both.
 */
export async function aiMemoryCounts(): Promise<AiMemoryCounts | null> {
  return invoke<AiMemoryCounts | null>('ai_memory_counts', {})
}
