import { aimScroll } from '../lib/aimScroll'
import { create } from 'zustand'
import type {
  Attachment,
  FileRecord,
  Mark,
  MarkCategory,
  MarkInput,
  MarkPatch,
  Message,
  Model,
  NoteClipSource,
  NoteTarget,
  NoteTransfer,
  Project,
  ProjectPatch,
  Provider,
  SearchService,
  Session,
  Settings,
  ThinkingLevel,
  ThreadAnchor,
  ThreadContextMode,
  SyncApplied,
  SyncStatus,
  UpdateStatus
} from '@shared/types'
import { mockSettings } from '@renderer/mock/data'
import { flushNoteSave, hasPendingNoteSave, sameTarget } from '@renderer/lib/noteSave'
import { noteClips } from '@shared/noteClips'
import { anchorToRange, termRanges } from '@renderer/lib/anchors'
import { flashPassages } from '@renderer/lib/highlights'
import {
  forgetNoteState,
  noteContentOf,
  onNoteContent,
  revealNoteClip,
  revealNoteTerms,
  syncNoteContent
} from '@renderer/lib/noteContent'

export type RightPanelTab = 'thread' | 'mark' | 'note' | 'file'

// Which input box is acting: the main conversation's or the open thread's.
export type ChatTarget = 'main' | 'thread'

// A thread that exists only in the window until its first message is sent; until then Fork/New can change.
export type DraftThread = Omit<ThreadAnchor, 'contextMode'> & { contextMode: ThreadContextMode }

// The note that belongs to the open conversation: its project's, else its own; the global note on the blank page.
export function sessionNoteTarget(sessions: Session[], activeSessionId: string | null): NoteTarget {
  const session = sessions.find((s) => s.id === activeSessionId && s.kind === 'main')
  if (!session) return { scope: 'global', scopeId: 'global' }
  if (session.projectId) return { scope: 'project', scopeId: session.projectId }
  return { scope: 'session', scopeId: session.id }
}

// The card for a new or an existing mark sits under `bottom`, or above `top` when there's no room.
export type MarkCardState = { x: number; top: number; bottom: number } & (
  | { markId: string }
  | { draft: Omit<MarkInput, 'comment' | 'categoryId'> }
)

export type ThreadResult = Extract<Attachment, { type: 'thread_result' }>
export type PendingFile = { key: string; name: string; file: FileRecord | null; error: string | null }
export type ChatDraft = {
  text: string
  pending: PendingFile[]
  noteRefs: Extract<Attachment, { type: 'note_ref' }>[]
  sessionRefs: Extract<Attachment, { type: 'session_ref' }>[]
}
export const EMPTY_CHAT_DRAFT: ChatDraft = { text: '', pending: [], noteRefs: [], sessionRefs: [] }
export type ReadingPosition = { messageId: string; offset: number; scrollTop: number; sentQuestionId: string | null }

export type MarkQuiz = Extract<Attachment, { type: 'mark_quiz' }>

export type SearchHit =
  | { kind: 'session'; id: string }
  | { kind: 'message'; id: string }
  | { kind: 'note'; target: NoteTarget }

export function streamingReplyIn(messages: Message[], sessionId: string | null): Message | undefined {
  return messages.find((m) => m.sessionId === sessionId && m.status === 'streaming')
}

export interface AppState {
  projects: Project[]
  sessions: Session[]
  messages: Message[]
  marks: Mark[]
  markCategories: MarkCategory[]
  providers: Provider[]
  models: Model[]
  // False until the first load, so the empty lists aren't taken for "nothing set up yet".
  providersLoaded: boolean
  files: FileRecord[]
  settings: Settings
  fontSize: number

  activeSessionId: string | null
  chatDrafts: Record<string, ChatDraft>
  updateChatDraft: (key: string, update: (draft: ChatDraft) => ChatDraft) => void
  readingPositions: Record<string, ReadingPosition>
  saveReadingPosition: (sessionId: string, position: ReadingPosition) => void
  loadingConversations: Record<string, boolean>
  // Set before any asynchronous jump work, so restoring a conversation cannot compete with it.
  messageJump: { messageId: string } | null
  expandedProjectIds: Record<string, boolean>
  leftSidebarOpen: boolean
  leftSidebarManualOverride: boolean | null
  rightPanelOpen: boolean
  rightPanelTab: RightPanelTab
  rightPanelWidth: number
  noteExpandedToCenter: boolean
  activeNoteTarget: NoteTarget | null
  // What the open conversation's note clipped, so its replies can underline it; follows the note's text.
  noteClips: { target: NoteTarget; clips: NoteClipSource[] } | null
  activeThreadId: string | null
  // The file the 附件 tab previews; null shows the list.
  activeFileId: string | null
  draftThread: DraftThread | null
  // The model the thread input box uses; a thread starts with its main session's model.
  threadModelId: string
  selectedMarkCategoryId: string | null
  markCard: MarkCardState | null
  // Brought back from threads, waiting above each main session's input box until sent; keyed by main session.
  bringBacks: Record<string, ThreadResult[]>
  // Waiting above the blank new conversation's input box until sent.
  markQuiz: MarkQuiz | null
  highlightedMessageId: string | null
  selectedModelId: string
  thinkingLevel: ThinkingLevel
  // The 联网 switch by the input box; on by default (docs/plans/2026-10-25-web-search.md).
  webSearch: boolean
  searchServices: SearchService[]
  // Replies whose latest event is a web step, so the status line says what it is doing right now.
  webBusy: Record<string, true>
  lastScrolledUserMessageId: string | null
  settingsOpen: boolean
  // The page settings opens on; null lets it choose.
  settingsSection: 'search' | null
  // The first-run wizard; opened at startup when there's no provider yet (D-080).
  onboardingOpen: boolean
  // The project whose settings take over the window; null when closed.
  projectSettingsId: string | null
  // Where the blank new conversation will be created once its first message is sent.
  newSessionProjectId: string | null
  searchOpen: boolean
  // null until main answers at start-up.
  syncStatus: SyncStatus | null
  updateStatus: UpdateStatus | null

