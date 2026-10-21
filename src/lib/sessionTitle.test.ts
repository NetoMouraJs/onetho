import { describe, expect, it } from 'vitest'

import { isInjectedTitle, sanitizeLeakedTabNames, sanitizeSessionTitle } from './sessionTitle'
import type { ProjectsFile } from './types'

describe('sanitizeSessionTitle', () => {
  it('returns null for an injected system reminder title', () => {
    const title =
      '<system-reminder> The user named this session "BS-20059". This may indicate the session\'s focus or intent. </system-reminder>'

    expect(isInjectedTitle(title)).toBe(true)
    expect(sanitizeSessionTitle(title)).toBeNull()
  })

  it('collapses whitespace and trims the title', () => {
    expect(sanitizeSessionTitle('  fix\n  the\tbug  ')).toBe('fix the bug')
  })

  it('keeps ordinary angle-bracket text', () => {
    expect(sanitizeSessionTitle('<div> breaks')).toBe('<div> breaks')
  })

  it('returns null for missing or blank titles', () => {
    expect(sanitizeSessionTitle(undefined)).toBeNull()
    expect(sanitizeSessionTitle(null)).toBeNull()
    expect(sanitizeSessionTitle(' \n\t ')).toBeNull()
  })
})

describe('sanitizeLeakedTabNames', () => {
  it('restores injected names and preserves real custom names', () => {
    const file = {
      projects: [
        {
          terminals: [
            {
              tabs: [
                {
                  id: 'claude-tab',
                  type: 'claude',
                  name: '<system-reminder> leaked title </system-reminder>',
                },
                { id: 'shell-tab', type: 'shell', name: 'tests' },
              ],
            },
          ],
        },
      ],
    } as unknown as ProjectsFile

    const sanitized = sanitizeLeakedTabNames(file)

    expect(sanitized).not.toBe(file)
    expect(sanitized.projects[0].terminals[0].tabs[0].name).toBe('claude')
    expect(sanitized.projects[0].terminals[0].tabs[1].name).toBe('tests')
    expect(file.projects[0].terminals[0].tabs[0].name).toContain('<system-reminder>')
  })

  it('returns the same file reference when no tab name changed', () => {
    const file = {
      projects: [
        {
          terminals: [{ tabs: [{ id: 'shell-tab', type: 'shell', name: 'tests' }] }],
        },
      ],
    } as unknown as ProjectsFile

    expect(sanitizeLeakedTabNames(file)).toBe(file)
  })
})
