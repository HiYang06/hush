export type SessionKind = 'main' | 'thread'

export type ThreadContextMode = 'fork' | 'new'

export type MessageRole = 'user' | 'assistant'

export type MessageStatus = 'streaming' | 'done' | 'stopped' | 'error'

export type ErrorKind = 'auth' | 'rate_limit' | 'context_length' | 'network' | 'other'

export type NoteScope = 'global' | 'project' | 'session'

// The global note's scopeId is 'global'; the others use the project's or session's id.
export type NoteTarget = { scope: NoteScope; scopeId: string }

export type NoteRevisionReason =
  | 'ai_append'
  | 'ai_rewrite'
  | 'migrate_in'
  | 'migrate_out'
  | 'merge'
  | 'restore'
  | 'sync_conflict'

export type ProviderProtocol =
  | 'openai_chat'
  | 'openai_responses'
  | 'anthropic'
  | 'gemini'

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'

export type Project = {
  id: string
  name: string
  systemPrompt: string | null
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export type MainSession = {
  id: string
  kind: 'main'
  projectId: string | null
  parentSessionId: null
  anchorMessageId: null
  anchorQuote: null
  anchorStart: null
  anchorEnd: null
  anchorPrefix: null
  anchorSuffix: null
  contextMode: null
  title: string
  providerId: string | null
  modelId: string | null
  createdAt: number
  updatedAt: number
}

export type ThreadSession = {
  id: string
  kind: 'thread'
  projectId: null
  parentSessionId: string
  anchorMessageId: string
  anchorQuote: string
  anchorStart: number
  anchorEnd: number
  anchorPrefix: string
  anchorSuffix: string
  contextMode: ThreadContextMode
  title: string
  providerId: string | null
  modelId: string | null
  createdAt: number
  updatedAt: number
}

export type Session = MainSession | ThreadSession

export type Attachment =
  | { type: 'file'; fileId: string }
  | {
      type: 'note_ref'
      noteId: string
      sectionTitle: string | null
      label: string
      text: string
    }
  | { type: 'session_ref'; sessionId: string; label: string; text: string }
  | {
      type: 'mark_quiz'
      sessionId: string
      label: string
      marks: { quote: string; comment: string | null }[]
    }
  | {
      type: 'thread_result'
      threadId: string
      messageId: string
      quote: string
      text: string
    }

export type Message = {
  id: string
  sessionId: string
  seq: number
  role: MessageRole
  content: string
  thinking: string | null
  thinkingMs: number | null
  attachments: Attachment[]
  status: MessageStatus
  error: string | null
  errorKind: ErrorKind | null
  providerId: string | null
  modelId: string | null
  inputTokens: number | null
  outputTokens: number | null
  // Only on a reply that went online; null otherwise.
  web: WebActivity | null
  createdAt: number
}

// One thing a reply looked up, in the order it happened: online, or in an attached PDF or pptx.
export type WebStep =
  | { type: 'search'; query: string }
  | { type: 'read'; url: string }
  | { type: 'doc_search'; file: string; query: string }
  | { type: 'doc_read'; file: string; start: number; end: number }

// A source the model may cite as [n]; numbered within one reply, a URL keeps its first number.
export type WebSource = { n: number; url: string; title: string; date: string | null; snippet: string }

export type WebActivity = { steps: WebStep[]; sources: WebSource[] }

export type SearchServiceId = 'tavily' | 'exa'

export type SearchService = { id: SearchServiceId; hasApiKey: boolean }

export type Mark = {
  id: string
  sessionId: string
  messageId: string
  quote: string
  startOffset: number
  endOffset: number
  prefix: string
  suffix: string
  comment: string | null
  categoryId: string | null
  createdAt: number
}

export type MarkInput = Pick<
  Mark,
  'messageId' | 'quote' | 'startOffset' | 'endOffset' | 'prefix' | 'suffix' | 'comment' | 'categoryId'
>

export type MarkPatch = Pick<Mark, 'comment' | 'categoryId'>

export type MarkCategory = {
  id: string
  name: string
  color: string
  sortOrder: number
}

export type Note = {
  id: string
  scope: NoteScope
  scopeId: string
  content: string
  updatedAt: number
}

// A range of one note moved or copied to the end of another; text is what the range held when sent.
export type NoteTransfer = {
  source: NoteTarget
  from: number
  to: number
  text: string
  target: NoteTarget
  mode: 'move' | 'copy'
}

// The clipped passage: start and end are anchor positions in the reply's plain text (renderer/lib/anchors.ts).
export type NoteClipSource = { messageId: string; start: number; end: number }

// AI organizing (product.md §6): a draft for the end of the note, or a rewrite of the whole note.
// The model is the one picked in the input box; `sessionId` is the main session to organize.
export type OrganizeInput =
  | { mode: 'session'; sessionId: string; target: NoteTarget; modelId: string; thinking: ThinkingLevel }
  | { mode: 'rewrite'; target: NoteTarget; modelId: string; thinking: ThinkingLevel }

// `base` is the note as the model saw it; a rewrite only replaces the note while it still reads so.
export type OrganizeStarted = { jobId: string; base: string }

export type NoteRevision = {
  id: string
  noteId: string
  content: string
  reason: NoteRevisionReason
  createdAt: number
}

export type Provider = {
  id: string
  name: string
  protocol: ProviderProtocol
  baseUrl: string
  hasApiKey: boolean
  sortOrder: number
  createdAt: number
}

export type Model = {
  id: string
  providerId: string
  modelName: string
  displayName: string
  enabled: boolean
  supportsVision: boolean
  supportsThinking: boolean
  thinkingCanDisable: boolean
  // Accepts function tools; web search needs it.
  supportsTools: boolean
  // In tokens; null when neither the provider nor the user has said.
  contextWindow: number | null
  maxOutputTokens: number | null
}

export type ModelCapabilities = Pick<
  Model,
  'supportsVision' | 'supportsThinking' | 'thinkingCanDisable' | 'supportsTools'
>

export type ModelLimits = Pick<Model, 'contextWindow' | 'maxOutputTokens'>

// A model as listed by the provider's API, before the user adds it. capabilities is null
// when the API doesn't report them (every protocol except Anthropic's official API, D-031).
export type RemoteModel = {
  modelName: string
  displayName: string
  capabilities: ModelCapabilities | null
} & ModelLimits

export type ProviderInput = {
  name: string
  protocol: ProviderProtocol
  baseUrl: string
  apiKey: string
}

// apiKey: omitted keeps the stored key, '' clears it.
export type ProviderPatch = Partial<Pick<ProviderInput, 'name' | 'baseUrl' | 'apiKey'>>

export type ModelInput = Pick<Model, 'modelName' | 'displayName'> & ModelCapabilities & ModelLimits

export type ModelPatch = Partial<Pick<Model, 'displayName' | 'enabled'> & ModelCapabilities & ModelLimits>

// What a page of a PDF or slide shows besides text; the model reads the page image when there is one.
export type PageTag = 'figure' | 'table' | 'math' | 'image'

// One page of a PDF or pptx (D-077). imageIds: its rendered page, or for a slide that couldn't be
// rendered, its embedded pictures; empty when the page is plain text.
export type DocumentPage = { n: number; title: string; text: string; tags: PageTag[]; imageIds: string[] }

// A PDF bookmark; depth 0 is the top level.
export type OutlineEntry = { title: string; page: number; depth: number }

// Files prepared before D-077 have only text and image parts; PDFs and pptx since then have pages.
export type ExtractedPart =
  | { type: 'text'; text: string }
  | { type: 'image'; fileId: string }
  | ({ type: 'page' } & DocumentPage)
  | { type: 'outline'; entries: OutlineEntry[] }

export type FileRecord = {
  id: string
  sha256: string
  name: string
  mime: string
  size: number
  path: string
  extracted: ExtractedPart[] | null
  isScanned: boolean | null
  createdAt: number
}

// What the window hands over after preparing a file: it extracts PDF/docx/pptx and downscales images,
// because that needs canvas (D-039). Derived images are added first so extracted can reference them.
export type NewFile = {
  name: string
  mime: string
  data: Uint8Array
  extracted: ExtractedPart[] | null
  isScanned: boolean | null
}

export type Settings = {
  systemPrompt: string
  lastModel: { providerId: string; modelId: string } | null
}

export type StreamEvent =
  | { type: 'thinking'; delta: string }
  | { type: 'text'; delta: string }
  // A web tool started; its sources follow once it returns.
  | { type: 'step'; step: WebStep }
  | { type: 'sources'; sources: WebSource[] }
  | { type: 'done'; usage: { input: number; output: number }; stopReason: string }
  | {
      type: 'error'
      kind: ErrorKind
      message: string
    }

export type ProjectPatch = Partial<Pick<Project, 'name'>> & { systemPrompt?: string }

// Where a thread hangs and how it sees the main conversation; fixed once its first message is sent.
export type ThreadAnchor = Pick<
  ThreadSession,
  | 'parentSessionId'
  | 'anchorMessageId'
  | 'anchorQuote'
  | 'anchorStart'
  | 'anchorEnd'
  | 'anchorPrefix'
  | 'anchorSuffix'
  | 'contextMode'
>

export type ChatSendInput = {
  // null starts a new session: a thread when newThread is set, otherwise a main session.
  sessionId: string | null
  // Where a new main session goes; ignored when sessionId is set.
  projectId: string | null
  newThread: ThreadAnchor | null
  text: string
  attachments: Attachment[]
  modelId: string
  thinking: ThinkingLevel
  // The 联网 switch; ignored when no search service is set up or the model takes no tools.
  webSearch: boolean
}

export type ChatSendResult = { session: Session; userMessage: Message; assistantMessage: Message }

// Replaces the last reply of a session (regenerate, retry), or with `text` the last question too (edit).
export type ChatRegenerateInput = {
  replyId: string
  text: string | null
  modelId: string
  thinking: ThinkingLevel
  webSearch: boolean
}

// removedIds: the reply, and the question when it was edited. Marks and threads on them went by cascade.
export type ChatRegenerateResult = ChatSendResult & { removedIds: string[] }

// ⌘K results, newest first in each group (product.md §11). A thread's message carries its main session's title.
export type SearchResults = {
  terms: string[]
  sessions: { id: string; title: string; updatedAt: number }[]
  messages: { id: string; sessionTitle: string; createdAt: number; snippet: string }[]
  // ownerName: the session's title or the project's name; null for the global note.
  notes: { target: NoteTarget; ownerName: string | null; updatedAt: number; snippet: string }[]
}

// Every renderer → main call: channel name → signature. Handlers are registered in main/ipc.ts.
// Cloud sync as the window shows it (D-067). email null: not signed in, nothing syncs.
export type SyncState = 'idle' | 'syncing' | 'offline' | 'expired' | 'failed'
export type SyncNotice = { id: string; text: string; at: number }
export type SyncStatus = {
  email: string | null
  state: SyncState
  lastSyncedAt: number | null
  // failed: what went wrong, in Chinese.
  error: string | null
  // Newest first; kept until the app quits. unseen until the 账号与同步 page is opened.
  notices: SyncNotice[]
  unseen: boolean
  // Bytes of attachments in the cloud; null until the first sync since start.
  storage: { usage: number; quota: number } | null
}
// What one sync changed here, so the window reloads just that. notes: note ids (<scope>:<scope_id>).
export type SyncApplied = { tables: string[]; notes: string[] }

export type IpcChannels = {
  'markCategories:list': () => MarkCategory[]
  // A main session's marks, those made in its threads included.
  'marks:list': (sessionId: string) => Mark[]
  // Throws when the passage overlaps an existing mark.
  'marks:create': (input: MarkInput) => Mark
  'marks:update': (id: string, patch: MarkPatch) => Mark
  'marks:delete': (id: string) => void
  'providers:list': () => Provider[]
  'providers:create': (input: ProviderInput) => Provider
  'providers:update': (id: string, patch: ProviderPatch) => Provider
  'providers:delete': (id: string) => void
  // Also serves as "test connection": a successful listing proves the address and key work.
  'providers:fetchModels': (id: string) => Promise<RemoteModel[]>
  'models:list': () => Model[]
  'models:add': (providerId: string, input: ModelInput) => Model
  'models:update': (id: string, patch: ModelPatch) => Model
  'models:delete': (id: string) => void
  'projects:list': () => Project[]
  'projects:create': (name: string) => Project
  'projects:update': (id: string, patch: ProjectPatch) => Project
  // Also deletes its sessions and its note.
  'projects:delete': (id: string) => void
  'sessions:list': () => Session[]
  'sessions:rename': (id: string, title: string) => Session
  // projectId null takes the session out of its project.
  'sessions:move': (id: string, projectId: string | null) => Session
  'sessions:delete': (id: string) => void
  // Threads included.
  'sessions:usage': (id: string) => { input: number; output: number }
  // The main conversation as plain text, snapshotted into a session_ref when it's picked.
  'sessions:transcript': (id: string) => string
  'globalPrompt:get': () => { prompt: string }
  'globalPrompt:set': (prompt: string) => void
  'fontSize:get': () => number
  'fontSize:set': (size: number) => void
  // A main session's messages together with those of all its threads.
  'messages:list': (sessionId: string) => Message[]
  // null once the message is gone, e.g. a clipped reply that was regenerated.
  'messages:get': (id: string) => Message | null
  // Notes that were ever written, most recently changed first; for the `@` picker.
  'notes:list': () => Note[]
  // A note that was never written reads as ''.
  'notes:get': (target: NoteTarget) => string
  'notes:save': (target: NoteTarget, content: string) => void
  // Newest first; at most 20 per note.
  'notes:revisions': (target: NoteTarget) => NoteRevision[]
  'notes:restore': (revisionId: string) => { target: NoteTarget; content: string }
  // Returns both notes' new content.
  'notes:transfer': (input: NoteTransfer) => { source: string; target: string }
  // Appends the quote to the note of the message's conversation (product.md §6); a mark's comment goes below it.
  'notes:clip': (clip: NoteClipSource, markdown: string, comment: string | null) => { target: NoteTarget; content: string }
  // Both keep a revision and return the note's new content. The rewrite throws when the note no longer reads as `base`.
  'notes:aiAppend': (target: NoteTarget, markdown: string) => string
  'notes:aiRewrite': (target: NoteTarget, base: string, content: string) => string
  'search:query': (query: string) => SearchResults
  // The window's answer to `app:flush`: unsaved edits are stored, it can close now.
  'app:flushed': () => void
  // Returns at once; the reply then streams in as `chat:event`s.
  'chat:send': (input: ChatSendInput) => Promise<ChatSendResult>
  // Only the last reply of a session; returns at once, like chat:send.
  'chat:regenerate': (input: ChatRegenerateInput) => Promise<ChatRegenerateResult>
  'chat:stop': (messageId: string) => void
  // Returns at once; the text then streams in as `organize:event`s.
  'organize:start': (input: OrganizeInput) => OrganizeStarted
  'organize:stop': (jobId: string) => void
  'searchServices:list': () => SearchService[]
  // '' removes the service.
  'searchServices:setKey': (id: SearchServiceId, apiKey: string) => SearchService[]
  // Runs one real search; throws with the service's error when it fails.
  'searchServices:test': (id: SearchServiceId) => Promise<void>
  // Opens a cited source in the system browser; only http(s) links.
  'links:open': (url: string) => Promise<void>
  'files:add': (input: NewFile) => FileRecord
  'files:get': (ids: string[]) => FileRecord[]
  // Opens a non-image attachment with the system's default app.
  'files:open': (id: string) => Promise<void>
  // Downloads a file synced from another device if it isn't here yet; rejects with the reason, in Chinese.
  'files:ensure': (id: string) => Promise<void>
  // Mails a sign-in code; throws with a Chinese message (wrong address, asked again too soon).
  'account:sendCode': (email: string) => Promise<void>
  // Signs in and starts the first sync, which merges this device's data with the account's.
  'account:login': (email: string, code: string) => Promise<SyncStatus>
  // Local data stays; it just stops syncing.
  'account:logout': () => Promise<SyncStatus>
  'account:delete': () => Promise<SyncStatus>
  'account:openPrivacy': () => Promise<void>
  'sync:status': () => SyncStatus
  'sync:now': () => void
  'sync:markSeen': () => SyncStatus
  // Windows only: the window's own title-bar buttons (WindowControls).
  'window:minimize': () => void
  'window:toggleMaximize': () => void
  'window:close': () => void
  // The mini window (D-079).
  'mini:hide': () => void
  // Height of the mini page's content in CSS pixels; the window grows to it, up to 70% of the screen.
  'mini:resize': (height: number) => void
  // Hides the mini window and shows the session in the main window.
  'mini:openInMain': (sessionId: string) => void
  // registered is false when another app holds the shortcut.
  'miniSettings:get': () => { shortcut: string; registered: boolean; openAtLogin: boolean }
  // False, and nothing changes, when another app holds the shortcut.
  'miniSettings:setShortcut': (accelerator: string) => boolean
  // While the settings page records a new shortcut, the current one doesn't open the mini window.
  'miniSettings:recording': (recording: boolean) => void
  'miniSettings:setOpenAtLogin': (on: boolean) => void
}

// Every main → renderer push: channel name → payload.
export type IpcEvents = {
  'chat:event': { messageId: string; event: StreamEvent }
  'organize:event': { jobId: string; event: StreamEvent }
  // A session changed in the main process on its own, e.g. it got its automatic title.
  'session:updated': Session
  // The window is about to close: save what's pending, then answer with `app:flushed`.
  'app:flush': null
  'sync:status': SyncStatus
  'sync:applied': SyncApplied
  'window:maximized': boolean
  // maxHeight: the most the page may grow to, in CSS pixels.
  'mini:shown': { maxHeight: number }
  'mini:hidden': null
  // To the main window: show this session (from the mini window's 在主窗口打开).
  'session:open': string
}

export type Api = {
  platform: string
  invoke<K extends keyof IpcChannels>(
    channel: K,
    ...args: Parameters<IpcChannels[K]>
  ): Promise<Awaited<ReturnType<IpcChannels[K]>>>
  // Returns a function that unsubscribes.
  on<K extends keyof IpcEvents>(channel: K, listener: (payload: IpcEvents[K]) => void): () => void
  setZoomFactor?(factor: number): void
}
