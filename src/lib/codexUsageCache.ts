import { classifyUsageFailure, type DevDiagnosticSource,finishDevTrace, startDevTrace } from './devDiagnostics'
import { getCodexUsage } from './tauri'
import { makeTtlCache } from './ttlCache'
import { isUsageAccessOff } from './usageAccess'

const TTL_MS = 60_000

export const getCachedCodexUsage = makeTtlCache(getCodexUsage, TTL_MS)

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
      isUsageAccessOff(error) ? undefined : classifyUsageFailure(error), error)
    throw error
  }
}
