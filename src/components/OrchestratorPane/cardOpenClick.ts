/** Run a card "open inspector" action unless the user has a non-empty text selection. */
export function openCardUnlessTextSelected(action: () => void): void {
  const selection = window.getSelection()
  if (selection?.type === 'Range' && selection.toString().length > 0) return
  action()
}