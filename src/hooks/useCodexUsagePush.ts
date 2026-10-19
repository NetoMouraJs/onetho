import { useEffect } from 'react'

import { receiveCodexSessionUsage } from '../lib/codexUsageCache'
import { getCodexSessionUsage, onCodexSessionUsage } from '../lib/tauri'
import { useProjectsStore } from '../stores/projectsStore'

/** Shows the usage each Codex turn records, as the session watcher pushes it. */
export function useCodexUsagePush(): void {
  const codexAccess = useProjectsStore((s) => s.preferences.usageAccess.codex)

  useEffect(() => {
    if (!codexAccess) return
    let cancelled = false
    let unlisten: (() => void) | undefined
    // What the newest session already recorded, before the next turn pushes anything.
    void getCodexSessionUsage().then(
      (reading) => !cancelled && receiveCodexSessionUsage(reading),
      () => undefined,
    )
    void onCodexSessionUsage((reading) => {
      if (!cancelled) receiveCodexSessionUsage(reading)
    }).then((off) => {
      if (cancelled) off()
      else unlisten = off
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [codexAccess])
}
