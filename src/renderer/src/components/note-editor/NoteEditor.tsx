import React, { useEffect, useRef } from 'react'
import { Annotation, EditorSelection, EditorState, StateEffect, StateField, type Text } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  keymap,
  placeholder,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { tags } from '@lezer/highlight'
import type { NoteClipSource, NoteTarget } from '@shared/types'
import { HUSH_LINK, noteClips } from '@shared/noteClips'
import { sourceTermMatches } from '@shared/search'
import { flushNoteSave, sameTarget, scheduleNoteSave } from '@renderer/lib/noteSave'
import { isWindows } from '@renderer/lib/platform'
import { livePreview, previewLinkClick } from './livePreview'
import { mathSyntax } from './mathSyntax'

// Marks changes the main process already saved, so they aren't saved again.
const fromMain = Annotation.define<boolean>()

// Each note keeps its state across switches, so its undo history survives; one view shows at a time.
const states = new Map<string, EditorState>()
let live: {
  target: NoteTarget
  view: EditorView
  onChange: (content: string) => void
  // Set once the note is deleted, so closing the editor doesn't cache it again.
  forgotten: boolean
} | null = null

export type NoteSelection = { from: number; to: number; text: string }

const keyOf = (target: NoteTarget): string => `${target.scope}:${target.scopeId}`

// Every change to a note's text, typed or written by the main process; the conversation's replies
// follow it to show what the note clipped.
type ContentListener = (target: NoteTarget, content: string) => void
const contentListeners = new Set<ContentListener>()

export function onNoteContent(listener: ContentListener): void {
  contentListeners.add(listener)
}

function emitContent(target: NoteTarget, content: string): void {
  for (const listener of contentListeners) listener(target, content)
}

// The editor's text runs up to 0.5s ahead of the database (lib/noteSave.ts); null when not loaded.
export function noteContentOf(target: NoteTarget): string | null {
  if (live && sameTarget(live.target, target)) return live.view.state.doc.toString()
  return states.get(keyOf(target))?.doc.toString() ?? null
}

// A clip opened from a reply flashes whole lines, like a message opened from its link; ⌘K hits flash
// just the words.
type Flash = { lines: { from: number; to: number } } | { words: { from: number; to: number }[] }
const setFlash = StateEffect.define<Flash | null>()
const FLASH_MS = 2000

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(flash, tr) {
    flash = flash.map(tr.changes)
    for (const effect of tr.effects) {
      if (!effect.is(setFlash)) continue
      if (!effect.value) flash = Decoration.none
      else if ('words' in effect.value) {
        flash = Decoration.set(effect.value.words.map((w) => Decoration.mark({ class: 'cm-flash-word' }).range(w.from, w.to)))
      } else {
        const { from, to } = effect.value.lines
        const lines = []
        for (let pos = from; pos <= to; ) {
          const line = tr.state.doc.lineAt(pos)
          lines.push(Decoration.line({ class: 'cm-flash-line' }).range(line.from))
          pos = line.to + 1
        }
        flash = Decoration.set(lines)
      }
    }
    return flash
  },
  provide: (field) => EditorView.decorations.from(field)
})

const hushLinks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    private matcher = new MatchDecorator({
      regexp: HUSH_LINK,
      decoration: Decoration.mark({ class: 'cm-hush-link', attributes: { title: `${isWindows ? 'Ctrl' : '⌘'} 点击跳回原文` } })
    })
    constructor(view: EditorView) {
      this.decorations = this.matcher.createDeco(view)
    }
    update(update: ViewUpdate): void {
      this.decorations = this.matcher.updateDeco(update, this.decorations)
    }
  },
  { decorations: (plugin) => plugin.decorations }
)

function hushLinkAt(view: EditorView, event: MouseEvent): string | null {
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
  if (pos === null) return null
  const line = view.state.doc.lineAt(pos)
  for (const match of line.text.matchAll(HUSH_LINK)) {
    const from = line.from + match.index
    if (pos >= from && pos <= from + match[0].length) return match[1]
  }
  return null
}

