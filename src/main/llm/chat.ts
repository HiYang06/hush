import type Database from 'better-sqlite3'
import type {
  Attachment,
  ChatRegenerateInput,
  ChatRegenerateResult,
  ChatSendInput,
  ChatSendResult,
  FileRecord,
  Message,
  Session,
  StreamEvent,
  ThinkingLevel
} from '@shared/types'
import { getFiles } from '../db/repo/files'
import { getProjectPrompt } from '../db/repo/projects'
import {
  appendMessage,
  deleteMessages,
  getMessage,
  listMessages,
  saveReply,
  stopInterruptedReplies,
  type ReplyProgress
} from '../db/repo/messages'
import { getModel } from '../db/repo/providers'
import {
  createMainSession,
  createThreadSession,
  getGlobalPrompt,
  getSession,
  replacePlaceholderTitle,
  touchSession
} from '../db/repo/sessions'
import { streamChat } from './adapters'
import { readsByTool } from '@shared/files'
import { buildContext, conversationMessages, type LoadedFile } from './context'
import { createDocumentTools } from './documentTools'
import { generateTitle, titleQuestion, titleRequest } from './title'
import type { ChatRequest, Connection, Tools } from './types'

// One set of tools from several: each call goes to the set that defines it.
function combineTools(sets: Tools[]): Tools | null {
  if (sets.length <= 1) return sets[0] ?? null
  return {
    specs: sets.flatMap((t) => t.specs),
    run: (call, signal) => (sets.find((t) => t.specs.some((s) => s.name === call.name)) ?? sets[0]).run(call, signal)
  }
}

// Streaming text is written to the database at most this often, so a crash loses at most this much.
const FLUSH_INTERVAL_MS = 500
const THREAD_TITLE_LENGTH = 30

// A thread is titled by the passage it asks about, without a model call (product.md).
export function threadTitle(quote: string): string {
  const flat = quote.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length > THREAD_TITLE_LENGTH ? `${chars.slice(0, THREAD_TITLE_LENGTH).join('')}…` : flat
}

// Shown until the automatic title arrives after the first reply.
function placeholderTitleOf(question: string): string {
  return question.trim().slice(0, 15) || '新对话'
}

export type ChatDeps = {
  db: Database.Database
  // The provider's address and decrypted key; decryption needs Electron, so the caller supplies it.
  connection: (providerId: string) => Connection
  emit: (messageId: string, event: StreamEvent) => void
  // A session changed without the window asking, e.g. it got its automatic title.
  sessionUpdated: (session: Session) => void
  checkFile: (file: FileRecord) => void
  readFile: (file: FileRecord) => Buffer
  ensureFile: (file: FileRecord) => Promise<void>
  // A fresh set of web tools for one reply, or null when no search service is set up.
  webTools: () => Tools | null
  stream?: (conn: Connection, req: ChatRequest) => AsyncIterable<StreamEvent>
}

export type Chat = {
  // Brings the bytes of every file the send or regenerate will read, for files synced from another
  // device. Awaited before send/regenerate, which read files synchronously.
  fetchFiles: (input: ChatSendInput | ChatRegenerateInput) => Promise<void>
  send: (input: ChatSendInput) => ChatSendResult
  regenerate: (input: ChatRegenerateInput) => ChatRegenerateResult
  stop: (messageId: string) => void
  // Resolves when every reply in flight has finished; for tests and quitting.
  idle: () => Promise<void>
  // Replies still streaming as they are now, not as last saved (up to 0.5s behind): a window that opens one
  // mid-reply, e.g. the main window from the mini window, appends the deltas still to come to this text.
  withLiveReplies: (messages: Message[]) => Message[]
}