  selectSession: (sessionId: string) => void
  startNewSession: (projectId?: string | null) => void
  reloadSessions: () => Promise<void>
  createProject: (name: string) => Promise<void>
  updateProject: (id: string, patch: ProjectPatch) => Promise<void>
  deleteProject: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  moveSession: (id: string, projectId: string | null) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  dropOrphanMessages: () => void
  openProjectSettings: (projectId: string) => void
  closeProjectSettings: () => void
  toggleProjectExpanded: (projectId: string) => void
  toggleLeftSidebar: () => void
  setLeftSidebarAutoCollapse: (shouldCollapse: boolean) => void
  toggleRightPanel: (tab?: RightPanelTab) => void
  openRightPanelTab: (tab: RightPanelTab) => void
  closeRightPanel: () => void
  setRightPanelWidth: (width: number) => void
  toggleNoteExpandedToCenter: () => void
  openGlobalNote: () => void
  openProjectNote: (projectId: string) => void
  openSessionNote: () => void
  selectThread: (threadId: string | null) => void
  openFilePreview: (fileId: string | null) => void
  startDraftThread: (anchor: Omit<ThreadAnchor, 'contextMode'>) => void
  setDraftThreadMode: (mode: ThreadContextMode) => void
  deleteThread: (id: string) => Promise<void>
  setSelectedMarkCategory: (categoryId: string | null) => void
  openMarkCard: (card: MarkCardState) => void
  closeMarkCard: () => void
  createMark: (input: MarkInput) => Promise<void>
  updateMark: (id: string, patch: MarkPatch) => Promise<void>
  deleteMark: (id: string) => Promise<void>
  jumpToMark: (mark: Mark) => void
  // A thread's reply, or part of it, goes onto a card above its main session's input box (product.md §5).
  bringBack: (messageId: string, text: string) => void
  removeBringBack: (sessionId: string, item: ThreadResult) => void
  clearBringBacks: (sessionId: string) => void
  startMarkQuiz: (marks: Mark[]) => void
  clearMarkQuiz: () => void
  // With flash (a ⌘K hit, a mark), only the passages it finds in the reply flash instead of the whole message.
  jumpToMessage: (messageId: string, flash?: (body: Element) => Range[]) => Promise<void>
  setSearchOpen: (open: boolean) => void
  openSearchHit: (hit: SearchHit, terms: string[]) => void
  clipToNote: (clip: NoteClipSource, markdown: string, comment?: string | null) => Promise<void>
  openNoteClip: (clip: NoteClipSource) => void
  transferNoteText: (input: NoteTransfer) => Promise<void>
  restoreNoteRevision: (revisionId: string) => Promise<void>
  selectModel: (modelId: string, target?: ChatTarget) => void
  openSettings: () => void
  openSearchSettings: () => void
  closeSettings: () => void
  setOnboardingOpen: (open: boolean) => void
  setFontSize: (size: number) => void
  increaseFontSize: () => void
  decreaseFontSize: () => void
  resetFontSize: () => void
  reloadProviders: () => Promise<void>
  setThinkingLevel: (level: ThinkingLevel) => void
  setWebSearch: (on: boolean) => void
  reloadSearchServices: () => Promise<void>
  addFiles: (files: FileRecord[]) => void
  sendMessage: (content: string, attachments?: Attachment[], target?: ChatTarget) => Promise<void>
  // Regenerates the last reply, or with text replaces the last question first. False when the user cancels.
  regenerateReply: (replyId: string, text?: string | null) => Promise<boolean>
  stopStreaming: (sessionId: string) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  projects: [],
  sessions: [],
  messages: [],
  marks: [],
  markCategories: [],
  providers: [],
  models: [],
  providersLoaded: false,
  files: [],
  settings: mockSettings,
  fontSize: 16,

  activeSessionId: null,
  chatDrafts: {},
  updateChatDraft: (key, update) => set((state) => ({
    chatDrafts: { ...state.chatDrafts, [key]: update(state.chatDrafts[key] ?? EMPTY_CHAT_DRAFT) }
  })),
  readingPositions: {},
  saveReadingPosition: (sessionId, position) => set((state) => ({
    readingPositions: { ...state.readingPositions, [sessionId]: position }
  })),
  loadingConversations: {},
  messageJump: null,
  expandedProjectIds: {},
  leftSidebarOpen: true,
  leftSidebarManualOverride: null,
  rightPanelOpen: false,
  rightPanelTab: 'mark',
  rightPanelWidth: 420,
  noteExpandedToCenter: false,
  activeNoteTarget: null,
  noteClips: null,
  activeThreadId: null,
  activeFileId: null,
  draftThread: null,
  threadModelId: '',
  selectedMarkCategoryId: null,
  markCard: null,
  bringBacks: {},
  markQuiz: null,
  highlightedMessageId: null,
  selectedModelId: '',
  thinkingLevel: 'medium',
  webSearch: true,
  searchServices: [],
  webBusy: {},
  lastScrolledUserMessageId: null,
  settingsOpen: false,
  settingsSection: null,
  onboardingOpen: false,
  projectSettingsId: null,
  newSessionProjectId: null,
  searchOpen: false,
  syncStatus: null,
  updateStatus: null,