const highlightStyle = HighlightStyle.define([
  { tag: tags.heading1, fontWeight: '700', fontSize: '1.2em' },
  { tag: tags.heading2, fontWeight: '700', fontSize: '1.1em' },
  { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.quote, color: 'var(--text-secondary)' },
  { tag: tags.link, color: 'var(--accent-link)' },
  { tag: [tags.url, tags.processingInstruction, tags.contentSeparator], color: 'var(--text-muted)' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.88em' }
])

const theme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--text-primary)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-body)',
    fontSize: 'var(--body-font-size)',
    lineHeight: '1.72',
    overflow: 'visible'
  },
  '.cm-content': { padding: '0', caretColor: 'var(--text-primary)' },
  '.cm-line': { padding: '0', transition: 'background-color 0.35s ease' },
  '.cm-flash-line': { backgroundColor: 'var(--accent-flash)' },
  '.cm-flash-word': { backgroundColor: 'var(--accent-flash)' },
  '.cm-cursor': { borderLeftColor: 'var(--text-primary)' },
  '.cm-placeholder': { color: 'var(--text-faint)' },
  '.cm-hush-link': { color: 'var(--text-muted)' }
})

// How Markdown looks in any note editor, the AI draft and comparison included.
export const noteLook = [markdown({ base: markdownLanguage, extensions: [mathSyntax] }), syntaxHighlighting(highlightStyle), EditorView.lineWrapping, theme, hushLinks]

type EditorCallbacks = {
  onJumpToMessage: (messageId: string) => void
  onOpenSession: (sessionId: string) => void
  onSelectionMenu: (x: number, y: number, selection: NoteSelection) => void
}

function createState(target: NoteTarget, content: string, callbacks: EditorCallbacks): EditorState {
  return EditorState.create({
    doc: content,
    extensions: [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      // Before noteLook, so its link marks sit inside the hush-link ones and their tooltip wins.
      livePreview,
      noteLook,
      placeholder('还没有内容'),
      flashField,
      EditorView.domEventHandlers({
        mousedown: (event, view) => {
          if (previewLinkClick(event, callbacks.onJumpToMessage, callbacks.onOpenSession)) return true
          if (!(event.metaKey || event.ctrlKey)) return false
          const messageId = hushLinkAt(view, event)
          if (!messageId) return false
          event.preventDefault()
          callbacks.onJumpToMessage(messageId)
          return true
        },
        // Right-clicking a selection offers moving or copying it to another note (product.md §6).
        contextmenu: (event, view) => {
          const { from, to } = view.state.selection.main
          if (from === to) return false
          event.preventDefault()
          callbacks.onSelectionMenu(event.clientX, event.clientY, {
            from,
            to,
            text: view.state.sliceDoc(from, to)
          })
          return true
        }
      }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return
        const content = update.state.doc.toString()
        if (!update.transactions.some((tr) => tr.annotation(fromMain))) scheduleNoteSave(target, content)
        if (live?.view === update.view) live.onChange(content)
        emitContent(target, content)
      })
    ]
  })
}

function commonPrefixLength(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}

// Brings an open or cached editor up to what the main process wrote. Applied as a change rather than
// a reset, so ⌘Z can take it back.
export function syncNoteContent(target: NoteTarget, content: string): void {
  const changeFor = (state: EditorState) => {
    const current = state.doc.toString()
    const from = commonPrefixLength(current, content)
    return { changes: { from, to: current.length, insert: content.slice(from) }, annotations: fromMain.of(true) }
  }
  if (live && sameTarget(live.target, target)) {
    live.view.dispatch({
      ...changeFor(live.view.state),
      effects: EditorView.scrollIntoView(content.length)
    })
    return
  }
  const cached = states.get(keyOf(target))
  if (cached) states.set(keyOf(target), cached.update(changeFor(cached)).state)
  emitContent(target, content)
}

// For a note that was deleted (with its session or project, or merged away).
export function forgetNoteState(target: NoteTarget): void {
  states.delete(keyOf(target))
  if (live && sameTarget(live.target, target)) live.forgotten = true
}

export function scrollNoteToLine(lineIndex: number): void {
  if (!live) return
  const { view } = live
  const line = view.state.doc.line(Math.min(lineIndex + 1, view.state.doc.lines))
  view.dispatch({
    selection: EditorSelection.cursor(line.from),
    effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 12 })
  })
  view.focus()
}

// What to flash once the note is on screen; null when it isn't in the note (anymore).
type Locate = (doc: Text) => Flash | null

// Waits for the note's editor to open when it isn't the one showing yet.
let pendingReveal: { target: NoteTarget; locate: Locate } | null = null

