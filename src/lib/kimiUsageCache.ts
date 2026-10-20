import { getKimiUsage } from './tauri'
import { makeTtlCache } from './ttlCache'

const API_READING_TTL_MS = 60_000

export const getCachedKimiUsage = makeTtlCache(getKimiUsage, API_READING_TTL_MS)
