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
const MIN_REQUEST_GAP_MS = 30_000
const COOLDOWN_BASE_MS = 60_000
const COOLDOWN_MAX_MS = 15 * 60_000
const HELD_BACK = 'held_back'
const THROTTLE_KEY = 'onetho.claudeUsageThrottle.v1'

type Throttle = { lastRequestAt: number; retryAt: number; consecutiveRateLimits: number }

const NO_THROTTLE: Throttle = { lastRequestAt: 0, retryAt: 0, consecutiveRateLimits: 0 }

// Kept across restarts and hot reloads: a fresh start must not send the request the API just
// refused.
function readThrottle(): Throttle {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(THROTTLE_KEY) ?? 'null')
    if (!stored || typeof stored !== 'object') return { ...NO_THROTTLE }
    const value = stored as Partial<Throttle>
    const number = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0)
    return {
      lastRequestAt: Math.min(number(value.lastRequestAt), Date.now()),
      retryAt: Math.min(number(value.retryAt), Date.now() + COOLDOWN_MAX_MS),
      consecutiveRateLimits: Math.min(number(value.consecutiveRateLimits), 10),
    }
  } catch {
    return { ...NO_THROTTLE }
  }
}

function saveThrottle(): void {
  try {
    window.localStorage.setItem(THROTTLE_KEY, JSON.stringify(throttle))
  } catch {
    // Without storage the throttle still holds for this session.
  }
}

let throttle = readThrottle()

/** When the next Claude usage request may go out after a 429, or null when nothing holds it. */
export function claudeUsageRetryAt(): number | null {
  return throttle.retryAt > Date.now() ? throttle.retryAt : null
}

/** The earliest time a request may reach the API: after the cooldown and the minimum gap. */
export function claudeUsageNextRequestAt(): number {
  return Math.max(throttle.retryAt, throttle.lastRequestAt + MIN_REQUEST_GAP_MS)
}

/** Clears the request throttle; for tests. */
export function resetClaudeUsageCooldown(): void {
  throttle = { ...NO_THROTTLE }
  try {
    window.localStorage.removeItem(THROTTLE_KEY)
  } catch {
    // Nothing stored to clear.
  }
}

function cooldownAfter(error: unknown): number | null {
  const message = String(error)
  if (!/API returned 429\b/.test(message)) return null
  // The usage API answers 429 with `Retry-After: 0`, so the header only ever lengthens the backoff.
  const retryAfterMs = Number(/retry-after=(\d+)/.exec(message)?.[1] ?? 0) * 1000
  const backoffMs = COOLDOWN_BASE_MS * 2 ** throttle.consecutiveRateLimits
  return Math.min(Math.max(retryAfterMs, backoffMs), COOLDOWN_MAX_MS)
}

/**
 * Every Claude usage request goes through here. Requests are at least MIN_REQUEST_GAP_MS apart,
 * and after a 429 none goes out until the cooldown ends (Retry-After, or a doubling backoff
 * without one): another request only keeps the limit hit.
 */
async function fetchClaudeUsage(): Promise<ClaudeUsage> {
  if (Date.now() < claudeUsageNextRequestAt()) throw HELD_BACK
  throttle.lastRequestAt = Date.now()
  saveThrottle()
  try {
    const usage = await getClaudeUsage()
    throttle = { ...throttle, retryAt: 0, consecutiveRateLimits: 0 }
    saveThrottle()
    return usage
  } catch (error) {
    const cooldown = cooldownAfter(error)
    if (cooldown !== null) {
      throttle = {
        ...throttle,
        retryAt: Date.now() + cooldown,
        consecutiveRateLimits: throttle.consecutiveRateLimits + 1,
      }
      saveThrottle()
    }
    throw error
  }
}

const cachedClaudeUsage = makeTtlCache(fetchClaudeUsage, TTL_MS)

/** A forced read inside the minimum gap is served like a regular one, from the cache. */
export function getCachedClaudeUsage(force = false): Promise<ClaudeUsage> {
  return cachedClaudeUsage(force && Date.now() >= claudeUsageNextRequestAt())
}

let reads = 0

/**
 * Reads Claude usage into the UI store. The usage API rate limits readily, so a failed read keeps
 * the last reading on screen and records that it could not be refreshed; only a missing token
 * clears it. The store says a read is on its way for as long as any caller waits on one.
 */
export async function loadClaudeUsage(
  force = false,
  source: Extract<DevDiagnosticSource, `claude.${string}`> = 'claude.titlebarPoll',
): Promise<ClaudeUsage | null> {
  const { setClaudeUsageLoading } = useUiStore.getState()
  reads += 1
  setClaudeUsageLoading(true)
  try {
    return await readClaudeUsage(force, source)
  } finally {
    reads -= 1
    if (reads === 0) setClaudeUsageLoading(false)
  }
}

async function readClaudeUsage(
  force: boolean,
  source: Extract<DevDiagnosticSource, `claude.${string}`>,
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
    const nextTry = claudeUsageRetryAt()
    // A read held back never reached the API, so it has nothing new to say: only the cooldown
    // is worth showing.
    if (error === HELD_BACK) {
      if (nextTry !== null) setClaudeUsageError('rate_limited', nextTry)
      finishDevTrace(trace, 'skipped')
      return null
    }
    const missingToken = String(error).includes('no_token')
    if (missingToken) setClaudeUsage(null)
    if (nextTry !== null) {
      setClaudeUsageError('rate_limited', nextTry)
    } else {
      setClaudeUsageError(missingToken ? 'no_token' : 'unavailable')
    }
    finishDevTrace(trace, 'failed', classifyUsageFailure(error), error)
    return null
  }
}
