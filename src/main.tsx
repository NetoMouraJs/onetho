import './bootstrap'
import './styles/reset.css'
import './styles/theme.css'
import './styles/visual-clean.css'

import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import React from 'react'
import ReactDOM from 'react-dom/client'

import App from './App'
import { recordFrontendDiagnostic } from './lib/devDiagnostics'
import { orchestrationWindowPane } from './lib/orchestrationWindow'
import { initPluginHost } from './lib/plugins'
import { recordFrontendError } from './lib/tauri'
import { watchPluginThemeStyles } from './lib/themeTokens'
import { OrchestrationWindow } from './OrchestrationWindow'
import { setProjectsReadOnly } from './stores/projectsStore'

// Capture uncaught errors that React boundaries cannot handle, such as PTY callbacks.
let lastErrorAt = 0
let lastErrorKey = ''
function captureGlobalError(message: string, stack: string | null, kind: string) {
  const now = Date.now()
  const key = `${kind}:${message}`
  if (key === lastErrorKey && now - lastErrorAt < 2000) return
  lastErrorKey = key
  lastErrorAt = now
  recordFrontendDiagnostic(
    kind === 'window.error' ? 'frontend.windowError' : 'frontend.unhandledRejection',
    stack,
  )
  void recordFrontendError(message, stack, kind)
}

window.addEventListener('error', (event) => {
  if (import.meta.env.DEV) console.error('[Alethe][window.error]', event.error ?? event.message)
  captureGlobalError(
    event.message || String(event.error ?? 'unknown error'),
    (event.error as Error | undefined)?.stack ?? null,
    'window.error',
  )
})

window.addEventListener('unhandledrejection', (event) => {
  if (import.meta.env.DEV) console.error('[Alethe][unhandledrejection]', event.reason)
  const reason = event.reason as { message?: string; stack?: string } | undefined
  captureGlobalError(
    reason?.message ?? String(event.reason),
    reason?.stack ?? null,
    'unhandledrejection',
  )
})

watchPluginThemeStyles()

/** The orchestration pane this window was opened to show on its own (#247), if any. */
function detachedBoardPane(): string | null {
  try {
    return orchestrationWindowPane(getCurrentWebviewWindow().label)
  } catch {
    // Outside Tauri (the plain Vite dev server) there is no window label.
    return null
  }
}

const boardPane = detachedBoardPane()
if (boardPane) {
  // The main window owns projects.json; this one only reads it.
  setProjectsReadOnly(true)
} else {
  // Contributions land in reactive registries, so the shell renders immediately
  // and picks plugin surfaces up as they activate. The main window hosts them once.
  void initPluginHost()
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {boardPane ? <OrchestrationWindow terminalId={boardPane} /> : <App />}
  </React.StrictMode>,
)