  selectSession: (sessionId) => {
    const session = get().sessions.find((s) => s.id === sessionId && s.kind === 'main')
    set({
      activeSessionId: sessionId,
      loadingConversations: { ...get().loadingConversations, [sessionId]: true },
      messageJump: null,
      highlightedMessageId: null,
      noteExpandedToCenter: false,
      activeNoteTarget: null,
      // The thread tab opens on the list until a thread is picked (product.md).
      activeThreadId: null,
      activeFileId: null,
      draftThread: null,
      selectedModelId: session?.modelId ?? get().selectedModelId,
      lastScrolledUserMessageId: null,
      settingsOpen: false,
      projectSettingsId: null,
      markCard: null
    })
    loadConversation(sessionId)
  },

  startNewSession: (projectId = null) => {
    set({
      activeSessionId: null,
      messageJump: null,
      highlightedMessageId: null,
      newSessionProjectId: projectId,
      markQuiz: null,
      projectSettingsId: null,
      activeFileId: null,
      noteExpandedToCenter: false,
      rightPanelOpen: false,
      lastScrolledUserMessageId: null,
      settingsOpen: false
    })
  },

  toggleProjectExpanded: (projectId) => {
    set((state) => ({
      expandedProjectIds: {
        ...state.expandedProjectIds,
        [projectId]: !state.expandedProjectIds[projectId]
      }
    }))
  },

  toggleLeftSidebar: () => {
    set((state) => {
      const next = !state.leftSidebarOpen
      return {
        leftSidebarOpen: next,
        leftSidebarManualOverride: next
      }
    })
  },

  setLeftSidebarAutoCollapse: (shouldCollapse) => {
    set((state) => {
      if (shouldCollapse) {
        return { leftSidebarOpen: false }
      }
      if (state.leftSidebarManualOverride !== null) {
        return { leftSidebarOpen: state.leftSidebarManualOverride }
      }
      return { leftSidebarOpen: true }
    })
  },

  toggleRightPanel: (tab) => {
    set((state) => {
      if (!state.rightPanelOpen) {
        return {
          rightPanelOpen: true,
          rightPanelTab: tab ?? state.rightPanelTab
        }
      }
      if (tab && state.rightPanelTab !== tab) {
        return { rightPanelTab: tab }
      }
      return {
        rightPanelOpen: false,
        noteExpandedToCenter: false
      }
    })
  },

  openRightPanelTab: (tab) => {
    set({
      rightPanelOpen: true,
      rightPanelTab: tab
    })
  },

  closeRightPanel: () => {
    set({
      rightPanelOpen: false,
      noteExpandedToCenter: false
    })
  },

  setRightPanelWidth: (width) => {
    set({ rightPanelWidth: width })
  },

  toggleNoteExpandedToCenter: () => {
    set((state) => ({
      noteExpandedToCenter: !state.noteExpandedToCenter,
      rightPanelOpen: true,
      rightPanelTab: 'note',
      markCard: null,
      messageJump: null,
      highlightedMessageId: null
    }))
  },

  openGlobalNote: () => {
    const state = get()
    if (
      !state.settingsOpen &&
      state.rightPanelOpen &&
      state.rightPanelTab === 'note' &&
      state.activeNoteTarget?.scope === 'global'
    ) {
      set({
        rightPanelOpen: false,
        noteExpandedToCenter: false
      })
      return
    }
    set({
      activeNoteTarget: { scope: 'global', scopeId: 'global' },
      rightPanelOpen: true,
      rightPanelTab: 'note',
      settingsOpen: false
    })
  },

  openProjectNote: (projectId) => {
    const state = get()
    if (
      !state.settingsOpen &&
      state.rightPanelOpen &&
      state.rightPanelTab === 'note' &&
      state.activeNoteTarget?.scope === 'project' &&
      state.activeNoteTarget?.scopeId === projectId
    ) {
      set({
        rightPanelOpen: false,
        noteExpandedToCenter: false
      })
      return
    }
    set({
      activeNoteTarget: { scope: 'project', scopeId: projectId },
      rightPanelOpen: true,
      rightPanelTab: 'note',
      settingsOpen: false
    })
  },

  openSessionNote: () => {
    const state = get()
    const target = sessionNoteTarget(state.sessions, state.activeSessionId)

    const currentTarget = state.activeNoteTarget ?? target
    if (
      state.rightPanelOpen &&
      state.rightPanelTab === 'note' &&
      currentTarget.scope === target.scope &&
      currentTarget.scopeId === target.scopeId
    ) {
      set({
        rightPanelOpen: false,
        noteExpandedToCenter: false
      })
      return
    }

    set({
      activeNoteTarget: target,
      rightPanelOpen: true,
      rightPanelTab: 'note'
    })
  },

  selectThread: (threadId) => {
    const state = get()
    const thread = state.sessions.find((s) => s.id === threadId)
    const main = state.sessions.find((s) => s.id === state.activeSessionId)
    set({
      activeThreadId: threadId,
      draftThread: null,
      threadModelId: thread?.modelId ?? main?.modelId ?? state.selectedModelId,
      rightPanelOpen: true,
      rightPanelTab: 'thread'
    })
  },

  openFilePreview: (fileId) => {
    set({ activeFileId: fileId, rightPanelOpen: true, rightPanelTab: 'file', noteExpandedToCenter: false })
  },

  startDraftThread: (anchor) => {
    const main = get().sessions.find((s) => s.id === anchor.parentSessionId)
    set({
      draftThread: { ...anchor, contextMode: 'fork' },
      activeThreadId: null,
      threadModelId: main?.modelId ?? get().selectedModelId,
      rightPanelOpen: true,
      rightPanelTab: 'thread',
      noteExpandedToCenter: false
    })
  },

  setDraftThreadMode: (mode) => {
    set((state) => ({ draftThread: state.draftThread && { ...state.draftThread, contextMode: mode } }))
  },

