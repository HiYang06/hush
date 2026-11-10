import type { NoteClipSource, NoteTarget } from '@shared/types'

const keyOf = (target: NoteTarget): string => `${target.scope}:${target.scopeId}`
const contents = new Map<string, string>()
type ContentListener = (target: NoteTarget, content: string) => void
const listeners = new Set<ContentListener>()

// The editor registers only after its lazy chunk loads; the store can read and sync text before that.
let editor: {
  sync: (target: NoteTarget, content: string) => void
  forget: (target: NoteTarget) => void
} | null = null

export function registerNoteEditor(adapter: NonNullable<typeof editor>): void {
  editor = adapter
}

export function onNoteContent(listener: ContentListener): void {
  listeners.add(listener)
}

export function emitNoteContent(target: NoteTarget, content: string): void {
  contents.set(keyOf(target), content)
  for (const listener of listeners) listener(target, content)
}

export function noteContentOf(target: NoteTarget): string | null {
  return contents.get(keyOf(target)) ?? null
}

export function syncNoteContent(target: NoteTarget, content: string): void {
  editor?.sync(target, content)
  emitNoteContent(target, content)
}

export function forgetNoteState(target: NoteTarget): void {
  contents.delete(keyOf(target))
  editor?.forget(target)
}

export function revealNoteClip(target: NoteTarget, clip: NoteClipSource): void {
  void import('../components/note-editor/NoteEditor').then((m) => m.revealNoteClip(target, clip))
}

export function revealNoteTerms(target: NoteTarget, terms: string[]): void {
  void import('../components/note-editor/NoteEditor').then((m) => m.revealNoteTerms(target, terms))
}
