import { describe, expect, it } from 'vitest'

import { externalEditorNameKey, isExternalEditorId } from './externalEditor'
import { DEFAULT_PREFERENCES } from './types'
import { normalizePreferences } from '../stores/projectsStore.migrations'

describe('externalEditor preference', () => {
  it('defaults existing installations to VS Code', () => {
    expect(normalizePreferences({}).externalEditor).toBe('vscode')
    expect(DEFAULT_PREFERENCES.externalEditor).toBe('vscode')
  })

  it('persists Cursor when saved', () => {
    expect(normalizePreferences({ externalEditor: 'cursor' }).externalEditor).toBe('cursor')
  })

  it('rejects unknown values', () => {
    expect(normalizePreferences({ externalEditor: 'emacs' as 'vscode' }).externalEditor).toBe('vscode')
  })

  it('maps editor ids to display-name keys', () => {
    expect(externalEditorNameKey('vscode')).toBe('externalEditor.vscode.name')
    expect(externalEditorNameKey('cursor')).toBe('externalEditor.cursor.name')
  })

  it('recognizes supported editor ids', () => {
    expect(isExternalEditorId('vscode')).toBe(true)
    expect(isExternalEditorId('cursor')).toBe(true)
    expect(isExternalEditorId('code')).toBe(false)
  })
})