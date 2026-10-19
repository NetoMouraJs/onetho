import { useUiStore } from '../stores/uiStore'
import {
  classifyUsageFailure,
  type DevDiagnosticSource,
  finishDevTrace,
  startDevTrace,
} from './devDiagnostics'
import { type ClaudeUsage, getClaudeUsage } from './tauri'
import { makeTtlCache } from './ttlCache'
import { isUsageAccessOff } from './usageAccess'

const TTL_MS = 60_000

export const getCachedClaudeUsage = makeTtlCache(getClaudeUsage, TTL_MS)

/**
 * Reads Claude usage into the UI store. The usage API rate limits readily, so a failed read keeps
 * the last reading on screen and records that it could not be refreshed; only a missing token
 * clears it.
 */
export async function loadClaudeUsage(
  force = false,
  source: Extract<DevDiagnosticSource, `claude.${string}`> = 'claude.titlebarPoll',
): Promise<ClaudeUsage | null> {
  const trace = startDevTrace(source)
  const { setClaudeUsage, setClaudeUsageError } = useUiStore.getState()
  try {
    const usage = await getCachedClaudeUsage(force)
    setClaudeUsage(usage)
    setClaudeUsageError(null)
    finishDevTrace(trace, 'succeeded')
    return usage
  } catch (error) {
    // Turned off is a choice, not a failure: leave nothing on screen and report no error.
    if (isUsageAccessOff(error)) {
      setClaudeUsage(null)
      setClaudeUsageError(null)
      finishDevTrace(trace, 'skipped')
      return null
    }
    const missingToken = String(error).includes('no_token')
    if (missingToken) setClaudeUsage(null)
    setClaudeUsageError(missingToken ? 'no_token' : 'unavailable')
    finishDevTrace(trace, 'failed', classifyUsageFailure(error), error)
    return null
  }
}
