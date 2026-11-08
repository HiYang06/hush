import { describe, expect, it } from 'vitest'
import { openDb } from '../src/main/db'
import { appendMessage } from '../src/main/db/repo/messages'
import {
  appendToNote,
  getNoteContent,
  listNotes,
  listRevisions,
  replaceNote,
  restoreRevision,
  saveNote
} from '../src/main/db/repo/notes'
import { createProject } from '../src/main/db/repo/projects'
import { addModel, createProvider } from '../src/main/db/repo/providers'
import { createMainSession, createThreadSession, getSession, moveSession } from '../src/main/db/repo/sessions'
import { clipBlock, clipToNote, transferNoteText } from '../src/main/notes'

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
  const ids = { providerId: provider.id, modelId: model.id }
  const newSession = (title: string, projectId: string | null = null) =>
    createMainSession(db, { title, projectId, ...ids })
  const reply = (sessionId: string) => appendMessage(db, sessionId, { role: 'assistant', ...ids })
  return { db, ids, newSession, reply }
}

const GLOBAL = { scope: 'global', scopeId: 'global' } as const

describe('note repo', () => {
  it('reads a never-written note as empty, then creates it on the first save', () => {
    const { db } = setup()
    expect(getNoteContent(db, GLOBAL)).toBe('')
    saveNote(db, GLOBAL, '# 笔记')
    saveNote(db, GLOBAL, '# 笔记\n\n第二版')
    expect(getNoteContent(db, GLOBAL)).toBe('# 笔记\n\n第二版')
    expect(db.prepare('SELECT COUNT(*) FROM notes').pluck().get()).toBe(1)
  })

  it('keeps full-text search in step with saves', () => {
    const { db } = setup()
    saveNote(db, GLOBAL, '特征值分解')
    saveNote(db, GLOBAL, '奇异值分解')
    const search = (q: string) =>
      db.prepare('SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH ?').pluck().get(q)
    expect(search('奇异值')).toBe(1)
    expect(search('特征值')).toBe(0)
  })

  it('appends after exactly one blank line, whatever the note ended with', () => {
    const { db } = setup()
    expect(appendToNote(db, GLOBAL, '> 一')).toBe('> 一\n')
    saveNote(db, GLOBAL, '> 一\n\n\n  ')
    expect(appendToNote(db, GLOBAL, '> 二')).toBe('> 一\n\n> 二\n')
  })
})

describe('clipBlock', () => {
  it('quotes every line and links back to the message', () => {
    expect(clipBlock('第一段\n\n- 要点', '线性代数', { messageId: 'm1', start: 3, end: 12 })).toBe(
      '> 第一段\n>\n> - 要点\n>\n> —— [《线性代数》](hush://message/m1#3-12)'
    )
  })

  it("puts a mark's comment below the quote as body text", () => {
    expect(clipBlock('x', '会话', { messageId: 'm1', start: 0, end: 1 }, '  我的批注\n')).toBe(
      '> x\n>\n> —— [《会话》](hush://message/m1#0-1)\n\n我的批注'
    )
  })

  it('escapes brackets in the title so the link stays a link', () => {
    expect(clipBlock('x', '[草稿] 矩阵', { messageId: 'm1', start: 0, end: 1 })).toContain(
      '[《\\[草稿\\] 矩阵》](hush://message/m1#0-1)'
    )
  })
})

describe('clipToNote', () => {
  it("writes to a standalone session's own note", () => {
    const { db, newSession, reply } = setup()
    const session = newSession('会话一')
    const message = reply(session.id)
    const { target, content } = clipToNote(db, { messageId: message.id, start: 0, end: 2 }, '原文')
    expect(target).toEqual({ scope: 'session', scopeId: session.id })
    expect(content).toBe(`> 原文\n>\n> —— [《会话一》](hush://message/${message.id}#0-2)\n`)
    expect(getNoteContent(db, target)).toBe(content)
  })

  it("writes to the project's note for a session in a project", () => {
    const { db, newSession, reply } = setup()
    const project = createProject(db, '线代')
    const message = reply(newSession('会话二', project.id).id)
    expect(clipToNote(db, { messageId: message.id, start: 0, end: 2 }, '原文').target).toEqual({ scope: 'project', scopeId: project.id })
  })

  it("writes a thread's text to its main session's note, titled after the main session", () => {
    const { db, ids, newSession, reply } = setup()
    const main = newSession('主对话')
    const anchor = reply(main.id)
    const thread = createThreadSession(db, {
      parentSessionId: main.id,
      anchorMessageId: anchor.id,
      anchorQuote: '原句',
      anchorStart: 0,
      anchorEnd: 2,
      anchorPrefix: '',
      anchorSuffix: '',
      contextMode: 'fork',
      title: '原句',
      ...ids
    })
    const message = reply(thread.id)
    const { target, content } = clipToNote(db, { messageId: message.id, start: 1, end: 5 }, '追问里的话')
    expect(target).toEqual({ scope: 'session', scopeId: main.id })
    expect(content).toContain(`[《主对话》](hush://message/${message.id}#1-5)`)
  })
})

describe('listNotes', () => {
  it('lists written notes, most recently changed first', () => {
    const { db } = setup()
    saveNote(db, GLOBAL, '全局')
    saveNote(db, { scope: 'project', scopeId: 'p1' }, '项目')
    db.prepare("UPDATE notes SET updated_at = 1 WHERE scope = 'global'").run()
    expect(listNotes(db).map((n) => [n.scope, n.scopeId, n.content])).toEqual([
      ['project', 'p1', '项目'],
      ['global', 'global', '全局']
    ])
  })
})

