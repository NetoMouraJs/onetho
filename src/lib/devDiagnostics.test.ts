import { beforeEach, describe, expect, it } from 'vitest'

import {
  classifyUsageFailure,
  clearDevDiagnostics,
  finishDevTrace,
  getDevDiagnostics,
  recordFrontendDiagnostic,
  sanitizeStack,
  startDevTrace,
} from './devDiagnostics'

beforeEach(() => clearDevDiagnostics())

describe('Dev diagnostics', () => {
  it('correlates the start and failure without storing the raw error', () => {
    const trace = startDevTrace('claude.manualRefresh')
    finishDevTrace(trace, 'failed', classifyUsageFailure('API returned 429; secret=private-token'))

    const events = getDevDiagnostics()
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ id: trace?.id, phase: 'failed', failure: 'http', httpStatus: 429 })
    expect(events[1]).toMatchObject({ id: trace?.id, phase: 'started' })
    expect(JSON.stringify(events)).not.toContain('private-token')
  })

  it('keeps a bounded local history', () => {
    for (let index = 0; index < 200; index++) {
      finishDevTrace(startDevTrace('claude.sharedFetch'), 'succeeded')
    }
    expect(getDevDiagnostics()).toHaveLength(300)
  })

  it('discards unexpected fields from stored events', () => {
    localStorage.setItem('onetho.devDiagnostics.v1', JSON.stringify([{
      id: 'known-id', at: Date.now(), source: 'claude.sharedFetch', phase: 'failed',
      failure: 'http', httpStatus: 429, token: 'private-token',
    }]))
    window.dispatchEvent(new StorageEvent('storage', { key: 'onetho.devDiagnostics.v1' }))

    expect(getDevDiagnostics()).toEqual([{
      id: 'known-id', at: expect.any(Number), source: 'claude.sharedFetch',
      phase: 'failed', failure: 'http', httpStatus: 429,
    }])
    expect(JSON.stringify(getDevDiagnostics())).not.toContain('private-token')
  })

  it('keeps local source locations but removes error text, host and query parameters', () => {
    const raw = 'Error: token=private-token\n    at refresh (http://localhost:1422/src/lib/usage.ts?token=private-token:42:7)\n    at remote (https://example.test/secret:3:2)'
    expect(sanitizeStack(raw)).toBe('at refresh (src/lib/usage.ts:42:7)')

    recordFrontendDiagnostic('frontend.windowError', raw)
    expect(getDevDiagnostics()[0]).toMatchObject({
      stack: 'at refresh (src/lib/usage.ts:42:7)', stackKind: 'error',
    })
    expect(JSON.stringify(getDevDiagnostics())).not.toContain('private-token')
  })
})
