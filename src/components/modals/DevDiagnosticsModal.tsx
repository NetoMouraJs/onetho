import { Copy, Info, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import {
  clearDevDiagnostics,
  type DevDiagnosticEvent,
  type DevDiagnosticFailure,
  type DevDiagnosticPhase,
  type DevDiagnosticSource,
  getDevDiagnostics,
  subscribeDevDiagnostics,
} from '../../lib/devDiagnostics'
import { useT } from '../../lib/i18n'
import type { MessageKey } from '../../lib/i18n/messages/en'
import { writeClipboardText } from '../../lib/tauri'
import { useUiStore } from '../../stores/uiStore'
import styles from './DevDiagnosticsModal.module.css'
import { Modal } from './Modal'

const SOURCE_KEYS: Record<DevDiagnosticSource, MessageKey> = {
  'claude.manualRefresh': 'devDiagnostics.source.manualRefresh',
  'claude.modalOpen': 'devDiagnostics.source.modalOpen',
  'claude.titlebarPoll': 'devDiagnostics.source.titlebarPoll',
  'claude.sharedFetch': 'devDiagnostics.source.sharedFetch',
  'claude.quotaPoll': 'devDiagnostics.source.quotaPoll',
  'codex.manualRefresh': 'devDiagnostics.source.codexManualRefresh',
  'codex.modalOpen': 'devDiagnostics.source.codexModalOpen',
  'codex.sharedFetch': 'devDiagnostics.source.codexSharedFetch',
  'codex.quotaPoll': 'devDiagnostics.source.codexQuotaPoll',
  'frontend.windowError': 'devDiagnostics.source.windowError',
  'frontend.unhandledRejection': 'devDiagnostics.source.unhandledRejection',
}

const PHASE_KEYS: Record<DevDiagnosticPhase, MessageKey> = {
  started: 'devDiagnostics.phase.started',
  succeeded: 'devDiagnostics.phase.succeeded',
  failed: 'devDiagnostics.phase.failed',
  skipped: 'devDiagnostics.phase.skipped',
}

const FAILURE_KEYS: Record<DevDiagnosticFailure, MessageKey> = {
  noToken: 'devDiagnostics.failure.noToken',
  http: 'devDiagnostics.failure.http',
  transport: 'devDiagnostics.failure.transport',
  response: 'devDiagnostics.failure.response',
  unknown: 'devDiagnostics.failure.unknown',
}

export function DevDiagnosticsModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === 'devDiagnostics')
  const closeModal = useUiStore((state) => state.closeModal)
  const [events, setEvents] = useState<DevDiagnosticEvent[]>(getDevDiagnostics)
  const [filter, setFilter] = useState<'all' | 'failed'>('all')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => subscribeDevDiagnostics(() => setEvents(getDevDiagnostics())), [])

  if (!import.meta.env.DEV) return null

  const failures = events.filter((event) => event.phase === 'failed').length
  const filtered = events.filter((event) => {
    if (filter === 'failed' && event.phase !== 'failed') return false
    const text = `${event.id} ${event.source} ${event.failure ?? ''} ${event.httpStatus ?? ''}`
    return text.toLowerCase().includes(query.trim().toLowerCase())
  })

  const copy = () => {
    void writeClipboardText(JSON.stringify({ schema: 1, events }, null, 2))
  }

  return (
    <Modal open={open} onClose={closeModal} title={t('devDiagnostics.title')} width={920}>
      <div className={styles.root}>
        <p className={styles.description}>{t('devDiagnostics.description')}</p>
        <div className={styles.summary}>
          <span>{t('devDiagnostics.events', { count: events.length })}</span>
          <span className={styles.failureCount}>
            {t('devDiagnostics.failures', { count: failures })}
          </span>
          <span>{t('devDiagnostics.retention')}</span>
        </div>
        <div className={styles.controls}>
          <input
            className={styles.search}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('devDiagnostics.search')}
            aria-label={t('devDiagnostics.search')}
          />
          <button
            type="button"
            className={filter === 'all' ? styles.activeButton : styles.button}
            onClick={() => setFilter('all')}
          >
            {t('devDiagnostics.all')}
          </button>
          <button
            type="button"
            className={filter === 'failed' ? styles.activeButton : styles.button}
            onClick={() => setFilter('failed')}
          >
            {t('devDiagnostics.errors')}
          </button>
          <button type="button" className={styles.button} onClick={copy}>
            <Copy size={14} /> {t('devDiagnostics.copy')}
          </button>
          <button type="button" className={styles.button} onClick={clearDevDiagnostics}>
            <Trash2 size={14} /> {t('devDiagnostics.clear')}
          </button>
        </div>
        <div className={styles.list} role="log" aria-label={t('devDiagnostics.title')}>
          {filtered.length === 0 ? (
            <p className={styles.empty}>{t('devDiagnostics.empty')}</p>
          ) : (
            filtered.map((event, index) => (
              <div
                className={`${styles.row} ${event.phase === 'failed' ? styles.failedRow : ''}`}
                key={`${event.id}-${event.phase}-${event.at}-${index}`}
              >
                <time dateTime={new Date(event.at).toISOString()}>
                  {new Date(event.at).toLocaleString()}
                </time>
                <span>{t(SOURCE_KEYS[event.source])}</span>
                <span>{t(PHASE_KEYS[event.phase])}</span>
                <span>
                  {event.failure ? t(FAILURE_KEYS[event.failure]) : '—'}
                  {event.httpStatus ? ` · ${t('devDiagnostics.httpStatus', { status: event.httpStatus })}` : ''}
                </span>
                <span>{event.durationMs === undefined ? '—' : t('devDiagnostics.duration', { duration: event.durationMs })}</span>
                <code title={event.id}>{event.id.slice(0, 8)}</code>
                {event.phase === 'failed' ? (
                  <button
                    type="button"
                    className={styles.detailButton}
                    aria-label={t('devDiagnostics.details')}
                    aria-expanded={expanded === `${event.id}-${event.at}`}
                    onClick={() => setExpanded(expanded === `${event.id}-${event.at}` ? null : `${event.id}-${event.at}`)}
                  >
                    <Info size={15} />
                  </button>
                ) : <span />}
                {expanded === `${event.id}-${event.at}` ? (
                  <div className={styles.details}>
                    <div><strong>{t('devDiagnostics.eventId')}</strong> <code>{event.id}</code></div>
                    <div><strong>{t('devDiagnostics.source')}</strong> {t(SOURCE_KEYS[event.source])}</div>
                    <div><strong>{t('devDiagnostics.failure')}</strong> {event.failure ? t(FAILURE_KEYS[event.failure]) : t('devDiagnostics.failure.unknown')}</div>
                    {event.httpStatus ? <div><strong>{t('devDiagnostics.httpStatus', { status: event.httpStatus })}</strong></div> : null}
                    <div><strong>{t(event.stackKind === 'error' ? 'devDiagnostics.errorStack' : 'devDiagnostics.callsiteStack')}</strong></div>
                    {event.stack ? <pre className={styles.stack}>{event.stack}</pre> : <p>{t('devDiagnostics.noStack')}</p>}
                    {event.source.startsWith('claude.') || event.source.startsWith('codex.') ? <p>{t('devDiagnostics.backendNote')}</p> : null}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </div>
    </Modal>
  )
}
