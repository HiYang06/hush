import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MainSession, Message } from '../../src/shared/types'

vi.mock('@renderer/mock/data', () => ({ mockSettings: {} }))
vi.mock('@renderer/lib/noteSave', () => ({
  flushNoteSave: vi.fn().mockResolvedValue(undefined),
  hasPendingNoteSave: () => false,
  sameTarget: (a: { scope: string; scopeId: string }, b: { scope: string; scopeId: string }) => a.scope === b.scope && a.scopeId === b.scopeId
}))
vi.mock('@renderer/lib/anchors', () => ({ anchorToRange: vi.fn(), termRanges: vi.fn() }))
vi.mock('@renderer/lib/highlights', () => ({ flashPassages: vi.fn() }))
vi.mock('@renderer/lib/noteContent', () => ({
  forgetNoteState: vi.fn(), noteContentOf: () => null, onNoteContent: vi.fn(),
  revealNoteClip: vi.fn(), revealNoteTerms: vi.fn(), syncNoteContent: vi.fn()
}))

const defaultInvoke = (channel: string): Promise<unknown> => Promise.resolve(channel === 'notes:get' ? '' : [])
const invoke = vi.fn(defaultInvoke)
let store: typeof import('../../src/renderer/src/stores/appStore').useAppStore

beforeAll(async () => {
  vi.stubGlobal('window', { api: { invoke, on: vi.fn(), setZoomFactor: vi.fn() }, addEventListener: vi.fn() })
  store = (await import('../../src/renderer/src/stores/appStore')).useAppStore
})

beforeEach(() => {
  store.setState({
    activeSessionId: null, sessions: [], messages: [], chatDrafts: {}, readingPositions: {},
    loadingConversations: {}, messageJump: null, highlightedMessageId: null, noteClips: null
  })
  invoke.mockReset().mockImplementation(defaultInvoke)
})

function message(id: string): Message {
  return {
    id, sessionId: 'a', seq: 1, role: 'assistant', content: id,
    thinking: null, thinkingMs: null, attachments: [], status: 'done', error: null, errorKind: null,
    providerId: null, modelId: null, inputTokens: null, outputTokens: null, web: null, createdAt: 0
  }
}

describe('conversation memory', () => {
  it('keeps drafts and delayed attachment results with their original input after switching', () => {
    const { updateChatDraft, selectSession, startNewSession } = store.getState()
    updateChatDraft('new:', (draft) => ({ ...draft, text: '还没发送的新问题' }))
    selectSession('a')
    updateChatDraft('main:a', (draft) => ({
      ...draft, text: 'A 的问题', pending: [{ key: 'file', name: 'a.pdf', file: null, error: null }],
      noteRefs: [{ type: 'note_ref', noteId: 'note', sectionTitle: null, label: 'Note', text: '引用' }],
      sessionRefs: [{ type: 'session_ref', sessionId: 'source', label: '来源', text: '原文' }]
    }))
    selectSession('b')
    updateChatDraft('main:b', (draft) => ({ ...draft, text: 'B 的问题' }))
    // The promise's callback still holds A's key after its component unmounted.
    updateChatDraft('main:a', (draft) => ({ ...draft, pending: draft.pending.map((p) => ({ ...p, error: '读取失败' })) }))
    selectSession('a')
    const drafts = store.getState().chatDrafts
    expect(drafts['main:a']).toMatchObject({ text: 'A 的问题', pending: [{ error: '读取失败' }], noteRefs: [{ text: '引用' }], sessionRefs: [{ sessionId: 'source' }] })
    expect(drafts['main:b'].text).toBe('B 的问题')
    startNewSession()
    expect(store.getState().chatDrafts['new:'].text).toBe('还没发送的新问题')
  })

  it('keeps each thread draft through closing the panel and opening another thread', () => {
    const { updateChatDraft, selectThread, closeRightPanel } = store.getState()
    selectThread('first')
    updateChatDraft('thread:first', (draft) => ({ ...draft, text: '追问一' }))
    closeRightPanel()
    selectThread('second')
    updateChatDraft('thread:second', (draft) => ({ ...draft, text: '追问二' }))
    selectThread('first')
    expect(store.getState().chatDrafts['thread:first'].text).toBe('追问一')
    expect(store.getState().chatDrafts['thread:second'].text).toBe('追问二')
  })

  it('does not discard a saved reading anchor while messages load asynchronously', async () => {
    let finish!: (messages: Message[]) => void
    invoke.mockImplementation((channel: string) => channel === 'messages:list' ? new Promise<Message[]>((resolve) => { finish = resolve }) : defaultInvoke(channel))
    const position = { messageId: 'reply', offset: -250, scrollTop: 3200, sentQuestionId: null }
    store.getState().saveReadingPosition('a', position)
    store.getState().selectSession('a')
    expect(store.getState().loadingConversations.a).toBe(true)
    finish([])
    await Promise.resolve()
    expect(store.getState().loadingConversations.a).toBe(false)
    expect(store.getState().readingPositions.a).toEqual(position)
  })

  it('ignores an older message load after a rapid return starts another load', async () => {
    const requests: ((messages: Message[]) => void)[] = []
    invoke.mockImplementation((channel: string) => channel === 'messages:list'
      ? new Promise<Message[]>((resolve) => requests.push(resolve)) : defaultInvoke(channel))
    store.getState().selectSession('a')
    store.getState().selectSession('b')
    store.getState().selectSession('a')
    requests[0]([message('stale')])
    await Promise.resolve()
    expect(store.getState().loadingConversations.a).toBe(true)
    requests[2]([message('current')])
    await Promise.resolve()
    expect(store.getState().messages.map((m) => m.id)).toEqual(['current'])
    expect(store.getState().loadingConversations.a).toBe(false)
    requests[1]([])
    await Promise.resolve()
  })

  it('cancels a delayed message lookup when the reader chooses a different conversation', async () => {
    let finish!: (message: Message) => void
    invoke.mockImplementation((channel: string) => channel === 'messages:get'
      ? new Promise<Message>((resolve) => { finish = resolve }) : defaultInvoke(channel))
    const jumping = store.getState().jumpToMessage('late')
    expect(store.getState().messageJump?.messageId).toBe('late')
    store.getState().selectSession('b')
    finish(message('late'))
    await jumping
    expect(store.getState().activeSessionId).toBe('b')
    expect(store.getState().messageJump).toBeNull()
  })

  it('keeps an explicit jump active until a cached conversation finishes reloading', async () => {
    vi.useFakeTimers()
    try {
      const session: MainSession = {
        id: 'a', kind: 'main', projectId: null, parentSessionId: null, anchorMessageId: null,
        anchorQuote: null, anchorStart: null, anchorEnd: null, anchorPrefix: null, anchorSuffix: null,
        contextMode: null, title: 'A', providerId: null, modelId: null, createdAt: 0, updatedAt: 0
      }
      let finish!: (messages: Message[]) => void
      invoke.mockImplementation((channel: string) => channel === 'messages:list'
        ? new Promise<Message[]>((resolve) => { finish = resolve }) : defaultInvoke(channel))
      store.setState({ sessions: [session], messages: [message('target')] })
      store.getState().selectSession('a')
      const jumping = store.getState().jumpToMessage('target')
      vi.advanceTimersByTime(3000)
      expect(store.getState().messageJump?.messageId).toBe('target')
      finish([message('target')])
      await jumping
      expect(store.getState().loadingConversations.a).toBe(false)
      expect(store.getState().highlightedMessageId).toBe('target')
      vi.advanceTimersByTime(2000)
      expect(store.getState().messageJump).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
