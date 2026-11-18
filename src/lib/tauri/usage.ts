import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import {
  classifyUsageFailure,
  type DevDiagnosticSource,
  finishDevTrace,
  startDevTrace,
} from '../devDiagnostics'
import { isUsageAccessOff, withUsageAccess } from '../usageAccess'
import type { ModelCost } from './sessions'

export type KimiUsage = {
  status: 'ready' | 'no_auth' | 'unavailable'
  windows: { label: string; used_percent: number; resets_at: string }[]
}

export function getKimiUsage(): Promise<KimiUsage> {
  return withUsageAccess('kimi', () => invoke<KimiUsage>('get_kimi_usage'))
}

export type ClaudeUsageWindow = {
  utilization: number
  resets_at: string
}

/** A weekly limit scoped to one model other than Opus, such as Fable. */
export type ClaudeModelLimit = {
  model: string
  utilization: number
  resets_at: string
}

export type ClaudeUsage = {
  five_hour: ClaudeUsageWindow
  seven_day: ClaudeUsageWindow
  seven_day_opus: ClaudeUsageWindow
  model_limits?: ClaudeModelLimit[]
}

/** Account plan label for the Claude usage card, from local OAuth metadata only. */
export async function getClaudePlan(): Promise<string | null> {
  return withUsageAccess('claude', () => invoke<string | null>('get_claude_plan'))
}

export async function getClaudeUsage(
  source: Extract<DevDiagnosticSource, `claude.${string}`> = 'claude.sharedFetch',
): Promise<ClaudeUsage> {
  const trace = startDevTrace(source)
  try {
    const usage = await withUsageAccess('claude', () => invoke<ClaudeUsage>('get_claude_usage'))
    finishDevTrace(trace, 'succeeded')
    return usage
  } catch (error) {
    finishDevTrace(
      trace,
      isUsageAccessOff(error) ? 'skipped' : 'failed',
      isUsageAccessOff(error) ? undefined : classifyUsageFailure(error),
      error,
    )
    throw error
  }
}

export type CodexUsageWindow = {
  used_percent: number
  window_minutes: number
  /** Epoch in milliseconds (0 = unknown). */
  resets_at_ms: number
}

export type CodexUsage = {
  primary: CodexUsageWindow
  secondary: CodexUsageWindow
  plan: string
  rate_limited: boolean
  reset_credits: number
  reset_credit_items?: CodexResetCredit[]
}

/** A Claude usage reading Claude Code passed to its status line, and when it arrived. */
export type ClaudeSessionUsage = {
  usage: ClaudeUsage
  at_ms: number
}

/** The last usage a Claude Code status line reported this run; no network involved. */
export async function getClaudeSessionUsage(): Promise<ClaudeSessionUsage | null> {
  return withUsageAccess('claude', () =>
    invoke<ClaudeSessionUsage | null>('get_claude_session_usage'),
  )
}

/** Claude usage as the status line of a Claude terminal reports it, after every response. */
export function onClaudeSessionUsage(
  handler: (reading: ClaudeSessionUsage) => void,
): Promise<UnlistenFn> {
  return listen<ClaudeSessionUsage>('usage://claude', (event) => handler(event.payload))
}

/** A Codex usage reading taken from a session file, and when Codex recorded it. */
export type CodexSessionUsage = {
  usage: CodexUsage
  at_ms: number
}

/** The newest Codex usage recorded in a session file; no network involved. */
export async function getCodexSessionUsage(): Promise<CodexSessionUsage | null> {
  return withUsageAccess('codex', () => invoke<CodexSessionUsage | null>('get_codex_session_usage'))
}

/** Codex usage as the session watcher reads it, every time a Codex turn records it. */
export function onCodexSessionUsage(
  handler: (reading: CodexSessionUsage) => void,
): Promise<UnlistenFn> {
  return listen<CodexSessionUsage>('usage://codex', (event) => handler(event.payload))
}

export type CodexResetCredit = {
  id: string
  status: string
  expires_at_ms: number
  title: string
  description: string
}

/** An all-zero window means the plan has no such limit (Pro Lite has no 5h window). */
export function hasCodexWindow(window: CodexUsageWindow): boolean {
  return window.window_minutes > 0 || window.resets_at_ms > 0 || window.used_percent > 0
}

/** The 5h window when the plan has one, otherwise the weekly window. */
export function codexHeadlineWindow(usage: CodexUsage): CodexUsageWindow {
  return hasCodexWindow(usage.primary) ? usage.primary : usage.secondary
}

export async function getCodexUsage(): Promise<CodexUsage> {
  const trace = startDevTrace('codex.sharedFetch')
  try {
    const usage = await withUsageAccess('codex', () => invoke<CodexUsage>('get_codex_usage'))
    finishDevTrace(trace, 'succeeded')
    return usage
  } catch (error) {
    finishDevTrace(
      trace,
      isUsageAccessOff(error) ? 'skipped' : 'failed',
      isUsageAccessOff(error) ? undefined : classifyUsageFailure(error),
      error,
    )
    throw error
  }
}

export async function consumeCodexResetCredit(creditId?: string): Promise<CodexUsage> {
  return withUsageAccess('codex', () =>
    invoke<CodexUsage>('consume_codex_reset_credit', { creditId }),
  )
}

export type AntigravityQuotaBucket = {
  label: string
  models: string[]
  used_percent: number
  remaining_percent: number
  resets_at: string
}

export type AntigravityUsage = {
  status: 'ready' | 'no_cli' | 'no_auth' | 'unavailable'
  cli_path: string
  used_percent: number
  rate_limited: boolean
  buckets: AntigravityQuotaBucket[]
}

