import { describe, expect, it } from 'vitest'
import { openDb } from '../src/main/db'
import { appendMessage, conversationUsage, listMessages, saveReply } from '../src/main/db/repo/messages'
import { createProject, deleteProject, listProjects, updateProject } from '../src/main/db/repo/projects'
import { addModel, createProvider } from '../src/main/db/repo/providers'
import {
  createMainSession,
  createThreadSession,
  deleteSession,
  getGlobalPrompt,
  getSession,
  listSessions,
  moveSession,
  renameSession,
  setGlobalPrompt
} from '../src/main/db/repo/sessions'

function setup() {
  const db = openDb(':memory:')
  const provider = createProvider(db, { name: 'P', protocol: 'anthropic', baseUrl: 'http://x', apiKeyEnc: null })
  const model = addModel(db, provider.id, {
    modelName: 'm',
    displayName: 'M',
    supportsVision: false,
    supportsThinking: false,
    thinkingCanDisable: true,
    supportsTools: true,
    contextWindow: null,
    maxOutputTokens: null
  })
  const newSession = (projectId: string | null = null) =>
    createMainSession(db, { title: '会话', projectId, providerId: provider.id, modelId: model.id })
  const note = (scope: string, scopeId: string) =>
    db
      .prepare('INSERT INTO notes (id, scope, scope_id, content, updated_at) VALUES (?, ?, ?, ?, 0)')
      .run(`${scope}-${scopeId}`, scope, scopeId, '内容')
  const noteCount = () => db.prepare('SELECT COUNT(*) FROM notes').pluck().get()
  return { db, ids: { providerId: provider.id, modelId: model.id }, newSession, note, noteCount }
}

describe('projects', () => {
  it('appends new projects to the end of the list', () => {
    const { db } = setup()
    createProject(db, '一')
    createProject(db, '二')
    expect(listProjects(db).map((p) => [p.name, p.sortOrder])).toEqual([
      ['一', 0],
      ['二', 1]
    ])
  })

  it('saves the global prompt, and a blank one leaves nothing behind, so the default applies', () => {
    const { db } = setup()
    setGlobalPrompt(db, '全局')
    setGlobalPrompt(db, '改过的全局')
    expect(getGlobalPrompt(db)).toBe('改过的全局')
    setGlobalPrompt(db, '  \n')
    expect(getGlobalPrompt(db)).toBe('')
    expect(db.prepare('SELECT COUNT(*) FROM settings').pluck().get()).toBe(0)
  })

  it('stores a blank prompt as null, so the global prompt applies', () => {
    const { db } = setup()
    const p = createProject(db, '线代')
    expect(updateProject(db, p.id, { systemPrompt: '你是助教' })).toMatchObject({ name: '线代', systemPrompt: '你是助教' })
    expect(updateProject(db, p.id, { name: '线性代数' })).toMatchObject({ name: '线性代数', systemPrompt: '你是助教' })
    expect(updateProject(db, p.id, { systemPrompt: '  ' }).systemPrompt).toBeNull()
  })

  it('deleting a project deletes its sessions, their messages and the project note, nothing else', () => {
    const { db, newSession, note, noteCount } = setup()
    const p = createProject(db, '线代')
    const inside = newSession(p.id)
    const outside = newSession()
    appendMessage(db, inside.id, { role: 'user', content: '问', attachments: [] })
    note('project', p.id)
    note('session', outside.id)

    deleteProject(db, p.id)
    expect(listProjects(db)).toEqual([])
    expect(listSessions(db).map((s) => s.id)).toEqual([outside.id])
    expect(listMessages(db, inside.id)).toEqual([])
    expect(noteCount()).toBe(1)
  })
})

describe('session actions', () => {
  it('renames and moves a session in and out of a project without changing its time', () => {
    const { db, newSession } = setup()
    const p = createProject(db, '线代')
    const s = newSession()
    expect(renameSession(db, s.id, '新标题').title).toBe('新标题')
    expect(moveSession(db, s.id, p.id).projectId).toBe(p.id)
    expect(moveSession(db, s.id, null).projectId).toBeNull()
    expect(getSession(db, s.id).updatedAt).toBe(s.updatedAt)
  })

  it('deleting a session deletes its messages and its note', () => {
    const { db, newSession, note, noteCount } = setup()
    const s = newSession()
    appendMessage(db, s.id, { role: 'user', content: '问', attachments: [] })
    note('session', s.id)
    deleteSession(db, s.id)
    expect(listSessions(db)).toEqual([])
    expect(listMessages(db, s.id)).toEqual([])
    expect(noteCount()).toBe(0)
  })
  it("adds up a conversation's tokens with its threads', skipping replies without usage", () => {
    const { db, ids, newSession } = setup()
    const reply = (sessionId: string, tokens: [number, number] | null) => {
      const m = appendMessage(db, sessionId, { role: 'assistant', ...ids })
      saveReply(db, m.id, {
        content: '答',
        thinking: null,
        thinkingMs: null,
        status: tokens ? 'done' : 'stopped',
        error: null,
        errorKind: null,
        inputTokens: tokens?.[0] ?? null,
        outputTokens: tokens?.[1] ?? null,
        web: null
      })
      return m
    }
    const main = newSession()
    const other = newSession()
    const anchor = reply(main.id, [100, 20])
    reply(main.id, null)
    const thread = createThreadSession(db, {
      parentSessionId: main.id,
      anchorMessageId: anchor.id,
      anchorQuote: '答',
      anchorStart: 0,
      anchorEnd: 1,
      anchorPrefix: '',
      anchorSuffix: '',
      contextMode: 'fork',
      title: '追问',
      ...ids
    })
    reply(thread.id, [300, 40])
    reply(other.id, [5000, 5000])

    expect(conversationUsage(db, main.id)).toEqual({ input: 400, output: 60 })
    expect(conversationUsage(db, newSession().id)).toEqual({ input: 0, output: 0 })
  })
})
