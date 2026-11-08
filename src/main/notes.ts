import type Database from 'better-sqlite3'
import type { NoteClipSource, NoteTarget, NoteTransfer } from '@shared/types'
import { getMessage } from './db/repo/messages'
import { appendToNote, getNoteContent, replaceNote, withAppended } from './db/repo/notes'
import { getSession } from './db/repo/sessions'

// The clip format from product.md §6: the quote, then a link back to where it came from. The link
// carries the passage's position in the reply, so the reply can show what this note clipped.
// A mark's comment follows as body text, below the quote.
export function clipBlock(markdown: string, title: string, clip: NoteClipSource, comment: string | null = null): string {
  const quoted = markdown
    .trim()
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
  const linkText = title.replace(/[[\]\\]/g, '\\$&')
  const link = `> —— [《${linkText}》](hush://message/${clip.messageId}#${clip.start}-${clip.end})`
  return [...quoted, '>', link, ...(comment ? ['', comment.trim()] : [])].join('\n')
}

// A thread's text goes to its main session's note; a session in a project writes to the project's note.
export function clipToNote(
  db: Database.Database,
  clip: NoteClipSource,
  markdown: string,
  comment: string | null = null
): { target: NoteTarget; content: string } {
  const session = getSession(db, getMessage(db, clip.messageId).sessionId)
  const main = session.kind === 'thread' ? getSession(db, session.parentSessionId) : session
  const target: NoteTarget = main.projectId
    ? { scope: 'project', scopeId: main.projectId }
    : { scope: 'session', scopeId: main.id }
  return { target, content: appendToNote(db, target, clipBlock(markdown, main.title, clip, comment)) }
}

// Moving or copying part of a note to the end of another (product.md §6). Both notes keep a revision.
// The window saved its edits first, so the range must still hold the text it saw.
export function transferNoteText(db: Database.Database, input: NoteTransfer): { source: string; target: string } {
  return db.transaction(() => {
    const sourceContent = getNoteContent(db, input.source)
    if (sourceContent.slice(input.from, input.to) !== input.text) {
      throw new Error('The note changed under the selection; nothing was moved')
    }
    const target = withAppended(getNoteContent(db, input.target), input.text.trim())
    replaceNote(db, input.target, target, 'migrate_in')
    if (input.mode === 'copy') return { source: sourceContent, target }
    const source = sourceContent.slice(0, input.from) + sourceContent.slice(input.to)
    replaceNote(db, input.source, source, 'migrate_out')
    return { source, target }
  })()
}

// An AI draft the user accepted goes to the end of the note, keeping what was there as a revision.
export function appendAiDraft(db: Database.Database, target: NoteTarget, markdown: string): string {
  return db.transaction(() => {
    const content = withAppended(getNoteContent(db, target), markdown.trim())
    replaceNote(db, target, content, 'ai_append')
    return content
  })()
}

// The rewrite was made from `base`; anything written to the note since (a clip, say) would be lost.
export function replaceWithAiRewrite(db: Database.Database, target: NoteTarget, base: string, content: string): string {
  return db.transaction(() => {
    if (getNoteContent(db, target) !== base) throw new Error('The note changed while it was being organized')
    replaceNote(db, target, content, 'ai_rewrite')
    return content
  })()
}
