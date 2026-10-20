import { useUiStore } from '../stores/uiStore'
import { classifyUsageFailure, type DevDiagnosticSource,finishDevTrace, startDevTrace } from './devDiagnostics'
import { type CodexSessionUsage, type CodexUsage, getCodexUsage } from './tauri'
import { makeTtlCache } from './ttlCache'
import { hasUsageAccess, isUsageAccessOff } from './usageAccess'

// How long an API reading is reused by reads that are not forced: as long as the automatic sync.
const API_READING_TTL_MS = 10 * 60_000
/** How long a reading pushed by a Codex session stands in for the API. */
const SESSION_READING_TTL_MS = 10 * 60_000

let session: CodexSessionUsage | null = null
let lastApi: { usage: CodexUsage; at: number } | null = null

/** Reset credits only come from the API: a session reading carries the last ones it reported. */
function withApiCredits(usage: CodexUsage): CodexUsage {
  if (!lastApi) return usage
  return {
    ...usage,
    reset_credits: lastApi.usage.reset_credits,
    reset_credit_items: lastApi.usage.reset_credit_items,
  }
}

const getCachedApiUsage = makeTtlCache(async () => {
  const usage = await getCodexUsage()
  lastApi = { usage, at: Date.now() }
  return usage
}, API_READING_TTL_MS)

/**
 * Codex usage from whichever source is newer: the reading the last Codex turn recorded in its
 * session file, or the API. A recent session reading spares the API call; a forced read always
 * asks the API, which also counts what other devices used.
 */
export async function getCachedCodexUsage(force = false): Promise<CodexUsage> {
  const { setCodexUsageSource } = useUiStore.getState()
  if (
    !force &&
    session &&
    Date.now() - session.at_ms < SESSION_READING_TTL_MS &&
    session.at_ms >= (lastApi?.at ?? 0)
  ) {
    setCodexUsageSource({ kind: 'session', at: session.at_ms })
    return withApiCredits(session.usage)
  }
  const usage = await getCachedApiUsage(force)
  if (lastApi) setCodexUsageSource({ kind: 'api', at: lastApi.at })
  return usage
}

/** Takes a reading pushed by the session watcher and shows it when it is the newest. */
export function receiveCodexSessionUsage(reading: CodexSessionUsage | null): void {
  if (!reading || !hasUsageAccess('codex')) return
  if (session && session.at_ms >= reading.at_ms) return
  session = reading
  // The API already answered with something more recent.
  if (lastApi && lastApi.at > reading.at_ms) return
  const { setCodexUsage, setCodexUsageSource } = useUiStore.getState()
  setCodexUsage(withApiCredits(reading.usage))
  setCodexUsageSource({ kind: 'session', at: reading.at_ms })
}

/** Forgets both sources; for tests. */
export function resetCodexUsageSources(): void {
  session = null
  lastApi = null
}

export async function traceCachedCodexUsage(
  force: boolean,
  source: Extract<DevDiagnosticSource, `codex.${string}`>,
): Promise<Awaited<ReturnType<typeof getCodexUsage>>> {
  const trace = startDevTrace(source)
  try {
    const usage = await getCachedCodexUsage(force)
    finishDevTrace(trace, 'succeeded')
    return usage
  } catch (error) {
    finishDevTrace(trace, isUsageAccessOff(error) ? 'skipped' : 'failed',
      isUsageAccessOff(error) ? undefined : classifyUsageFailure(error))
    throw error
  }
}
