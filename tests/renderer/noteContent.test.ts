import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteTarget } from '../../src/shared/types'

const target: NoteTarget = { scope: 'session', scopeId: 'a' }

beforeEach(() => vi.resetModules())

describe('note content without loading the editor', () => {
  it('keeps main-process writes before CodeMirror loads and forgets deleted notes', async () => {
    const notes = await import('../../src/renderer/src/lib/noteContent')
    const changed = vi.fn()
    notes.onNoteContent(changed)
    expect(notes.noteContentOf(target)).toBeNull()
    notes.syncNoteContent(target, '收录的内容')
    expect(notes.noteContentOf(target)).toBe('收录的内容')
    expect(changed).toHaveBeenCalledWith(target, '收录的内容')
    notes.forgetNoteState(target)
    expect(notes.noteContentOf(target)).toBeNull()
  })

  it('routes writes and deletion to the loaded editor while keeping the latest typed text', async () => {
    const notes = await import('../../src/renderer/src/lib/noteContent')
    const editor = { sync: vi.fn(), forget: vi.fn() }
    notes.registerNoteEditor(editor)
    notes.emitNoteContent(target, '尚未自动保存的输入')
    expect(notes.noteContentOf(target)).toBe('尚未自动保存的输入')
    notes.syncNoteContent(target, '同步后的内容')
    expect(editor.sync).toHaveBeenCalledWith(target, '同步后的内容')
    expect(notes.noteContentOf(target)).toBe('同步后的内容')
    notes.forgetNoteState(target)
    expect(editor.forget).toHaveBeenCalledWith(target)
    expect(notes.noteContentOf(target)).toBeNull()
  })
})
