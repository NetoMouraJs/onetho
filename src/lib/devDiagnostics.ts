export type DevDiagnosticSource =
  | 'claude.manualRefresh'
  | 'claude.modalOpen'
  | 'claude.titlebarPoll'
  | 'claude.sharedFetch'
  | 'claude.quotaPoll'
  | 'codex.manualRefresh'
  | 'codex.modalOpen'
  | 'codex.sharedFetch'
  | 'codex.quotaPoll'
  | 'frontend.windowError'
  | 'frontend.unhandledRejection'

export type DevDiagnosticPhase = 'started' | 'succeeded' | 'failed' | 'skipped'
export type DevDiagnosticFailure = 'noToken' | 'http' | 'transport' | 'response' | 'unknown'
export type DevDiagnosticStackKind = 'error' | 'callsite'

export type DevDiagnosticEvent = {
  id: string
  at: number
  source: DevDiagnosticSource
  phase: DevDiagnosticPhase
  failure?: DevDiagnosticFailure
  httpStatus?: number
  durationMs?: number
  stack?: string
  stackKind?: DevDiagnosticStackKind
}

type Trace = Pick<DevDiagnosticEvent, 'id' | 'source'> & { startedAt: number; callsite?: string }

const STORAGE_KEY = 'onetho.devDiagnostics.v1'
const MAX_EVENTS = 300
const MAX_AGE_MS = 7 * 24 * 60 * 60_000
const listeners = new Set<() => void>()
let events: DevDiagnosticEvent[] | null = null

function isEvent(value: unknown): value is DevDiagnosticEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<DevDiagnosticEvent>
  return (
    typeof event.id === 'string' && event.id.length <= 64 &&
    typeof event.at === 'number' && Number.isFinite(event.at) &&
    SOURCES.includes(event.source as DevDiagnosticSource) &&
    PHASES.includes(event.phase as DevDiagnosticPhase) &&
    (event.failure === undefined || FAILURES.includes(event.failure)) &&
    (event.httpStatus === undefined || (Number.isInteger(event.httpStatus) && event.httpStatus >= 100 && event.httpStatus <= 599)) &&
    (event.durationMs === undefined || (Number.isFinite(event.durationMs) && event.durationMs >= 0)) &&
    (event.stack === undefined || (typeof event.stack === 'string' && event.stack.length <= 1800)) &&
    (event.stackKind === undefined || event.stackKind === 'error' || event.stackKind === 'callsite')
  )
}

const SOURCES: DevDiagnosticSource[] = ['claude.manualRefresh', 'claude.modalOpen', 'claude.titlebarPoll', 'claude.sharedFetch', 'claude.quotaPoll', 'codex.manualRefresh', 'codex.modalOpen', 'codex.sharedFetch', 'codex.quotaPoll', 'frontend.windowError', 'frontend.unhandledRejection']
const PHASES: DevDiagnosticPhase[] = ['started', 'succeeded', 'failed', 'skipped']
const FAILURES: DevDiagnosticFailure[] = ['noToken', 'http', 'transport', 'response', 'unknown']

function bounded(items: DevDiagnosticEvent[]): DevDiagnosticEvent[] {
  const cutoff = Date.now() - MAX_AGE_MS
  return items.filter((event) => event.at >= cutoff && event.at <= Date.now()).slice(-MAX_EVENTS)
}

function readStored(): DevDiagnosticEvent[] {
  if (!import.meta.env.DEV || typeof window === 'undefined') return []
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? bounded(parsed.filter(isEvent).map((event) => ({
      id: event.id,
      at: event.at,
      source: event.source,
      phase: event.phase,
      ...(event.failure === undefined ? {} : { failure: event.failure }),
      ...(event.httpStatus === undefined ? {} : { httpStatus: event.httpStatus }),
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      ...(event.stack === undefined ? {} : { stack: sanitizeStack(event.stack) }),
      ...(event.stackKind === undefined ? {} : { stackKind: event.stackKind }),
    }))) : []
  } catch {
    return []
  }
}