function reveal(view: EditorView, locate: Locate): void {
  const flash = locate(view.state.doc)
  if (!flash) return
  const at = 'words' in flash ? flash.words[0].from : flash.lines.from
  view.dispatch({
    effects: [setFlash.of(flash), EditorView.scrollIntoView(at, { y: 'center' })]
  })
  // CodeMirror first aims by estimated heights of lines it hasn't drawn, and corrects them a frame or
  // two later, which can push the spot out of view; aim again once its height stops changing.
  let height = -1
  const settle = (frame: number): void => {
    if (!view.dom.isConnected) return
    if (view.contentHeight !== height && frame < 30) {
      height = view.contentHeight
      requestAnimationFrame(() => settle(frame + 1))
    } else view.dom.querySelector('.cm-flash-word, .cm-flash-line')?.scrollIntoView({ block: 'center' })
  }
  requestAnimationFrame(() => settle(0))
  setTimeout(() => {
    if (!view.dom.isConnected) return
    view.dispatch({ effects: setFlash.of(null) })
  }, FLASH_MS)
}

function revealIn(target: NoteTarget, locate: Locate): void {
  if (live && sameTarget(live.target, target)) {
    pendingReveal = null
    reveal(live.view, locate)
  } else pendingReveal = { target, locate }
}

export function revealNoteClip(target: NoteTarget, clip: NoteClipSource): void {
  revealIn(target, (doc) => {
    const found = noteClips(doc.toString()).find(
      (c) => c.messageId === clip.messageId && c.start === clip.start && c.end === clip.end
    )
    if (!found) return null
    // The clip's quote is the run of `>` lines that ends with its link.
    let first = doc.lineAt(found.at)
    while (first.number > 1 && doc.line(first.number - 1).text.startsWith('>')) first = doc.line(first.number - 1)
    return { lines: { from: first.from, to: doc.lineAt(found.at).to } }
  })
}

// The lines holding `text`, last occurrence: what was just appended.
export function revealNoteText(target: NoteTarget, text: string): void {
  revealIn(target, (doc) => {
    const at = doc.toString().lastIndexOf(text)
    if (at === -1) return null
    return { lines: { from: at, to: at + text.length } }
  })
}

export function revealNoteTerms(target: NoteTarget, terms: string[]): void {
  revealIn(target, (doc) => {
    const words = sourceTermMatches(doc.toString(), terms)
    return words.length ? { words } : null
  })
}

interface NoteEditorProps extends EditorCallbacks {
  target: NoteTarget
  onChange: (content: string) => void
}

export const NoteEditor: React.FC<NoteEditorProps> = ({ target, onChange, onJumpToMessage, onOpenSession, onSelectionMenu }) => {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  // The editor state outlives this component, so it calls back through refs to the latest props.
  const callbacksRef = useRef<EditorCallbacks>({ onJumpToMessage, onOpenSession, onSelectionMenu })
  callbacksRef.current = { onJumpToMessage, onOpenSession, onSelectionMenu }
  const { scope, scopeId } = target

  useEffect(() => {
    const target: NoteTarget = { scope, scopeId }
    const key = keyOf(target)
    let view: EditorView | null = null
    let cancelled = false

    const mount = (state: EditorState): void => {
      view = new EditorView({ state, parent: hostRef.current! })
      live = { target, view, onChange: (content) => onChangeRef.current(content), forgotten: false }
      onChangeRef.current(state.doc.toString())
      if (pendingReveal && sameTarget(pendingReveal.target, target)) {
        reveal(view, pendingReveal.locate)
        pendingReveal = null
      }
    }

    const cached = states.get(key)
    if (cached) mount(cached)
    else {
      onChangeRef.current('')
      window.api.invoke('notes:get', target).then((content) => {
        if (!cancelled)
          mount(
            createState(target, content, {
              onJumpToMessage: (id) => callbacksRef.current.onJumpToMessage(id),
              onOpenSession: (id) => callbacksRef.current.onOpenSession(id),
              onSelectionMenu: (x, y, selection) => callbacksRef.current.onSelectionMenu(x, y, selection)
            })
          )
      })
    }

    return () => {
      cancelled = true
      if (view) {
        // A flash still showing would come back the next time the note opens.
        if (!(live?.view === view && live.forgotten)) states.set(key, view.state.update({ effects: setFlash.of(null) }).state)
        if (live?.view === view) live = null
        view.destroy()
      }
      void flushNoteSave()
    }
  }, [scope, scopeId])

  return <div ref={hostRef} className="note-editor-host" />
}
