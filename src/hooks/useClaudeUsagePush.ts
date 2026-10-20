import { useEffect } from 'react'

import { receiveClaudeSessionUsage } from '../lib/claudeUsageCache'
import { getClaudeSessionUsage, onClaudeSessionUsage } from '../lib/tauri'
import { useProjectsStore } from '../stores/projectsStore'

/** Shows the usage each Claude response passes to its status line, as the listener pushes it. */
export function useClaudeUsagePush(): void {
  const claudeAccess = useProjectsStore((s) => s.preferences.usageAccess.claude)

  useEffect(() => {
    if (!claudeAccess) return
    let cancelled = false
    let unlisten: (() => void) | undefined
    // What a status line already reported this run, before the next response pushes anything.
    void getClaudeSessionUsage().then(
      (reading) => !cancelled && receiveClaudeSessionUsage(reading),
      () => undefined,
    )
    void onClaudeSessionUsage((reading) => {
      if (!cancelled) receiveClaudeSessionUsage(reading)
    }).then((off) => {
      if (cancelled) off()
      else unlisten = off
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [claudeAccess])
}
