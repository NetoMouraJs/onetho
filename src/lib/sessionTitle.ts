import type { ProjectsFile } from './types'

export function isInjectedTitle(value: string | null | undefined): boolean {
  return value?.trim().startsWith('<system-reminder>') ?? false
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