  deleteThread: async (id) => {
    stopRepliesIn(new Set([id]))
    await window.api.invoke('sessions:delete', id)
    set((state) => ({
      bringBacks: Object.fromEntries(
        Object.entries(state.bringBacks).map(([sessionId, items]) => [sessionId, items.filter((b) => b.threadId !== id)])
      ),
      sessions: state.sessions.filter((s) => s.id !== id),
      messages: state.messages.filter((m) => m.sessionId !== id),
      marks: state.marks.filter((mark) => !state.messages.some((m) => m.id === mark.messageId && m.sessionId === id)),
      activeThreadId: state.activeThreadId === id ? null : state.activeThreadId
    }))
  },


  setSelectedMarkCategory: (categoryId) => {
    set({ selectedMarkCategoryId: categoryId })
  },

  openMarkCard: (card) => set({ markCard: card }),
  closeMarkCard: () => set({ markCard: null }),

  createMark: async (input) => {
    const mark = await window.api.invoke('marks:create', input)
    set((state) => ({ marks: [...state.marks, mark] }))
  },

  updateMark: async (id, patch) => {
    const mark = await window.api.invoke('marks:update', id, patch)
    set((state) => ({ marks: state.marks.map((m) => (m.id === id ? mark : m)) }))
  },

  deleteMark: async (id) => {
    await window.api.invoke('marks:delete', id)
    set((state) => ({ marks: state.marks.filter((m) => m.id !== id) }))
  },

  bringBack: (messageId, text) => {
    const { messages, sessions } = get()
    const thread = sessions.find((s) => s.id === messages.find((m) => m.id === messageId)?.sessionId)
    if (thread?.kind !== 'thread') return
    const item: ThreadResult = { type: 'thread_result', threadId: thread.id, messageId, quote: thread.anchorQuote, text }
    set((state) => {
      const current = state.bringBacks[thread.parentSessionId] ?? []
      if (current.some((b) => b.messageId === messageId && b.text === text)) return {}
      return { bringBacks: { ...state.bringBacks, [thread.parentSessionId]: [...current, item] } }
    })
  },

  removeBringBack: (sessionId, item) => {
    set((state) => ({
      bringBacks: { ...state.bringBacks, [sessionId]: (state.bringBacks[sessionId] ?? []).filter((b) => b !== item) }
    }))
  },

  clearBringBacks: (sessionId) => {
    set((state) => ({ bringBacks: { ...state.bringBacks, [sessionId]: [] } }))
  },

  startMarkQuiz: (marks) => {
    const session = get().sessions.find((s) => s.id === get().activeSessionId)
    if (session?.kind !== 'main') return
    get().startNewSession(session.projectId)
    set({
      markQuiz: {
        type: 'mark_quiz',
        sessionId: session.id,
        label: `《${session.title}》`,
        marks: marks.map((m) => ({ quote: m.quote, comment: m.comment }))
      }
    })
  },

  clearMarkQuiz: () => set({ markQuiz: null }),

  jumpToMark: (mark) => {
    const anchor = { quote: mark.quote, start: mark.startOffset, end: mark.endOffset, prefix: mark.prefix, suffix: mark.suffix }
    void get().jumpToMessage(mark.messageId, (body) => {
      const range = anchorToRange(body, anchor)
      return range ? [range] : []
    })
  },

  // The message may be in another conversation (a link in a project or global note).
  jumpToMessage: async (messageId, flash) => {
    const jump = { messageId }
    set({ messageJump: jump, highlightedMessageId: null, lastScrolledUserMessageId: null, settingsOpen: false, projectSettingsId: null })
    let msg = get().messages.find((m) => m.id === messageId)
    if (!msg) {
      msg = (await window.api.invoke('messages:get', messageId)) ?? undefined
      if (get().messageJump !== jump) return
      if (!msg) {
        set({ messageJump: null })
        return
      }
      const { sessionId } = msg
      const session = get().sessions.find((s) => s.id === sessionId)
      const mainId = session?.kind === 'thread' ? session.parentSessionId : sessionId
      get().selectSession(mainId)
      set({ messageJump: jump })
      // Highlighting scrolls to the element, so it waits until the conversation is in the window.
      await waitFor(() => get().messageJump !== jump || get().messages.some((m) => m.id === messageId))
    }
    if (get().messageJump !== jump) return
    const session = get().sessions.find((s) => s.id === msg.sessionId)
    if (!session) {
      set({ messageJump: null })
      return
    }

    if (session.kind === 'thread') {
      set({
        activeSessionId: session.parentSessionId,
        activeThreadId: session.id,
        draftThread: null,
        rightPanelOpen: true,
        rightPanelTab: 'thread',
        noteExpandedToCenter: false,
        highlightedMessageId: flash ? null : session.anchorMessageId
      })
    } else {
      set({
        activeSessionId: session.id,
        noteExpandedToCenter: false,
        highlightedMessageId: flash ? null : messageId
      })
    }
    const mainId = session.kind === 'thread' ? session.parentSessionId : session.id
    if (get().loadingConversations[mainId]) {
      await waitFor(() => get().messageJump !== jump || !get().loadingConversations[mainId])
      if (get().messageJump !== jump) return
    }
    if (flash) {
      await flashMessagePassages(messageId, flash)
      if (get().messageJump === jump) set({ messageJump: null })
      return
    }

    setTimeout(() => {
      if (get().messageJump === jump) {
        set({ highlightedMessageId: null, messageJump: null })
      }
    }, 2000)
  },

  setSearchOpen: (open) => {
    set({ searchOpen: open })
  },

  openSearchHit: (hit, terms) => {
    set({ searchOpen: false, settingsOpen: false, projectSettingsId: null })
    if (hit.kind === 'session') return get().selectSession(hit.id)
    if (hit.kind === 'message') return void get().jumpToMessage(hit.id, (body) => termRanges(body, terms))
    // A session's note is shown with its own conversation.
    if (hit.target.scope === 'session') get().selectSession(hit.target.scopeId)
    set({ activeNoteTarget: hit.target, rightPanelOpen: true, rightPanelTab: 'note', noteExpandedToCenter: false })
    revealNoteTerms(hit.target, terms)
  },

