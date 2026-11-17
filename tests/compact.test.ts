import { describe, expect, it } from 'vitest'
import { shouldAutoCompact } from '@shared/compact'
import type { Message, Session } from '@shared/types'
import {
  chooseCut,
  COMPACT_PROMPT,
  compactRequest,
  contextUsage,
  IMAGE_TOKENS,
  KEEP_RECENT_TOKENS,
  planCompaction,
  roundsOf,
  SUMMARY_MAX_OUTPUT,
  type Round
} from '../src/main/llm/compact'
import type { ContextInput, LoadedFile } from '../src/main/llm/context'

const MODEL = {
  modelName: 'm',
  supportsVision: true,
  supportsTools: false,
  supportsThinking: true,
  thinkingCanDisable: true,
  maxOutputTokens: null
}

const SESSION: Session = {
  id: 's', kind: 'main', projectId: null, parentSessionId: null, anchorMessageId: null, anchorQuote: null,
  anchorMarkdown: null, anchorStart: null, anchorEnd: null, anchorPrefix: null, anchorSuffix: null, contextMode: null, title: '',
  providerId: null, modelId: null, createdAt: 0, updatedAt: 0,
  compactSummary: null, compactThroughId: null, compactedAt: null
}

function msg(seq: number, role: 'user' | 'assistant', content: string, extra: Partial<Message> = {}): Message {
  return {
    id: `m${seq}`, sessionId: 's', seq, role, content, thinking: null, thinkingMs: null, attachments: [],
    status: 'done', error: null, errorKind: null, providerId: null, modelId: null, inputTokens: null,
    outputTokens: null, contextTokens: null, web: null, createdAt: seq, ...extra
  }
}

// n characters of Latin text estimate to n / 4 tokens.
const NOTHING = { compressible: 0, nothingReason: 'recent' } as const
const text = (tokens: number): string => 'a'.repeat(tokens * 4)

function input(messages: Message[], extra: Partial<ContextInput> = {}): ContextInput {
  return {
    session: SESSION, messages, parentMessages: [], parentSession: null, projectPrompt: null, projectSessions: [],
    globalPrompt: '', model: MODEL, thinking: 'medium', files: new Map(), ...extra
  }
}

const round = (lastId: string, tokens: number): Round => ({ lastId, tokens, text: tokens })

describe('chooseCut', () => {
  it('keeps about KEEP_RECENT_TOKENS of the newest rounds and cuts at the end of a round', () => {
    const rounds = [round('a', 30_000), round('b', 5000), round('c', 12_000), round('d', 7000)]
    expect(chooseCut(rounds, Infinity)).toBe('b')
  })

  it('always keeps the last round, however long it is', () => {
    expect(chooseCut([round('a', 100), round('b', KEEP_RECENT_TOKENS * 3)], Infinity)).toBe('a')
    expect(chooseCut([round('a', KEEP_RECENT_TOKENS * 3)], Infinity)).toBeNull()
    expect(chooseCut([], Infinity)).toBeNull()
  })

  it('nothing to cut while everything fits in the recent part', () => {
    expect(chooseCut([round('a', 5000), round('b', 5000)], Infinity)).toBeNull()
  })

  it('over budget, takes only the oldest rounds that fit', () => {
    const rounds = [round('a', 40_000), round('b', 40_000), round('c', 40_000), round('d', 10_000)]
    expect(chooseCut(rounds, 90_000)).toBe('b')
    expect(chooseCut(rounds, 30_000)).toBeNull()
  })
})

describe('roundsOf', () => {
  it('groups a question with its reply; files count toward tokens but not toward text', () => {
    const files = new Map<string, LoadedFile>([
      ['img', { record: { id: 'img', sha256: 'img', name: 'a.png', mime: 'image/png', size: 1, path: 'img', extracted: null, isScanned: null, createdAt: 0 }, data: () => Buffer.from('') }]
    ])
    const rounds = roundsOf(
      [msg(1, 'user', text(10), { attachments: [{ type: 'file', fileId: 'img' }] }), msg(2, 'assistant', text(20)), msg(3, 'user', text(5))],
      { files, model: MODEL }
    )
    expect(rounds).toEqual([
      { lastId: 'm2', tokens: 30 + IMAGE_TOKENS, text: 30 },
      { lastId: 'm3', tokens: 5, text: 5 }
    ])
  })
})

describe('planCompaction', () => {
  const long = [
    msg(1, 'user', text(15_000)), msg(2, 'assistant', text(15_000)),
    msg(3, 'user', text(15_000)), msg(4, 'assistant', text(15_000)),
    msg(5, 'user', text(5000)), msg(6, 'assistant', text(5000))
  ]

  it('starts after the current boundary and reports what compacting could free', () => {
    expect(planCompaction(input(long), null)).toEqual({ throughId: 'm4', compressible: 60_000, nothingReason: null })
    const compacted = { ...SESSION, compactSummary: '摘要', compactThroughId: 'm2', compactedAt: 1 }
    expect(planCompaction(input(long, { session: compacted }), null)).toEqual({ throughId: 'm4', compressible: 30_000, nothingReason: null })
  })

  it('a limit too small for every round summarizes only the first ones now, and names too_large when none fits', () => {
    const limit = 35_000 + 1000
    expect(planCompaction(input(long), limit).throughId).toBe('m2')
    expect(planCompaction(input(long), 1000)).toEqual({ throughId: null, compressible: 0, nothingReason: 'too_large' })
    expect(planCompaction(input([msg(1, 'user', text(100))]), 1000)).toEqual({ throughId: null, compressible: 0, nothingReason: 'recent' })
    // compressible doesn't shrink with the limit: it tells whether compacting is worth it at all.
    expect(planCompaction(input(long), limit).compressible).toBe(60_000)
  })
})

