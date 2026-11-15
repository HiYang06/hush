import type Database from 'better-sqlite3'
import type {
  Attachment,
  ChatRegenerateInput,
  ChatRegenerateResult,
  ChatSendInput,
  ChatSendResult,
  CompactResult,
  CompactState,
  ContextUsage,
  FileRecord,
  Message,
  Model,
  Session,
  StreamEvent,
  ThinkingLevel
} from '@shared/types'
import { getFiles } from '../db/repo/files'
import { getProject } from '../db/repo/projects'
import {
  appendMessage,
  deleteMessages,
  findMessage,
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
  listProjectSessionRefs,
  replacePlaceholderTitle,
  setCompaction,
  touchSession
} from '../db/repo/sessions'
import { isTruncated, streamChat } from './adapters'
import { readsByTool } from '@shared/files'
import { shouldAutoCompact } from '@shared/compact'
import { compactLimit, compactRequest, contextUsage, nothingToCompact, planCompaction, SUMMARY_MAX_OUTPUT } from './compact'
import { activeCompaction, buildContext, conversationMessages, type ContextInput, type LoadedFile } from './context'
import { createDocumentTools } from './documentTools'
import { createProjectTools } from './projectTools'
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
  compactState: (sessionId: string, state: CompactState | null) => void
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
  // Summarizes the older part of the conversation in the background; replies can go on meanwhile (D-087). Called
  // again while one runs, returns that one.
  compact: (sessionId: string) => Promise<CompactResult>
  // For the model picked in the input box, which may not be the one the session last used.
  contextUsage: (sessionId: string, modelId: string) => ContextUsage
  // Resolves when every reply and compaction in flight has finished; for tests.
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
  compactState,
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
  const compacting = new Map<string, Promise<CompactResult>>()

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
      contextTokens: null,
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
            reply.contextTokens = event.usage.context
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

  function contextInputFor(
    session: Session,
    model: ReturnType<typeof getModel>,
    thinking: ThinkingLevel,
    files: Map<string, LoadedFile>
  ): ContextInput {
    const mainSession = session.kind === 'thread' ? getSession(db, session.parentSessionId) : session
    const project = mainSession.projectId === null ? null : getProject(db, mainSession.projectId)
    return {
      session,
      messages: listMessages(db, session.id),
      parentMessages: session.kind === 'thread' ? listMessages(db, mainSession.id) : [],
      parentSession: session.kind === 'thread' ? mainSession : null,
      projectPrompt: project?.systemPrompt ?? null,
      projectSessions: model.supportsTools && project?.memoryEnabled
        ? listProjectSessionRefs(db, project.id, mainSession.id)
        : [],
      globalPrompt: getGlobalPrompt(db),
      model,
      thinking,
      files
    }
  }

  // Read afresh: a compaction or another round may have landed since the caller loaded the session. The estimate
  // counts an image without its bytes, so a file not downloaded to this device yet doesn't matter here.
  function usageNow(sessionId: string, model: Model): ContextUsage {
    const session = getSession(db, sessionId)
    const files = new Map(filesFor(session, null, []).map((record) => [record.id, { record, data: () => Buffer.alloc(0) }]))
    const input = contextInputFor(session, model, 'off', files)
    // compressible must agree with compact(), which runs on session.modelId rather than the composer's pick.
    const compactModel = session.modelId === null ? null : getModel(db, session.modelId)
    const plan = compactModel
      ? planCompaction(contextInputFor(session, compactModel, 'off', files), compactLimit(compactModel))
      : nothingToCompact('model_deleted')
    return contextUsage(
      conversationMessages(input),
      activeCompaction(input),
      buildContext(input),
      model.contextWindow,
      plan
    )
  }

  // The summary's text, or the provider's error; nothing is written until the whole summary is in.
  async function summarize(conn: Connection, req: ChatRequest): Promise<{ text: string } | { error: string }> {
    let text = ''
    for await (const event of stream(conn, req)) {
      if (event.type === 'text') text += event.delta
      if (event.type === 'error') return { error: event.message }
      // A summary cut off at the output cap would silently lose whatever it didn't reach.
      if (event.type === 'done' && isTruncated(event.stopReason)) {
        // Only a model whose own cap is below the summary's can be helped by raising it; otherwise the model
        // simply wrote too much this time, and a retry usually comes out shorter.
        return req.maxOutputTokens! < SUMMARY_MAX_OUTPUT
          ? { error: '摘要超过了模型的最大输出，没有保存。可以在设置里调大这个模型的最大输出。' }
          : { error: '摘要写得太长，超过了上限，没有保存。可以再试一次。' }
      }
    }
    return text.trim() ? { text: text.trim() } : { error: '模型没有返回摘要' }
  }

  // Repeats while the context is still past the trigger: a request that can't hold everything summarizes the
  // oldest part first. The session's model does it, so its cache from the conversation is reused.
  async function runCompaction(sessionId: string): Promise<CompactResult> {
    let compacted: Session | null = null
    // A failure on a follow-up pass keeps the summary an earlier pass saved, and still says what went wrong.
    const fail = (error: string): CompactResult => (compacted ? { ok: true, session: compacted, error } : { ok: false, error })
    for (;;) {
      try {
        // Loaded again each pass: rounds sent meanwhile may have brought new attachments.
        const session = getSession(db, sessionId)
        if (session.modelId === null) return fail('这个会话用的模型已被删除')
        await Promise.all(filesFor(session, null, []).map(ensureFile))
        const { model, conn, files } = prepare({ modelId: session.modelId, webSearch: false }, session, null, [])
        const input = contextInputFor(session, model, 'off', files)
        const { throughId } = planCompaction(input, compactLimit(model))
        if (throughId === null) {
          return compacted ? { ok: true, session: compacted } : { ok: false, error: 'nothing' }
        }
        const signal = new AbortController().signal
        const result = await summarize(conn, { ...compactRequest(buildContext({ ...input, through: throughId }), model), signal })
        if ('error' in result) return fail(result.error)
        const saved = setCompaction(db, sessionId, { summary: result.text, throughMessageId: throughId, compactedAt: Date.now() })
        if (!saved) return { ok: false, error: 'deleted' }
        compacted = saved
        sessionUpdated(compacted)
        // Checked before the next pass loads anything, so a failure there can't undo a compaction that was enough.
        if (!shouldAutoCompact(usageNow(sessionId, model))) return { ok: true, session: compacted }
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    }
  }

  function compact(sessionId: string): Promise<CompactResult> {
    const already = compacting.get(sessionId)
    if (already) return already
    compactState(sessionId, { status: 'running' })
    const job = runCompaction(sessionId)
      .then((result) => {
        compactState(sessionId, !result.error || result.error === 'nothing' ? null : { status: 'error', error: result.error })
        return result
      })
      .finally(() => compacting.delete(sessionId))
    compacting.set(sessionId, job)
    return job
  }

  // title: set when the session still has the placeholder title and this is its first round.
  function start(
    session: Session,
    assistantMessage: Message,
    { model, conn, tools, files }: ReturnType<typeof prepare>,
    thinking: ThinkingLevel,
    title: { question: Message; placeholder: string } | null
  ): void {
    const input = contextInputFor(session, model, thinking, files)
    const { projectSessions } = input
    const context = buildContext(input)

    // Documents the context shows as a page map, compacted messages' ones included; the model reads them through
    // these tools (D-077).
    const documentIds = new Set(
      conversationMessages(input).flatMap((m) => m.attachments.flatMap((a) => (a.type === 'file' ? [a.fileId] : [])))
    )
    const documents = [...documentIds].map((id) => files.get(id)!.record).filter((f) => readsByTool(f, model))
    const allTools = combineTools([
      ...(documents.length > 0 ? [createDocumentTools(documents, files, model.supportsVision)] : []),
      ...(projectSessions.length > 0 ? [createProjectTools(
        projectSessions,
        (id) => listMessages(db, id),
        (id) => getFiles(db, [id])[0]?.name ?? '文件'
      )] : []),
      ...(tools ? [tools] : [])
    ])

    const controller = new AbortController()
    const done = generate(assistantMessage.id, conn, {
      ...context,
      ...(allTools && { tools: allTools }),
      signal: controller.signal
    })
      .then(async (reply) => {
        // A session deleted meanwhile (e.g. by sync) took the reply with it.
        if (reply.status !== 'done' || !findMessage(db, assistantMessage.id)) return
        if (!compacting.has(session.id) && shouldAutoCompact(usageNow(session.id, model))) {
          void compact(session.id)
        }
        if (!title) return
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

    compact,

    contextUsage(sessionId, modelId) {
      return usageNow(sessionId, getModel(db, modelId))
    },

    async idle() {
      // A reply that ends can start a compaction, so wait for those after the replies.
      await Promise.all([...running.values()].map((r) => r.done))
      await Promise.all([...compacting.values()])
    },

    withLiveReplies(messages) {
      return messages.map((m) => {
        const reply = live.get(m.id)
        return reply ? { ...m, ...reply } : m
      })
    }
  }
}