  // Pending edits go first, or their delayed save would overwrite the clip (lib/noteSave.ts).
  clipToNote: async (clip, markdown, comment = null) => {
    await flushNoteSave()
    const { target, content } = await window.api.invoke('notes:clip', clip, markdown, comment)
    syncNoteContent(target, content)
  },

  openNoteClip: (clip) => {
    const target = sessionNoteTarget(get().sessions, get().activeSessionId)
    set({ activeNoteTarget: target, rightPanelOpen: true, rightPanelTab: 'note' })
    revealNoteClip(target, clip)
  },

  transferNoteText: async (input) => {
    await flushNoteSave()
    const { source, target } = await window.api.invoke('notes:transfer', input)
    syncNoteContent(input.source, source)
    syncNoteContent(input.target, target)
  },

  restoreNoteRevision: async (revisionId) => {
    await flushNoteSave()
    const { target, content } = await window.api.invoke('notes:restore', revisionId)
    syncNoteContent(target, content)
  },

  selectModel: (modelId, target = 'main') => {
    const model = get().models.find((m) => m.id === modelId)
    if (!model) return
    set((state) => {
      const sessionId = target === 'main' ? state.activeSessionId : state.activeThreadId
      return {
        ...(target === 'main' ? { selectedModelId: modelId } : { threadModelId: modelId }),
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? { ...s, modelId: model.id, providerId: model.providerId } : s
        )
      }
    })
  },

  setThinkingLevel: (level) => {
    set({ thinkingLevel: level })
  },

  setWebSearch: (on) => {
    set({ webSearch: on })
    void window.api.invoke('webSearch:set', on)
  },

  reloadSearchServices: async () => {
    set({ searchServices: await window.api.invoke('searchServices:list') })
  },

  reloadSessions: async () => {
    const [projects, sessions] = await Promise.all([
      window.api.invoke('projects:list'),
      window.api.invoke('sessions:list')
    ])
    set({ projects, sessions })
  },

  createProject: async (name) => {
    const project = await window.api.invoke('projects:create', name)
    set((state) => ({
      projects: [...state.projects, project],
      expandedProjectIds: { ...state.expandedProjectIds, [project.id]: true }
    }))
  },

  updateProject: async (id, patch) => {
    const project = await window.api.invoke('projects:update', id, patch)
    set((state) => ({ projects: state.projects.map((p) => (p.id === id ? project : p)) }))
  },

  deleteProject: async (id) => {
    const state = get()
    const active = state.sessions.find((s) => s.id === state.activeSessionId)
    // Stop first, so no reply is still being requested for a deleted session.
    stopRepliesIn(conversationIds(state.sessions, (s) => s.kind === 'main' && s.projectId === id))
    if (active?.kind === 'main' && active.projectId === id) state.startNewSession()
    // Saved first, so a delayed save can't bring the deleted note back.
    await flushNoteSave()
    await window.api.invoke('projects:delete', id)
    forgetNote({ scope: 'project', scopeId: id })
    set((curr) => ({
      projectSettingsId: null,
      newSessionProjectId: curr.newSessionProjectId === id ? null : curr.newSessionProjectId
    }))
    await get().reloadSessions()
    get().dropOrphanMessages()
  },

  renameSession: async (id, title) => {
    const session = await window.api.invoke('sessions:rename', id, title)
    set((state) => ({ sessions: state.sessions.map((s) => (s.id === id ? session : s)) }))
  },

  // A standalone session moving into a project has its note merged into the project's (main process).
  moveSession: async (id, projectId) => {
    const merging = projectId !== null && get().sessions.find((s) => s.id === id)?.projectId === null
    if (merging) await flushNoteSave()
    const session = await window.api.invoke('sessions:move', id, projectId)
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? session : s)),
      expandedProjectIds: projectId
        ? { ...state.expandedProjectIds, [projectId]: true }
        : state.expandedProjectIds
    }))
    if (!merging) return
    const projectNote: NoteTarget = { scope: 'project', scopeId: projectId }
    const shown = get().activeNoteTarget
    forgetNote({ scope: 'session', scopeId: id })
    if (shown && sameTarget(shown, { scope: 'session', scopeId: id })) set({ activeNoteTarget: projectNote })
    syncNoteContent(projectNote, await window.api.invoke('notes:get', projectNote))
  },

  deleteSession: async (id) => {
    stopRepliesIn(conversationIds(get().sessions, (s) => s.id === id))
    if (get().activeSessionId === id) get().startNewSession()
    await flushNoteSave()
    await window.api.invoke('sessions:delete', id)
    forgetNote({ scope: 'session', scopeId: id })
    await get().reloadSessions()
    get().dropOrphanMessages()
  },

  // Threads, messages and marks were deleted in the database by cascade; forget them here too.
  dropOrphanMessages: () => {
    set((state) => {
      const remaining = new Set(state.sessions.map((s) => s.id))
      return {
        messages: state.messages.filter((m) => remaining.has(m.sessionId)),
        marks: state.marks.filter((m) => remaining.has(m.sessionId))
      }
    })
  },

  openProjectSettings: (projectId) => set({ projectSettingsId: projectId, settingsOpen: false, markCard: null, messageJump: null, highlightedMessageId: null }),
  closeProjectSettings: () => set({ projectSettingsId: null }),

  openSettings: () => set({ settingsOpen: true, settingsSection: null, projectSettingsId: null, markCard: null, messageJump: null, highlightedMessageId: null }),
  openSearchSettings: () => set({ settingsOpen: true, settingsSection: 'search', projectSettingsId: null, markCard: null, messageJump: null, highlightedMessageId: null }),
  closeSettings: () => set({ settingsOpen: false }),
  setOnboardingOpen: (open) => set({ onboardingOpen: open, markCard: null, messageJump: null, highlightedMessageId: null }),

  setFontSize: (size) => {
    const clamped = Math.min(24, Math.max(12, Math.round(size)))
    set({ fontSize: clamped })
    if (window.api.setZoomFactor) {
      window.api.setZoomFactor(clamped / 16)
    } else {
      document.documentElement.style.setProperty('--body-font-size', `${clamped}px`)
    }
    void window.api.invoke('fontSize:set', clamped)
  },
  increaseFontSize: () => {
    get().setFontSize(get().fontSize + 1)
  },
  decreaseFontSize: () => {
    get().setFontSize(get().fontSize - 1)
  },
  resetFontSize: () => {
    get().setFontSize(16)
  },

  reloadProviders: async () => {
    const [providers, models] = await Promise.all([
      window.api.invoke('providers:list'),
      window.api.invoke('models:list')
    ])
    set({ providers, models, providersLoaded: true })
  },

  addFiles: (files) => {
    set((state) => {
      const known = new Set(state.files.map((f) => f.id))
      return { files: [...state.files, ...files.filter((f) => !known.has(f.id))] }
    })
  },

  sendMessage: async (content, attachments = [], target = 'main') => {
    const text = content.trim()
    if (!text && attachments.length === 0) return

    const state = get()
    const wanted = target === 'main' ? state.selectedModelId : state.threadModelId
    const model =
      state.models.find((m) => m.id === wanted && m.enabled) ?? state.models.find((m) => m.enabled)
    if (!model) return

    const base = { text, attachments, modelId: model.id, thinking: state.thinkingLevel, webSearch: state.webSearch }

    if (target === 'thread') {
      const newThread = state.activeThreadId ? null : state.draftThread
      if (!state.activeThreadId && !newThread) return
      const { session, userMessage, assistantMessage } = await window.api.invoke('chat:send', {
        ...base,
        sessionId: state.activeThreadId,
        projectId: null,
        newThread
      })
      set((curr) => ({
        sessions: [session, ...curr.sessions.filter((s) => s.id !== session.id)],
        activeThreadId: session.id,
        draftThread: null,
        threadModelId: model.id,
        messages: [...curr.messages, userMessage, assistantMessage]
      }))
      return
    }

    const { session, userMessage, assistantMessage } = await window.api.invoke('chat:send', {
      ...base,
      sessionId: state.activeSessionId,
      projectId: state.activeSessionId ? null : state.newSessionProjectId,
      newThread: null
    })

    set((curr) => ({
      sessions: [session, ...curr.sessions.filter((s) => s.id !== session.id)],
      activeSessionId: session.id,
      selectedModelId: model.id,
      newSessionProjectId: null,
      markQuiz: null,
      messages: [...curr.messages, userMessage, assistantMessage],
      lastScrolledUserMessageId: userMessage.id,
      messageJump: null,
      highlightedMessageId: null,
      noteExpandedToCenter: false
    }))
  },

  regenerateReply: async (replyId, text = null) => {
    const state = get()
    const reply = state.messages.find((m) => m.id === replyId)
    const session = state.sessions.find((s) => s.id === reply?.sessionId)
    if (!reply || !session) return false
    const marks = state.marks.filter((m) => m.messageId === replyId)
    const threads = state.sessions.filter((s) => s.kind === 'thread' && s.anchorMessageId === replyId)
    if ((marks.length > 0 || threads.length > 0) && !window.confirm(regenerateWarning(marks, threads))) return false

    const wanted = session.kind === 'main' ? state.selectedModelId : state.threadModelId
    const model =
      state.models.find((m) => m.id === wanted && m.enabled) ?? state.models.find((m) => m.enabled)
    if (!model) return false
    const threadIds = new Set(threads.map((t) => t.id))
    stopRepliesIn(threadIds)
    const { session: touched, removedIds, userMessage, assistantMessage } = await window.api.invoke(
      'chat:regenerate',
      { replyId, text, modelId: model.id, thinking: state.thinkingLevel, webSearch: state.webSearch }
    )
    const removed = new Set(removedIds)
    set((curr) => ({
      sessions: [touched, ...curr.sessions.filter((s) => s.id !== touched.id && !threadIds.has(s.id))],
      messages: [
        ...curr.messages.filter((m) => !removed.has(m.id) && !threadIds.has(m.sessionId)),
        ...(text === null ? [] : [userMessage]),
        assistantMessage
      ],
      marks: curr.marks.filter((m) => !removed.has(m.messageId) && !threadIds.has(m.sessionId)),
      bringBacks: Object.fromEntries(
        Object.entries(curr.bringBacks).map(([id, items]) => [id, items.filter((b) => !threadIds.has(b.threadId))])
      ),
      activeThreadId: curr.activeThreadId && threadIds.has(curr.activeThreadId) ? null : curr.activeThreadId,
      ...(text !== null && session.kind === 'main' && { lastScrolledUserMessageId: userMessage.id })
    }))
    return true
  },

  stopStreaming: (sessionId) => stopRepliesIn(new Set([sessionId]))
}))

