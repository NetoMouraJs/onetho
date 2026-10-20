import { getAntigravityUsage } from './tauri'
import { makeTtlCache } from './ttlCache'

const API_READING_TTL_MS = 60_000

export const getCachedAntigravityUsage = makeTtlCache(getAntigravityUsage, API_READING_TTL_MS)
