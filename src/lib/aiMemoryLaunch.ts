import { useProjectsStore } from '../stores/projectsStore'
import { aiMemoryDetect, aiMemoryTerminalSetup } from './tauri/aiMemory'

/**
 * The launch arguments ai-memory needs for a Codex or OpenCode terminal in `cwd`, once the backend
 * has set up (or cleared) what it keeps in the repository. Any other agent, or no folder, gets none.
 * Every launch and relaunch goes through here, since Codex only reads `-c` overrides at start.
 */
export async function aiMemoryTerminalArgs(
  agent: string | null | undefined,
  cwd: string | null | undefined,
  onMissing?: () => void,
): Promise<string[]> {
  if (!cwd || (agent !== 'codex' && agent !== 'opencode')) return []
  let enabled = useProjectsStore.getState().preferences.enabledFeatures.aiMemory
  if (enabled) {
    const status = await aiMemoryDetect().catch(() => undefined)
    if (!status?.installed) {
      onMissing?.()
      enabled = false
    }
  }
  return aiMemoryTerminalSetup(cwd, agent, enabled).catch(() => [])
}
