import { invoke } from '@tauri-apps/api/core'

import type { ExternalEditorId } from './types'

export function isExternalEditorId(value: unknown): value is ExternalEditorId {
  return value === 'vscode' || value === 'cursor'
}

export function externalEditorNameKey(editor: ExternalEditorId): 'externalEditor.vscode.name' | 'externalEditor.cursor.name' {
  return editor === 'cursor' ? 'externalEditor.cursor.name' : 'externalEditor.vscode.name'
}

export async function openInExternalEditor(path: string, editor: ExternalEditorId): Promise<void> {
  await invoke('open_in_external_editor', { path, editor })
}