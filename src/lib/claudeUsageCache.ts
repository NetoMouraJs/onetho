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
const COOLDOWN_BASE_MS = 60_000
const COOLDOWN_MAX_MS = 15 * 60_000
const RATE_LIMITED = 'rate_limited'

let retryAt = 0
let consecutiveRateLimits = 0

/** When the next Claude usage request may go out after a 429, or null when nothing holds it. */
export function claudeUsageRetryAt(): number | null {
  return retryAt > Date.now() ? retryAt : null
}

/** Clears the 429 cooldown; for tests. */
export function resetClaudeUsageCooldown(): void {
  retryAt = 0
  consecutiveRateLimits = 0
}

function cooldownAfter(error: unknown): number | null {
  const message = String(error)
  if (!/API returned 429\b/.test(message)) return null
  const retryAfter = /retry-after=(\d+)/.exec(message)
  if (retryAfter) return Math.min(Number(retryAfter[1]) * 1000, COOLDOWN_MAX_MS)
  return Math.min(COOLDOWN_BASE_MS * 2 ** consecutiveRateLimits, COOLDOWN_MAX_MS)
}

/**
 * Every Claude usage request goes through here. After a 429 no caller reaches the API until the
 * cooldown ends (Retry-After, or a doubling backoff without one): another request only keeps the
 * limit hit.
 */
async function fetchClaudeUsage(): Promise<ClaudeUsage> {
  if (claudeUsageRetryAt() !== null) throw RATE_LIMITED
  try {
    const usage = await getClaudeUsage()
    consecutiveRateLimits = 0
    return usage
  } catch (error) {
    const cooldown = cooldownAfter(error)
    if (cooldown !== null) {
      retryAt = Date.now() + cooldown
      consecutiveRateLimits += 1
    }
    throw error
  }
}

export const getCachedClaudeUsage = makeTtlCache(fetchClaudeUsage, TTL_MS)

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
    const nextTry = claudeUsageRetryAt()
    if (nextTry !== null) {
      setClaudeUsageError('rate_limited', nextTry)
    } else {
      setClaudeUsageError(missingToken ? 'no_token' : 'unavailable')
    }
    // A read held back by the cooldown never reached the API.
    if (error === RATE_LIMITED) finishDevTrace(trace, 'skipped')
    else finishDevTrace(trace, 'failed', classifyUsageFailure(error), error)
    return null
  }
}