function regenerateWarning(marks: Mark[], threads: Session[]): string {
  const counts = [marks.length > 0 && `${marks.length} 条 mark`, threads.length > 0 && `${threads.length} 个追问`]
  const lines = [
    ...marks.map((m) => `· mark「${shorten(m.quote)}」`),
    ...threads.map((t) => `· 追问「${t.title}」`)
  ]
  return `这样会删除这条回答上的 ${counts.filter(Boolean).join(' 和 ')}：\n\n${lines.join('\n')}\n\n继续吗？`
}

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 30 ? `${flat.slice(0, 30)}…` : flat
}

// The note is gone from the database: drop its editor state, and stop showing it.
function forgetNote(target: NoteTarget): void {
  forgetNoteState(target)
  const shown = useAppStore.getState().activeNoteTarget
  if (shown && sameTarget(shown, target)) useAppStore.setState({ activeNoteTarget: null })
}

function setNoteClips(target: NoteTarget, content: string): void {
  const current = useAppStore.getState().noteClips
  if (!current || !sameTarget(current.target, target)) return
  const clips = noteClips(content).map(({ messageId, start, end }) => ({ messageId, start, end }))
  // Typing in the note mostly leaves its clips as they were; a new array would redraw every reply.
  if (JSON.stringify(clips) === JSON.stringify(current.clips)) return
  useAppStore.setState({ noteClips: { target, clips } })
}

