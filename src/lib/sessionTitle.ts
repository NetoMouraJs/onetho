import type { ProjectsFile, SessionTitle, SubTab, Terminal } from './types'

export function isInjectedTitle(value: string | null | undefined): boolean {
  return value?.includes('<system-reminder>') ?? false
}

export function sanitizeSessionTitle(value: string | null | undefined): string | null {
  if (isInjectedTitle(value)) return null
  const title = value?.replace(/\s+/g, ' ').trim()
  return title || null
}

export function sanitizeLeakedTabNames(file: ProjectsFile): ProjectsFile {
  let fileChanged = false
  const projects = file.projects.map((project) => {
    let projectChanged = false
    const terminals = project.terminals.map((terminal) => {
      let terminalChanged = false
      const tabs = terminal.tabs.map((tab) => {
        if (!isInjectedTitle(tab.name)) return tab
        terminalChanged = true
        return { ...tab, name: tab.type }
      })
      if (!terminalChanged) return terminal
      projectChanged = true
      return { ...terminal, tabs }
    })
    if (!projectChanged) return project
    fileChanged = true
    return { ...project, terminals }
  })

  return fileChanged ? { ...file, projects } : file
}

function manualName(value: string | null | undefined): string | null {
  if (!value || isInjectedTitle(value)) return null
  const name = value.trim()
  return name || null
}

export function paneDisplayName(
  terminal: Terminal,
  tab: SubTab | undefined,
  sessionTitle: SessionTitle | null,
): string {
  const terminalName = manualName(terminal.name) ?? ''
  const fallbackName = tab ? (isInjectedTitle(tab.name) ? tab.type : tab.name) : terminalName
  if (sessionTitle?.userNamed) return sanitizeSessionTitle(sessionTitle.title) ?? fallbackName
  if (terminal.customName) return terminalName

  const tabName = manualName(tab?.name)
  if (tab && tabName && tabName !== tab.type) return tabName

  const automaticTitle = sanitizeSessionTitle(sessionTitle?.title)
  if (automaticTitle) return automaticTitle
  return manualName(fallbackName) ?? tab?.type ?? terminalName
}
