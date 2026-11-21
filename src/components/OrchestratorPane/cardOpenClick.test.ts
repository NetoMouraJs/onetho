import { describe, expect, it, vi } from 'vitest'

import { openCardUnlessTextSelected } from './cardOpenClick'

describe('openCardUnlessTextSelected', () => {
  it('runs the action when there is no text selection', () => {
    const action = vi.fn()
    vi.spyOn(window, 'getSelection').mockReturnValue(null)
    openCardUnlessTextSelected(action)
    expect(action).toHaveBeenCalledOnce()
  })

  it('skips the action when the user selected text', () => {
    const action = vi.fn()
    vi.spyOn(window, 'getSelection').mockReturnValue({
      type: 'Range',
      toString: () => 'copied line',
    } as Selection)
    openCardUnlessTextSelected(action)
    expect(action).not.toHaveBeenCalled()
  })
})