onNoteContent(setNoteClips)

useAppStore.subscribe((state) => {
  const target = sessionNoteTarget(state.sessions, state.activeSessionId)
  if (state.noteClips && sameTarget(state.noteClips.target, target)) return
  useAppStore.setState({ noteClips: { target, clips: [] } })
  const content = noteContentOf(target)
  if (content !== null) setNoteClips(target, content)
  // An editor opened meanwhile is ahead of the database.
  else window.api.invoke('notes:get', target).then((saved) => setNoteClips(target, noteContentOf(target) ?? saved))
})

// A cross-conversation jump can precede React mounting its message.
async function flashMessagePassages(messageId: string, find: (body: Element) => Range[]): Promise<void> {
  const jump = useAppStore.getState().messageJump
  let el: HTMLElement | null = null
  for (let frame = 0; frame < 60; frame++) {
    if (useAppStore.getState().messageJump !== jump) return
    el = document.getElementById(`message-${messageId}`)
    if (el) break
    await new Promise(requestAnimationFrame)
  }
  if (!el) return
  const body = el.querySelector('.markdown-body')
  const ranges = body ? find(body) : []
  const scroller = el.closest<HTMLElement>('.chat-scroll-container, .thread-messages-scroll')
  if (!scroller) return
  let finished = (): void => {}
  await new Promise<void>((resolve) => {
    const stop = aimScroll(scroller, el, () => {
      const rect = ranges[0]?.getBoundingClientRect() ?? el.getBoundingClientRect()
      const viewport = scroller.getBoundingClientRect()
      return rect.top - viewport.top - (ranges.length ? (scroller.clientHeight - rect.height) / 2 : 18)
    }, { onSettled: () => {
      flashPassages(ranges, 2000)
      resolve()
    }, onStop: resolve })
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.messageJump === jump) return
      stop()
      resolve()
    })
    finished = unsubscribe
  }).finally(() => finished())
}

function waitFor(ready: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (ready()) return resolve()
    const unsubscribe = useAppStore.subscribe(() => {
      if (!ready()) return
      unsubscribe()
      resolve()
    })
  })
}

// The given sessions plus the threads hanging off them.
export function conversationIds(sessions: Session[], pick: (s: Session) => boolean): Set<string> {
  const ids = new Set(sessions.filter(pick).map((s) => s.id))
  for (const s of sessions) if (s.kind === 'thread' && ids.has(s.parentSessionId)) ids.add(s.id)
  return ids
}

function stopRepliesIn(sessionIds: Set<string>): void {
  const streaming = useAppStore
    .getState()
    .messages.filter((m) => m.status === 'streaming' && sessionIds.has(m.sessionId))
  if (streaming.length === 0) return
  for (const m of streaming) window.api.invoke('chat:stop', m.id)
  const ids = new Set(streaming.map((m) => m.id))
  // A cancelled stream sends no further events, so the window marks it stopped itself.
  useAppStore.setState((state) => ({
    messages: state.messages.map((m) => (ids.has(m.id) ? { ...m, status: 'stopped' } : m))
  }))
}

// Something about sync needs a look: offline, signed out by the server, failing, or a new notice.
export function syncNeedsLook(status: SyncStatus | null): boolean {
  return status?.email != null && (status.unseen || ['offline', 'expired', 'failed'].includes(status.state))
}

// A main session's messages (its threads' included) and marks, from the database. A reply still streaming
// keeps its in-memory copy: the database only has it as of the last save, up to 0.5s behind.
const conversationLoads = new Map<string, object>()

function loadConversation(sessionId: string): void {
  const request = {}
  conversationLoads.set(sessionId, request)
  window.api.invoke('marks:list', sessionId).then((loaded) => {
    useAppStore.setState((state) => ({ marks: [...state.marks.filter((m) => m.sessionId !== sessionId), ...loaded] }))
  })
  window.api.invoke('messages:list', sessionId).then(async (loaded) => {
    const known = new Set(useAppStore.getState().files.map((f) => f.id))
    const missing = loaded.flatMap((m) =>
      m.attachments.flatMap((a) => (a.type === 'file' && !known.has(a.fileId) ? [a.fileId] : []))
    )
    const files = missing.length > 0 ? await window.api.invoke('files:get', missing) : []
    if (conversationLoads.get(sessionId) !== request) return
    useAppStore.getState().addFiles(files)
    useAppStore.setState((state) => {
      const replaced = conversationIds(state.sessions, (s) => s.id === sessionId)
      const streaming = new Map(state.messages.filter((m) => m.status === 'streaming').map((m) => [m.id, m]))
      return {
        loadingConversations: { ...state.loadingConversations, [sessionId]: false },
        messages: [
          ...state.messages.filter((m) => !replaced.has(m.sessionId)),
          ...loaded.map((m) => streaming.get(m.id) ?? m)
        ]
      }
    })
  })
}

