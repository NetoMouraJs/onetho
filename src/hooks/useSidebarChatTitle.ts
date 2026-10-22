import { useEffect, useState } from 'react'

import { sanitizeSessionTitle } from '../lib/sessionTitle'
import { getClaudeSessionTitleInfo, getCodexSessionTitle } from '../lib/tauri/sessions'
import type { SessionTitle, SubTab } from '../lib/types'

const CACHE_TTL_MS = 300_000
// A titleless session is one Claude has not written a summary into yet, so the answer is expected
// to change shortly — caching that "no" for the full TTL made every retry a cache hit and the first
// real read land five minutes after the chat started.
const MISS_TTL_MS = 2_000
const FIRST_RETRY_MS = 3_000
const MAX_RETRY_MS = 60_000

type TitleCacheEntry = {
  loadedAt: number
  title: SessionTitle | null
  pending?: Promise<SessionTitle | null>
}

const titlesByKey = new Map<string, TitleCacheEntry>()
// The pane header and its sidebar row poll on their own timers; whichever reads first updates both.
const listenersByKey = new Map<string, Set<(title: SessionTitle | null) => void>>()

function subscribe(key: string, listener: (title: SessionTitle | null) => void): () => void {
  const listeners = listenersByKey.get(key) ?? new Set()
  listeners.add(listener)
  listenersByKey.set(key, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) listenersByKey.delete(key)
  }
}

function cacheKey(type: string, cwd: string, sessionId: string): string {
  return `${type}\u0000${cwd.trim().toLowerCase()}\u0000${sessionId}`
}

async function loadTitle(type: 'claude' | 'codex', cwd: string, sessionId: string) {
  const key = cacheKey(type, cwd, sessionId)
  const cached = titlesByKey.get(key)
  const now = Date.now()
  if (cached?.pending) return cached.pending
  const ttl = cached?.title ? CACHE_TTL_MS : MISS_TTL_MS
  if (cached && now - cached.loadedAt < ttl) return cached.title

  const pending = (
    type === 'claude'
      ? getClaudeSessionTitleInfo(cwd, sessionId)
      : getCodexSessionTitle(sessionId).then((title) =>
          title ? { title, userNamed: false } : null,
        )
  )
    .then((value) => {
      const sanitizedTitle = sanitizeSessionTitle(value?.title)
      const previous = cached?.title ?? null
      const unchanged = previous
        ? previous.title === sanitizedTitle && previous.userNamed === value?.userNamed
        : !sanitizedTitle
      const title = unchanged
        ? previous
        : sanitizedTitle && value
          ? { title: sanitizedTitle, userNamed: value.userNamed }
          : null
      titlesByKey.set(key, { loadedAt: Date.now(), title })
      if (!unchanged) listenersByKey.get(key)?.forEach((listener) => listener(title))
      return title
    })
    .catch(() => {
      const title = cached?.title ?? null
      titlesByKey.set(key, { loadedAt: Date.now(), title })
      return title
    })

  titlesByKey.set(key, {
    loadedAt: cached?.loadedAt ?? 0,
    title: cached?.title ?? null,
    pending,
  })
  return pending
}

/** Resolves one Claude or Codex session title without scanning unrelated sessions. */
export function useSessionTitle(
  tab: SubTab | undefined,
  fallbackCwd?: string,
): SessionTitle | null {
  const [title, setTitle] = useState<SessionTitle | null>(null)
  const sessionId = tab?.sessionId
  const cwd = tab?.cwd || fallbackCwd
  const type = tab?.type

  useEffect(() => {
    setTitle(null)
    if ((type !== 'claude' && type !== 'codex') || !sessionId || (type === 'claude' && !cwd)) return

    const titleType = type as 'claude' | 'codex'
    let cancelled = false
    let attempts = 0
    let timer: number | undefined
    const unsubscribe = subscribe(cacheKey(titleType, cwd ?? '', sessionId), (next) => {
      if (!cancelled) setTitle(next)
    })

    const refresh = async () => {
      attempts += 1
      const next = await loadTitle(titleType, cwd ?? '', sessionId)
      if (cancelled) return
      if (next) {
        setTitle(next)
        // Claude keeps rewriting the summary as the conversation grows, so the row follows it at
        // the cache cadence instead of freezing on the first title it ever saw.
        attempts = 0
        timer = window.setTimeout(() => void refresh(), CACHE_TTL_MS)
        return
      }
      // Never give up: a session can be named with /rename long after it started.
      const delay =
        attempts <= 5 ? Math.min(FIRST_RETRY_MS * 2 ** (attempts - 1), MAX_RETRY_MS) : MAX_RETRY_MS
      timer = window.setTimeout(() => void refresh(), delay)
    }

    void refresh()
    return () => {
      cancelled = true
      unsubscribe()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [cwd, sessionId, type])

  return title
}

export function useSidebarChatTitle(tab: SubTab | undefined): string | null {
  return useSessionTitle(tab)?.title ?? null
}
