import { describe, expect, it } from 'vitest'
import { hushLinkSessionId, pastedSessionId, sessionLink } from '../src/shared/sessionLinks'

describe('sessionLinks', () => {
  it('escapes brackets in the title, and the pasted link reads back to its session', () => {
    const link = sessionLink('s-1', '[草稿] 矩阵')
    expect(link).toBe('[《\\[草稿\\] 矩阵》](hush://session/s-1)')
    expect(pastedSessionId(` ${link}\n`)).toBe('s-1')
  })

  it('takes a bare link too, but not one inside other text', () => {
    expect(pastedSessionId('hush://session/s-1')).toBe('s-1')
    expect(pastedSessionId('看这个 [《矩阵》](hush://session/s-1)')).toBeNull()
    expect(pastedSessionId('[《矩阵》](hush://message/m-1)')).toBeNull()
  })

  it('tells session links from other links', () => {
    expect(hushLinkSessionId('hush://session/s-1')).toBe('s-1')
    expect(hushLinkSessionId('hush://message/m-1#0-3')).toBeNull()
    expect(hushLinkSessionId('https://example.com')).toBeNull()
  })
})
