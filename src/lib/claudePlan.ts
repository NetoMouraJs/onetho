import { useUiStore } from '../stores/uiStore'
import { getClaudePlan } from './tauri'
import { hasUsageAccess } from './usageAccess'

let latestLookup = 0

/**
 * Reads the Claude plan label from OAuth metadata and stores it for the usage card. A label already
 * on screen is kept unless `refresh` asks to read the credentials again.
 */
export async function loadClaudePlan(refresh = false): Promise<void> {
  if (!hasUsageAccess('claude')) {
    // A lookup still on its way must not bring the label back.
    latestLookup += 1
    useUiStore.getState().setClaudePlanLabel(null)
    return
  }
  if (!refresh && useUiStore.getState().claudePlanLabel !== null) return
  const lookup = ++latestLookup
  let label: string | null
  try {
    label = await getClaudePlan()
  } catch {
    label = null
  }
  // Only the newest lookup writes, so an older one finishing last cannot overwrite or clear it.
  if (lookup === latestLookup) useUiStore.getState().setClaudePlanLabel(label)
}