function notify(): void {
  listeners.forEach((listener) => listener())
}

function persist(): void {
  if (!import.meta.env.DEV || typeof window === 'undefined' || !events) return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(events))
  } catch {
    // Diagnostics must never interrupt the operation they observe.
  }
  notify()
}

export function getDevDiagnostics(): DevDiagnosticEvent[] {
  events ??= readStored()
  return [...events].reverse()
}

export function subscribeDevDiagnostics(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function clearDevDiagnostics(): void {
  events = []
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(STORAGE_KEY)
    } catch {
      // The in-memory view still clears when storage is unavailable.
    }
  }
  notify()
}

function record(event: DevDiagnosticEvent): void {
  if (!import.meta.env.DEV) return
  events ??= readStored()
  events = bounded([...events, event])
  persist()
}

export function startDevTrace(source: DevDiagnosticSource): Trace | null {
  if (!import.meta.env.DEV) return null
  const startedAt = Date.now()
  const callsite = sanitizeStack(new Error().stack)?.split('\n').slice(1).join('\n') || undefined
  const trace = { id: crypto.randomUUID(), source, startedAt, callsite }
  record({ id: trace.id, at: startedAt, source, phase: 'started' })
  return trace
}

/** Keep only local code locations; discard messages, URLs, query strings and machine paths. */
export function sanitizeStack(stack: unknown): string | undefined {
  if (typeof stack !== 'string') return undefined
  const frames = stack.split('\n').slice(1).flatMap((line) => {
    const match = /^\s*at (?:(?<name>[\w.$<> ]{1,80}) \()?(.+?):(\d+):(\d+)\)?$/.exec(line)
    if (!match) return []
    const location = match[2].replace(/\\/g, '/')
    const marker = /(?:^|\/)(src|assets)\//.exec(location)
    if (!marker) return []
    const path = location.slice(marker.index + (marker[0].startsWith('/') ? 1 : 0)).split(/[?#]/, 1)[0]
    if (!/^[\w./-]+$/.test(path)) return []
    const name = match.groups?.name?.trim() || 'anonymous'
    return [`at ${name} (${path}:${match[3]}:${match[4]})`]
  })
  return frames.length ? frames.slice(0, 12).join('\n').slice(0, 1800) : undefined
}

export function classifyUsageFailure(error: unknown): {
  failure: DevDiagnosticFailure
  httpStatus?: number
} {
  const message = String(error)
  if (message.includes('no_token')) return { failure: 'noToken' }
  const status = /API returned (\d{3})/.exec(message)
  if (status) return { failure: 'http', httpStatus: Number(status[1]) }
  if (message.includes('request failed:')) return { failure: 'transport' }
  if (message.includes('json parse:')) return { failure: 'response' }
  return { failure: 'unknown' }
}

export function finishDevTrace(
  trace: Trace | null,
  phase: Exclude<DevDiagnosticPhase, 'started'>,
  failure?: ReturnType<typeof classifyUsageFailure>,
  error?: unknown,
): void {
  if (!trace) return
  const errorStack = error instanceof Error ? sanitizeStack(error.stack) : undefined
  const stack = phase === 'failed' ? errorStack ?? trace.callsite : undefined
  record({
    id: trace.id,
    at: Date.now(),
    source: trace.source,
    phase,
    ...(failure ?? {}),
    durationMs: Math.max(0, Date.now() - trace.startedAt),
    ...(stack ? { stack, stackKind: errorStack ? 'error' : 'callsite' } as const : {}),
  })
}

export function recordFrontendDiagnostic(source: 'frontend.windowError' | 'frontend.unhandledRejection', stack?: string | null): void {
  if (!import.meta.env.DEV) return
  const safeStack = sanitizeStack(stack)
  record({ id: crypto.randomUUID(), at: Date.now(), source, phase: 'failed', failure: 'unknown',
    ...(safeStack ? { stack: safeStack, stackKind: 'error' as const } : {}),
  })
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return
    events = readStored()
    notify()
  })
}