export async function getAntigravityUsage(): Promise<AntigravityUsage> {
  return withUsageAccess('antigravity', () => invoke<AntigravityUsage>('get_antigravity_usage'))
}

/** Account balance; read only with an OpenRouter management key. */
export type OpenRouterAccount = {
  total_credits: number
  total_usage: number
  remaining: number
  used_percent: number
}

/** The stored API key's own spend and cap. `limit` is null for a key with no cap. */
export type OpenRouterKeyUsage = {
  label: string
  usage: number
  usage_daily: number
  usage_weekly: number
  usage_monthly: number
  limit: number | null
  limit_remaining: number | null
  limit_reset: string | null
  is_free_tier: boolean
}

/** The budget that blocks the API key's requests first (guardrail, workspace or key limit). */
export type OpenRouterBudget = {
  limit_usd: number
  spend_usd: number
  remaining_usd: number
  reset_interval: string | null
  resets_at: string | null
}

export type OpenRouterModelSpend = { model: string; usage: number; requests: number }

/** The last 30 completed UTC days; read only with a management key. */
export type OpenRouterActivity = {
  spend_7d: number
  spend_30d: number
  requests_30d: number
  daily: { date: string; usage: number }[]
  top_models: OpenRouterModelSpend[]
}

/** The tightest known cap: whichever of account, key limit and budget has the least left. */
export type OpenRouterHeadline = {
  source: 'account' | 'key' | 'budget'
  used_percent: number
  remaining_usd: number
  total_usd: number
}

export type OpenRouterFetchError = 'auth' | 'network' | 'other'

export type OpenRouterUsage = {
  status: 'ready' | 'no_key' | 'unavailable'
  has_api_key: boolean
  has_management_key: boolean
  key_error: OpenRouterFetchError | null
  management_error: OpenRouterFetchError | null
  account: OpenRouterAccount | null
  key: OpenRouterKeyUsage | null
  budget: OpenRouterBudget | null
  activity: OpenRouterActivity | null
  headline: OpenRouterHeadline | null
  /** Average spend per day over the last 7 days, in USD. */
  daily_burn_usd: number | null
  /** How long the headline balance lasts at `daily_burn_usd`. */
  days_left: number | null
}

export async function getOpenRouterUsage(): Promise<OpenRouterUsage> {
  return withUsageAccess('openrouter', () => invoke<OpenRouterUsage>('get_openrouter_usage'))
}

/** Saves a management key after OpenRouter confirms it is one; it never leaves the keychain. */
export async function setOpenRouterManagementKey(key: string): Promise<void> {
  return invoke<void>('openrouter_set_management_key', { key })
}

export async function deleteOpenRouterManagementKey(): Promise<void> {
  return invoke<void>('openrouter_delete_management_key')
}

export type ModelRate = {
  family: string
  input: number
  output: number
  cache_write_5m: number
  cache_write_1h: number
  cache_read: number
}

export async function getModelPricing(): Promise<ModelRate[]> {
  return invoke<ModelRate[]>('get_model_pricing')
}

export type OpenCodeUsageSummary = {
  cost_usd: number
  input_tokens: number
  output_tokens: number
  session_count: number
  by_model: ModelCost[]
}

export async function getOpenCodeUsageSummary(hours: number): Promise<OpenCodeUsageSummary> {
  return invoke<OpenCodeUsageSummary>('get_opencode_usage_summary', { hours })
}

export type ActivityDay = {
  /** Data UTC YYYY-MM-DD */
  date: string
  /** Mensagens (user + assistant) registradas no dia */
  count: number
}

export async function getClaudeActivity(days = 91): Promise<ActivityDay[]> {
  return invoke<ActivityDay[]>('get_claude_activity', { days }).catch(() => [])
}

export async function getMultiAgentActivity(days: number): Promise<ActivityDay[]> {
  return invoke<ActivityDay[]>('get_multi_agent_activity', { days })
}

export type ActivityAgentSample = {
  agent: Exclude<import('../types').AgentType, 'shell'>
  projectId: string | null
  terminalId: string | null
  state: 'working' | 'waiting'
}

export type ActivitySample = {
  date: string
  durationMs: number
  appFocused: boolean
  userActive: boolean
  activeProjectId: string | null
  activeTerminalId: string | null
  agents: ActivityAgentSample[]
}

export type ActivityTimeTotals = {
  appOpenMs: number
  appFocusedMs: number
  userActiveMs: number
  userIdleMs: number
  agentWallMs: number
  agentSumMs: number
  agentBackgroundMs: number
  parallelMs: number
  peakConcurrent: number
}

export type AgentTimeStats = {
  workingMs: number
  waitingMs: number
  focusedMs: number
  backgroundMs: number
}

export type ProjectTimeStats = {
  focusedMs: number
  activeMs: number
  idleMs: number
  agentWallMs: number
  agentSumMs: number
  agentBackgroundMs: number
  parallelMs: number
}

export type ActivitySummary = {
  totals: ActivityTimeTotals
  agents: Record<string, AgentTimeStats>
  projects: Record<string, ProjectTimeStats>
}

export async function recordActivitySamples(samples: ActivitySample[]): Promise<void> {
  await invoke('record_activity_samples', { samples })
}

export async function getActivitySummary(dates: string[] = []): Promise<ActivitySummary> {
  return invoke<ActivitySummary>('get_activity_summary', { dates })
}

export async function clearActivityStats(): Promise<void> {
  await invoke('clear_activity_stats')
}