describe('revisions', () => {
  it('keeps what was there before a replace, newest first', () => {
    const { db } = setup()
    replaceNote(db, GLOBAL, '第一版', 'ai_rewrite')
    replaceNote(db, GLOBAL, '第二版', 'ai_rewrite')
    replaceNote(db, GLOBAL, '第三版', 'migrate_in')
    expect(getNoteContent(db, GLOBAL)).toBe('第三版')
    // The first write had nothing before it to keep.
    expect(listRevisions(db, GLOBAL).map((r) => [r.content, r.reason])).toEqual([
      ['第二版', 'migrate_in'],
      ['第一版', 'ai_rewrite']
    ])
  })

  it('keeps only the latest 20', () => {
    const { db } = setup()
    for (let i = 0; i <= 25; i++) replaceNote(db, GLOBAL, `v${i}`, 'ai_append')
    const revisions = listRevisions(db, GLOBAL)
    expect(revisions).toHaveLength(20)
    expect(revisions[0].content).toBe('v24')
    expect(revisions[19].content).toBe('v5')
  })

  it('restores a revision, keeping the current content as one too', () => {
    const { db } = setup()
    replaceNote(db, GLOBAL, '旧', 'ai_rewrite')
    replaceNote(db, GLOBAL, '新', 'ai_rewrite')
    const [old] = listRevisions(db, GLOBAL)
    expect(restoreRevision(db, old.id)).toEqual({ target: GLOBAL, content: '旧' })
    expect(getNoteContent(db, GLOBAL)).toBe('旧')
    expect(listRevisions(db, GLOBAL)[0]).toMatchObject({ content: '新', reason: 'restore' })
  })
})

describe('transferNoteText', () => {
  const PROJECT = { scope: 'project', scopeId: 'p1' } as const
  const SOURCE = '# 笔记\n\n## 特征值\n\nAv = λv\n\n## 奇异值\n\nσ\n'
  const section = '## 特征值\n\nAv = λv\n\n'
  const from = SOURCE.indexOf(section)
  const to = from + section.length

  it('moves a range to the end of another note, with a revision on each', () => {
    const { db } = setup()
    saveNote(db, GLOBAL, SOURCE)
    saveNote(db, PROJECT, '已有内容')
    const result = transferNoteText(db, { source: GLOBAL, from, to, text: section, target: PROJECT, mode: 'move' })
    expect(result).toEqual({
      source: '# 笔记\n\n## 奇异值\n\nσ\n',
      target: '已有内容\n\n## 特征值\n\nAv = λv\n'
    })
    expect(getNoteContent(db, GLOBAL)).toBe(result.source)
    expect(listRevisions(db, GLOBAL)[0]).toMatchObject({ content: SOURCE, reason: 'migrate_out' })
    expect(listRevisions(db, PROJECT)[0]).toMatchObject({ content: '已有内容', reason: 'migrate_in' })
  })

  it('copies without touching the source, and can start a note that was never written', () => {
    const { db } = setup()
    saveNote(db, GLOBAL, SOURCE)
    const result = transferNoteText(db, { source: GLOBAL, from, to, text: section, target: PROJECT, mode: 'copy' })
    expect(result.source).toBe(SOURCE)
    expect(getNoteContent(db, PROJECT)).toBe('## 特征值\n\nAv = λv\n')
    expect(listRevisions(db, GLOBAL)).toEqual([])
  })

  it('refuses when the range no longer holds the text, and changes nothing', () => {
    const { db } = setup()
    saveNote(db, GLOBAL, SOURCE)
    expect(() =>
      transferNoteText(db, { source: GLOBAL, from, to, text: '别的内容', target: PROJECT, mode: 'move' })
    ).toThrow()
    expect(getNoteContent(db, GLOBAL)).toBe(SOURCE)
    expect(getNoteContent(db, PROJECT)).toBe('')
  })
})

describe('moving a session into a project', () => {
  it("appends the session's note to the project's under a heading, and drops the session's", () => {
    const { db, newSession } = setup()
    const project = createProject(db, '线代')
    const target = { scope: 'project', scopeId: project.id } as const
    saveNote(db, target, '项目笔记')
    const session = newSession('特征值入门')
    saveNote(db, { scope: 'session', scopeId: session.id }, '\n会话笔记\n')
    moveSession(db, session.id, project.id)
    expect(getNoteContent(db, target)).toBe('项目笔记\n\n## 来自《特征值入门》\n\n会话笔记\n')
    expect(listRevisions(db, target)[0]).toMatchObject({ content: '项目笔记', reason: 'merge' })
    expect(db.prepare("SELECT COUNT(*) FROM notes WHERE scope = 'session'").pluck().get()).toBe(0)
  })

  it('merges nothing for an empty note, or between projects', () => {
    const { db, newSession } = setup()
    const a = createProject(db, 'A')
    const b = createProject(db, 'B')
    const session = newSession('空的')
    saveNote(db, { scope: 'session', scopeId: session.id }, '  \n')
    moveSession(db, session.id, a.id)
    moveSession(db, session.id, b.id)
    expect(listNotes(db)).toEqual([])
    expect(getSession(db, session.id).projectId).toBe(b.id)
  })
})
