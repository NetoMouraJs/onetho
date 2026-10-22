import { listen } from '@tauri-apps/api/event'
import { useEffect } from 'react'

import { trackClaudeSessionHook } from '../lib/claudeSessionTracking'
import { nativeSubagentCompleted } from '../lib/tauri/sessions'
import { type AgentHookPayload, useAgentCanvasStore } from '../stores/agentCanvasStore'

const COMPLETION_POLL_MS = 5_000

/**
 * Feeds `agentCanvasStore` from the app's own subagent hooks (SubagentStart/Stop, PreToolUse,
 * agent_events.rs) regardless of which pane is open — without this mounted somewhere always-on, the
 * orchestrator board's native-subagent branch never fills in outside the AgentCanvasPOC pane, since
 * that pane owned the only other listener for this event.
 */
export function useAgentHookBridge(): void {
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    void listen<AgentHookPayload>('agent-hook', (event) => {
      if (cancelled) return
      trackClaudeSessionHook(event.payload)
      useAgentCanvasStore.getState().ingest(event.payload)
    }).then((off) => {
      if (cancelled) off()
      else unlisten = off
    })
    let checking = false
    let reportedFailure = false
    const reconcile = async () => {
      if (checking || cancelled) return
      const nodes = useAgentCanvasStore
        .getState()
        .nodes.filter((node) => node.kind === 'subagent' && node.status === 'running')
      if (nodes.length === 0) return
      checking = true
      try {
        const results = await Promise.allSettled(
          nodes.map(async (node) => {
            if (node.sourceAgent === 'claude' && !node.sessionId) return
            const completed = await nativeSubagentCompleted(
              node.sourceAgent,
              node.id,
              node.sessionId ?? null,
              node.startedAt,
            )
            if (!completed || cancelled) return
            const current = useAgentCanvasStore.getState().nodes.find((entry) => entry.id === node.id)
            if (current?.status !== 'running') return
            useAgentCanvasStore.getState().ingest({
              hook_event_name: 'SubagentStop',
              agent_id: node.id,
              sourceAgent: node.sourceAgent,
              plannerId: node.plannerId ?? undefined,
            })
          }),
        )
        const failed = results.some((result) => result.status === 'rejected')
        if (failed && !reportedFailure) {
          console.warn('[agentHookBridge] subagent completion reconciliation failed')
        }
        reportedFailure = failed
      } finally {
        checking = false
      }
    }
    const timer = window.setInterval(() => void reconcile(), COMPLETION_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      unlisten?.()
    }
  }, [])
}
