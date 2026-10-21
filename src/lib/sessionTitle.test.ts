import { describe, expect, it } from 'vitest'

import {
  isInjectedTitle,
  paneDisplayName,
  sanitizeLeakedTabNames,
  sanitizeSessionTitle,
} from './sessionTitle'
import type { ProjectsFile, SubTab, Terminal } from './types'

const terminal = (overrides: Partial<Terminal> = {}) =>
  ({ name: 'Pane', customName: false, ...overrides }) as Terminal
const tab = (overrides: Partial<SubTab> = {}) =>
  ({ name: 'claude', type: 'claude', ...overrides }) as SubTab

describe('paneDisplayName', () => {
  it('uses the user named session title before every manual name', () => {
    expect(
      paneDisplayName(terminal({ customName: true }), tab({ name: 'Tab name' }), {
        title: 'Session name',
        userNamed: true,
      }),
    ).toBe('Session name')
  })

  it('uses the pane name before a manual tab name and automatic title', () => {
    expect(
      paneDisplayName(terminal({ name: '  Pane  name ', customName: true }), tab({ name: 'Tab' }), {
        title: 'Automatic',
        userNamed: false,
      }),
    ).toBe('Pane  name')
  })

  it('uses the manual tab name before an automatic title and preserves internal spaces', () => {
    expect(
      paneDisplayName(terminal(), tab({ name: '  My  tab  ' }), {
        title: 'Automatic',
        userNamed: false,
      }),
    ).toBe('My  tab')
  })

  it('uses an automatic title before the default tab name', () => {
    expect(paneDisplayName(terminal(), tab(), { title: 'Automatic', userNamed: false })).toBe(
      'Automatic',
    )
  })

  it('uses the pane name when there is no tab', () => {
    expect(paneDisplayName(terminal({ name: 'Pane only' }), undefined, null)).toBe('Pane only')
  })

  it('uses the agent type for an injected tab name', () => {
    expect(
      paneDisplayName(terminal(), tab({ name: '<system-reminder>secret</system-reminder>' }), null),
    ).toBe('claude')
  })

  it('never returns an injected session title', () => {
    expect(
      paneDisplayName(terminal(), tab(), {
        title: '<system-reminder>secret</system-reminder>',
        userNamed: true,
      }),
    ).toBe('claude')
  })
})

describe('sanitizeSessionTitle', () => {
  it('returns null for an injected system reminder title', () => {
    const title =
      '<system-reminder> The user named this session "BS-20059". This may indicate the session\'s focus or intent. </system-reminder>'

    expect(isInjectedTitle(title)).toBe(true)
    expect(sanitizeSessionTitle(title)).toBeNull()
  })

  it('returns null when the reminder appears after other text', () => {
    expect(sanitizeSessionTitle('prefix <system-reminder>secret</system-reminder>')).toBeNull()
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