describe('planCompaction with attachment-only rounds', () => {
  it('says nothing can be compacted when the rounds it would summarize are only attachments', () => {
    const record = (id: string) => ({ id, sha256: id, name: `${id}.png`, mime: 'image/png', size: 1, path: id, extracted: null, isScanned: null, createdAt: 0 })
    const ids = Array.from({ length: 30 }, (_, i) => `img${i}`)
    const files = new Map<string, LoadedFile>(ids.map((id) => [id, { record: record(id), data: () => Buffer.from('') }]))
    const images = (from: number) => ids.slice(from, from + 15).map((fileId) => ({ type: 'file' as const, fileId }))
    const messages = [
      msg(1, 'user', '', { attachments: images(0) }), msg(2, 'assistant', ''),
      msg(3, 'user', '', { attachments: images(15) }), msg(4, 'assistant', ''),
      msg(5, 'user', text(100)), msg(6, 'assistant', text(100))
    ]
    expect(planCompaction(input(messages, { files }), null)).toEqual({ throughId: null, compressible: 0, nothingReason: 'files_only' })
  })
})

describe('compactRequest', () => {
  it('asks for the summary last, without tools, thinking as low as the model allows, output capped', () => {
    const context = { model: 'm', system: '提示词', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: '问' }] }], thinking: 'high' as const, maxOutputTokens: 64_000 }
    const req = compactRequest(context, { ...MODEL, maxOutputTokens: 64_000 })
    // The context ends with a question here: the prompt joins it, since providers expect roles to alternate.
    expect(req.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: '问' }, { type: 'text', text: COMPACT_PROMPT }] }])
    const answered = { ...context, messages: [...context.messages, { role: 'assistant' as const, content: [{ type: 'text' as const, text: '答' }] }] }
    expect(compactRequest(answered, MODEL).messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: COMPACT_PROMPT }] })
    expect(req.system).toBe('提示词')
    expect(req.thinking).toBe('off')
    expect(req.maxOutputTokens).toBe(SUMMARY_MAX_OUTPUT)
    expect(compactRequest(context, { ...MODEL, thinkingCanDisable: false, maxOutputTokens: 4000 })).toMatchObject({ thinking: 'low', maxOutputTokens: 4000 })
    expect(compactRequest(context, { ...MODEL, supportsThinking: false }).thinking).toBeNull()
    expect(req.tools).toBeUndefined()
  })
})

describe('contextUsage', () => {
  const built = { system: '', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: text(500) }] }] }

  it('uses the provider count of the last reply plus that reply', () => {
    const conversation = [msg(1, 'user', '问'), msg(2, 'assistant', text(100), { contextTokens: 9000, createdAt: 10 })]
    expect(contextUsage(conversation, null, built, 100_000, NOTHING).tokens).toBe(9100)
    expect(contextUsage(conversation, { summary: '摘要', throughIndex: 0, compactedAt: 5 }, built, 100_000, NOTHING)).toMatchObject({ tokens: 9100, summary: '摘要' })
  })

  it('estimates when the last reply has no count, or was sent the context from before the compaction', () => {
    const stopped = [msg(1, 'user', '问'), msg(2, 'assistant', '半', { status: 'stopped' })]
    expect(contextUsage(stopped, null, built, 100_000, NOTHING).tokens).toBe(500)
    const old = [msg(1, 'user', '问'), msg(2, 'assistant', '答', { contextTokens: 9000, createdAt: 10 })]
    expect(contextUsage(old, { summary: '摘要', throughIndex: 0, compactedAt: 20 }, built, 100_000, NOTHING).tokens).toBe(500)
    expect(contextUsage([], null, built, null, NOTHING)).toEqual({ tokens: 500, window: null, compressible: 0, summary: null, nothingReason: 'recent' })
  })
})

describe('shouldAutoCompact', () => {
  it('at 85% of a known window, when compacting frees at least 10% of it', () => {
    expect(shouldAutoCompact({ tokens: 85_000, window: 100_000, compressible: 10_000, summary: null, nothingReason: null })).toBe(true)
    expect(shouldAutoCompact({ tokens: 84_999, window: 100_000, compressible: 50_000, summary: null, nothingReason: null })).toBe(false)
    expect(shouldAutoCompact({ tokens: 99_000, window: 100_000, compressible: 9999, summary: null, nothingReason: null })).toBe(false)
    expect(shouldAutoCompact({ tokens: 99_000, window: null, compressible: 50_000, summary: null, nothingReason: null })).toBe(false)
  })
})