// Another device's changes were just written here: reload only what they touched.
async function refreshAfterSync({ tables, notes }: SyncApplied): Promise<void> {
  const changed = new Set(tables)
  const store = useAppStore.getState()
  if (changed.has('projects') || changed.has('sessions')) {
    await store.reloadSessions()
    const { activeSessionId, sessions } = useAppStore.getState()
    if (activeSessionId && !sessions.some((s) => s.id === activeSessionId)) store.startNewSession()
    store.dropOrphanMessages()
  }
  if (changed.has('providers') || changed.has('models')) await store.reloadProviders()
  if (changed.has('mark_categories')) {
    useAppStore.setState({ markCategories: await window.api.invoke('markCategories:list') })
  }
  const { activeSessionId } = useAppStore.getState()
  if (activeSessionId && (changed.has('messages') || changed.has('marks') || changed.has('sessions'))) {
    loadConversation(activeSessionId)
  }
  for (const id of notes) {
    const split = id.indexOf(':')
    const target = { scope: id.slice(0, split), scopeId: id.slice(split + 1) } as NoteTarget
    // Typed in the last 0.5s and not saved yet: the editor keeps what was typed, and the next sync
    // merges it with this change (docs/progress.md has the case this can't cover).
    if (hasPendingNoteSave(target)) continue
    syncNoteContent(target, await window.api.invoke('notes:get', target))
  }
}

window.api.invoke('markCategories:list').then((markCategories) => {
  useAppStore.setState({ markCategories })
})

void useAppStore.getState().reloadProviders().then(() => {
  if (useAppStore.getState().providers.length === 0) useAppStore.setState({ onboardingOpen: true })
})

useAppStore.getState().reloadSearchServices()

useAppStore.getState().reloadSessions().then(() => {
  // A new session keeps the last model used (product.md); after a restart that's the newest main session's,
  // since sending and switching models both bump updated_at.
  const { sessions, selectedModelId } = useAppStore.getState()
  const last = sessions.find((s) => s.kind === 'main' && s.modelId)
  if (!selectedModelId && last?.modelId) useAppStore.setState({ selectedModelId: last.modelId })
})

// Thinking time counts from the first thinking delta to the first answer delta, as the main process stores it.
const thinkingStartedAt = new Map<string, number>()

function setWebBusy(messageId: string, busy: boolean): void {
  const current = useAppStore.getState().webBusy
  if (Boolean(current[messageId]) === busy) return
  const { [messageId]: _, ...rest } = current
  useAppStore.setState({ webBusy: busy ? { ...rest, [messageId]: true } : rest })
}

function reloadWebSearch(): void {
  void window.api.invoke('webSearch:get').then((webSearch) => useAppStore.setState({ webSearch }))
}

reloadWebSearch()
window.addEventListener('focus', reloadWebSearch)
window.api.on('mini:shown', reloadWebSearch)

window.api.invoke('fontSize:get').then((fontSize) => {
  const size = fontSize || 16
  if (window.api.setZoomFactor) {
    window.api.setZoomFactor(size / 16)
  } else {
    document.documentElement.style.setProperty('--body-font-size', `${size}px`)
  }
  useAppStore.setState({ fontSize: size })
})

window.api.invoke('sync:status').then((syncStatus) => useAppStore.setState({ syncStatus }))
window.api.on('sync:status', (syncStatus) => useAppStore.setState({ syncStatus }))
window.api.invoke('updater:status').then((updateStatus) => useAppStore.setState({ updateStatus }))
window.api.on('updater:status', (updateStatus) => useAppStore.setState({ updateStatus }))
window.api.on('sync:applied', (applied) => void refreshAfterSync(applied))

// Also a session another window just started, e.g. the mini window.
window.api.on('session:updated', (session) => {
  useAppStore.setState((state) =>
    state.sessions.some((s) => s.id === session.id)
      ? { sessions: state.sessions.map((s) => (s.id === session.id ? session : s)) }
      : { sessions: [session, ...state.sessions] }
  )
})

window.api.on('session:open', (sessionId) => useAppStore.getState().selectSession(sessionId))

window.api.on('chat:event', ({ messageId, event }) => {
  setWebBusy(messageId, event.type === 'step' || event.type === 'sources')
  const patch = (update: (m: Message) => Partial<Message>): void =>
    useAppStore.setState((state) => {
      const index = state.messages.findIndex((m) => m.id === messageId)
      if (index < 0) return state
      const messages = state.messages.slice()
      messages[index] = { ...messages[index], ...update(messages[index]) }
      return { messages }
    })
  // Thinking ends where the answer starts, or where the reply ends without one.
  const endThinking = (): Partial<Message> => {
    const startedAt = thinkingStartedAt.get(messageId)
    thinkingStartedAt.delete(messageId)
    return startedAt === undefined ? {} : { thinkingMs: Date.now() - startedAt }
  }
  const finish = (update: Partial<Message>): void => {
    const thinking = endThinking()
    patch(() => ({ ...thinking, ...update }))
  }

  switch (event.type) {
    case 'thinking': {
      const startedAt = thinkingStartedAt.get(messageId) ?? Date.now()
      thinkingStartedAt.set(messageId, startedAt)
      patch((m) => ({ thinking: (m.thinking ?? '') + event.delta, thinkingMs: Date.now() - startedAt }))
      break
    }
    case 'text': {
      const thinking = endThinking()
      patch((m) => ({ ...thinking, content: m.content + event.delta }))
      break
    }
    case 'step':
      patch((m) => ({ web: { steps: [...(m.web?.steps ?? []), event.step], sources: m.web?.sources ?? [] } }))
      break
    case 'sources':
      patch((m) => ({ web: { steps: m.web?.steps ?? [], sources: [...(m.web?.sources ?? []), ...event.sources] } }))
      break
    case 'done':
      finish({ status: 'done', inputTokens: event.usage.input, outputTokens: event.usage.output })
      break
    case 'error':
      finish({ status: 'error', error: event.message, errorKind: event.kind })
      break
  }
})
