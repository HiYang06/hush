import { describe, expect, it } from 'vitest'
import { hushLinkMessageId, noteClips } from '../src/shared/noteClips'

describe('noteClips', () => {
  it('reads each clip link with its range and where it sits', () => {
    const note = '前言\n\n> 原文\n>\n> —— [《\\[草稿\\] 矩阵》](hush://message/m-1#3-12)\n\n> 又一段\n>\n> —— [《矩阵》](hush://message/m2#0-4)\n'
    expect(noteClips(note)).toEqual([
      { messageId: 'm-1', start: 3, end: 12, at: note.indexOf('[《\\[') },
      { messageId: 'm2', start: 0, end: 4, at: note.indexOf('[《矩阵') }
    ])
  })

  it('skips links written before clips kept a range', () => {
    expect(noteClips('> x\n>\n> —— [《旧》](hush://message/m1)')).toEqual([])
  })
})

describe('hushLinkMessageId', () => {
  it('drops the range', () => {
    expect(hushLinkMessageId('hush://message/m1#3-12')).toBe('m1')
    expect(hushLinkMessageId('hush://message/m1')).toBe('m1')
  })
})