export function createChat({
  db,
  connection,
  emit,
  sessionUpdated,
  readFile,
  checkFile,
  ensureFile,
  webTools,
  stream = streamChat
}: ChatDeps): Chat {
  stopInterruptedReplies(db)
  // One entry per reply being generated; a main session and its threads can stream at the same time.
  const running = new Map<string, { controller: AbortController; done: Promise<void> }>()
  const live = new Map<string, ReplyProgress>()

  // The files a reply in this session can send: attached ones (the session's, the inherited parent
  // messages' for a fork thread, and the new message's) and the files derived from them (resized
  // images, rendered pages, embedded images).
  function filesFor(
    session: Session | null,
    newThread: ChatSendInput['newThread'],
    attachments: Attachment[]
  ): FileRecord[] {
    const fork =
      session?.kind === 'thread'
        ? session.contextMode === 'fork'
          ? session
          : null
        : newThread?.contextMode === 'fork'
          ? newThread
          : null
    const parentMessages = fork ? listMessages(db, fork.parentSessionId) : []
    const anchor = fork ? parentMessages.find((m) => m.id === fork.anchorMessageId) : undefined
    const earlier = [
      ...(session ? listMessages(db, session.id) : []),
      ...parentMessages.filter((m) => anchor && m.seq <= anchor.seq)
    ]
    const ids = [...earlier.flatMap((m) => m.attachments), ...attachments].flatMap((a) =>
      a.type === 'file' ? [a.fileId] : []
    )
    const records = getFiles(db, ids)
    if (records.length !== new Set(ids).size) throw new Error('An attached file is not in the database')
    const derivedIds = records.flatMap((f) =>
      (f.extracted ?? []).flatMap((p) => (p.type === 'image' ? [p.fileId] : p.type === 'page' ? p.imageIds : []))
    )
    return [...records, ...getFiles(db, derivedIds)]
  }

  async function generate(messageId: string, conn: Connection, req: ChatRequest): Promise<ReplyProgress> {
    const reply: ReplyProgress = {
      content: '',
      thinking: null,
      thinkingMs: null,
      status: 'streaming',
      error: null,
      errorKind: null,
      inputTokens: null,
      outputTokens: null,
      web: null
    }
    let thinkingStartedAt: number | null = null
    let lastFlush = Date.now()
    live.set(messageId, reply)

    try {
      for await (const event of stream(conn, req)) {
        emit(messageId, event)
        switch (event.type) {
          case 'thinking':
            thinkingStartedAt ??= Date.now()
            reply.thinking = (reply.thinking ?? '') + event.delta
            break
          case 'text':
            // Thinking ends where the answer starts.
            if (thinkingStartedAt !== null && reply.thinkingMs === null) {
              reply.thinkingMs = Date.now() - thinkingStartedAt
            }
            reply.content += event.delta
            break
          case 'step':
            reply.web ??= { steps: [], sources: [] }
            reply.web.steps.push(event.step)
            break
          case 'sources':
            reply.web ??= { steps: [], sources: [] }
            reply.web.sources.push(...event.sources)
            break
          case 'done':
            reply.status = 'done'
            reply.inputTokens = event.usage.input
            reply.outputTokens = event.usage.output
            break
          case 'error':
            reply.status = 'error'
            reply.error = event.message
            reply.errorKind = event.kind
            break
        }
        if (Date.now() - lastFlush >= FLUSH_INTERVAL_MS) {
          saveReply(db, messageId, reply)
          lastFlush = Date.now()
        }
      }
    } finally {
      live.delete(messageId)
    }

    // The stream ends without a done or error event only when it was cancelled.
    if (reply.status === 'streaming') reply.status = 'stopped'
    if (thinkingStartedAt !== null && reply.thinkingMs === null) {
      reply.thinkingMs = Date.now() - thinkingStartedAt
    }
    saveReply(db, messageId, reply)
    return reply
  }

  // Everything that can fail before writing: if it fails there must be no reply left stuck in "streaming".
  function prepare(
    input: { modelId: string; webSearch: boolean },
    session: Session | null,
    newThread: ChatSendInput['newThread'],
    attachments: Attachment[]
  ) {
    const model = getModel(db, input.modelId)
    const conn = connection(model.providerId)
    // The search keys are decrypted here.
    const tools = input.webSearch && model.supportsTools ? webTools() : null
    // An attachment missing from disk throws here.
    const files = new Map<string, LoadedFile>()
    for (const record of filesFor(session, newThread, attachments)) {
      if (files.has(record.id)) continue
      checkFile(record)
      let data: Buffer | undefined
      files.set(record.id, { record, data: () => (data ??= readFile(record)) })
    }
    return { model, modelRef: { providerId: model.providerId, modelId: model.id }, conn, tools, files }
  }

  // title: set when the session still has the placeholder title and this is its first round.
  function start(
    session: Session,
    assistantMessage: Message,
    { model, conn, tools, files }: ReturnType<typeof prepare>,
    thinking: ThinkingLevel,
    title: { question: Message; placeholder: string } | null
  ): void {
    const mainSession = session.kind === 'thread' ? getSession(db, session.parentSessionId) : session
    const conversation = {
      session,
      messages: listMessages(db, session.id),
      parentMessages: session.kind === 'thread' ? listMessages(db, mainSession.id) : []
    }
    const context = buildContext({
      ...conversation,
      projectPrompt: getProjectPrompt(db, mainSession.projectId),
      globalPrompt: getGlobalPrompt(db),
      model,
      thinking,
      files
    })

    // Documents the context shows as a page map; the model reads them through these tools (D-077).
    const documentIds = new Set(
      conversationMessages(conversation).flatMap((m) => m.attachments.flatMap((a) => (a.type === 'file' ? [a.fileId] : [])))
    )
    const documents = [...documentIds].map((id) => files.get(id)!.record).filter((f) => readsByTool(f, model))
    const allTools = combineTools([
      ...(documents.length > 0 ? [createDocumentTools(documents, files, model.supportsVision)] : []),
      ...(tools ? [tools] : [])
    ])

    const controller = new AbortController()
    const done = generate(assistantMessage.id, conn, {
      ...context,
      ...(allTools && { tools: allTools }),
      signal: controller.signal
    })
      .then(async (reply) => {
        if (!title || reply.status !== 'done') return
        const generated = await generateTitle(
          stream,
          conn,
          titleRequest(
            model,
            titleQuestion(title.question.content, title.question.attachments, (id) => files.get(id)?.record.name ?? '文件'),
            reply.content,
            controller.signal
          )
        )
        const renamed = generated && replacePlaceholderTitle(db, session.id, title.placeholder, generated)
        if (renamed) sessionUpdated(renamed)
      })
      .finally(() => running.delete(assistantMessage.id))
    running.set(assistantMessage.id, { controller, done })
  }

  return {
    fetchFiles(input) {
      const sessionId = 'replyId' in input ? getMessage(db, input.replyId).sessionId : input.sessionId
      const existing = sessionId ? getSession(db, sessionId) : null
      const newThread = 'replyId' in input ? null : input.newThread
      const attachments = 'replyId' in input ? [] : input.attachments
      return Promise.all(filesFor(existing, newThread, attachments).map(ensureFile)).then(() => undefined)
    },

    send(input) {
      const existing = input.sessionId ? getSession(db, input.sessionId) : null
      const prepared = prepare(input, existing, input.newThread, input.attachments)
      const { modelRef } = prepared

      const placeholderTitle = placeholderTitleOf(input.text)
      const { session, userMessage, assistantMessage } = db.transaction(() => {
        const session = input.sessionId
          ? touchSession(db, input.sessionId, modelRef)
          : input.newThread
            ? createThreadSession(db, {
                ...input.newThread,
                title: threadTitle(input.newThread.anchorQuote),
                ...modelRef
              })
            : createMainSession(db, {
                title: placeholderTitle,
                projectId: input.projectId,
                ...modelRef
              })
        const userMessage = appendMessage(db, session.id, {
          role: 'user',
          content: input.text,
          attachments: input.attachments
        })
        const assistantMessage = appendMessage(db, session.id, { role: 'assistant', ...modelRef })
        return { session, userMessage, assistantMessage }
      })()

      const isNewMain = !input.sessionId && !input.newThread
      const title = isNewMain ? { question: userMessage, placeholder: placeholderTitle } : null
      start(session, assistantMessage, prepared, input.thinking, title)
      return { session, userMessage, assistantMessage }
    },

    regenerate(input) {
      const reply = getMessage(db, input.replyId)
      const existing = getSession(db, reply.sessionId)
      const messages = listMessages(db, existing.id)
      const [question, last] = messages.slice(-2)
      // Everything before the last round stays as it is: marks, threads and forks depend on it (D-005).
      if (
        last?.id !== reply.id ||
        reply.role !== 'assistant' ||
        reply.status === 'streaming' ||
        question?.role !== 'user'
      ) {
        throw new Error('Only the last finished reply of a session can be regenerated')
      }
      const prepared = prepare(input, existing, null, [])
      const { modelRef } = prepared

      const removedIds = input.text === null ? [reply.id] : [question.id, reply.id]
      const { session, userMessage, assistantMessage } = db.transaction(() => {
        deleteMessages(db, removedIds)
        const session = touchSession(db, existing.id, modelRef)
        const userMessage =
          input.text === null
            ? question
            : appendMessage(db, session.id, {
                role: 'user',
                content: input.text,
                attachments: question.attachments
              })
        const assistantMessage = appendMessage(db, session.id, { role: 'assistant', ...modelRef })
        return { session, userMessage, assistantMessage }
      })()

      // A first round that never got its title (it failed or was stopped) gets one now.
      const placeholder = placeholderTitleOf(question.content)
      const untitled = existing.kind === 'main' && messages.length === 2 && existing.title === placeholder
      const title = untitled ? { question: userMessage, placeholder } : null
      start(session, assistantMessage, prepared, input.thinking, title)
      return { session, userMessage, assistantMessage, removedIds }
    },

    stop(messageId) {
      running.get(messageId)?.controller.abort()
    },

    async idle() {
      await Promise.all([...running.values()].map((r) => r.done))
    },

    withLiveReplies(messages) {
      return messages.map((m) => {
        const reply = live.get(m.id)
        return reply ? { ...m, ...reply } : m
      })
    }
  }
}
